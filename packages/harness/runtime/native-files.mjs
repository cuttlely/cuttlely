import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessError } from '../errors.mjs'
import { mergeTurnArtifacts, newTurnImageDir, removeTurnImageDir, turnFiles, turnImages } from '../images.mjs'
import { managedFileOwnerTag, managedUploadActor, readManagedUpload } from '../prediction-files.mjs'
import { specialistProfileName, specialistWorkspace, tryProfileName } from '../profile.mjs'
import { readManagedWorkspace } from '../session.mjs'
import { defaultUploadRoots, parseUploadStubs, uploadSource } from '../uploads.mjs'

const worker = fileURLToPath(new URL('./managed-files/managed.py', import.meta.url))
const reportWorker = fileURLToPath(new URL('./managed-files/fixed_report.py', import.meta.url))
const schema = JSON.parse(fs.readFileSync(new URL('./managed-files/tools.json', import.meta.url), 'utf8'))
const maxBytes = 64 * 1024 ** 2
const maxEntries = 256
const maxOutput = maxBytes * 1.5 + 1024 ** 2
const unavailable = () => new HarnessError('workspace_unavailable', 'The restricted file worker is unavailable on this deployment.', 503)
let checked

function assertRelative(name) {
    if (
        typeof name !== 'string' ||
        !name ||
        name.length > 512 ||
        /^[~/]|^[a-z]:/i.test(name) ||
        /[\\\x00-\x1f]/.test(name) ||
        name.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.env'))
    ) {
        throw new HarnessError('protected_file', 'Use a relative path inside this specialist workspace.')
    }
    return name
}

function environment(dir) {
    return {
        HOME: dir,
        TMPDIR: dir,
        CUTTLELY_NATIVE_REPORT_ASSETS: process.env.CUTTLELY_NATIVE_REPORT_ASSETS || '/opt/cuttlely-report-assets',
        LANG: 'C.UTF-8',
        PATH: '/usr/bin:/bin',
        CUTTLELY_NATIVE_FILE_DECODER: process.env.CUTTLELY_NATIVE_FILE_DECODER || '/opt/cuttlely-file-decoder',
        CUTTLELY_NATIVE_FILE_SEARCH: process.env.CUTTLELY_NATIVE_FILE_SEARCH || '/usr/bin/rg'
    }
}

export function managedFilesReady() {
    const now = Date.now()
    if (checked && checked.until > now) return checked.ready
    let ready = false
    let dir
    try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-files-check-'))
        const probe = spawnSync('/usr/bin/python3', ['-IB', worker, '--check'], {
            cwd: dir,
            env: environment(dir),
            timeout: 5000,
            encoding: 'utf8',
            maxBuffer: 4096
        })
        ready = probe.status === 0 && probe.stdout.trim() === 'ready'
    } catch {
        ready = false
    } finally {
        if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
    checked = { until: now + 60000, ready }
    return ready
}

async function executeWorker(record, signal, entry = worker) {
    signal?.throwIfAborted()
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cuttlely-managed-file-'))
    try {
        return await new Promise((resolve, reject) => {
            const subprocess = spawn('/usr/bin/python3', ['-IB', entry], {
                cwd: dir,
                env: environment(dir),
                detached: true,
                stdio: ['pipe', 'pipe', 'ignore']
            })
            const chunks = []
            let length = 0,
                failure
            function stop(reason) {
                failure ||= reason
                try {
                    process.kill(-subprocess.pid, 'SIGKILL')
                } catch {
                    /* Child has exited. */
                }
            }
            const abort = () => stop(signal.reason)
            signal?.addEventListener('abort', abort, { once: true })
            if (signal?.aborted) abort()
            const timer = setTimeout(() => stop(new HarnessError('tool_timeout', 'The managed file operation timed out.')), 25000)
            subprocess.on('error', () => stop(unavailable()))
            subprocess.stdin.on('error', () => {})
            subprocess.stdout.on('data', (chunk) => {
                length += chunk.length
                if (length > maxOutput) stop(new HarnessError('file_limit', 'The managed file response exceeded the workspace quota.'))
                else chunks.push(chunk)
            })
            subprocess.on('close', (code) => {
                clearTimeout(timer)
                signal?.removeEventListener('abort', abort)
                if (failure || code !== 0) return reject(failure || unavailable())
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString()))
                } catch {
                    reject(unavailable())
                }
            })
            subprocess.stdin.end(JSON.stringify(record))
        })
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true })
    }
}

export function renderFixedDocuments(table, signal) {
    return executeWorker(table, signal, reportWorker)
}

export async function withManagedUploads(context, input, run) {
    const flow = context.moduleOptions.flowOptions
    const actor = managedUploadActor(flow.nestedFlowCaller)
    if (!actor) throw new HarnessError('forbidden', 'Managed files need a signed-in user or a specific admitted API key.', 403)
    const generation = context.roster.createdAt || context.roster.tryId
    if (!generation) throw new HarnessError('bad_session', 'Managed files require a published team generation.')
    const scope = {
        workspace: context.roster.workspaceId,
        flow: flow.callerChatflowId || context.roster.chatflowId,
        chat: context.chatId,
        caller: flow.nestedFlowCaller
    }
    const uploads = Object.create(null),
        sources = []
    let used = 0
    let question = String(input)
    const admitted = context.managedUploadReceipts || []
    const paths = new Set(admitted.map((receipt) => receipt.path).filter(Boolean))
    const legacy = parseUploadStubs(input).filter((stub) => stub.path && !paths.has(stub.path))
    for (const [index, stub] of [...admitted, ...legacy].entries()) {
        let key
        try {
            if (Object.keys(uploads).length >= maxEntries) throw Error('Workspace upload limit')
            const stored = await readManagedUpload(stub.proof, scope, defaultUploadRoots()[0], maxBytes - used)
            if (!stored) throw Error('Unbound file')
            let basename = path.basename(stub.name || stored.name)
            if (Object.hasOwn(uploads, 'uploads/' + basename)) basename = Object.keys(uploads).length + '-' + basename
            key = assertRelative('uploads/' + basename)
            used += stored.body.length
            uploads[key] = stored.body.toString('base64')
            sources.push(uploadSource({ name: basename, absolutePath: key, size: stored.body.length, mime: stub.mime, rows: stub.rows }))
        } catch {
            if (index < admitted.length)
                throw new HarnessError('upload_changed', 'The admitted upload could not be verified. Send the file again.', 409)
            key = '[upload path refused]'
        }
        if (stub.path) {
            question = question.replaceAll(stub.path, key)
            if (index >= admitted.length && stub.proof) question = question.replaceAll(stub.proof, '[verified upload receipt]')
        }
    }
    context.managedFileOwner = await managedFileOwnerTag(flow.nestedFlowCaller, scope.workspace, scope.chat)
    context.managedUploads = uploads
    context.uploadSources = sources
    return run(question)
}
export function existingFileDependency(roster, specialist) {
    const opened = []
    const flags = fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_RDONLY
    function openDirectory(directory) {
        const fd = fs.openSync(directory, flags)
        opened.push(fd)
        return '/proc/self/fd/' + fd
    }
    function firstEntry(directory, visit) {
        const entries = fs.opendirSync(directory)
        try {
            let entry
            while ((entry = entries.readSync())) if (visit(entry)) return true
            return false
        } finally {
            entries.closeSync()
        }
    }
    try {
        if (!roster.name || !specialist.name) return true
        const profile = roster.tryId ? tryProfileName(roster.tryId) : roster.name
        const workspace = specialistWorkspace(specialistProfileName(profile, specialist.name))
        const base = openDirectory(path.dirname(path.dirname(workspace)))
        const all = openDirectory(path.join(base, 'workspaces'))
        const own = openDirectory(path.join(all, path.basename(workspace)))
        return firstEntry(
            own,
            (entry) =>
                entry.name !== 'chat-images' || !entry.isDirectory() || firstEntry(openDirectory(path.join(own, entry.name)), () => true)
        )
    } catch (error) {
        return error.code !== 'ENOENT'
    } finally {
        for (const fd of opened.reverse()) fs.closeSync(fd)
    }
}

function modelSupportsPatch(model) {
    const label = String(model?.inputs?.modelName || model?.modelName || '').toLowerCase()
    return (
        ['chatOpenAI', 'azureChatOpenAI', 'chatOpenAICustom'].includes(model?.nodeName) ||
        /(?:^|\/)(?:gpt[-.]|chatgpt|codex|o[1345])/.test(label) ||
        label.includes('openai/')
    )
}

// The child parses only stdin. A fixed CLI, an empty environment and explicit syntax mode
// exclude user preloads, package scripts and import resolution. No provided code executes.
async function javascriptDiagnostic(encoded, mode, signal) {
    const bytes = Buffer.from(encoded || '', 'base64')
    return new Promise((resolve, reject) => {
        const child = execFile(
            process.execPath,
            ['--check', '--no-warnings', '--input-type=' + mode, '-'],
            {
                cwd: os.tmpdir(),
                env: {},
                signal,
                timeout: 3000,
                maxBuffer: 32768,
                killSignal: 'SIGKILL'
            },
            (error, stdout, stderr) => {
                if (signal?.aborted) return reject(signal.reason)
                if (!error) return resolve('')
                const kind = /^(SyntaxError|RangeError): (.+)$/m.exec(stderr)
                if (!kind) return resolve('Syntax check unavailable.')
                const line = /^\[stdin\]:(\d+)/m.exec(stderr)?.[1]
                return resolve('JavaScript syntax error' + (line ? ' at line ' + line : '') + '.')
            }
        )
        child.stdin.on('error', () => {})
        child.stdin.end(bytes)
    })
}

function workspaceModuleMode(files, filename) {
    let dir = path.posix.dirname(filename)
    for (;;) {
        const entry = files[path.posix.join(dir, 'package.json')]
        if (entry) {
            try {
                const type = JSON.parse(Buffer.from(entry, 'base64').toString()).type
                if (type === 'module' || type === 'commonjs') return type
            } catch {
                /* Malformed package manifests do not alter parser authority. */
            }
        }
        if (dir === '.') return ''
        dir = path.posix.dirname(dir)
    }
}

async function checkJavaScript(current, prior, mode, signal) {
    const check = async (body) => {
        if (mode) return javascriptDiagnostic(body, mode, signal)
        const common = await javascriptDiagnostic(body, 'commonjs', signal)
        return common && (await javascriptDiagnostic(body, 'module', signal)) ? common : ''
    }
    const issue = await check(current)
    if (issue === 'Syntax check unavailable.') return { status: 'skipped', message: issue }
    if (issue && issue !== (await check(prior))) return { status: 'error', output: issue }
    return { status: 'ok', output: '' }
}

export function openManagedFiles(context, specialist) {
    if (!managedFilesReady()) throw unavailable()
    const actor = managedUploadActor(context.moduleOptions.flowOptions.nestedFlowCaller)
    const generation = context.roster.createdAt || context.roster.tryId
    const scope = [
        context.roster.workspaceId,
        context.roster.chatflowId,
        context.roster.tryId || '',
        generation,
        actor,
        context.chatId,
        specialist.name
    ]
    if (scope.some((v, i) => i !== 2 && (typeof v !== 'string' || !v)))
        throw new HarnessError('bad_session', 'A managed workspace needs a saved team and admitted chat.')
    const scopeKey = createHash('sha256').update(JSON.stringify(scope)).digest('hex')
    context.managedWorkspaces ||= new Map()
    const prior = context.managedWorkspaces.get(scopeKey)
    const saved = prior || (!context.replay && readManagedWorkspace(context.name, context.sessionScope, scopeKey))
    const state = prior ? structuredClone(prior.manifest) : saved ? JSON.parse(saved.manifest) : { files: {}, modified: {} }
    let files = Object.assign(Object.create(null), state.files, context.managedUploads)
    let modified = Object.assign(Object.create(null), state.modified)
    let known = Object.create(null)
    const names = ['READ_FILE_SCHEMA', 'WRITE_FILE_SCHEMA', 'SEARCH_FILES_SCHEMA', 'PATCH_SCHEMA']
    const tools = names.map((key) => {
        const entry = structuredClone(schema[key])
        if (key === 'PATCH_SCHEMA' && modelSupportsPatch(specialist.model || context.roster.chief.model)) {
            entry.description = schema._PATCH_V4A_DESCRIPTION
            Object.assign(entry.parameters.properties, schema._PATCH_V4A_PARAMS)
        }
        return { type: 'function', function: entry }
    })
    return {
        tools,
        note:
            'Use relative paths inside your specialist workspace. Save files for the chat under output/. Uploaded file paths: ' +
            Object.keys(context.managedUploads || {}).join(', '),
        async readAssigned(file, args) {
            context.assertNativeAuthority()
            const response = await executeWorker(
                {
                    files: { [file.path]: Buffer.from(file.content).toString('base64') },
                    name: 'read_file',
                    args: { path: file.path, offset: args.offset, limit: args.limit }
                },
                context.workSignal
            )
            context.assertNativeAuthority()
            return { content: JSON.stringify(response.result), error: Boolean(response.result.error) }
        },
        async execute(name, args) {
            context.assertNativeAuthority()
            const response = await executeWorker({ files, modified, known, name, args }, context.workSignal)
            context.assertNativeAuthority()
            if (response.known) {
                const modifications = Object.entries(response.changed)
                for (const [p, next] of modifications) {
                    if (path.extname(p).toLowerCase() !== '.js') continue
                    const lint = await checkJavaScript(next, files[p], workspaceModuleMode(files, p), context.workSignal)
                    if (args.mode === 'patch') {
                        if (lint.status === 'error') response.result.lint = { ...response.result.lint, [p]: lint }
                    } else response.result.lint = lint
                }
                context.assertNativeAuthority()
                for (const removed of response.removed) delete files[assertRelative(removed)]
                for (const [p, body] of Object.entries(response.changed)) files[assertRelative(p)] = body
                modified = response.modified
                known = response.known
            }
            return {
                content: JSON.stringify(response.result),
                error: Boolean(response.result.error || response.result.success === false),
                // A missing file may have similarly named siblings. Neither names nor paths belong in a public diagnostic.
                ...(name === 'read_file' && response.result.not_found === true ? { managedFileNotFound: true } : {})
            }
        },
        async finish() {
            context.assertNativeAuthority()
            const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cuttlely-file-artifacts-'))
            const dir = newTurnImageDir(root)
            try {
                if (!dir) throw unavailable()
                for (const p of Object.keys(files)) {
                    if (!p.startsWith('output/')) continue
                    const name = assertRelative(p.slice('output/'.length))
                    const target = path.join(dir, name)
                    await fs.promises.mkdir(path.dirname(target), { recursive: true })
                    await fs.promises.writeFile(target, Buffer.from(files[p], 'base64'), { flag: 'wx', mode: 0o600 })
                    await fs.promises.utimes(target, 0, new Date(1700000000000 + Number(modified[p] || 0) * 10))
                    delete files[p]
                    delete modified[p]
                }
                const artifacts = mergeTurnArtifacts(
                    [turnImages(dir, 0, { specialist: specialist.name })],
                    [turnFiles(dir, 0, { specialist: specialist.name })]
                ).artifacts
                context.assertNativeAuthority()
                if (context.managedWorkspaces.get(scopeKey) !== prior)
                    throw new HarnessError('workspace_changed', 'Another delegation changed this workspace.', 409)
                context.managedWorkspaces.set(scopeKey, { scopeKey, revision: saved?.revision || 0, manifest: { files, modified } })
                return artifacts
            } finally {
                removeTurnImageDir(dir)
                await fs.promises.rm(root, { recursive: true, force: true })
            }
        }
    }
}
