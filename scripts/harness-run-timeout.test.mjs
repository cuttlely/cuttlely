// The agent wait can be raised or disabled without disabling cancellation or the turn budget.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { spawn } from 'node:child_process'
import yaml from 'js-yaml'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-run-timeout-'))
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'hermes')
const portProbe = net.createServer()
await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve))
process.env.CUTTLELY_HARNESS_GATEWAY_PORT = String(portProbe.address().port)
await new Promise((resolve) => portProbe.close(resolve))
delete process.env.HERMES_API_URL
const { agentRunTimeoutMs } = await import('../packages/harness/budget.mjs')
const { createRun, waitForRun } = await import('../packages/harness/client.mjs')
const { compileProfileCached, profileEnvPath, profileOutdated, recompileOutdatedProfiles } = await import('../packages/harness/profile.mjs')
const { profileDir } = await import('../packages/harness/paths.mjs')
const { repoRoot } = await import('../packages/harness/paths.mjs')
const { runHarness } = await import('../packages/harness/run.mjs')
const { saveHarness } = await import('../packages/harness/store.mjs')
const { flowiseNodeOptions } = await import('../packages/harness/credential-store.mjs')
const { stopGateway } = await import('../packages/harness/gateway.mjs')

const harnessName = 'bakery-timeout--baker'
fs.mkdirSync(path.dirname(profileEnvPath(harnessName)), { recursive: true })
fs.writeFileSync(profileEnvPath(harnessName), 'API_SERVER_KEY=test-key\n')
after(async () => {
    await stopGateway()
    fs.rmSync(dataDir, { recursive: true, force: true })
})

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const abortError = () => new DOMException('The request was aborted.', 'AbortError')
const outcome = (promise) =>
    promise.then(
        (value) => ({ value }),
        (error) => ({ error })
    )
const clock = (t) => t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
}

test('agent run timeout keeps four minutes by default and accepts five minutes or unlimited', () => {
    assert.equal(agentRunTimeoutMs({}), 240000)
    assert.equal(agentRunTimeoutMs({ CUTTLELY_HARNESS_RUN_TIMEOUT_MS: '' }), 240000)
    assert.equal(agentRunTimeoutMs({ CUTTLELY_HARNESS_RUN_TIMEOUT_MS: '300000' }), 300000)
    assert.equal(agentRunTimeoutMs({ CUTTLELY_HARNESS_RUN_TIMEOUT_MS: '0' }), 0)
    assert.equal(agentRunTimeoutMs({ CUTTLELY_HARNESS_RUN_TIMEOUT_MS: '3600000' }), 3600000)
    for (const value of ['later', '-1', '1.5', 'Infinity', 'NaN', '3600001', '9007199254740992']) {
        assert.equal(agentRunTimeoutMs({ CUTTLELY_HARNESS_RUN_TIMEOUT_MS: value }), 240000, value)
    }
})

test('unlimited run creation waits for a response instead of aborting on a zero timer', async (t) => {
    clock(t)
    let requestSignal
    let respond
    const pending = createRun({
        harnessName,
        body: { input: 'Bake bread.' },
        timeoutMs: 0,
        fetchImpl: async (_url, { signal }) => {
            requestSignal = signal
            return new Promise((resolve, reject) => {
                respond = resolve
                signal.addEventListener('abort', () => reject(abortError()), { once: true })
            })
        }
    })
    t.mock.timers.tick(300000)
    await settle()
    assert.equal(requestSignal.aborted, false)
    respond(json({ run_id: 'one', status: 'started' }))
    assert.equal((await pending).run_id, 'one')
})

test('unlimited run creation still honors caller cancellation', async () => {
    const controller = new AbortController()
    const pending = outcome(
        createRun({
            harnessName,
            body: { input: 'Bake bread.' },
            timeoutMs: 0,
            signal: controller.signal,
            fetchImpl: async (_url, { signal }) =>
                new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))
        })
    )
    controller.abort()
    assert.equal((await pending).error?.name, 'AbortError')
})

function stalledPostBody() {
    let requestSignal
    let bodyController
    let reading
    const ready = new Promise((resolve) => (reading = resolve))
    return {
        ready,
        get signal() {
            return requestSignal
        },
        close() {
            if (!requestSignal?.aborted) bodyController.close()
        },
        fetch: async (_url, { signal }) => {
            requestSignal = signal
            return new Response(
                new ReadableStream({
                    start(controller) {
                        bodyController = controller
                        signal.addEventListener('abort', () => controller.error(abortError()), { once: true })
                    },
                    pull() {
                        reading()
                    }
                })
            )
        }
    }
}

test('run creation keeps its finite deadline through POST response body consumption', async (t) => {
    clock(t)
    const gateway = stalledPostBody()
    t.after(() => gateway.close())
    const pending = outcome(createRun({ harnessName, body: { input: 'Bake bread.' }, timeoutMs: 300000, fetchImpl: gateway.fetch }))
    await gateway.ready
    await settle()
    t.mock.timers.tick(300000)
    assert.equal(gateway.signal.aborted, true)
    assert.equal((await pending).error?.code, 'hermes_unreachable')
})

test('unlimited run creation can be cancelled after POST headers arrive', async (t) => {
    const gateway = stalledPostBody()
    t.after(() => gateway.close())
    const controller = new AbortController()
    const pending = outcome(
        createRun({ harnessName, body: { input: 'Bake bread.' }, timeoutMs: 0, fetchImpl: gateway.fetch, signal: controller.signal })
    )
    await gateway.ready
    await settle()
    controller.abort()
    assert.equal(gateway.signal.aborted, true)
    assert.equal((await pending).error?.name, 'AbortError')
})

function streamingGateway() {
    let stream
    let streamSignal
    let opened
    const ready = new Promise((resolve) => (opened = resolve))
    return {
        ready,
        get signal() {
            return streamSignal
        },
        close() {
            stream.close()
        },
        fetch: async (url, { signal } = {}) => {
            if (String(url).endsWith('/events')) {
                streamSignal = signal
                const response = new Response(
                    new ReadableStream({
                        start(controller) {
                            stream = controller
                            signal.addEventListener('abort', () => controller.error(abortError()), { once: true })
                        }
                    }),
                    { headers: { 'content-type': 'text/event-stream' } }
                )
                opened()
                return response
            }
            return json({ status: 'completed', output: 'Bread is ready.' })
        }
    }
}

test('unlimited specialist stream stays open beyond four minutes and returns its answer', async (t) => {
    clock(t)
    const gateway = streamingGateway()
    const pending = waitForRun({ harnessName, runId: 'one', timeoutMs: 0, fetchImpl: gateway.fetch })
    await gateway.ready
    t.mock.timers.tick(300000)
    await settle()
    assert.equal(gateway.signal.aborted, false)
    gateway.close()
    assert.equal((await pending).output, 'Bread is ready.')
})

test('unlimited specialist wait honors cancellation while streaming', async () => {
    const gateway = streamingGateway()
    const controller = new AbortController()
    const pending = outcome(waitForRun({ harnessName, runId: 'one', timeoutMs: 0, fetchImpl: gateway.fetch, signal: controller.signal }))
    await gateway.ready
    controller.abort()
    assert.equal((await pending).error?.name, 'AbortError')
})

test('a finite specialist deadline still ends a stalled stream', async (t) => {
    clock(t)
    const gateway = streamingGateway()
    const pending = outcome(waitForRun({ harnessName, runId: 'one', timeoutMs: 300000, fetchImpl: gateway.fetch }))
    await gateway.ready
    t.mock.timers.tick(299999)
    assert.equal(gateway.signal.aborted, false)
    t.mock.timers.tick(1)
    assert.equal((await pending).error?.code, 'run_timeout')
    assert.equal(gateway.signal.aborted, true)
})

test('unlimited specialist wait polls until completion when streaming is unavailable', async (t) => {
    clock(t)
    let reads = 0
    const pending = waitForRun({
        harnessName,
        runId: 'one',
        timeoutMs: 0,
        fetchImpl: async (url) => {
            if (String(url).endsWith('/events')) return new Response('', { status: 503 })
            return json(++reads < 3 ? { status: 'running' } : { status: 'completed', output: 'Bread is ready.' })
        }
    })
    await settle()
    assert.equal(reads, 1)
    t.mock.timers.tick(25)
    await settle()
    assert.equal(reads, 2)
    t.mock.timers.tick(50)
    await settle()
    assert.equal((await pending).output, 'Bread is ready.')
    assert.equal(reads, 3)
})

test('a finite specialist deadline also aborts a stalled polling request', async (t) => {
    clock(t)
    let pollSignal
    let polling
    const ready = new Promise((resolve) => (polling = resolve))
    const pending = outcome(
        waitForRun({
            harnessName,
            runId: 'one',
            timeoutMs: 300000,
            fetchImpl: async (url, { signal }) => {
                if (String(url).endsWith('/events')) return new Response('', { status: 503 })
                pollSignal = signal
                polling()
                return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))
            }
        })
    )
    await ready
    t.mock.timers.tick(300000)
    assert.equal((await pending).error?.code, 'run_timeout')
    assert.equal(pollSignal.aborted, true)
})

test('nested roster tasks receive unlimited or five-minute waits and refresh after an Admin restart', (t) => {
    const previous = process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS
    t.after(() => {
        if (previous === undefined) delete process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS
        else process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS = previous
    })
    const record = {
        name: 'bakery-timeout-mixed',
        chief: { instructions: 'Route bakery tasks.', model: { provider: 'xai', model: 'grok-4.7' } },
        specialists: [
            {
                name: 'baker',
                instructions: 'Bake bread.',
                model: { provider: 'xai', model: 'grok-4.7' },
                modules: [{ nodeName: 'recipeTool', nodeId: 'recipe', inputs: {} }]
            },
            { name: 'orders', instructions: 'Take orders.', model: { provider: 'openai', model: 'gpt-4.1' } }
        ]
    }
    const configAt = (dir) => yaml.load(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf8'))
    const envIn = (compiled) => configAt(compiled.dir).mcp_servers.roster.env
    process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS = '0'
    const first = compileProfileCached(record)
    assert.equal(envIn(first).CUTTLELY_HARNESS_RUN_TIMEOUT_MS, '0')
    assert.equal(envIn(first).CUTTLELY_DATA_DIR, dataDir)
    assert.equal(envIn(first).CUTTLELY_HERMES_HOME, process.env.CUTTLELY_HERMES_HOME)
    assert.equal(configAt(first.dir).mcp_servers.roster.timeout, Infinity)
    const baker = first.roster.specialists.find((specialist) => specialist.name === 'baker')
    const ordinaryServers = Object.values(configAt(profileDir(baker.profileName)).mcp_servers)
    assert.ok(ordinaryServers.length > 0)
    assert.ok(ordinaryServers.every((server) => !Object.hasOwn(server, 'timeout')))
    assert.equal(profileOutdated(record), false)
    assert.equal(compileProfileCached(record), first)

    process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS = '300000'
    assert.equal(profileOutdated(record), true)
    const second = compileProfileCached(record)
    assert.notEqual(second, first)
    assert.equal(envIn(second).CUTTLELY_HARNESS_RUN_TIMEOUT_MS, '300000')
    assert.equal(configAt(second.dir).mcp_servers.roster.timeout, Infinity)
    assert.equal(profileOutdated(record), false)

    // Startup checks the on-disk roster even when its compiler version is already current.
    process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS = '0'
    assert.equal(profileOutdated(record), true)
    assert.deepEqual(recompileOutdatedProfiles([record], { log: {} }), [{ name: record.name, status: 'recompiled' }])
    assert.equal(envIn(second).CUTTLELY_HARNESS_RUN_TIMEOUT_MS, '0')
    assert.equal(profileOutdated(record), false)
})

function mcpPacket(message) {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message })
    return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

for (const cancellation of ['notification', 'stdin EOF', 'SIGTERM']) {
    test(`unlimited nested run stops on ${cancellation}`, { timeout: 15000 }, async (t) => {
        const parentName = `bakery-roster-${cancellation.replace(/\W/g, '-').toLowerCase()}`
        fs.mkdirSync(profileDir(parentName), { recursive: true })
        fs.writeFileSync(
            path.join(profileDir(parentName), 'harness-roster.json'),
            JSON.stringify({ specialists: [{ name: 'baker', profileName: harnessName }] })
        )
        let streaming
        let stopped
        const streamReady = new Promise((resolve) => (streaming = resolve))
        const runStopped = new Promise((resolve) => (stopped = resolve))
        const stops = []
        const server = http.createServer((req, res) => {
            req.resume()
            const base = `/p/${harnessName}/v1/runs`
            if (req.method === 'POST' && req.url === base) {
                res.writeHead(202, { 'content-type': 'application/json' })
                return res.end(JSON.stringify({ run_id: 'nested-one', status: 'started' }))
            }
            if (req.url === `${base}/nested-one/events`) {
                res.writeHead(200, { 'content-type': 'text/event-stream' })
                res.flushHeaders()
                streaming()
                return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            if (req.method === 'POST' && req.url === `${base}/nested-one/stop`) {
                stops.push(req.url)
                res.end(JSON.stringify({ status: 'cancelled' }))
                stopped()
            } else res.end(JSON.stringify({ status: 'running' }))
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        const child = spawn(process.execPath, [path.join(repoRoot(), 'packages/harness/roster-mcp.mjs'), '--harness', parentName], {
            env: {
                ...process.env,
                CUTTLELY_HARNESS_RUN_TIMEOUT_MS: '0',
                HERMES_API_URL: `http://127.0.0.1:${server.address().port}`
            },
            stdio: ['pipe', 'pipe', 'pipe']
        })
        let stderr = ''
        child.stderr.on('data', (chunk) => (stderr += chunk))
        const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
        const whileRunning = (promise) =>
            Promise.race([
                promise,
                exited.then((status) => {
                    throw new Error(`Roster exited before the test completed: ${JSON.stringify(status)} ${stderr}`)
                })
            ])
        t.after(async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
            await exited
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        })
        let buffer = Buffer.alloc(0)
        let replied
        const response = new Promise((resolve) => (replied = resolve))
        child.stdout.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk])
            for (;;) {
                const headerEnd = buffer.indexOf('\r\n\r\n')
                if (headerEnd < 0) return
                const length = Number(
                    buffer
                        .subarray(0, headerEnd)
                        .toString()
                        .match(/Content-Length:\s*(\d+)/i)?.[1]
                )
                if (!Number.isFinite(length) || buffer.length < headerEnd + 4 + length) return
                const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString())
                buffer = buffer.subarray(headerEnd + 4 + length)
                if (message.id === 7) replied(message)
            }
        })
        child.stdin.write(
            mcpPacket({
                id: 7,
                method: 'tools/call',
                params: { name: 'run_specialist', arguments: { name: 'baker', task: 'Bake bread.' } }
            })
        )
        await whileRunning(streamReady)
        if (cancellation === 'notification') {
            child.stdin.write(mcpPacket({ method: 'notifications/cancelled', params: { requestId: 7, reason: 'Test cancellation.' } }))
            await whileRunning(runStopped)
            assert.equal((await whileRunning(response)).result.isError, true)
            child.stdin.end()
        } else if (cancellation === 'stdin EOF') child.stdin.end()
        else child.kill('SIGTERM')
        await runStopped
        assert.deepEqual(stops, [`/p/${harnessName}/v1/runs/nested-one/stop`])
        assert.deepEqual(await exited, { code: 0, signal: null })
    })
}

let sequence = 0
async function engineRun(extra = {}) {
    const name = `bakery-timeout-${++sequence}`
    const model = { nodeName: 'scriptedChat', nodeId: 'chat', inputs: {} }
    saveHarness({
        name,
        chief: { model, instructions: 'Route bakery requests.' },
        specialists: [
            {
                name: 'baker',
                instructions: 'Answer bakery questions.',
                model,
                answerDirect: true,
                playbooks: [{ name: 'bread', description: 'Bread recipe.', content: 'Use flour and water.' }]
            }
        ]
    })
    const gateway = streamingGateway()
    const stops = []
    const pending = outcome(
        runHarness({
            name,
            chatId: 'chat',
            input: 'Bake bread.',
            budgetMs: 0,
            flowOptions: { ...flowiseNodeOptions(), harnessCaller: { via: 'session' } },
            baseUrl: 'http://127.0.0.1:9',
            fetchImpl: async (url, init) => {
                if (init?.method === 'POST' && String(url).endsWith('/v1/runs')) return json({ run_id: 'one', status: 'started' })
                if (init?.method === 'POST' && String(url).endsWith('/stop')) {
                    stops.push(new URL(url).pathname)
                    return json({ status: 'stopping' })
                }
                return gateway.fetch(url, init)
            },
            loadNode: async () =>
                class {
                    async init() {
                        return {
                            invoke: async (messages) => ({
                                content: String(messages[0]?.content || '').includes('You route work')
                                    ? JSON.stringify({ steps: [{ specialist: 'baker', task: 'Bake bread.' }] })
                                    : 'Bread is ready.'
                            })
                        }
                    }
                },
            ...extra
        })
    )
    await Promise.race([
        gateway.ready,
        pending.then((result) => {
            throw result.error || new Error(`Engine finished without opening the specialist stream: ${JSON.stringify(result.value)}`)
        })
    ])
    return { name, gateway, pending, stops }
}

test('engine uses the configured wait and preserves an explicit per-call override', async (t) => {
    const previous = process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS
    process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS = '20'
    t.after(() => {
        if (previous === undefined) delete process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS
        else process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS = previous
    })
    clock(t)
    const configured = await engineRun()
    t.mock.timers.tick(20)
    const failed = await configured.pending
    assert.equal(configured.gateway.signal.aborted, true)
    const failedSpecialist = failed.value?.trace?.specialists?.find((specialist) => specialist.name === 'baker')
    assert.equal(failedSpecialist?.status, 'failed')
    assert.match(failedSpecialist?.error || '', /did not finish the Hermes run in time/)
    assert.deepEqual(configured.stops, [`/p/${configured.name}--baker/v1/runs/one/stop`])
    const overridden = await engineRun({ timeoutMs: 100 })
    t.mock.timers.tick(20)
    await settle()
    assert.equal(overridden.gateway.signal.aborted, false)
    overridden.gateway.close()
    assert.equal((await overridden.pending).value?.text, 'Bread is ready.')
    assert.deepEqual(overridden.stops, [])
})

test('engine accepts unlimited waits while a shorter turn budget still cancels work', async (t) => {
    const previous = process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS
    process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS = '0'
    t.after(() => {
        if (previous === undefined) delete process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS
        else process.env.CUTTLELY_HARNESS_RUN_TIMEOUT_MS = previous
    })
    clock(t)
    const unlimited = await engineRun()
    t.mock.timers.tick(300000)
    await settle()
    assert.equal(unlimited.gateway.signal.aborted, false)
    unlimited.gateway.close()
    assert.equal((await unlimited.pending).value?.text, 'Bread is ready.')

    // AbortSignal.timeout uses the platform clock rather than the mocked JS timers.
    t.mock.timers.reset()
    const bounded = await engineRun({ budgetMs: 500 })
    const keepAlive = setTimeout(() => {}, 2000)
    const failed = await bounded.pending.finally(() => clearTimeout(keepAlive))
    assert.equal(bounded.gateway.signal.aborted, true)
    assert.match(failed.error?.message || failed.value?.text || '', /time budget|turn budget|ran out of time/i)
})
