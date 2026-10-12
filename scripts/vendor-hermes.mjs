#!/usr/bin/env node
// Vendors NousResearch/hermes-agent into hermes/: upstream at a tag or commit, minus the paths in
// hermes/CUTTLELY_EXCLUDE.txt, and when hermes/CUTTLELY_LOADED.txt is present only the files that
// list names plus package __init__ files, data files those modules name, license files and the
// local patches. See hermes/CUTTLELY_VENDOR.txt.
//
//   pnpm hermes:vendor <tag-or-commit>   fetch, trim, apply the patches, and swap the result into hermes/
//   pnpm hermes:vendor --continue        after fixing a patch that did not apply in the staging copy
//   pnpm hermes:vendor --abort           drop the staging copy; hermes/ is left as it was
//   pnpm hermes:vendor --save-patches    turn edits made in hermes/ into patch files (--new <name> for new files)
//   pnpm hermes:vendor --check           offline guard used by pnpm verify
//
// hermes/ is only written after every patch applies. Each patch owns its files; no file is in two patches.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_UPSTREAM = 'https://github.com/NousResearch/hermes-agent.git'
// Files Cuttlely owns inside hermes/. They are not upstream files and are never trimmed or patched.
export const OWN_FILES = [
    'CUTTLELY_VENDOR.txt',
    'CUTTLELY_EXCLUDE.txt',
    'CUTTLELY_LOADED.txt',
    'CUTTLELY_VENDOR.lock',
    'UPSTREAM_COMMIT'
]
const OWN_DIRS = ['patches/']
const BOT = { name: 'cuttlely vendor', email: 'vendor@cuttlely.invalid', date: '2000-01-01T00:00:00Z' }

export class VendorError extends Error {}

function run(cmd, args, opts = {}) {
    const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts })
    if (res.error) throw new VendorError(`${cmd} could not start: ${res.error.message}`)
    if (res.status !== 0 && !opts.allowFail) {
        throw new VendorError(`${cmd} ${args.join(' ')} failed:\n${(res.stderr || res.stdout || '').trim()}`)
    }
    return res
}

function git(cwd, args, opts = {}) {
    const env = {
        ...process.env,
        GIT_AUTHOR_NAME: BOT.name,
        GIT_AUTHOR_EMAIL: BOT.email,
        GIT_AUTHOR_DATE: BOT.date,
        GIT_COMMITTER_NAME: BOT.name,
        GIT_COMMITTER_EMAIL: BOT.email,
        GIT_COMMITTER_DATE: BOT.date,
        ...(opts.env || {})
    }
    return run('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd, ...opts, env })
}

export function paths(root = SCRIPT_ROOT, env = process.env) {
    const hermes = path.join(root, 'hermes')
    const cache =
        env.CUTTLELY_HERMES_VENDOR_CACHE || path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'cuttlely', 'hermes-vendor')
    const key = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)
    return {
        root,
        hermes,
        patches: path.join(hermes, 'patches'),
        exclude: path.join(hermes, 'CUTTLELY_EXCLUDE.txt'),
        loaded: path.join(hermes, 'CUTTLELY_LOADED.txt'),
        lock: path.join(hermes, 'CUTTLELY_VENDOR.lock'),
        upstreamCommit: path.join(hermes, 'UPSTREAM_COMMIT'),
        cache,
        mirror: path.join(cache, 'upstream.git'),
        staging: path.join(cache, `staging-${key}`),
        state: path.join(cache, `state-${key}.json`),
        upstream: env.CUTTLELY_HERMES_UPSTREAM || DEFAULT_UPSTREAM
    }
}

// --- exclude list ----------------------------------------------------------------------------------------------

// Gitignore-style subset: "name/" is a folder of that name at any depth, "/name/" is a folder at the hermes root,
// "/file" is one file at the root. Blank lines and # comments are skipped.
export function parseExcludes(text) {
    return String(text)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
            const anchored = line.startsWith('/')
            const folder = line.endsWith('/')
            const name = line.replace(/^\/+/, '').replace(/\/+$/, '')
            if (!name || (!anchored && name.includes('/'))) throw new VendorError(`CUTTLELY_EXCLUDE.txt: unsupported pattern "${line}"`)
            return { line, anchored, folder, name }
        })
}

// Measured files the agent runtime loads. Blank lines and # comments are skipped.
// One repo-relative path per line. An empty list is refused so a bad file cannot wipe the tree.
export function parseLoaded(text) {
    const files = []
    for (const line of String(text).split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        if (trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.split('/').includes('..')) {
            throw new VendorError(`CUTTLELY_LOADED.txt: unsupported path "${trimmed}"`)
        }
        files.push(trimmed)
    }
    if (!files.length) throw new VendorError('CUTTLELY_LOADED.txt has no paths. Refusing to vendor an empty tree.')
    return files
}

const DATA_EXT = new Set([
    '.yaml',
    '.yml',
    '.json',
    '.toml',
    '.txt',
    '.md',
    '.html',
    '.jinja',
    '.j2',
    '.sql',
    '.csv',
    '.xml',
    '.ini',
    '.cfg',
    '.typed'
])

function isLicenseFile(file) {
    const base = file.split('/').pop()
    return /^(LICENSE|NOTICE|COPYING|AUTHORS|COPYRIGHT)(\..*)?$/i.test(base)
}

// Listed files, plus package __init__ files, license and attribution files, files a local patch
// edits, and data files a kept module names with a string literal.
export function filesToKeep(upstreamFiles, { loaded, patchFiles, readFile }) {
    const all = new Set(upstreamFiles)
    const keep = new Set()
    for (const file of [...loaded, ...patchFiles]) if (all.has(file)) keep.add(file)
    for (const file of upstreamFiles) if (isLicenseFile(file)) keep.add(file)
    const addInits = () => {
        for (const file of [...keep]) {
            const parts = file.split('/')
            for (let i = 1; i < parts.length; i++) {
                const init = `${parts.slice(0, i).join('/')}/__init__.py`
                if (all.has(init)) keep.add(init)
            }
        }
    }
    addInits()
    if (readFile) {
        let grew = true
        while (grew) {
            grew = false
            for (const file of [...keep]) {
                if (!file.endsWith('.py') || !all.has(file)) continue
                let source = ''
                try {
                    source = readFile(file)
                } catch {
                    continue
                }
                const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
                for (const match of source.matchAll(/['"]([^'"\n]{1,200})['"]/g)) {
                    const lit = match[1]
                    if (!lit || lit.startsWith('/') || lit.includes('\\') || lit.split('/').includes('..')) continue
                    const ext = lit.includes('.') ? lit.slice(lit.lastIndexOf('.')) : ''
                    if (!DATA_EXT.has(ext) && !lit.endsWith('SKILL.md')) continue
                    const candidates = dir ? [`${dir}/${lit}`, lit] : [lit]
                    for (const rel of candidates) {
                        const normal = rel.replace(/\/+/g, '/').replace(/^\.\//, '')
                        if (all.has(normal) && !keep.has(normal)) {
                            keep.add(normal)
                            grew = true
                        }
                    }
                }
            }
            const before = keep.size
            addInits()
            if (keep.size !== before) grew = true
        }
    } else {
        addInits()
    }
    return keep
}

export function excludedBy(file, patterns) {
    const parts = file.split('/')
    for (const pattern of patterns) {
        if (pattern.anchored) {
            if (pattern.folder ? file.startsWith(`${pattern.name}/`) : file === pattern.name) return pattern.line
        } else if (pattern.folder ? parts.slice(0, -1).includes(pattern.name) : parts.at(-1) === pattern.name) {
            return pattern.line
        }
    }
    return null
}

function isOwn(file) {
    return OWN_FILES.includes(file) || OWN_DIRS.some((dir) => file.startsWith(dir))
}

// --- patches ---------------------------------------------------------------------------------------------------

export function listPatches(dir) {
    if (!fs.existsSync(dir)) return []
    return fs
        .readdirSync(dir)
        .filter((name) => /^\d{4}-.+\.patch$/.test(name))
        .sort()
        .map((name) => ({ name, file: path.join(dir, name), text: fs.readFileSync(path.join(dir, name), 'utf8') }))
}

// Files a patch touches, and which of them it creates.
export function patchFiles(text) {
    const files = []
    const created = []
    const lines = String(text).split('\n')
    for (let i = 0; i < lines.length; i++) {
        const found = /^diff --git a\/(\S+) b\/(\S+)$/.exec(lines[i])
        if (!found) continue
        files.push(found[2])
        for (let j = i + 1; j < lines.length && !lines[j].startsWith('diff --git '); j++) {
            if (lines[j].startsWith('new file mode')) created.push(found[2])
            if (lines[j].startsWith('@@')) break
        }
    }
    return { files, created }
}

export function patchOwners(patches) {
    const owners = new Map()
    for (const patch of patches) {
        for (const file of patchFiles(patch.text).files) {
            if (owners.has(file))
                throw new VendorError(`${file} is in both ${owners.get(file)} and ${patch.name}. Keep each file in one patch.`)
            owners.set(file, patch.name)
        }
    }
    return owners
}

// --- tree fingerprint ------------------------------------------------------------------------------------------

// Files under hermes/ on disk that git tracks or would track. Ignored files such as .venv are skipped.
export function hermesFiles(p) {
    const out = git(p.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'hermes']).stdout
    return [...new Set(out.split('\0').filter(Boolean))]
        .map((file) => file.slice('hermes/'.length))
        .filter((file) => {
            try {
                fs.lstatSync(path.join(p.hermes, file))
                return true
            } catch {
                return false
            }
        })
        .sort()
}

// Every file under hermes/ except the lock and the CUTTLELY_VENDOR.txt notes: path, executable bit and content.
const UNFINGERPRINTED = ['CUTTLELY_VENDOR.lock', 'CUTTLELY_VENDOR.txt']

export function fingerprint(p) {
    const hash = crypto.createHash('sha256')
    for (const file of hermesFiles(p)) {
        if (UNFINGERPRINTED.includes(file)) continue
        const full = path.join(p.hermes, file)
        const stat = fs.lstatSync(full)
        const body = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full)
        const mode = stat.isSymbolicLink() ? 'link' : stat.mode & 0o111 ? 'exec' : 'file'
        hash.update(`${mode} ${crypto.createHash('sha256').update(body).digest('hex')} ${file}\n`)
    }
    return hash.digest('hex')
}

export function readLock(p) {
    if (!fs.existsSync(p.lock)) return null
    const lock = {}
    for (const line of fs.readFileSync(p.lock, 'utf8').split('\n')) {
        const found = /^([a-z]+):\s*(.*)$/.exec(line.trim())
        if (found) lock[found[1]] = found[2]
    }
    return lock
}

function writeLock(p, { upstream, ref, commit }) {
    const body = [
        '# Written by pnpm hermes:vendor. Do not edit by hand; pnpm verify checks it.',
        `upstream: ${upstream}`,
        `ref: ${ref}`,
        `commit: ${commit}`,
        `fingerprint: ${fingerprint(p)}`,
        ''
    ].join('\n')
    fs.writeFileSync(p.lock, body)
}

// --- check (offline) -------------------------------------------------------------------------------------------

export function check(p) {
    const problems = []
    const patches = listPatches(p.patches)
    let owners = new Map()
    try {
        owners = patchOwners(patches)
    } catch (error) {
        problems.push(error.message)
    }
    const created = new Set(patches.flatMap((patch) => patchFiles(patch.text).created))
    const patterns = fs.existsSync(p.exclude) ? parseExcludes(fs.readFileSync(p.exclude, 'utf8')) : []
    if (!fs.existsSync(p.exclude)) problems.push('hermes/CUTTLELY_EXCLUDE.txt is missing.')
    const files = hermesFiles(p)
    const back = files.filter((file) => !isOwn(file) && !created.has(file) && excludedBy(file, patterns))
    if (back.length) {
        problems.push(
            `${back.length} file(s) under hermes/ match CUTTLELY_EXCLUDE.txt, for example ${back.slice(0, 5).join(', ')}. ` +
                'Delete them, or take the pattern off the exclude list and re-vendor.'
        )
    }
    // Undo every patch on a scratch copy of its files. If one does not undo cleanly, the files no longer match it.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-check-'))
    try {
        for (const file of owners.keys()) {
            const from = path.join(p.hermes, file)
            if (!fs.existsSync(from)) continue
            const to = path.join(scratch, file)
            fs.mkdirSync(path.dirname(to), { recursive: true })
            fs.copyFileSync(from, to)
        }
        for (const patch of [...patches].reverse()) {
            const res = run('git', ['apply', '-R', '--check', patch.file], { cwd: scratch, allowFail: true })
            if (res.status !== 0) {
                problems.push(
                    `${patch.name} no longer matches the files in hermes/. Save the change with pnpm hermes:vendor --save-patches.`
                )
                continue
            }
            run('git', ['apply', '-R', patch.file], { cwd: scratch })
        }
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true })
    }
    const lock = readLock(p)
    if (!lock?.fingerprint) problems.push('hermes/CUTTLELY_VENDOR.lock is missing or has no fingerprint.')
    else if (lock.fingerprint !== fingerprint(p)) {
        problems.push(
            'hermes/ changed outside pnpm hermes:vendor. Save an intended change as a patch with ' +
                'pnpm hermes:vendor --save-patches (add --new <name> for files no patch owns yet), or undo it.'
        )
    }
    const pinned = fs.existsSync(p.upstreamCommit) ? fs.readFileSync(p.upstreamCommit, 'utf8').trim() : ''
    if (lock?.commit && pinned !== lock.commit) problems.push('hermes/UPSTREAM_COMMIT does not match the commit in CUTTLELY_VENDOR.lock.')
    return problems
}

// --- staging ---------------------------------------------------------------------------------------------------

function readState(p) {
    return fs.existsSync(p.state) ? JSON.parse(fs.readFileSync(p.state, 'utf8')) : null
}

function writeState(p, state) {
    fs.mkdirSync(p.cache, { recursive: true })
    fs.writeFileSync(p.state, JSON.stringify(state, null, 2))
}

function clearStaging(p) {
    fs.rmSync(p.staging, { recursive: true, force: true })
    fs.rmSync(p.state, { force: true })
}

export function fetchUpstream(p, ref) {
    fs.mkdirSync(p.cache, { recursive: true })
    if (!fs.existsSync(p.mirror)) git(p.cache, ['init', '-q', '--bare', p.mirror])
    git(p.mirror, ['fetch', '-q', '--depth', '1', '--no-tags', p.upstream, ref])
    const commit = git(p.mirror, ['rev-parse', 'FETCH_HEAD^{commit}']).stdout.trim()
    const date = git(p.mirror, ['log', '-1', '--format=%cI', commit]).stdout.trim()
    return { commit, date }
}

// Upstream at the commit, minus the exclude list and anything Cuttlely's .gitignore files would drop.
// `previous` is the commit vendored before; its files let a patch apply three-way and leave conflict markers.
export function buildBase(p, commit, previous) {
    clearStaging(p)
    git(p.cache, ['init', '-q', p.staging])
    if (previous && previous !== commit) git(p.staging, ['fetch', '-q', '--depth', '1', p.mirror, previous])
    git(p.staging, ['fetch', '-q', '--depth', '1', p.mirror, commit])
    git(p.staging, ['checkout', '-q', '-b', 'vendor', commit])
    const patterns = parseExcludes(fs.readFileSync(p.exclude, 'utf8'))
    const all = git(p.staging, ['ls-files', '-z']).stdout.split('\0').filter(Boolean)
    const excluded = all.filter((file) => excludedBy(file, patterns))
    const rest = all.filter((file) => !excludedBy(file, patterns))
    const ignored = rest.length
        ? git(p.root, ['check-ignore', '--no-index', '--stdin', '-z'], {
              input: rest.map((file) => `hermes/${file}\0`).join(''),
              allowFail: true
          })
              .stdout.split('\0')
              .filter(Boolean)
              .map((file) => file.slice('hermes/'.length))
        : []
    const ignoredSet = new Set(ignored)
    const notIgnored = rest.filter((file) => !ignoredSet.has(file))
    let subset = []
    if (fs.existsSync(p.loaded)) {
        const loaded = parseLoaded(fs.readFileSync(p.loaded, 'utf8'))
        const patchTouched = listPatches(p.patches).flatMap((patch) => patchFiles(patch.text).files)
        const keep = filesToKeep(notIgnored, {
            loaded,
            patchFiles: patchTouched,
            readFile: (file) => fs.readFileSync(path.join(p.staging, file), 'utf8')
        })
        subset = notIgnored.filter((file) => !keep.has(file))
    }
    const drop = [...excluded, ...ignored, ...subset]
    for (let i = 0; i < drop.length; i += 500) git(p.staging, ['rm', '-q', '--cached', '--', ...drop.slice(i, i + 500)])
    for (const file of drop) fs.rmSync(path.join(p.staging, file), { force: true })
    git(p.staging, ['commit', '-q', '--allow-empty', '-m', `upstream ${commit} minus excluded paths`])
    git(p.staging, ['tag', 'base'])
    return { excluded: excluded.length, ignored, subset: subset.length }
}

function applyPatches(p, patches) {
    if (!patches.length) return { ok: true }
    const res = git(p.staging, ['am', '-q', '-3', '--keep-cr', ...patches.map((patch) => patch.file)], { allowFail: true })
    if (res.status === 0) return { ok: true }
    return { ok: false, detail: (res.stderr || res.stdout || '').trim() }
}

function stoppedMessage(p) {
    const current = fs.existsSync(path.join(p.staging, '.git', 'rebase-apply', 'final-commit'))
        ? fs.readFileSync(path.join(p.staging, '.git', 'rebase-apply', 'final-commit'), 'utf8').split('\n')[0]
        : 'a patch'
    let conflicts = git(p.staging, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).stdout.trim()
    const failed = path.join(p.staging, '.git', 'rebase-apply', 'patch')
    if (!conflicts && fs.existsSync(failed)) conflicts = patchFiles(fs.readFileSync(failed, 'utf8')).files.join('\n')
    return [
        `Stopped: "${current}" did not apply. hermes/ was not changed.`,
        conflicts ? `Files:\n${conflicts.replace(/^/gm, '  ')}` : '',
        `Fix the files in ${p.staging} (the patch header says what it is for), git add them there, then run pnpm hermes:vendor --continue.`,
        'Or run pnpm hermes:vendor --abort to drop the staging copy.'
    ]
        .filter(Boolean)
        .join('\n')
}

// Patch files from the staging commits after base, one per commit, with stable headers.
export function exportPatches(p) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-patches-'))
    git(p.staging, ['format-patch', '-q', '-N', '--zero-commit', '--no-signature', '--full-index', '-o', out, 'base..HEAD'])
    return out
}

function stagingFiles(p) {
    return git(p.staging, ['ls-files', '-z']).stdout.split('\0').filter(Boolean).sort()
}

// Replace hermes/ with the staging tree. Files Cuttlely owns and anything untracked or ignored (.venv) stay.
export function swapIn(p, patchDir, { ref, commit }) {
    const keep = new Set(stagingFiles(p))
    const tracked = git(p.root, ['ls-files', '-z', '--', 'hermes'])
        .stdout.split('\0')
        .filter(Boolean)
        .map((f) => f.slice(7))
    let removed = 0
    for (const file of tracked) {
        if (isOwn(file) || keep.has(file)) continue
        fs.rmSync(path.join(p.hermes, file), { force: true })
        removed++
        let dir = path.dirname(path.join(p.hermes, file))
        while (dir.startsWith(p.hermes) && dir !== p.hermes && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir)
            dir = path.dirname(dir)
        }
    }
    let changed = 0
    for (const file of keep) {
        const from = path.join(p.staging, file)
        const to = path.join(p.hermes, file)
        const stat = fs.lstatSync(from)
        const body = fs.readFileSync(from)
        const same =
            fs.existsSync(to) && Buffer.compare(fs.readFileSync(to), body) === 0 && (fs.statSync(to).mode & 0o111) === (stat.mode & 0o111)
        if (same) continue
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.rmSync(to, { force: true })
        fs.writeFileSync(to, body)
        fs.chmodSync(to, stat.mode & 0o777)
        changed++
    }
    fs.rmSync(p.patches, { recursive: true, force: true })
    fs.mkdirSync(p.patches, { recursive: true })
    const names = fs
        .readdirSync(patchDir)
        .filter((name) => name.endsWith('.patch'))
        .sort()
    for (const name of names) fs.copyFileSync(path.join(patchDir, name), path.join(p.patches, name))
    fs.rmSync(patchDir, { recursive: true, force: true })
    fs.writeFileSync(p.upstreamCommit, `${commit}\n`)
    writeLock(p, { upstream: p.upstream, ref, commit })
    return { removed, changed, patches: names }
}

function finish(p, state, log) {
    const patchDir = exportPatches(p)
    const result = swapIn(p, patchDir, state)
    clearStaging(p)
    log(`Vendored ${state.ref} (${state.commit}${state.date ? `, ${state.date}` : ''}).`)
    log(`hermes/: ${result.changed} file(s) written, ${result.removed} removed. Patches: ${result.patches.join(', ') || 'none'}.`)
    if (state.ignored?.length) {
        log(`Dropped because .gitignore matches them (${state.ignored.length}):`)
        for (const file of state.ignored) log(`  ${file}`)
    }
    log('Next: bash scripts/setup-hermes.sh, then pnpm verify.')
    return result
}

function preflight(p) {
    run('git', ['--version'])
    const dirty = git(p.root, ['status', '--porcelain', '--', 'hermes']).stdout.trim()
    if (dirty) throw new VendorError('hermes/ has uncommitted changes. Commit or undo them first (or save them with --save-patches).')
    const branch = git(p.root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()
    if (branch === 'main') throw new VendorError('Run this on a branch, not main.')
    if (readState(p)) throw new VendorError('A vendor run is already in progress. Run pnpm hermes:vendor --continue or --abort.')
}

export function vendor(p, ref, log = console.log) {
    if (!ref) throw new VendorError('Name a tag or commit, for example: pnpm hermes:vendor v0.21.6')
    preflight(p)
    const previous = readLock(p)?.commit
    if (previous) fetchUpstream(p, previous)
    const { commit, date } = fetchUpstream(p, ref)
    log(`Upstream ${ref} is ${commit} (${date}).`)
    const { excluded, ignored, subset } = buildBase(p, commit, previous)
    log(`Left out ${excluded} excluded, ${ignored.length} ignored, and ${subset} unlisted file(s).`)
    const state = { ref, commit, date, ignored }
    writeState(p, state)
    const applied = applyPatches(p, listPatches(p.patches))
    if (!applied.ok) throw new VendorError(stoppedMessage(p))
    return finish(p, state, log)
}

export function resume(p, log = console.log) {
    const state = readState(p)
    if (!state) throw new VendorError('Nothing to continue.')
    const res = git(p.staging, ['am', '--continue'], { allowFail: true })
    if (res.status !== 0) throw new VendorError(stoppedMessage(p))
    return finish(p, state, log)
}

export function abort(p, log = console.log) {
    if (fs.existsSync(path.join(p.staging, '.git', 'rebase-apply'))) git(p.staging, ['am', '--abort'], { allowFail: true })
    clearStaging(p)
    log('Dropped the staging copy. hermes/ is unchanged.')
}

// Turn the current hermes/ into patches against the pinned upstream. Each changed file goes to the patch that
// owns it; files no patch owns need --new <name> (and --message for the header).
export function savePatches(p, { name, message } = {}, log = console.log) {
    const lock = readLock(p)
    if (!lock?.commit) throw new VendorError('hermes/CUTTLELY_VENDOR.lock has no commit to compare against.')
    if (readState(p)) throw new VendorError('A vendor run is in progress. Run pnpm hermes:vendor --continue or --abort first.')
    const patches = listPatches(p.patches)
    const owners = patchOwners(patches)
    fetchUpstream(p, lock.commit)
    const { ignored } = buildBase(p, lock.commit)
    const upstreamFiles = new Set(stagingFiles(p))
    const local = hermesFiles(p).filter((file) => !isOwn(file) && fs.existsSync(path.join(p.hermes, file)))
    const differs = (file) => {
        const mine = path.join(p.hermes, file)
        const theirs = path.join(p.staging, file)
        if (!fs.existsSync(mine)) return fs.existsSync(theirs)
        if (!fs.existsSync(theirs)) return true
        return (
            Buffer.compare(fs.readFileSync(mine), fs.readFileSync(theirs)) !== 0 ||
            (fs.statSync(mine).mode & 0o111) !== (fs.statSync(theirs).mode & 0o111)
        )
    }
    const changed = [...new Set([...local, ...owners.keys()])].filter(differs).sort()
    const unowned = changed.filter((file) => !owners.has(file))
    const removedUpstream = [...upstreamFiles].filter((file) => !fs.existsSync(path.join(p.hermes, file)))
    if (removedUpstream.length) {
        clearStaging(p)
        throw new VendorError(
            `Upstream files are missing from hermes/: ${removedUpstream.slice(0, 5).join(', ')}. Add them to CUTTLELY_EXCLUDE.txt instead.`
        )
    }
    if (unowned.length && !name) {
        clearStaging(p)
        throw new VendorError(`No patch owns ${unowned.join(', ')}. Run again with --new <name> --message "<what and why>".`)
    }
    const commitFiles = (files, subject, body) => {
        for (const file of files) {
            const from = path.join(p.hermes, file)
            const to = path.join(p.staging, file)
            if (fs.existsSync(from)) {
                fs.mkdirSync(path.dirname(to), { recursive: true })
                fs.copyFileSync(from, to)
                fs.chmodSync(to, fs.statSync(from).mode & 0o777)
                git(p.staging, ['add', '-f', '--', file])
            } else if (fs.existsSync(to)) {
                git(p.staging, ['rm', '-q', '--', file])
            }
        }
        git(p.staging, ['commit', '-q', '--allow-empty', '-m', subject, ...(body ? ['-m', body] : [])])
    }
    for (const patch of patches) {
        const files = [...owners.entries()].filter(([, owner]) => owner === patch.name).map(([file]) => file)
        const { subject, body } = patchMessage(patch.text)
        commitFiles(files, subject, body)
    }
    if (unowned.length) commitFiles(unowned, `cuttlely: ${name}`, message || '')
    const patchDir = exportPatches(p)
    // Patches that end up empty (their files match upstream again) are dropped.
    for (const file of fs.readdirSync(patchDir)) {
        if (!/^diff --git /m.test(fs.readFileSync(path.join(patchDir, file), 'utf8'))) fs.rmSync(path.join(patchDir, file))
    }
    const result = swapIn(p, patchDir, { ref: lock.ref || lock.commit, commit: lock.commit })
    clearStaging(p)
    log(`Saved ${result.patches.length} patch(es): ${result.patches.join(', ')}.`)
    if (ignored.length) log(`${ignored.length} upstream file(s) are left out because .gitignore matches them.`)
    return result
}

export function patchMessage(text) {
    const lines = String(text).split('\n')
    const start = lines.findIndex((line) => line.startsWith('Subject: '))
    if (start < 0) return { subject: 'Cuttlely patch', body: '' }
    let subject = lines[start].replace(/^Subject: (\[PATCH[^\]]*\] )?/, '')
    let i = start + 1
    while (i < lines.length && /^\s/.test(lines[i]) && lines[i].trim()) subject += ` ${lines[i++].trim()}`
    const end = lines.findIndex((line, at) => at > i && line === '---')
    const body = lines
        .slice(i, end < 0 ? undefined : end)
        .join('\n')
        .trim()
    return { subject, body }
}

function parseArgs(argv) {
    const args = { _: [] }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--new' || arg === '--message') args[arg.slice(2)] = argv[++i]
        else if (arg.startsWith('--')) args[arg.slice(2)] = true
        else args._.push(arg)
    }
    return args
}

export function main(argv = process.argv.slice(2), root = process.env.CUTTLELY_VENDOR_ROOT || SCRIPT_ROOT) {
    const args = parseArgs(argv)
    const p = paths(root)
    try {
        if (args.check) {
            const problems = check(p)
            if (problems.length) {
                for (const problem of problems) console.error(`hermes-vendor: ${problem}`)
                return 1
            }
            console.log(`hermes-vendor: hermes/ matches the lock, the exclude list and ${listPatches(p.patches).length} patch(es).`)
            return 0
        }
        if (args.abort) abort(p)
        else if (args.continue) resume(p)
        else if (args['save-patches']) savePatches(p, { name: args.new, message: args.message })
        else vendor(p, args._[0])
        return 0
    } catch (error) {
        if (!(error instanceof VendorError)) throw error
        console.error(error.message)
        return 1
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
