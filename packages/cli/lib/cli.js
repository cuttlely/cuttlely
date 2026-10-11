// The full server needs the Python agent runtime, which ships in the Docker image.
// This package only talks to the local Docker daemon.
import { readFileSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

export class UsageError extends Error {}

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
        '',
        `Install guide: ${INSTALL_DOCS}`
    ].join('\n')
}

function parsePort(value) {
    if (!value || !/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) {
        throw new UsageError(`Port must be a number from 1 to 65535, got ${value || '(missing)'}.`)
    }
    return Number(value)
}

function parseTag(value) {
    if (!value || !TAG_RE.test(value)) {
        throw new UsageError(`Not a valid image tag: ${value || '(missing)'}. Example: 1.0.0 or latest.`)
    }
    return value
}

function takeValue(argv, index, flag) {
    const inline = argv[index].indexOf('=')
    if (inline !== -1) return { value: argv[index].slice(inline + 1), next: index }
    const value = argv[index + 1]
    if (!value || value.startsWith('-')) throw new UsageError(`${flag} needs a value. Run cuttlely --help.`)
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
        follow: false
    }
    const words = []
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '--help' || arg === '-h') opts.help = true
        else if (arg === '--version' || arg === '-V') opts.version = true
        else if (arg === '--no-open') opts.open = false
        else if (arg === '--follow' || arg === '-f') opts.follow = true
        else if (arg === '--port' || arg === '-p' || arg.startsWith('--port=')) {
            const taken = takeValue(argv, i, '--port')
            opts.port = parsePort(taken.value)
            i = taken.next
        } else if (arg === '--tag' || arg.startsWith('--tag=')) {
            const taken = takeValue(argv, i, '--tag')
            opts.tag = parseTag(taken.value)
            i = taken.next
        } else if (arg === '--env-file' || arg.startsWith('--env-file=')) {
            const taken = takeValue(argv, i, '--env-file')
            opts.envFile = taken.value
            i = taken.next
        } else if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}. Run cuttlely --help.`)
        else words.push(arg)
    }
    if (words.length > 1) throw new UsageError(`Unknown argument ${words[1]}. Run cuttlely --help.`)
    if (words.length === 1) {
        if (!['start', 'stop', 'status', 'logs', 'upgrade', 'help'].includes(words[0])) {
            throw new UsageError(`Unknown command ${words[0]}. Run cuttlely --help.`)
        }
        opts.command = words[0]
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
            return 1
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
        fetchImpl: io.fetch || globalThis.fetch.bind(globalThis),
        sleep: io.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        open: io.open || openBrowser,
        now: io.now || Date.now,
        timeoutMs: io.healthTimeoutMs ?? HEALTH_TIMEOUT_MS
    }
    try {
        if (opts.command === 'start') return await launch(ctx, { restart: false })
        if (opts.command === 'upgrade') return await launch(ctx, { restart: true })
        if (opts.command === 'stop') return await stop(ctx)
        if (opts.command === 'status') return await status(ctx)
        if (opts.command === 'logs') return await logs(ctx)
    } catch (error) {
        if (error instanceof UsageError) {
            err(error.message)
            return 1
        }
        throw error
    }
    err(`Unknown command ${opts.command}. Run cuttlely --help.`)
    return 1
}
