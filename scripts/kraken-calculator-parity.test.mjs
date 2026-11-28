import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { calculatorStreamReader } from './kraken-calculator-load.mjs'
import { compareCalculatorMatrix, compareCalculatorRounds } from './kraken-calculator-parity.mjs'

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
function matched(clients = 8, workers = 1) {
    return ['bundled', 'native', 'native', 'bundled'].map((engine, i) => ({
        engine,
        revision: engine === 'bundled' ? 'bb1191321688de52a405dfb88ab43826250c814f' : 'a'.repeat(40),
        config: { ...config, clients, workers },
        deployment: 'restore-' + i,
        rows: ['fresh', 'warm'].map((cohort) => ({
            engine,
            cohort,
            sampleId: 'sample-' + i,
            clientSha256: 'e'.repeat(64),
            submitted: clients,
            verified: clients,
            recorded: clients,
            tcpConnections: clients,
            peakRequestsOnWire: clients,
            peakOpenSseResponses: Math.min(2, clients),
            wallMs: 100,
            turnDurationsMs: Array.from({ length: clients }, (_, index) => 10 * (1 + (index % 8))),
            headerDurationsMs: Array(clients).fill(2),
            pingDurationsMs: [5],
            ping: { http200: 1 }
        }))
    }))
}

test('the release matrix requires all five configurations from one candidate and fails on any missed threshold', () => {
    const groups = [matched(32, 4), matched(1), matched(32, 2), matched(8), matched(32)]
    assert.equal(compareCalculatorMatrix(groups).passed, true)
    assert.throws(() => compareCalculatorMatrix(groups.slice(1)), /each required/)
    assert.throws(() => compareCalculatorMatrix([groups[1], ...groups.slice(1)]), /each required/)
    for (const round of groups[0]) {
        for (const row of round.rows) row.clientSha256 = '9'.repeat(64)
    }
    assert.throws(() => compareCalculatorMatrix(groups), /same load client/)
    groups[0] = matched(32, 4)
    for (const round of groups[0].filter((r) => r.engine === 'native')) round.revision = 'b'.repeat(40)
    assert.throws(() => compareCalculatorMatrix(groups), /single tested candidate/)
    groups[0] = matched(32, 4)
    groups[0][1].rows[1].wallMs *= 2
    const result = compareCalculatorMatrix(groups)
    assert.equal(result.passed, false)
    assert.equal(result.cells.filter((cell) => cell.passed).length, 4)
})

test('matching cold and warm cohorts allow equality and report individual round spread', () => {
    const rounds = matched()
    rounds[1].rows[1].peakOpenSseResponses = 7
    const result = compareCalculatorRounds(rounds)
    assert.ok(result.passed)
    assert.equal(result.cohorts[0].native.completed, 16)
    assert.equal(result.cohorts[0].native.turnsPerSecond, 80)
    assert.equal(result.cohorts[0].native.p95Ms, 80)
    assert.deepEqual(
        result.cohorts[1].native.perRound.map((r) => [r.peakRequestsOnWire, r.peakOpenSseResponses]),
        [
            [8, 7],
            [8, 2]
        ]
    )
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

test('first answer uses the complete visible answer frame and ignores progress and late partials', () => {
    const reader = () => calculatorStreamReader({ chatId: 'chat', expected: 45, engines: new Set(), recordedRuns: new Set() })
    const frame = (event, data) => 'message:\r\ndata:' + JSON.stringify({ event, data }) + '\r\n\r\n'
    const part = (phase, text, chatId = 'chat') => frame('harness.partial', { type: 'partial', phase, text, chatId })
    const final = (text) =>
        frame('harness.final', {
            type: 'final',
            text,
            chatId: 'chat',
            agents: [{ name: 'math', status: 'completed' }],
            trace: { specialists: [{ tools: [{ name: 'calculator', status: 'done' }] }] }
        })
    const receipt = frame('harness.recorded', { chatId: 'chat', run: { id: 'run_' + randomUUID() } })
    const progress =
        ': heartbeat\r\n\r\n' +
        part('route', 'route') +
        part('specialist', '45') +
        part('answer', ' \t') +
        frame('harness.tool', { type: 'tool', text: '45' }) +
        frame('artifacts', [{ name: 'result' }])
    const streamed = reader()
    streamed.push(progress, 2)
    const delta = part('answer', '4')
    streamed.push(delta.slice(0, -1), 4)
    streamed.push(delta.slice(-1), 7)
    streamed.push(part('answer', '5') + final('45') + receipt, 14)
    assert.deepEqual(streamed.finish(), { firstAnswerMs: 7, firstAnswerEvent: 'partial' })
    const finalOnly = reader()
    finalOnly.push(progress, 2)
    finalOnly.push(final('45') + part('answer', '45'), 12)
    finalOnly.push(receipt, 18)
    assert.deepEqual(finalOnly.finish(), { firstAnswerMs: 12, firstAnswerEvent: 'final' })
    const incomplete = reader()
    incomplete.push(delta, 4)
    assert.throws(() => incomplete.finish(), /verified Calculator answer/)
    assert.throws(() => incomplete.push(final('44'), 5), /Incorrect arithmetic/)
    assert.throws(() => reader().push(part('answer', '4', 'other'), 6))
})

test('first-answer telemetry distinguishes measured and unavailable samples and preserves acceptance thresholds', () => {
    const history = matched()
    assert.deepEqual(compareCalculatorRounds(history).cohorts[0].native.firstAnswer, {
        observed: 0,
        expected: 16,
        partial: 0,
        final: 0,
        p50Ms: null,
        p95Ms: null
    })
    for (const round of history)
        for (const row of round.rows) {
            row.firstAnswerDurationsMs = row.turnDurationsMs.map((ms) => (round.engine === 'native' ? ms - 1 : 3))
            row.firstAnswerEvents = row.turnDurationsMs.map((_, i) => (i % 2 ? 'partial' : 'final'))
        }
    const compared = compareCalculatorRounds(history)
    assert.equal(compared.passed, true)
    assert.deepEqual(compared.cohorts[0].native.firstAnswer, { observed: 16, expected: 16, partial: 8, final: 8, p50Ms: 39, p95Ms: 79 })
    assert.equal(compared.cohorts[0].bundled.firstAnswer.p95Ms, 3)
    delete history[1].rows[0].firstAnswerDurationsMs
    assert.throws(() => compareCalculatorRounds(history), /Incomplete first-answer telemetry/)
    delete history[1].rows[0].firstAnswerEvents
    assert.deepEqual(compareCalculatorRounds(history).cohorts[0].native.firstAnswer, {
        observed: 8,
        expected: 16,
        partial: 4,
        final: 4,
        p50Ms: null,
        p95Ms: null
    })
    history[0].rows[0].firstAnswerDurationsMs[0] = 1
    assert.throws(() => compareCalculatorRounds(history), /Invalid first-answer timing/)
    history[0].rows[0].firstAnswerDurationsMs[0] = 11
    assert.throws(() => compareCalculatorRounds(history), /Invalid first-answer timing/)
})

test(
    'distinct connected endpoints behind one origin can share a local port, while a reused or incomplete socket fails',
    { timeout: 15000 },
    async (t) => {
        const [{ spawn }, fs, os, path, { once }, { createInterface }] = await Promise.all([
            import('node:child_process'),
            import('node:fs'),
            import('node:os'),
            import('node:path'),
            import('node:events'),
            import('node:readline')
        ])
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'calculator-connection-evidence-'))
        const token = randomUUID(),
            endpoints = new Set(),
            localPorts = new Set(),
            observedHosts = new Set()
        const servers = []
        const cleanup = async () => {
            for (const s of servers) s.closeAllConnections()
            await Promise.all(servers.map((s) => new Promise((done) => s.close(done))))
            fs.rmSync(temp, { recursive: true, force: true })
        }
        t.after(cleanup)
        const listen = async (server, address, port = 0) => {
            server.listen(port, address)
            await once(server, 'listening')
            return server.address().port
        }
        async function responder(req, res) {
            if (req.url === '/api/v1/ping') return res.writeHead(200).end()
            if (req.url !== '/api/v1/harnesses/qa-calculator/runs' || req.headers.authorization !== 'Bearer ' + token)
                return res.writeHead(403).end()
            endpoints.add(req.socket.localAddress)
            localPorts.add(req.socket.remotePort)
            observedHosts.add(req.headers.host)
            let body = ''
            for await (const chunk of req) body += chunk
            const { question, chatId } = JSON.parse(body)
            const emit = (event, data) => res.write('data: ' + JSON.stringify({ event, data }) + '\n\n')
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            emit('harness.final', {
                chatId,
                text: String(Number(question.split(' ')[0]) + 23),
                agents: [{ name: 'math', status: 'completed' }],
                trace: { specialists: [{ tools: [{ name: 'calculator', status: 'done' }] }] }
            })
            emit('harness.recorded', { chatId, run: { id: 'run_' + randomUUID(), chatId, status: 'succeeded' } })
            res.end()
        }
        let port = 0
        for (let i = 1; i <= 8; i++) {
            const server = http.createServer(responder)
            servers.push(server)
            port = await listen(server, '127.0.0.' + i, port)
        }
        const reserve = http.createServer()
        const local = await listen(reserve, '127.0.0.1')
        await new Promise((done) => reserve.close(done))
        const shim = path.join(temp, 'fixture.cjs')
        fs.writeFileSync(
            shim,
            `
        const http=require('node:http'), original=http.request, mode=process.env.FIXTURE_MODE
        const agent=new http.Agent({keepAlive:true,maxSockets:2})
        let index=0
        http.request=function(url,options,cb){
            if(url.pathname!=='/api/v1/harnesses/qa-calculator/runs')throw Error('Unexpected fixture request')
            if(mode==='distinct')options={...options,hostname:'127.0.0.'+(++index),localAddress:'127.0.0.1',localPort:${local},headers:{...options.headers,host:url.host}}
            if(mode==='shared')options={...options,agent}
            const request=original.call(this,url,options,cb)
            if(mode==='incomplete')request.once('socket',s=>Object.defineProperty(s,'remotePort',{value:undefined}))
            return request
        }
    `
        )
        for (const mode of ['distinct', 'shared', 'incomplete']) {
            endpoints.clear()
            localPorts.clear()
            observedHosts.clear()
            const child = spawn(
                process.execPath,
                ['--require', shim, fileURLToPath(new URL('./kraken-calculator-load.mjs', import.meta.url)), '8'],
                {
                    env: { ...process.env, CUTTLELY_QA_ORIGIN: 'http://127.0.0.1:' + port, CUTTLELY_QA_TOKEN: token, FIXTURE_MODE: mode },
                    stdio: ['ignore', 'pipe', 'pipe']
                }
            )
            const exit = once(child, 'exit')
            const lines = createInterface({ input: child.stdout })
            let errors = ''
            child.stderr.on('data', (chunk) => {
                errors += chunk
            })
            try {
                if (mode === 'distinct') {
                    const result = await Promise.race([once(lines, 'line').then(([line]) => JSON.parse(line)), exit.then(() => null)])
                    assert.ok(result, 'eight actual simultaneous connections to distinct destinations should be accepted')
                    assert.deepEqual([result.tcpConnections, result.verified, result.recorded], [8, 8, 8])
                    assert.ok(result.peakRequestsOnWire >= 2)
                    assert.equal(endpoints.size, 8)
                    assert.equal(localPorts.size, 1)
                    assert.deepEqual([...observedHosts], ['127.0.0.1:' + port])
                } else {
                    assert.equal((await exit)[0], 1)
                    assert.match(
                        errors,
                        mode === 'shared' ? /Expected one TCP connection per chat/ : /Calculator TCP connection could not be verified/
                    )
                    if (mode === 'shared') assert.equal(localPorts.size, 2)
                }
            } finally {
                if (child.exitCode === null && !child.signalCode) child.kill()
                await exit
                lines.close()
            }
        }
    }
)
