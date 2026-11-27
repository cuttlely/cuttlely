import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compareCalculatorRounds } from './kraken-calculator-parity.mjs'

const config = {
    clients: 8,
    workers: 1,
    resources: '2 cores',
    database: 'PG16',
    seed: 'calculator-1',
    ingress: 'loopback',
    provider: 'simulated',
    settings: 'default queue'
}
function matched() {
    return ['bundled', 'native', 'native', 'bundled'].map((engine, i) => ({
        engine,
        revision: engine === 'bundled' ? 'bb1191321688de52a405dfb88ab43826250c814f' : 'a'.repeat(40),
        config: { ...config },
        deployment: 'restore-' + i,
        rows: ['fresh', 'warm'].map((cohort) => ({
            engine,
            cohort,
            sampleId: 'sample-' + i,
            clientSha256: 'e'.repeat(64),
            submitted: 8,
            verified: 8,
            recorded: 8,
            tcpConnections: 8,
            peakRequestsOnWire: 8,
            peakOpenSseResponses: 2,
            wallMs: 100,
            turnDurationsMs: [10, 20, 30, 40, 50, 60, 70, 80],
            headerDurationsMs: Array(8).fill(2),
            pingDurationsMs: [5],
            ping: { http200: 1 }
        }))
    }))
}

test('matching cold and warm cohorts allow equality and report individual round spread', () => {
    const result = compareCalculatorRounds(matched())
    assert.ok(result.passed)
    assert.equal(result.cohorts[0].native.completed, 16)
    assert.equal(result.cohorts[0].native.turnsPerSecond, 80)
    assert.equal(result.cohorts[0].native.p95Ms, 80)
    assert.equal(result.cohorts[1].native.perRound.length, 2)
})

test('a slower candidate p95 or completion rate fails its own cohort even if the other measure passes', () => {
    const rounds = matched()
    rounds[1].rows[0].turnDurationsMs[0] = 90
    rounds[2].rows[1].wallMs = 125
    const result = compareCalculatorRounds(rounds)
    assert.equal(result.passed, false)
    assert.deepEqual(
        result.cohorts.map((c) => [c.latencyPass, c.throughputPass]),
        [
            [false, true],
            [true, false]
        ]
    )
})

test('incomplete, unmatched or reused evidence cannot support a parity result', () => {
    for (const change of [
        (r) => r.pop(),
        (r) => (r[1].revision = r[0].revision),
        (r) => r.splice(1, 2, r[3], r[2]),
        (r) => (r[1].config.workers = 2),
        (r) => (r[1].deployment = r[0].deployment),
        (r) => (r[1].rows[0].engine = 'bundled'),
        (r) => r[1].rows.pop(),
        (r) => (r[1].rows[1].sampleId = r[0].rows[0].sampleId),
        (r) => (r[1].rows[1].clientSha256 = 'f'.repeat(64)),
        (r) => (r[1].rows[0].submitted = 9),
        (r) => (r[1].rows[0].verified = 7),
        (r) => (r[1].rows[0].recorded = 7),
        (r) => (r[1].rows[0].tcpConnections = 7),
        (r) => (r[1].rows[0].peakRequestsOnWire = 1),
        (r) => (r[1].rows[0].ping.http200 = 0),
        (r) => r[1].rows[0].turnDurationsMs.pop(),
        (r) => (r[1].rows[0].headerDurationsMs[0] = 300)
    ]) {
        const rounds = matched()
        change(rounds)
        assert.throws(() => compareCalculatorRounds(rounds))
    }
})

test('the real load client rejects cross-chat receipts, reused run IDs and rate-limited submissions', async (t) => {
    let fault = 'wrong chat'
    const reused = 'run_' + randomUUID(),
        key = randomUUID()
    const server = http.createServer(async (req, res) => {
        if (req.url === '/api/v1/ping') return res.writeHead(200).end()
        if (req.url !== '/api/v1/harnesses/qa-calculator/runs' || req.headers.authorization !== 'Bearer ' + key)
            return res.writeHead(403).end()
        if (fault === 'rate limit') return res.writeHead(429).end()
        let body = ''
        for await (const chunk of req) body += chunk
        const { chatId, question } = JSON.parse(body)
        const text = String(Number(question.split(' ')[0]) + 23)
        const data = {
            text,
            agents: [{ name: 'math', status: 'completed' }],
            trace: { specialists: [{ tools: [{ name: 'calculator', status: 'done' }] }] }
        }
        const emit = (event, data) => res.write('data: ' + JSON.stringify({ event, data }) + '\n\n')
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        emit('harness.final', fault === 'wrong final' ? { ...data, chatId: randomUUID() } : data)
        emit('harness.recorded', {
            chatId: fault === 'wrong chat' ? randomUUID() : chatId,
            run: { id: fault === 'wrong chat' ? 'run_' + randomUUID() : reused }
        })
        res.end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise((resolve) => server.close(resolve)))
    for (fault of ['wrong chat', 'wrong final', 'same run', 'rate limit']) {
        const error = await promisify(execFile)(
            process.execPath,
            [fileURLToPath(new URL('./kraken-calculator-load.mjs', import.meta.url)), '8'],
            {
                env: { ...process.env, CUTTLELY_QA_ORIGIN: 'http://127.0.0.1:' + server.address().port, CUTTLELY_QA_TOKEN: key },
                timeout: 5000
            }
        ).then(
            () => null,
            (e) => e
        )
        assert.equal(error?.code, 1)
        const row = JSON.parse(error.stderr.trim().split('\n')[0])
        assert.equal(row.submitted, 8)
        assert.equal(row.verified, fault === 'same run' ? 1 : 0)
        assert.equal(
            Object.values(row.errors).reduce((a, b) => a + b),
            8 - row.verified
        )
        if (fault === 'rate limit') assert.equal(row.errors['Calculator returned HTTP 429'], 8)
    }
})
