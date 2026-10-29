import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { capacityRetryDelayMs, isRejectedCapacityAdmission, specialistCapacityWaitSeconds } from './capacity-wait.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-wait-'))
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
delete process.env.HERMES_API_URL
const { createRun } = await import('./client.mjs')
const { profileEnvPath } = await import('./profile.mjs')
const { rosterFromFlow } = await import('./sync-from-flow.mjs')
const { saveHarness, getHarness } = await import('./store.mjs')
const { runHarness } = await import('./run.mjs')
const profile = 'capacity-client-fixture'
fs.mkdirSync(path.dirname(profileEnvPath(profile)), { recursive: true })
fs.writeFileSync(profileEnvPath(profile), 'API_SERVER_KEY=offline-fixture-only\n', { mode: 0o600 })
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const limited = { error: { message: 'Too many concurrent runs (max 10)', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }
const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const request = { harnessName: profile, body: { input: 'Supplied fixture rows', session_id: 'same-turn' }, baseUrl: 'http://127.0.0.1:9' }

test('capacity wait is absent by default and bounded when explicitly enabled', () => {
    for (const value of [undefined, null, false, true, '', ' ', 'bad', -1, 0, NaN, Infinity, 0.9]) {
        assert.equal(specialistCapacityWaitSeconds(value), 0)
    }
    assert.equal(specialistCapacityWaitSeconds('12.8'), 12)
    assert.equal(specialistCapacityWaitSeconds(300), 60)
})

test('only an explicit unadmitted concurrency rejection is retryable', () => {
    assert.equal(isRejectedCapacityAdmission(json(limited, 429), limited), true)
    for (const [status, payload] of [
        [503, limited],
        [429, { ...limited, run_id: 'run_already_admitted' }],
        [429, { error: { ...limited.error, message: 'Monthly quota exceeded' } }],
        [429, { error: { ...limited.error, message: 'Too many API requests' } }],
        [429, { error: { ...limited.error, code: 'insufficient_quota' } }],
        [200, { ...limited, run_id: 'run_completed', status: 'failed' }]
    ])
        assert.equal(isRejectedCapacityAdmission(json(payload, status), payload), false)
})

test('capacity backoff honors numeric and HTTP-date Retry-After without shortening it', () => {
    const now = Date.UTC(2026, 0, 1)
    assert.equal(capacityRetryDelayMs(json({}, 429, { 'retry-after': '7' }), 1, now), 7000)
    assert.equal(capacityRetryDelayMs(json({}, 429, { 'retry-after': new Date(now + 9000).toUTCString() }), 2, now), 9000)
    assert.equal(capacityRetryDelayMs(json({}, 429, { 'retry-after': 'bad' }), 1, now), 1000)
    assert.equal(capacityRetryDelayMs(json({}, 429, { 'retry-after': '0' }), 3, now), 4000)
    assert.equal(capacityRetryDelayMs(json({}, 429), 20, now), 5000)
})

test('flag off preserves the first admission failure and performs no retry', async () => {
    let calls = 0
    await assert.rejects(
        createRun({
            ...request,
            fetchImpl: async () => {
                calls += 1
                return json(limited, 429, { 'retry-after': '0' })
            }
        }),
        /Too many concurrent runs/
    )
    assert.equal(calls, 1)
})

test('rejected attempts reuse the original body and admit work exactly once', async () => {
    const bodies = [],
        waits = []
    let admitted = 0
    const result = await createRun({
        ...request,
        capacityWaitSeconds: 5,
        onCapacityWait: (wait) => waits.push(wait),
        fetchImpl: async (_url, init) => {
            bodies.push(init.body)
            if (bodies.length <= 2) return json(limited, 429, { 'retry-after': '0' })
            admitted += 1
            return json({ run_id: 'run_once', status: 'running' }, 202)
        }
    })
    assert.deepEqual(result, { run_id: 'run_once', status: 'running' })
    assert.equal(admitted, 1)
    assert.equal(bodies.length, 3)
    assert.ok(bodies.every((body) => body === JSON.stringify(request.body)))
    assert.deepEqual(waits, [
        { attempt: 1, delayMs: 1000 },
        { attempt: 2, delayMs: 2000 }
    ])
})

test('accepted or post-admission failed runs never reenter admission', async () => {
    for (const body of [
        { run_id: 'run_accepted', status: 'running' },
        { run_id: 'run_failed', status: 'failed', error: limited.error.message }
    ]) {
        let calls = 0
        assert.deepEqual(
            await createRun({
                ...request,
                capacityWaitSeconds: 5,
                fetchImpl: async () => {
                    calls += 1
                    return json(body, 202)
                }
            }),
            body
        )
        assert.equal(calls, 1)
    }
})

test('a rejected admission cannot change the body of a later retry', async () => {
    const body = { input: 'Original supplied rows', session_id: 'same-turn' }
    const original = JSON.stringify(body)
    const sent = []
    await createRun({
        ...request,
        body,
        capacityWaitSeconds: 3,
        fetchImpl: async (_url, init) => {
            sent.push(init.body)
            if (sent.length === 1) {
                body.input = 'A caller changed this object while admission was pending'
                return json(limited, 429, { 'retry-after': '0' })
            }
            return json({ run_id: 'run_original_body_once', status: 'running' }, 202)
        }
    })
    assert.deepEqual(sent, [original, original])
})

test('quota, server, malformed and ambiguous transport errors are not retried', async () => {
    for (const response of [
        () => json({ error: { ...limited.error, message: 'Quota exceeded' } }, 429),
        () => json(limited, 503),
        () => new Response('Too many concurrent runs (max 10)', { status: 429 }),
        () => {
            throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
        }
    ]) {
        let calls = 0
        await assert.rejects(
            createRun({
                ...request,
                capacityWaitSeconds: 5,
                fetchImpl: async () => {
                    calls += 1
                    return response()
                }
            })
        )
        assert.equal(calls, 1)
    }
})

test('a Retry-After outside the wait window is never shortened into an early retry', async () => {
    let calls = 0
    await assert.rejects(
        createRun({
            ...request,
            capacityWaitSeconds: 5,
            fetchImpl: async () => {
                calls += 1
                return json(limited, 429, { 'retry-after': '60' })
            }
        }),
        /Too many concurrent runs/
    )
    assert.equal(calls, 1)
})

test('the existing request budget bounds capacity admission', async () => {
    let calls = 0
    await assert.rejects(
        createRun({
            ...request,
            timeoutMs: 50,
            capacityWaitSeconds: 60,
            fetchImpl: async () => {
                calls += 1
                return json(limited, 429, { 'retry-after': '1' })
            }
        }),
        /Too many concurrent runs/
    )
    assert.equal(calls, 1)
})

test('client cancellation interrupts waiting before another POST', async () => {
    const controller = new AbortController()
    let calls = 0
    await assert.rejects(
        createRun({
            ...request,
            capacityWaitSeconds: 5,
            signal: controller.signal,
            onCapacityWait: () => controller.abort(),
            fetchImpl: async () => {
                calls += 1
                return json(limited, 429, { 'retry-after': '0' })
            }
        }),
        { name: 'AbortError' }
    )
    assert.equal(calls, 1)
})

test('canvas and stored rosters opt in one specialist without changing the others', () => {
    const canvas = JSON.parse(fs.readFileSync(new URL('../../samples/harnesses/research.canvas.json', import.meta.url)))
    const flow = JSON.parse(canvas.flowData)
    const original = flow.nodes.find((node) => node.data?.name === 'harnessSpecialist')
    const other = JSON.parse(JSON.stringify(original).replaceAll(original.id, 'capacity-other-specialist'))
    other.data.inputs.specialistName = 'capacity-other'
    flow.nodes.push(other)
    const specialists = flow.nodes.filter((node) => node.data?.name === 'harnessSpecialist')
    assert.ok(specialists.length >= 2)
    specialists[0].data.inputs.capacityWaitSeconds = '12.8'
    const roster = rosterFromFlow({ name: 'capacity-config', chatflowId: 'capacity-config', flowData: JSON.stringify(flow) })
    assert.equal(roster.specialists[0].capacityWaitSeconds, 12)
    assert.ok(roster.specialists.slice(1).every((specialist) => !('capacityWaitSeconds' in specialist)))
    saveHarness(roster)
    const saved = getHarness('capacity-config')
    assert.equal(saved.specialists[0].capacityWaitSeconds, 12)
    assert.ok(saved.specialists.slice(1).every((specialist) => !('capacityWaitSeconds' in specialist)))
    saved.specialists[0].capacityWaitSeconds = 0
    saveHarness(saved, { overwrite: true })
    assert.ok(getHarness('capacity-config').specialists.every((specialist) => !('capacityWaitSeconds' in specialist)))
})

test('an opted-in harness recovers admission without executing a second accepted turn', async () => {
    const name = 'capacity-execution'
    const question = 'Summarize the supplied fixture rows.'
    saveHarness({
        name,
        chief: { model: { nodeName: 'fixtureChat', inputs: {} } },
        specialists: [{ name: 'worker', capacityWaitSeconds: 3, codeExecution: true }]
    })
    let attempts = 0,
        admitted = 0
    const result = await runHarness({
        name,
        input: question,
        chatId: 'chat',
        baseUrl: 'http://127.0.0.1:9',
        flowOptions: { appDataSource: {}, harnessCaller: { via: 'session' } },
        loadNode: async () =>
            class {
                async init() {
                    return {
                        invoke: async (messages) => ({
                            content: String(messages[0]?.content).includes('You route work')
                                ? JSON.stringify({ steps: [{ specialist: 'worker', task: question }] })
                                : 'Processed the fixture rows once.'
                        })
                    }
                }
            },
        fetchImpl: async (url, init = {}) => {
            if (init.method === 'POST' && new URL(url).pathname.endsWith('/v1/runs')) {
                attempts += 1
                if (attempts === 1) return json(limited, 429, { 'retry-after': '0' })
                admitted += 1
                return json({ run_id: 'run_accepted_once', status: 'running' }, 202)
            }
            if (String(url).endsWith('/events')) return new Response(': done\n\n', { headers: { 'content-type': 'text/event-stream' } })
            return json({ status: 'completed', output: 'Processed the fixture rows once.' })
        }
    })
    assert.equal(attempts, 2)
    assert.equal(admitted, 1)
    assert.equal(result.agents[0].status, 'completed')
    assert.equal(result.text, 'Processed the fixture rows once.')
})
