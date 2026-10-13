// The full server needs the Python agent runtime, which ships in the Docker image.
// This package only talks to the local Docker daemon.
import { readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RESOURCE_ID_RE, runCheck } from './check.js'
import { spawnDocker } from './docker.js'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')

export const VERSION = JSON.parse(readFileSync(PKG, 'utf8')).version
export const IMAGE = 'ghcr.io/cuttlely/cuttlely'
export const DEFAULT_PORT = 43117
export const CONTAINER_NAME = 'cuttlely'
export const VOLUME_NAME = 'cuttlely-data'
export const DATA_DIR = '/var/cuttlely'
export const INSTALL_DOCS = 'https://github.com/cuttlely/cuttlely/blob/main/docs/how-to/docker.md'
export const HEALTH_TIMEOUT_MS = 6 * 60 * 1000

const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const INSPECT_FORMAT = '{{.State.Status}}|{{.Config.Image}}|{{.Image}}|{{range $p, $b := .HostConfig.PortBindings}}{{$p}} {{end}}'

export class UsageError extends Error {
    constructor(message, exitCode = 1) {
        super(message)
        this.exitCode = exitCode
    }
}

export function helpText() {
    return [
        'cuttlely runs Cuttlely in Docker.',
        '',
        'Usage:',
        '  cuttlely start [--port <n>] [--tag <tag>] [--env-file <path>] [--no-open]',
        '  cuttlely stop',
        '  cuttlely status',
        '  cuttlely logs [--follow]',
        '  cuttlely upgrade [--port <n>] [--tag <tag>] [--env-file <path>] [--no-open]',
        '  cuttlely check --flow <id> [--server <url>] [--timeout <seconds>] [--json <path>] [--fail-on-changed]',
        '  cuttlely check --flow <id> [--server <url>] [--timeout <seconds>] [--json <path>] --dataset <id> [--evaluator <id> ...] [--threshold <0-100>]',
        '  cuttlely check --flow <id> [--server <url>] [--timeout <seconds>] [--json <path>] --gate',
        '  cuttlely --help',
        '  cuttlely --version',
        '',
        `The image is ${IMAGE}. The tag defaults to this package's version (${VERSION}).`,
        `Data is kept in the Docker volume ${VOLUME_NAME}.`,
        `The app listens on http://localhost:${DEFAULT_PORT} unless you set --port.`,
        '',
        'Commands:',
        '  start     Pull the image and start Cuttlely. Opens the browser when it is ready.',
        '  stop      Stop the Cuttlely container. Running answers get up to 35 seconds to finish.',
        '  status    Show whether Cuttlely is running.',
        '  logs      Show container logs. --follow keeps streaming.',
        '  upgrade   Pull the image and start it again.',
        '  check     Run the Publish check on a flow draft. Reads CUTTLELY_API_KEY.',
        '            The key needs chatflows:view and chatflows:update, or agentflows:view and agentflows:update.',
        '            --dataset or --gate also needs datasets:view and evaluators:view.',
        '',
        'Exit codes for check:',
        '  0  The check finished. No answer was Changed, or --fail-on-changed was off. A scored check exits 0 when the server verdict is passed.',
        '  1  --fail-on-changed was set and at least one answer was Changed. A scored check exits 1 when the server verdict is failed.',
        '  2  The check timed out, the server returned an error, CUTTLELY_API_KEY was missing, the flow has no draft, or the command was used wrong.',
        'A check the server marks stopped or failed also exits 2. If the draft is saved, published, or discarded while the check runs, the command exits 2, because the answers may be for a draft that is already gone. After the check has started, a timeout, a 403, or any other failure asks the server to stop it. That stop is best effort: if it fails, the exit code is still 2.',
        'Cancelling the command stops the server-side check.',
        'A scored check (--dataset or --gate) exits on the server verdict and does not score the answers itself. --gate reads the dataset, evaluators, and threshold saved on the flow. Do not combine --gate with --dataset, or those flags with --fail-on-changed.',
        '',
        `Install guide: ${INSTALL_DOCS}`
    ].join('\n')
}

function parsePort(value, exitCode = 1) {
    if (!value || !/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
        throw new UsageError(`Port must be a number from 1 to 65535, got ${value || '(missing)'}.`, exitCode)
    }
    return Number(value)
}

function parseTag(value, exitCode = 1) {
    if (!value || !TAG_RE.test(value)) {
        throw new UsageError(`Not a valid image tag: ${value || '(missing)'}. Example: 1.0.0 or latest.`, exitCode)
    }
    return value
}

// These options take the next argv token as their value. A following `check` is that value, not the command.
// Any other previous token, including an unknown flag, leaves `check` as the command.
const VALUE_OPTIONS = new Set([
    '--flow',
    '--server',
    '--timeout',
    '--json',
    '--dataset',
    '--evaluator',
    '--threshold',
    '--port',
    '-p',
    '--tag',
    '--env-file'
])

export function isCheckCommand(argv) {
    return argv.some((item, index) => {
        if (item !== 'check') return false
        if (index === 0) return true
        return !VALUE_OPTIONS.has(argv[index - 1])
    })
}

// An unexpected failure while running check is not a Changed answer.
export function commandFailureCode(argv) {
    return isCheckCommand(argv) ? 2 : 1
}

function parseFlow(value) {
    if (!value || !RESOURCE_ID_RE.test(value)) {
        throw new UsageError('--flow needs the flow id from the canvas address bar.', 2)
    }
    return value
}

function parseResourceId(value, flag) {
    if (!value || !RESOURCE_ID_RE.test(value)) {
        throw new UsageError(`${flag} needs ${flag === '--dataset' ? 'a dataset id' : 'an evaluator id'}.`, 2)
    }
    return value
}

function parseThreshold(value) {
    if (!/^(?:0|[1-9]\d?|100)$/.test(value || '')) {
        throw new UsageError(`--threshold must be a whole number from 0 to 100, got ${value || '(missing)'}.`, 2)
    }
    return Number(value)
}

function parseServer(value) {
    let url
    try {
        url = new URL(value)
    } catch {
        throw new UsageError('--server needs an http or https URL, for example http://127.0.0.1:43117.', 2)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UsageError('--server needs an http or https URL, for example http://127.0.0.1:43117.', 2)
    }
    if (url.username || url.password) {
        throw new UsageError(`Put the API key in CUTTLELY_API_KEY, not in the server URL.`, 2)
    }
    if (url.pathname !== '/' && url.pathname !== '') {
        throw new UsageError('--server is the server origin, for example http://127.0.0.1:43117.', 2)
    }
    return url.origin
}

function parseTimeout(value) {
    if (!value || !/^[1-9]\d{0,4}$/.test(value) || Number(value) > 3600) {
        throw new UsageError(`Timeout must be a whole number of seconds from 1 to 3600, got ${value || '(missing)'}.`, 2)
    }
    return Number(value)
}

function parseJsonPath(value) {
    if (!value || value.includes('\0')) throw new UsageError('--json needs a file path.', 2)
    return value
}

function takeValue(argv, index, flag, allowSigned = false) {
    const inline = argv[index].indexOf('=')
    if (inline !== -1) return { value: argv[index].slice(inline + 1), next: index }
    const value = argv[index + 1]
    if (!value || (!allowSigned && value.startsWith('-'))) {
        throw new UsageError(`${flag} needs a value. Run cuttlely --help.`, commandFailureCode(argv))
    }
    return { value, next: index + 1 }
}

export function parseArgs(argv) {
    const opts = {
        command: null,
        help: false,
        version: false,
        port: DEFAULT_PORT,
        tag: VERSION,
        envFile: null,
        open: true,
        follow: false,
        flow: null,
        server: null,
        timeoutSeconds: null,
        jsonPath: null,
        failOnChanged: false,
        datasetId: null,
        evaluatorIds: [],
        threshold: null,
        gate: false,
        scored: false
    }
    const words = []
    const dockerFlags = []
    const checkFlags = []
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--help' || arg === '-h') opts.help = true
        else if (arg === '--version' || arg === '-V') opts.version = true
        else if (arg === '--no-open') {
            opts.open = false
            dockerFlags.push('--no-open')
        } else if (arg === '--follow' || arg === '-f') {
            opts.follow = true
            dockerFlags.push(arg === '-f' ? '-f' : '--follow')
        } else if (arg === '--port' || arg === '-p' || arg.startsWith('--port=')) {
            const taken = takeValue(argv, i, '--port')
            opts.port = parsePort(taken.value, commandFailureCode(argv))
            i = taken.next
            dockerFlags.push('--port')
        } else if (arg === '--tag' || arg.startsWith('--tag=')) {
            const taken = takeValue(argv, i, '--tag')
            opts.tag = parseTag(taken.value, commandFailureCode(argv))
            i = taken.next
            dockerFlags.push('--tag')
        } else if (arg === '--env-file' || arg.startsWith('--env-file=')) {
            const taken = takeValue(argv, i, '--env-file')
            opts.envFile = taken.value
            i = taken.next
            dockerFlags.push('--env-file')
        } else if (arg === '--flow' || arg.startsWith('--flow=')) {
            const taken = takeValue(argv, i, '--flow')
            opts.flow = taken.value
            i = taken.next
            checkFlags.push('--flow')
        } else if (arg === '--server' || arg.startsWith('--server=')) {
            const taken = takeValue(argv, i, '--server')
            opts.server = taken.value
            i = taken.next
            checkFlags.push('--server')
        } else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
            const taken = takeValue(argv, i, '--timeout')
            opts.timeoutSeconds = taken.value
            i = taken.next
            checkFlags.push('--timeout')
        } else if (arg === '--json' || arg.startsWith('--json=')) {
            const taken = takeValue(argv, i, '--json')
            opts.jsonPath = taken.value
            i = taken.next
            checkFlags.push('--json')
        } else if (arg === '--fail-on-changed') {
            opts.failOnChanged = true
            checkFlags.push('--fail-on-changed')
        } else if (arg === '--dataset' || arg.startsWith('--dataset=')) {
            const taken = takeValue(argv, i, '--dataset')
            opts.datasetId = taken.value
            i = taken.next
            checkFlags.push('--dataset')
        } else if (arg === '--evaluator' || arg.startsWith('--evaluator=')) {
            const taken = takeValue(argv, i, '--evaluator')
            opts.evaluatorIds.push(taken.value)
            i = taken.next
            checkFlags.push('--evaluator')
        } else if (arg === '--threshold' || arg.startsWith('--threshold=')) {
            const taken = takeValue(argv, i, '--threshold', true)
            opts.threshold = taken.value
            i = taken.next
            checkFlags.push('--threshold')
        } else if (arg === '--gate') {
            opts.gate = true
            checkFlags.push('--gate')
        } else if (arg.startsWith('-')) {
            throw new UsageError(`Unknown option ${arg}. Run cuttlely --help.`, commandFailureCode(argv))
        } else words.push(arg)
    }
    if (words.length > 1) throw new UsageError(`Unknown argument ${words[1]}. Run cuttlely --help.`, words[0] === 'check' ? 2 : 1)
    if (words.length === 1) {
        if (!['start', 'stop', 'status', 'logs', 'upgrade', 'help', 'check'].includes(words[0])) {
            throw new UsageError(`Unknown command ${words[0]}. Run cuttlely --help.`)
        }
        opts.command = words[0]
    }
    if (opts.command === 'check') {
        const checkExit = 2
        if (dockerFlags.length) {
            throw new UsageError(`${dockerFlags[0]} is not a check option. Run cuttlely check --help.`, checkExit)
        }
        if (!opts.help && !opts.version) {
            if (!opts.flow) throw new UsageError('check needs --flow <id>. Run cuttlely check --help.', checkExit)
            opts.flow = parseFlow(opts.flow)
            if (checkFlags.includes('--server')) {
                if (!opts.server)
                    throw new UsageError('--server needs an http or https URL, for example http://127.0.0.1:43117.', checkExit)
                opts.server = parseServer(opts.server)
            }
            if (checkFlags.includes('--timeout')) {
                if (!opts.timeoutSeconds)
                    throw new UsageError('Timeout must be a whole number of seconds from 1 to 3600, got (missing).', checkExit)
                opts.timeoutSeconds = parseTimeout(opts.timeoutSeconds)
            }
            // An empty --json= is still the flag. Skipping it would run the check and write nothing.
            if (checkFlags.includes('--json')) opts.jsonPath = parseJsonPath(opts.jsonPath)
            if (opts.gate && checkFlags.includes('--dataset')) {
                throw new UsageError('--gate uses the saved test set. Do not pass --dataset with it.', checkExit)
            }
            if (opts.gate && (checkFlags.includes('--evaluator') || checkFlags.includes('--threshold'))) {
                throw new UsageError(
                    '--gate uses the saved dataset, evaluators, and threshold. Do not pass --evaluator or --threshold with it.',
                    checkExit
                )
            }
            const scoredFlag = ['--dataset', '--evaluator', '--threshold', '--gate'].some((flag) => checkFlags.includes(flag))
            if (opts.failOnChanged && scoredFlag) {
                throw new UsageError('--fail-on-changed cannot be combined with --dataset, --evaluator, --threshold, or --gate.', checkExit)
            }
            if (checkFlags.includes('--dataset')) opts.datasetId = parseResourceId(opts.datasetId, '--dataset')
            if (checkFlags.includes('--evaluator')) {
                const seen = new Set()
                const unique = []
                for (const id of opts.evaluatorIds) {
                    const parsed = parseResourceId(id, '--evaluator')
                    if (seen.has(parsed)) continue
                    seen.add(parsed)
                    unique.push(parsed)
                }
                opts.evaluatorIds = unique
            }
            if (checkFlags.includes('--threshold')) opts.threshold = parseThreshold(opts.threshold)
            if (
                !opts.gate &&
                !checkFlags.includes('--dataset') &&
                (checkFlags.includes('--evaluator') || checkFlags.includes('--threshold'))
            ) {
                throw new UsageError('--evaluator and --threshold need --dataset.', checkExit)
            }
            opts.scored = Boolean(opts.gate || checkFlags.includes('--dataset'))
        }
    } else if (checkFlags.length) {
        throw new UsageError(`Unknown option ${checkFlags[0]}. Run cuttlely --help.`)
    }
    return opts
}

export function containerRunArgs({ image, port, envFile }) {
    const args = [
        'run',
        '-d',
        '--name',
        CONTAINER_NAME,
        '--restart',
        'unless-stopped',
        '--init',
        '--stop-timeout',
        '35',
        '-p',
        `${port}:${port}`,
        '-v',
        `${VOLUME_NAME}:${DATA_DIR}`,
        '-e',
        'HOST=0.0.0.0',
        '-e',
        `PORT=${port}`,
        '-e',
        'NODE_OPTIONS=--max-old-space-size=2048',
        '-e',
        `DATABASE_PATH=${DATA_DIR}/data`,
        '-e',
        `SECRETKEY_PATH=${DATA_DIR}/data`,
        '-e',
        `BLOB_STORAGE_PATH=${DATA_DIR}/storage`,
        '-e',
        `LOG_PATH=${DATA_DIR}/logs`,
        '-e',
        `CUTTLELY_DATA_DIR=${DATA_DIR}`,
        '-e',
        `CUTTLELY_HERMES_HOME=${DATA_DIR}/hermes`,
        '-e',
        `HERMES_HOME=${DATA_DIR}/hermes`,
        '-e',
        `CUTTLELY_ETL_DIR=${DATA_DIR}/etl`,
        '-e',
        'CUTTLELY_INSTALL=docker',
        '--health-cmd',
        `curl -fsS "http://127.0.0.1:${port}/api/v1/ping"`,
        '--health-interval',
        '15s',
        '--health-timeout',
        '5s',
        '--health-retries',
        '20',
        '--health-start-period',
        '300s'
    ]
    if (envFile) args.push('--env-file', envFile)
    args.push(image)
    return args
}

export function publicUrl(port) {
    return `http://localhost:${port}`
}

export function healthUrl(port) {
    return `http://127.0.0.1:${port}/api/v1/ping`
}

function dockerMissingMessage() {
    return [
        'Docker is not installed, or it is not on your PATH.',
        '',
        'Cuttlely runs in Docker. Install Docker, start it, and run this command again.',
        INSTALL_DOCS
    ].join('\n')
}

function dockerDownMessage(detail) {
    const lines = ['Docker is installed, but it is not running.', '', 'Start Docker and run this command again.', INSTALL_DOCS]
    if (detail && detail.trim()) lines.push('', detail.trim())
    return lines.join('\n')
}

function assertEnvFile(file) {
    if (!file) return
    let info
    try {
        info = statSync(file)
    } catch {
        throw new UsageError(`Env file not found: ${file}`)
    }
    if (!info.isFile()) throw new UsageError(`Env file is not a file: ${file}`)
}

async function ensureDocker(docker, err) {
    const result = await docker(['info', '--format', '{{.ServerVersion}}'])
    if (result.error && result.error.code === 'ENOENT') {
        err(dockerMissingMessage())
        return false
    }
    if (result.code !== 0 || result.error) {
        err(dockerDownMessage(result.stderr || result.error?.message || ''))
        return false
    }
    return true
}

async function inspectContainer(docker) {
    const result = await docker(['inspect', CONTAINER_NAME, '--format', INSPECT_FORMAT])
    if (result.code !== 0 || result.error) {
        const text = `${result.stderr || ''}\n${result.stdout || ''}`
        if (/No such object|no such container/i.test(text)) return null
        return { error: (result.stderr || result.error?.message || 'Could not inspect the Cuttlely container.').trim() }
    }
    const [status, image, imageId, ports = ''] = result.stdout.trim().split('|')
    const portMatch = /(\d+)\//.exec(ports)
    return { status, image, imageId, port: portMatch ? Number(portMatch[1]) : null }
}

async function readImageId(docker, image) {
    const result = await docker(['image', 'inspect', image, '--format', '{{.Id}}'])
    if (result.code !== 0 || result.error) return ''
    return result.stdout.trim()
}

async function waitForHealth({ url, fetchImpl, sleep, timeoutMs, now }) {
    const deadline = now() + timeoutMs
    for (;;) {
        try {
            const res = await fetchImpl(url, { redirect: 'manual' })
            const body = typeof res.text === 'function' ? await res.text() : String(res.body ?? '')
            if (res.ok && body.includes('pong')) return true
        } catch {
            // The server is still booting, or the port is not open yet.
        }
        if (now() >= deadline) return false
        await sleep(1000)
    }
}

async function reportReady(ctx) {
    const url = publicUrl(ctx.opts.port)
    const ping = healthUrl(ctx.opts.port)
    ctx.out(`Waiting for Cuttlely at ${ping}`)
    const ready = await waitForHealth({
        url: ping,
        fetchImpl: ctx.fetchImpl,
        sleep: ctx.sleep,
        timeoutMs: ctx.timeoutMs,
        now: ctx.now
    })
    if (!ready) {
        ctx.err(`Cuttlely is still starting. Open ${url} when it is ready.`)
        ctx.err('Logs: cuttlely logs')
        ctx.err(INSTALL_DOCS)
        return 1
    }
    ctx.out(`Cuttlely is ready. Open ${url}`)
    if (ctx.opts.open) ctx.open(url)
    return 0
}

async function removeContainer(docker) {
    await docker(['stop', '-t', '35', CONTAINER_NAME])
    return docker(['rm', CONTAINER_NAME])
}

async function launch(ctx, { restart }) {
    if (!(await ensureDocker(ctx.docker, ctx.err))) return 1
    assertEnvFile(ctx.opts.envFile)
    const image = `${IMAGE}:${ctx.opts.tag}`
    ctx.out(`Pulling ${image}`)
    const pulled = await ctx.docker(['pull', image], { stdio: 'inherit' })
    if (pulled.code !== 0 || pulled.error) {
        const detail = (pulled.stderr || pulled.error?.message || '').trim()
        ctx.err([`Could not pull ${image}.`, 'Check the tag, and see the install guide.', INSTALL_DOCS, detail].filter(Boolean).join('\n'))
        return 1
    }
    const imageId = await readImageId(ctx.docker, image)
    const current = await inspectContainer(ctx.docker)
    if (current && current.error) {
        ctx.err(current.error)
        return 1
    }
    const same = current && current.image === image && current.imageId === imageId && current.port === ctx.opts.port && !ctx.opts.envFile
    if (current && same && current.status === 'running' && !restart) {
        ctx.out('Cuttlely is already running.')
        return reportReady(ctx)
    }
    if (current && same && !restart) {
        const started = await ctx.docker(['start', CONTAINER_NAME])
        if (started.code !== 0 || started.error) {
            ctx.err((started.stderr || started.error?.message || 'Could not start the Cuttlely container.').trim())
            return 1
        }
        return reportReady(ctx)
    }
    if (current) {
        const removed = await removeContainer(ctx.docker)
        if (removed.code !== 0 || removed.error) {
            ctx.err((removed.stderr || removed.error?.message || 'Could not replace the Cuttlely container.').trim())
            return 1
        }
    }
    const run = await ctx.docker(containerRunArgs({ image, port: ctx.opts.port, envFile: ctx.opts.envFile }))
    if (run.code !== 0 || run.error) {
        const detail = (run.stderr || run.error?.message || 'Could not start Cuttlely.').trim()
        const hint = /port is already allocated|address already in use/i.test(detail)
            ? `Port ${ctx.opts.port} is in use. Stop what is using it, or run cuttlely start --port <port>.`
            : ''
        ctx.err([detail, hint].filter(Boolean).join('\n'))
        return 1
    }
    return reportReady(ctx)
}

async function stop(ctx) {
    if (!(await ensureDocker(ctx.docker, ctx.err))) return 1
    const current = await inspectContainer(ctx.docker)
    if (current && current.error) {
        ctx.err(current.error)
        return 1
    }
    if (!current || !['running', 'restarting', 'paused'].includes(current.status)) {
        ctx.out('Cuttlely is not running.')
        return 0
    }
    const result = await ctx.docker(['stop', '-t', '35', CONTAINER_NAME])
    if (result.code !== 0 || result.error) {
        ctx.err((result.stderr || result.error?.message || 'Could not stop Cuttlely.').trim())
        return 1
    }
    ctx.out('Stopped Cuttlely.')
    return 0
}

async function status(ctx) {
    if (!(await ensureDocker(ctx.docker, ctx.err))) return 1
    const current = await inspectContainer(ctx.docker)
    if (current && current.error) {
        ctx.err(current.error)
        return 1
    }
    if (!current) {
        ctx.out('Cuttlely is not running.')
        ctx.out('Start it with: cuttlely start')
        return 0
    }
    ctx.out(`name: ${CONTAINER_NAME}`)
    ctx.out(`status: ${current.status}`)
    ctx.out(`image: ${current.image}`)
    ctx.out(`volume: ${VOLUME_NAME}`)
    if (current.status === 'running' && current.port) ctx.out(`url: ${publicUrl(current.port)}`)
    return 0
}

async function logs(ctx) {
    if (!(await ensureDocker(ctx.docker, ctx.err))) return 1
    const current = await inspectContainer(ctx.docker)
    if (current && current.error) {
        ctx.err(current.error)
        return 1
    }
    if (!current) {
        ctx.err('No Cuttlely container yet. Start it with: cuttlely start')
        return 1
    }
    const args = ctx.opts.follow ? ['logs', '-f', CONTAINER_NAME] : ['logs', CONTAINER_NAME]
    const result = await ctx.docker(args, ctx.opts.follow ? { stdio: 'inherit' } : {})
    if (!ctx.opts.follow) {
        if (result.stdout) ctx.out(result.stdout.replace(/\s*$/, ''))
        if (result.stderr && result.stderr.trim()) ctx.err(result.stderr.replace(/\s*$/, ''))
    }
    return result.code === 0 && !result.error ? 0 : 1
}

function openBrowser(url) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open'
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
    try {
        const child = spawn(command, args, { stdio: 'ignore', detached: true })
        child.on('error', () => {})
        child.unref()
    } catch {
        // The URL is already printed.
    }
}

export async function main(argv, io = {}) {
    const out = io.out || ((line) => console.info(line))
    const err = io.err || ((line) => console.error(line))
    let opts
    try {
        opts = parseArgs(argv)
    } catch (error) {
        if (error instanceof UsageError) {
            err(error.message)
            return error.exitCode
        }
        throw error
    }
    if (opts.version) {
        out(VERSION)
        return 0
    }
    if (opts.help || !opts.command || opts.command === 'help') {
        out(helpText())
        return 0
    }
    const ctx = {
        opts,
        out,
        err,
        docker: io.docker || spawnDocker,
        env: io.env || process.env,
        fetch: io.fetch || globalThis.fetch.bind(globalThis),
        writeFile: io.writeFile,
        fetchImpl: io.fetch || globalThis.fetch.bind(globalThis),
        sleep: io.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        open: io.open || openBrowser,
        now: io.now || Date.now,
        timeoutMs: io.healthTimeoutMs ?? HEALTH_TIMEOUT_MS
    }
    try {
        if (opts.command === 'check') {
            return await runCheck(
                {
                    flow: opts.flow,
                    server: opts.server,
                    timeoutSeconds: opts.timeoutSeconds,
                    jsonPath: opts.jsonPath,
                    failOnChanged: opts.failOnChanged,
                    scored: opts.scored,
                    gate: opts.gate,
                    datasetId: opts.datasetId,
                    evaluatorIds: opts.evaluatorIds,
                    threshold: opts.threshold
                },
                ctx
            )
        }
        if (opts.command === 'start') return await launch(ctx, { restart: false })
        if (opts.command === 'upgrade') return await launch(ctx, { restart: true })
        if (opts.command === 'stop') return await stop(ctx)
        if (opts.command === 'status') return await status(ctx)
        if (opts.command === 'logs') return await logs(ctx)
    } catch (error) {
        if (error instanceof UsageError) {
            err(error.message)
            return error.exitCode
        }
        throw error
    }
    err(`Unknown command ${opts.command}. Run cuttlely --help.`)
    return 1
}
