// A harness question asked while Hermes is still starting waits for it instead of failing at once.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-start-wait-'))
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'hermes')
const { profileEnvPath } = await import('../harness/profile.mjs')
const { createRun, hermesStarting, hermesStartWaitMs } = await import('../harness/client.mjs')

fs.mkdirSync(path.dirname(profileEnvPath('bakery-demo--analyst')), { recursive: true })
fs.writeFileSync(profileEnvPath('bakery-demo--analyst'), 'API_SERVER_KEY=test-key\n')

const refused = () => Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
const okResponse = () => new Response(JSON.stringify({ run_id: 'run-1' }), { status: 200, headers: { 'content-type': 'application/json' } })
const call = (fetchImpl, extra = {}) =>
    createRun({ harnessName: 'bakery-demo--analyst', body: { input: 'hi' }, fetchImpl, retryEveryMs: 5, startWaitMs: 1000, ...extra })

test('waits while the supervisor says Hermes is starting, then runs', async () => {
    let calls = 0
    const fetchImpl = async () => {
        calls += 1
        if (calls < 4) throw refused()
        return okResponse()
    }
    const payload = await call(fetchImpl, { isStarting: () => true })
    assert.deepEqual(payload, { run_id: 'run-1' })
    assert.equal(calls, 4)
})

test('fails at once when Hermes is not supervised, is down, or the error is not a refused connection', async () => {
    let calls = 0
    const fetchImpl = async () => {
        calls += 1
        throw refused()
    }
    await assert.rejects(call(fetchImpl, { isStarting: () => false }), /Hermes did not accept POST \/v1\/runs/)
    assert.equal(calls, 1)
    calls = 0
    await assert.rejects(
        call(
            async () => {
                calls += 1
                throw new Error('boom')
            },
            { isStarting: () => true }
        ),
        /did not accept/
    )
    assert.equal(calls, 1)
})

test('gives up after the start wait', async () => {
    let calls = 0
    const started = Date.now()
    await assert.rejects(
        call(
            async () => {
                calls += 1
                throw refused()
            },
            { isStarting: () => true, startWaitMs: 60 }
        ),
        /did not accept/
    )
    assert.ok(calls > 1)
    assert.ok(Date.now() - started < 2000)
})

test('reads the supervisor state and the wait setting', () => {
    assert.equal(hermesStarting(dataDir), false)
    fs.writeFileSync(path.join(dataDir, 'hermes-supervisor.json'), JSON.stringify({ state: 'up' }))
    assert.equal(hermesStarting(dataDir), true)
    fs.writeFileSync(path.join(dataDir, 'hermes-supervisor.json'), JSON.stringify({ state: 'down' }))
    assert.equal(hermesStarting(dataDir), false)
    assert.equal(hermesStartWaitMs({}), 60000)
    assert.equal(hermesStartWaitMs({ CUTTLELY_HERMES_START_WAIT_MS: '0' }), 0)
    assert.equal(hermesStartWaitMs({ CUTTLELY_HERMES_START_WAIT_MS: 'soon' }), 60000)
})
