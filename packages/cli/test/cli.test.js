import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_QUESTION_COUNT, DEFAULT_SERVER, DEFAULT_TIMEOUT_SECONDS, selectVerdict } from '../lib/check.js'
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

const REPO = join(ROOT, '..', '..')
const KEY = 'test-key'

function checkBody(overrides = {}) {
    return {
        id: 'check-1',
        status: 'done',
        stopReason: null,
        error: null,
        total: 1,
        completed: 1,
        draftChanged: false,
        liveEmpty: false,
        summary: { ran: 1, same: 1, changed: 0, errors: 0, liveTokens: 10, draftTokens: 11, liveMedianMs: 100, draftMedianMs: 90 },
        cases: [
            {
                question: 'What time do you open on Saturday?',
                live: { text: 'We open at 8 AM on Saturdays.', error: null, tokens: 10, ms: 100 },
                draft: { text: 'We open at 8 AM on Saturdays.', error: null, tokens: 11, ms: 90 },
                same: true
            }
        ],
        ...overrides
    }
}

function changedBody() {
    return checkBody({
        summary: { ran: 1, same: 0, changed: 1, errors: 0, liveTokens: 10, draftTokens: 12, liveMedianMs: 100, draftMedianMs: 80 },
        cases: [
            {
                question: 'What time do you open on Saturday?',
                live: { text: 'We open at 8 AM on Saturdays.', error: null, tokens: 10, ms: 100 },
                draft: { text: 'We open at 7 AM on Saturdays.', error: null, tokens: 12, ms: 80 },
                same: false
            }
        ]
    })
}

function httpResult(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return { status, ok: status >= 200 && status < 300, text: async () => text }
}

function scriptedFetch(steps) {
    const calls = []
    const fetch = async (url, init) => {
        calls.push({ url, init, body: init && init.body })
        const next = steps.shift()
        if (!next) throw new Error(`unexpected ${init && init.method} ${url}`)
        return typeof next === 'function' ? next(url, init) : next
    }
    return { fetch, calls }
}

function checkIo(extra = {}) {
    const io = capture()
    return { ...io, env: { CUTTLELY_API_KEY: KEY }, sleep: async () => {}, ...extra }
}

test('check help documents the command and the exit codes', async () => {
    const help = capture()
    assert.equal(await main(['check', '--help'], help), 0)
    assert.match(help.text(), /cuttlely check --flow <id>/)
    assert.match(help.text(), /CUTTLELY_API_KEY/)
    assert.match(help.text(), /--fail-on-changed/)
    assert.match(help.text(), /0 {2}The check finished/)
    assert.match(help.text(), /1 {2}--fail-on-changed was set/)
    assert.match(help.text(), /2 {2}The check timed out/)
    assert.equal(DEFAULT_SERVER, `http://127.0.0.1:${DEFAULT_PORT}`)
    assert.equal(parseArgs(['check', '--flow', 'flow-1']).server, null)
    assert.equal(parseArgs(['check', '--flow', 'flow-1']).timeoutSeconds, null)
    assert.equal(DEFAULT_TIMEOUT_SECONDS, 300)
    assert.equal(DEFAULT_QUESTION_COUNT, 4)
})

test('check exits 0 when the draft answers match, and writes the JSON result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cuttlely-check-'))
    const jsonPath = join(dir, 'check.json')
    const io = checkIo()
    const { fetch, calls } = scriptedFetch([httpResult(202, checkBody({ status: 'running', completed: 0 })), httpResult(200, checkBody())])
    const code = await main(['check', '--flow', 'flow-1', '--json', jsonPath, '--fail-on-changed'], { ...io, fetch })
    assert.equal(code, 0)
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].url, `${DEFAULT_SERVER}/api/v1/flow-drafts/flow-1/check`)
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`)
    assert.equal(calls[0].init.redirect, 'manual')
    assert.deepEqual(JSON.parse(calls[0].body), { count: 4 })
    assert.equal(calls[1].init.method, 'GET')
    assert.equal(calls[1].url, `${DEFAULT_SERVER}/api/v1/flow-drafts/flow-1/check/check-1`)
    assert.match(io.text(), /Questions: 1 ran, 1 same, 0 changed, 0 errors/)
    assert.doesNotMatch(`${io.text()}\n${io.errors()}`, /test-key/)
    const saved = JSON.parse(readFileSync(jsonPath, 'utf8'))
    assert.equal(saved.id, 'check-1')
    assert.equal(saved.status, 'done')
    assert.equal(saved.summary.changed, 0)
})

test('check exits 0 without --fail-on-changed when an answer changed, and 1 with it', async () => {
    const report = checkIo()
    const open = scriptedFetch([httpResult(202, changedBody())])
    assert.equal(await main(['check', '--flow', 'flow-1', '--server', 'http://127.0.0.1:3000'], { ...report, fetch: open.fetch }), 0)
    assert.match(report.text(), /1 changed/)
    assert.match(report.text(), /Live: We open at 8 AM on Saturdays\./)
    assert.match(report.text(), /Draft: We open at 7 AM on Saturdays\./)
    assert.equal(report.errors(), '')
    assert.equal(open.calls[0].url, 'http://127.0.0.1:3000/api/v1/flow-drafts/flow-1/check')

    const gate = checkIo()
    const files = new Map()
    const gated = scriptedFetch([httpResult(202, changedBody())])
    const code = await main(['check', '--flow', 'flow-1', '--fail-on-changed', '--json', 'check.json'], {
        ...gate,
        fetch: gated.fetch,
        writeFile: (file, text) => files.set(file, text)
    })
    assert.equal(code, 1)
    assert.match(gate.errors(), /1 answer changed\./)
    assert.equal(JSON.parse(files.get('check.json')).summary.changed, 1)
    assert.deepEqual(selectVerdict(changedBody(), { failOnChanged: true }), { code: 1, label: 'changed' })
    assert.deepEqual(selectVerdict(changedBody(), { failOnChanged: false }), { code: 0, label: 'pass' })
})

test('check exits 2 on timeout and asks the server to stop', async () => {
    const io = checkIo()
    let clock = 0
    const running = checkBody({ status: 'running', completed: 0, summary: null, cases: [] })
    const { fetch, calls } = scriptedFetch([httpResult(202, running), httpResult(200, running), httpResult(200, running)])
    const code = await main(['check', '--flow', 'flow-1', '--timeout', '2', '--json', 'partial.json'], {
        ...io,
        fetch,
        now: () => clock,
        sleep: async () => {
            clock += 1000
        },
        writeFile: (file, text) => io.out(`wrote ${file} ${text.length}`)
    })
    assert.equal(code, 2)
    assert.match(io.errors(), /Timed out after 2s waiting for check check-1/)
    assert.deepEqual(
        calls.map((call) => call.init.method),
        ['POST', 'GET', 'DELETE']
    )
    assert.match(io.text(), /wrote partial.json/)
})

test('check exits 2 when the API key is missing and does not call the server', async () => {
    const io = capture()
    const { fetch, calls } = scriptedFetch([])
    assert.equal(await main(['check', '--flow', 'flow-1'], { ...io, env: {}, fetch }), 2)
    assert.match(io.errors(), /CUTTLELY_API_KEY is not set/)
    assert.equal(calls.length, 0)
    const blank = capture()
    assert.equal(await main(['check', '--flow', 'flow-1'], { ...blank, env: { CUTTLELY_API_KEY: '   ' }, fetch }), 2)
    assert.equal(calls.length, 0)
})

test('check exits 2 on a server error, a missing draft, and a failed check', async () => {
    const missing = checkIo()
    const noDraft = scriptedFetch([
        httpResult(409, { statusCode: 409, success: false, message: 'There are no unpublished changes to check.' })
    ])
    assert.equal(await main(['check', '--flow', 'flow-1'], { ...missing, fetch: noDraft.fetch }), 2)
    assert.match(missing.errors(), /No draft to check/)
    assert.equal(noDraft.calls.length, 1)

    const broken = checkIo()
    const failure = scriptedFetch([httpResult(500, { message: 'Database unreachable' })])
    assert.equal(await main(['check', '--flow', 'flow-1'], { ...broken, fetch: failure.fetch }), 2)
    assert.match(broken.errors(), /Check failed \(500\): Database unreachable/)

    const refused = checkIo()
    const down = scriptedFetch([() => Promise.reject(new Error('connect ECONNREFUSED'))])
    assert.equal(await main(['check', '--flow', 'flow-1'], { ...refused, fetch: down.fetch }), 2)
    assert.match(refused.errors(), /ECONNREFUSED/)

    const failed = checkIo()
    const done = scriptedFetch([httpResult(202, checkBody({ status: 'failed', error: 'The check could not run.' }))])
    assert.equal(await main(['check', '--flow', 'flow-1', '--fail-on-changed'], { ...failed, fetch: done.fetch }), 2)
    assert.match(failed.errors(), /The check failed\. The check could not run\./)

    const stale = checkIo()
    const moved = scriptedFetch([httpResult(202, checkBody({ draftChanged: true }))])
    assert.equal(await main(['check', '--flow', 'flow-1', '--fail-on-changed'], { ...stale, fetch: moved.fetch }), 2)
    assert.match(stale.errors(), /draft changed while the check was running/)

    const echoed = checkIo()
    const leak = scriptedFetch([httpResult(401, { error: `Unauthorized ${KEY}` })])
    assert.equal(await main(['check', '--flow', 'flow-1'], { ...echoed, fetch: leak.fetch }), 2)
    assert.match(echoed.errors(), /\[redacted\]/)
    assert.doesNotMatch(echoed.errors(), /test-key/)
})

test('check usage failures exit 2 and other commands reject check flags', async () => {
    const missingFlow = capture()
    assert.equal(await main(['check'], missingFlow), 2)
    assert.match(missingFlow.errors(), /check needs --flow/)

    const badFlow = capture()
    assert.equal(await main(['check', '--flow', '../etc'], badFlow), 2)
    assert.match(badFlow.errors(), /--flow needs the flow id/)

    const badServer = capture()
    assert.equal(await main(['check', '--flow', 'flow-1', '--server', 'file:///tmp'], badServer), 2)
    assert.match(badServer.errors(), /http or https/)

    const keyed = capture()
    assert.equal(await main(['check', '--flow', 'flow-1', '--server', 'http://user:secret@127.0.0.1:43117'], keyed), 2)
    assert.match(keyed.errors(), /CUTTLELY_API_KEY/)

    const start = capture()
    assert.equal(await main(['start', '--flow', 'flow-1'], start), 1)
    assert.match(start.errors(), /Unknown option --flow/)

    const port = capture()
    assert.equal(await main(['check', '--flow', 'flow-1', '--port', '8080'], port), 2)
    assert.match(port.errors(), /--port is not a check option/)
})

test('check talks to a local server', async () => {
    const seen = []
    const server = createServer((req, res) => {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
            seen.push({
                method: req.method,
                url: req.url,
                authorization: req.headers.authorization,
                body: Buffer.concat(chunks).toString('utf8')
            })
            const body = req.method === 'POST' ? checkBody({ status: 'running', completed: 0 }) : checkBody()
            res.writeHead(req.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(body))
        })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
        const { port } = server.address()
        const io = checkIo({ sleep: async () => {} })
        const code = await main(
            ['check', '--flow', 'flow-1', '--server', `http://127.0.0.1:${port}`, '--fail-on-changed', '--timeout', '30'],
            io
        )
        assert.equal(code, 0)
        assert.equal(seen[0].method, 'POST')
        assert.equal(seen[0].url, '/api/v1/flow-drafts/flow-1/check')
        assert.equal(seen[0].authorization, `Bearer ${KEY}`)
        assert.deepEqual(JSON.parse(seen[0].body), { count: 4 })
        assert.equal(seen[1].method, 'GET')
        assert.match(io.text(), /0 changed/)
        assert.doesNotMatch(`${io.text()}\n${io.errors()}`, /test-key/)
    } finally {
        await new Promise((resolve) => server.close(resolve))
    }
})

// Enough of YAML to parse the example workflow: maps, lists, and literal blocks.
// The CLI package cannot import a YAML library from outside itself.
function parseYaml(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n')
    if (lines.some((line) => line.includes('\t'))) throw new Error('YAML tabs are not allowed')
    let i = 0
    const indentOf = (line) => line.match(/^ */)[0].length
    const unquote = (value) => {
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1)
        if (value.startsWith('{') || value.startsWith('[')) throw new Error('flow collections are not supported')
        return value
    }
    const readLiteral = (parentIndent) => {
        const collected = []
        let contentIndent = null
        while (i < lines.length) {
            const line = lines[i]
            if (line.trim() === '') {
                collected.push('')
                i += 1
                continue
            }
            const indent = indentOf(line)
            if (contentIndent === null) {
                if (indent <= parentIndent) break
                contentIndent = indent
            }
            if (indent < contentIndent) break
            collected.push(line.slice(contentIndent))
            i += 1
        }
        while (collected.length && collected[collected.length - 1] === '') collected.pop()
        return collected.join('\n')
    }
    const parseBlock = (parentIndent) => {
        let level = null
        let mode = null
        const map = {}
        const seq = []
        while (i < lines.length) {
            while (i < lines.length && (lines[i].trim() === '' || /^\s*#/.test(lines[i]))) i += 1
            if (i >= lines.length) break
            const indent = indentOf(lines[i])
            if (indent <= parentIndent) break
            if (level === null) level = indent
            if (indent < level) break
            if (indent > level) throw new Error(`line ${i + 1}: unexpected indent`)
            const trimmed = lines[i].slice(indent)
            if (trimmed.startsWith('- ')) {
                if (mode === 'map') throw new Error(`line ${i + 1}: mixed list and map`)
                mode = 'seq'
                const rest = trimmed.slice(2).trim()
                i += 1
                if (!rest) {
                    seq.push(parseBlock(level))
                    continue
                }
                const colon = rest.indexOf(':')
                if (colon === -1) {
                    seq.push(unquote(rest))
                    continue
                }
                const key = rest.slice(0, colon).trim()
                const value = rest.slice(colon + 1).trim()
                const item = {}
                if (value === '|' || value === '|-' || value === '|+') item[key] = readLiteral(level)
                else if (value === '') item[key] = parseBlock(level)
                else item[key] = unquote(value)
                const more = parseBlock(level)
                if (more && typeof more === 'object' && !Array.isArray(more)) Object.assign(item, more)
                seq.push(item)
                continue
            }
            if (mode === 'seq') break
            mode = 'map'
            const colon = trimmed.indexOf(':')
            if (colon <= 0) throw new Error(`line ${i + 1}: expected a key`)
            const key = trimmed.slice(0, colon).trim()
            const value = trimmed.slice(colon + 1).trim()
            i += 1
            if (value === '|' || value === '|-' || value === '|+') map[key] = readLiteral(level)
            else if (value === '') map[key] = parseBlock(level)
            else map[key] = unquote(value)
        }
        if (mode === 'seq') return seq
        return map
    }
    return parseBlock(-1)
}

test('the example workflow is valid YAML and runs cuttlely check', () => {
    const file = join(REPO, 'examples', 'ci', 'cuttlely-check.yml')
    const text = readFileSync(file, 'utf8')
    const doc = parseYaml(text)
    assert.equal(doc.name, 'Cuttlely draft check')
    assert.deepEqual(doc.on, { pull_request: {} })
    const step = doc.jobs.check.steps[0]
    assert.equal(step.name, 'Check the draft')
    assert.match(step.run, /npx --yes cuttlely check/)
    assert.match(step.run, /--fail-on-changed/)
    assert.match(step.run, /--json check\.json/)
    assert.equal(step.env.CUTTLELY_API_KEY, '${{ secrets.CUTTLELY_API_KEY }}')
    assert.doesNotMatch(text, /sk-|ghp_|Bearer [A-Za-z0-9]/)
    assert.throws(() => parseYaml('jobs: [\n'), /flow collections/)
    assert.throws(() => parseYaml('not a mapping\n'), /expected a key/)
    const guide = readFileSync(join(REPO, 'docs', 'how-to', 'ci-gate.md'), 'utf8')
    assert.match(guide, /examples\/ci\/cuttlely-check\.yml/)
    assert.match(guide, /Exit codes/)
    const index = readFileSync(join(REPO, 'docs', 'README.md'), 'utf8')
    assert.match(index, /how-to\/ci-gate\.md/)
    const api = readFileSync(join(REPO, 'docs', 'reference', 'drafts-api.md'), 'utf8')
    assert.match(api, /how-to\/ci-gate\.md/)
})
