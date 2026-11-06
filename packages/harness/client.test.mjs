import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cleanup-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
const { stopRun, waitForRun } = await import('./client.mjs')
const { profileEnvPath } = await import('./profile.mjs')
const { profileDir } = await import('./paths.mjs')
const { saveHarness } = await import('./store.mjs')
const { runHarness } = await import('./run.mjs')
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const profile = 'cleanup-fixture--worker'
fs.mkdirSync(path.dirname(profileEnvPath(profile)), { recursive: true })
fs.writeFileSync(profileEnvPath(profile), 'API_SERVER_KEY=offline-fixture-only\n', { mode: 0o600 })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('shutdown-interrupted runs finish polling immediately', async () => {
    let polls = 0
    const status = await waitForRun({
        harnessName: profile,
        runId: 'interrupted',
        timeoutMs: 80,
        fetchImpl: async (url) => {
            if (String(url).endsWith('/events')) return new Response(': stream closed\n\n')
            polls += 1
            return json({ status: 'interrupted', error: 'Gateway shutdown interrupted the run.' })
        }
    })
    assert.equal(status.status, 'interrupted')
    assert.equal(polls, 1)
})

test('stop retries transient failures and confirms worker exit rather than its stopping acknowledgment', async () => {
    let posts = 0
    let polls = 0
    const confirmed = await stopRun({
        harnessName: profile,
        runId: 'owned-run',
        timeoutMs: 1500,
        fetchImpl: async (url, init = {}) => {
            assert.ok(String(url).includes('/runs/owned-run'))
            if (init.method === 'POST') {
                posts += 1
                return posts === 1 ? json({ error: 'temporary proxy failure' }, 503) : json({ status: 'stopping' })
            }
            polls += 1
            return json({ status: polls === 1 ? 'stopping' : 'cancelled' })
        }
    })
    assert.equal(confirmed, true)
    assert.equal(posts, 2)
    assert.equal(polls, 2)
})

test('unconfirmed stop is bounded and reported as unconfirmed', async () => {
    let posts = 0
    const started = Date.now()
    const confirmed = await stopRun({
        harnessName: profile,
        runId: 'blocked',
        timeoutMs: 35,
        fetchImpl: async () => {
            posts += 1
            return json({ error: 'unavailable' }, 503)
        }
    })
    assert.equal(confirmed, false)
    assert.ok(posts > 0)
    assert.ok(Date.now() - started < 1000)
})

// Model a runtime with two slots: one belongs to another chat, and one to our
// request. A lost status connection must not strand our accepted worker.
async function runtime(t, interrupted = false) {
    const active = new Set(['another-chat'])
    const states = new Map()
    let admitted = 0
    let rejected = 0
    const stopped = []
    const server = http.createServer(async (req, res) => {
        for await (const _ of req) void _
        const pathname = new URL(req.url, 'http://localhost').pathname
        const reply = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(body))
        }
        if (req.method === 'POST' && pathname.endsWith('/v1/runs')) {
            if (active.size >= 2) {
                rejected += 1
                return reply(429, { error: { message: 'Too many concurrent runs (max 2)' } })
            }
            const id = `owned-${++admitted}`
            active.add(id)
            states.set(id, { stopAttempts: 0, polls: 0 })
            return reply(202, { run_id: id, status: 'running' })
        }
        const match = pathname.match(/\/v1\/runs\/([^/]+)(?:\/(events|stop))?$/)
        if (!match) return reply(404, {})
        const [, id, action] = match
        const state = states.get(id)
        if (action === 'events') {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            return res.end(': stream closed\n\n')
        }
        if (action === 'stop') {
            stopped.push(id)
            state.stopAttempts += 1
            if (state.stopAttempts === 1) return reply(503, { error: 'temporary stop failure' })
            state.stopping = true
            return reply(200, { status: 'stopping' })
        }
        if (!state?.stopping) {
            if (interrupted) {
                active.delete(id)
                return reply(200, { status: 'interrupted', output: 'Unfinished output', error: 'Gateway shutdown interrupted the run.' })
            }
            return reply(502, { error: 'lost status transport' })
        }
        if (++state.polls === 1) return reply(200, { status: 'stopping' })
        active.delete(id)
        return reply(200, { status: 'cancelled' })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    })
    return { active, stopped, url: `http://127.0.0.1:${server.address().port}`, counts: () => ({ admitted, rejected }) }
}

test('repeated top-level transport failures release admitted slots and leave another chat running', { timeout: 15000 }, async (t) => {
    const remote = await runtime(t)
    const name = 'cleanup-top-level'
    saveHarness({ name, chief: { model: { nodeName: 'fixtureChat', inputs: {} } }, specialists: [{ name: 'worker', codeExecution: true }] })
    for (let index = 0; index < 3; index++) {
        const result = await runHarness({
            name,
            input: 'Process supplied fixture text.',
            chatId: `chat-${index}`,
            baseUrl: remote.url,
            flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
            loadNode: async () =>
                class {
                    async init() {
                        return {
                            invoke: async (messages) => ({
                                content: String(messages[0]?.content).includes('You route work')
                                    ? JSON.stringify({ steps: [{ specialist: 'worker', task: 'Process supplied fixture text.' }] })
                                    : 'The fixture run failed.'
                            })
                        }
                    }
                }
        })
        assert.equal(result.agents[0].status, 'failed')
        assert.deepEqual([...remote.active], ['another-chat'], 'accepted worker survived the failed status request')
    }
    assert.deepEqual(remote.counts(), { admitted: 3, rejected: 0 })
    assert.ok(remote.stopped.every((id) => id !== 'another-chat'))
})

test('nested specialist transport failure also releases only its accepted worker', { timeout: 15000 }, async (t) => {
    const remote = await runtime(t)
    const name = 'cleanup-nested'
    fs.mkdirSync(profileDir(name), { recursive: true })
    fs.writeFileSync(
        path.join(profileDir(name), 'harness-roster.json'),
        JSON.stringify({ specialists: [{ name: 'worker', profileName: profile }] })
    )
    const child = spawn(process.execPath, [fileURLToPath(new URL('./roster-mcp.mjs', import.meta.url)), '--harness', name], {
        env: { ...process.env, HERMES_API_URL: remote.url, CUTTLELY_HARNESS_RUN_TIMEOUT_MS: '5000' },
        stdio: ['pipe', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const exited = new Promise((resolve) => child.once('exit', resolve))
    t.after(async () => {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
        await exited
        clearTimeout(timer)
    })
    let buffer = Buffer.alloc(0)
    const pending = new Map()
    child.stdout.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
            const end = buffer.indexOf('\r\n\r\n')
            if (end < 0) return
            const length = Number(
                buffer
                    .subarray(0, end)
                    .toString()
                    .match(/Content-Length:\s*(\d+)/i)?.[1]
            )
            if (!Number.isFinite(length) || buffer.length < end + 4 + length) return
            const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
            buffer = buffer.subarray(end + 4 + length)
            pending.get(message.id)?.(message)
            pending.delete(message.id)
        }
    })
    for (let id = 1; id <= 3; id++) {
        const reply = new Promise((resolve) => pending.set(id, resolve))
        const body = JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'run_specialist', arguments: { name: 'worker', task: 'Process supplied fixture text.' } }
        })
        child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
        const response = await reply
        assert.equal(response.result.isError, true, stderr)
        assert.deepEqual([...remote.active], ['another-chat'], 'nested worker survived the failed status request')
    }
    assert.deepEqual(remote.counts(), { admitted: 3, rejected: 0 })
})

test('an interrupted specialist cannot deliver its partial output as a successful answer', { timeout: 5000 }, async (t) => {
    const remote = await runtime(t, true)
    const name = 'cleanup-interrupted'
    saveHarness({ name, chief: { model: { nodeName: 'fixtureChat', inputs: {} } }, specialists: [{ name: 'worker', codeExecution: true }] })
    const result = await runHarness({
        name,
        input: 'Process supplied fixture text.',
        chatId: 'interrupted-chat',
        baseUrl: remote.url,
        flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
        loadNode: async () =>
            class {
                async init() {
                    return {
                        invoke: async (messages) => ({
                            content: String(messages[0]?.content).includes('You route work')
                                ? JSON.stringify({ steps: [{ specialist: 'worker', task: 'Process supplied fixture text.' }] })
                                : 'The fixture run failed.'
                        })
                    }
                }
            }
    })
    assert.equal(result.agents[0].status, 'failed')
    assert.ok(!result.text.includes('Unfinished output'))
    assert.deepEqual(remote.counts(), { admitted: 1, rejected: 0 })
    assert.equal(remote.stopped.length, 0, 'a terminal run needs no new stop request')
    assert.deepEqual([...remote.active], ['another-chat'])
})
