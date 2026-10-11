import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    CONTAINER_NAME,
    DATA_DIR,
    DEFAULT_PORT,
    IMAGE,
    INSTALL_DOCS,
    UsageError,
    VERSION,
    VOLUME_NAME,
    containerRunArgs,
    main,
    parseArgs,
    publicUrl
} from '../lib/cli.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function capture() {
    const out = []
    const err = []
    return {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        text: () => out.join('\n'),
        errors: () => err.join('\n')
    }
}

function scriptedDocker(steps) {
    const calls = []
    const docker = async (args, opts = {}) => {
        calls.push({ args, opts })
        const next = steps.shift()
        if (!next) throw new Error(`unexpected docker ${args.join(' ')}`)
        return typeof next === 'function' ? next(args, opts) : next
    }
    return { docker, calls }
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', error: null })
const missing = () => ({
    code: 127,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
})
const down = () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon', error: null })
const absent = () => ({ code: 1, stdout: '', stderr: 'Error: No such object: cuttlely', error: null })

function inspectLine({ status = 'running', image = `${IMAGE}:${VERSION}`, imageId = 'sha256:abc', port = DEFAULT_PORT } = {}) {
    return ok(`${status}|${image}|${imageId}|${port}/tcp `)
}

function readyFetch(urls) {
    return async (url, init) => {
        urls.push({ url, init })
        return { ok: true, text: async () => 'pong' }
    }
}

test('package metadata is publishable and has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'cuttlely')
    // pnpm release bumps this with the product version, so the test reads it instead of pinning one.
    assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
    assert.equal(pkg.license, 'Apache-2.0')
    assert.equal(pkg.homepage, 'https://cuttlely.com')
    assert.equal(pkg.private, undefined)
    assert.equal(pkg.publishConfig.access, 'public')
    assert.equal(pkg.engines.node, '>=20')
    assert.equal(pkg.bin.cuttlely, 'bin/cuttlely.js')
    assert.equal(pkg.repository.directory, 'packages/cli')
    assert.deepEqual(pkg.files, ['bin', 'lib', 'README.md', 'LICENSE'])
    assert.equal(pkg.dependencies, undefined)
    assert.equal(VERSION, pkg.version)
})

test('the launcher imports only Node and makes no telemetry call', () => {
    const files = ['bin/cuttlely.js', ...readdirSync(join(ROOT, 'lib')).map((name) => `lib/${name}`)]
    for (const file of files) {
        const text = readFileSync(join(ROOT, file), 'utf8')
        for (const line of text.split('\n')) {
            const imported = line.match(/from ['"]([^'"]+)['"]/)
            if (imported) assert.ok(imported[1].startsWith('node:') || imported[1].startsWith('.'), `${file}: ${line}`)
        }
        assert.doesNotMatch(text, /telemetry|analytics|sentry|posthog|googletagmanager/i)
        const urls = text.match(/https?:\/\/[^\s"'`]+/g) || []
        for (const url of urls) {
            assert.ok(
                url.startsWith(INSTALL_DOCS) || url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:'),
                `${file} has ${url}`
            )
        }
    }
})

test('the default image tag is this package version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    assert.equal(VERSION, pkg.version)
    assert.equal(parseArgs(['start']).tag, pkg.version)
    assert.equal(parseArgs(['upgrade']).tag, pkg.version)
    assert.equal(`${IMAGE}:${parseArgs(['start']).tag}`, `${IMAGE}:${pkg.version}`)
})

test('--help and --version', async () => {
    const help = capture()
    assert.equal(await main(['--help'], help), 0)
    assert.match(help.text(), /cuttlely start/)
    assert.match(help.text(), /cuttlely stop/)
    assert.match(help.text(), /cuttlely status/)
    assert.match(help.text(), /cuttlely logs/)
    assert.match(help.text(), /cuttlely upgrade/)
    assert.match(help.text(), new RegExp(IMAGE))
    assert.match(help.text(), new RegExp(INSTALL_DOCS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const version = capture()
    assert.equal(await main(['--version'], version), 0)
    assert.equal(version.text(), JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version)

    const none = capture()
    assert.equal(await main([], none), 0)
    assert.match(none.text(), /Usage:/)
})

test('unknown command and a bad port fail before Docker', async () => {
    const unknown = capture()
    const docker = scriptedDocker([])
    assert.equal(await main(['fly'], { ...unknown, docker: docker.docker }), 1)
    assert.match(unknown.errors(), /Unknown command fly/)
    assert.equal(docker.calls.length, 0)

    const port = capture()
    assert.equal(await main(['start', '--port', '0'], port), 1)
    assert.match(port.errors(), /Port must be a number/)
    assert.equal(parseArgs(['start', '--tag', 'latest']).tag, 'latest')
    assert.throws(() => parseArgs(['start', '--tag', 'ghcr.io/other/cuttlely']), UsageError)
})

test('a missing Docker install points at the install guide', async () => {
    const io = capture()
    const { docker, calls } = scriptedDocker([missing()])
    assert.equal(await main(['start'], { ...io, docker }), 1)
    assert.match(io.errors(), /Docker is not installed/)
    assert.match(io.errors(), new RegExp(INSTALL_DOCS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, ['info', '--format', '{{.ServerVersion}}'])
})

test('Docker installed but not running points at the install guide', async () => {
    const io = capture()
    const { docker } = scriptedDocker([down()])
    assert.equal(await main(['status'], { ...io, docker }), 1)
    assert.match(io.errors(), /Docker is installed, but it is not running/)
    assert.match(io.errors(), /Cannot connect to the Docker daemon/)
    assert.match(io.errors(), /docs\/how-to\/docker\.md/)
})

test('start pulls the version tag, publishes the README port, and opens the browser', async () => {
    const io = capture()
    const opened = []
    const fetched = []
    const { docker, calls } = scriptedDocker([ok('26.0.0\n'), ok(''), ok('sha256:abc\n'), absent(), ok('container-id\n')])
    const code = await main(['start'], {
        ...io,
        docker,
        fetch: readyFetch(fetched),
        open: (url) => opened.push(url),
        sleep: async () => {}
    })
    assert.equal(code, 0)
    assert.deepEqual(
        calls.map((call) => call.args[0]),
        ['info', 'pull', 'image', 'inspect', 'run']
    )
    assert.deepEqual(calls[1].args, ['pull', `${IMAGE}:${VERSION}`])
    assert.equal(calls[1].opts.stdio, 'inherit')
    assert.deepEqual(calls[4].args, containerRunArgs({ image: `${IMAGE}:${VERSION}`, port: DEFAULT_PORT, envFile: null }))
    assert.equal(calls[4].args.at(-1), `${IMAGE}:${VERSION}`)
    assert.ok(calls[4].args.includes(`${VOLUME_NAME}:${DATA_DIR}`))
    assert.ok(calls[4].args.includes(`${DEFAULT_PORT}:${DEFAULT_PORT}`))
    assert.ok(calls[4].args.includes('CUTTLELY_INSTALL=docker'))
    assert.deepEqual(fetched, [{ url: `http://127.0.0.1:${DEFAULT_PORT}/api/v1/ping`, init: { redirect: 'manual' } }])
    assert.deepEqual(opened, [publicUrl(DEFAULT_PORT)])
    assert.match(io.text(), /Cuttlely is ready\. Open http:\/\/localhost:43117/)
})

test('start honors --tag, --port, --env-file and --no-open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cuttlely-cli-'))
    const envFile = join(dir, 'cuttlely.env')
    writeFileSync(envFile, 'CUTTLELY_ANALYST=auto\n')
    const io = capture()
    const opened = []
    const { docker, calls } = scriptedDocker([ok('26\n'), ok(''), ok('sha256:def\n'), absent(), ok('')])
    const code = await main(['start', '--tag', '9.9.9', '--port', '8080', '--env-file', envFile, '--no-open'], {
        ...io,
        docker,
        fetch: readyFetch([]),
        open: (url) => opened.push(url),
        sleep: async () => {}
    })
    assert.equal(code, 0)
    assert.equal(opened.length, 0)
    const run = calls.find((call) => call.args[0] === 'run').args
    assert.equal(run.at(-3), '--env-file')
    assert.equal(run.at(-2), envFile)
    assert.equal(run.at(-1), `${IMAGE}:9.9.9`)
    assert.ok(run.includes(envFile))
    assert.ok(run.includes('8080:8080'))
    assert.ok(run.includes('PORT=8080'))
    assert.match(io.text(), /Open http:\/\/localhost:8080/)
})

test('start leaves a matching running container in place', async () => {
    const io = capture()
    const { docker, calls } = scriptedDocker([ok('26\n'), ok(''), ok('sha256:abc\n'), inspectLine()])
    const code = await main(['start', '--no-open'], { ...io, docker, fetch: readyFetch([]), sleep: async () => {} })
    assert.equal(code, 0)
    assert.equal(
        calls.some((call) => call.args[0] === 'run'),
        false
    )
    assert.match(io.text(), /already running/)
})

test('start replaces a container when the pulled image id changed', async () => {
    const io = capture()
    const { docker, calls } = scriptedDocker([
        ok('26\n'),
        ok(''),
        ok('sha256:new\n'),
        inspectLine({ imageId: 'sha256:old' }),
        ok(''),
        ok(''),
        ok('')
    ])
    assert.equal(await main(['start', '--no-open'], { ...io, docker, fetch: readyFetch([]), sleep: async () => {} }), 0)
    assert.deepEqual(
        calls.map((call) => call.args[0]),
        ['info', 'pull', 'image', 'inspect', 'stop', 'rm', 'run']
    )
    assert.deepEqual(calls[4].args, ['stop', '-t', '35', CONTAINER_NAME])
})

test('a missing env file fails before Docker pulls', async () => {
    const io = capture()
    const { docker, calls } = scriptedDocker([ok('26\n')])
    assert.equal(await main(['start', '--env-file', '/no/such/cuttlely.env'], { ...io, docker }), 1)
    assert.match(io.errors(), /Env file not found/)
    assert.equal(calls.length, 1)
})

test('stop, status and logs', async () => {
    const stopped = capture()
    const stopDocker = scriptedDocker([ok('26\n'), inspectLine(), ok('')])
    assert.equal(await main(['stop'], { ...stopped, docker: stopDocker.docker }), 0)
    assert.deepEqual(stopDocker.calls[2].args, ['stop', '-t', '35', CONTAINER_NAME])
    assert.match(stopped.text(), /Stopped Cuttlely/)

    const idle = capture()
    const idleDocker = scriptedDocker([ok('26\n'), absent()])
    assert.equal(await main(['stop'], { ...idle, docker: idleDocker.docker }), 0)
    assert.match(idle.text(), /not running/)

    const state = capture()
    const statusDocker = scriptedDocker([ok('26\n'), inspectLine({ port: 8080 })])
    assert.equal(await main(['status'], { ...state, docker: statusDocker.docker }), 0)
    assert.match(state.text(), /status: running/)
    assert.match(state.text(), /url: http:\/\/localhost:8080/)
    assert.match(state.text(), new RegExp(VOLUME_NAME))

    const logged = capture()
    const logsDocker = scriptedDocker([ok('26\n'), inspectLine(), ok('boot line\n')])
    assert.equal(await main(['logs'], { ...logged, docker: logsDocker.docker }), 0)
    assert.deepEqual(logsDocker.calls[2].args, ['logs', CONTAINER_NAME])
    assert.match(logged.text(), /boot line/)

    const follow = capture()
    const followDocker = scriptedDocker([ok('26\n'), inspectLine(), ok('')])
    assert.equal(await main(['logs', '--follow'], { ...follow, docker: followDocker.docker }), 0)
    assert.deepEqual(followDocker.calls[2].args, ['logs', '-f', CONTAINER_NAME])
    assert.equal(followDocker.calls[2].opts.stdio, 'inherit')
})

test('upgrade pulls and restarts even when the same image is running', async () => {
    const io = capture()
    const { docker, calls } = scriptedDocker([ok('26\n'), ok(''), ok('sha256:abc\n'), inspectLine(), ok(''), ok(''), ok('')])
    assert.equal(await main(['upgrade', '--no-open'], { ...io, docker, fetch: readyFetch([]), sleep: async () => {} }), 0)
    assert.deepEqual(
        calls.map((call) => call.args[0]),
        ['info', 'pull', 'image', 'inspect', 'stop', 'rm', 'run']
    )
    assert.match(io.text(), /Cuttlely is ready/)
})

test('health waits through a starting response, then times out', async () => {
    const io = capture()
    let tries = 0
    const { docker } = scriptedDocker([ok('26\n'), ok(''), ok('sha256:abc\n'), absent(), ok('')])
    let clock = 0
    const code = await main(['start', '--no-open'], {
        ...io,
        docker,
        healthTimeoutMs: 1500,
        now: () => clock,
        sleep: async () => {
            clock += 1000
        },
        fetch: async () => {
            tries += 1
            return { ok: false, text: async () => '{"status":"starting"}' }
        }
    })
    assert.equal(code, 1)
    assert.ok(tries >= 2)
    assert.match(io.errors(), /still starting/)
    assert.match(io.errors(), /cuttlely logs/)
})

test('a taken port is reported without opening the browser', async () => {
    const io = capture()
    const opened = []
    const { docker } = scriptedDocker([
        ok('26\n'),
        ok(''),
        ok('sha256:abc\n'),
        absent(),
        { code: 1, stdout: '', stderr: 'Bind for 0.0.0.0:43117 failed: port is already allocated\n', error: null }
    ])
    assert.equal(await main(['start'], { ...io, docker, open: (url) => opened.push(url) }), 1)
    assert.match(io.errors(), /Port 43117 is in use/)
    assert.equal(opened.length, 0)
})
