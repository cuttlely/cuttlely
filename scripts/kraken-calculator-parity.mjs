// Run once per matching load/worker configuration. See the native runtime guide for the manifest format.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const released = 'bb1191321688de52a405dfb88ab43826250c814f'
const hash = /^[0-9a-f]{64}$/
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
const phases = ['fresh', 'warm']

function measure(rows) {
    const times = rows.flatMap((r) => r.turnDurationsMs)
    const headers = rows.flatMap((r) => r.headerDurationsMs)
    const pings = rows.flatMap((r) => r.pingDurationsMs)
    const rate = (r) => (r.verified * 1000) / r.wallMs
    return {
        completed: times.length,
        p50Ms: quantile(times, 0.5),
        p95Ms: quantile(times, 0.95),
        turnsPerSecond: (times.length * 1000) / rows.reduce((total, r) => total + r.wallMs, 0),
        headerP95Ms: quantile(headers, 0.95),
        pingP95Ms: quantile(pings, 0.95),
        perRound: rows.map((r) => ({ p95Ms: quantile(r.turnDurationsMs, 0.95), turnsPerSecond: rate(r) }))
    }
}

export function compareCalculatorRounds(rounds) {
    assert.ok(Array.isArray(rounds) && [4, 8].includes(rounds.length), 'Provide two or four paired repeats.')
    const config = rounds[0].config
    for (const field of ['resources', 'database', 'seed', 'ingress', 'provider', 'settings'])
        assert.ok(typeof config?.[field] === 'string' && config[field].trim(), 'Missing matched configuration field: ' + field)
    assert.ok([1, 8, 32].includes(config.clients) && [1, 2, 4].includes(config.workers), 'Choose a supported client and worker count.')
    const candidate = rounds.find((r) => r.engine === 'native')?.revision
    assert.ok(/^(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/.test(candidate) && candidate !== released, 'Identify the candidate revision.')
    const first = rounds[0].engine
    assert.ok(['bundled', 'native'].includes(first), 'Unknown engine.')
    const second = first === 'bundled' ? 'native' : 'bundled'
    const order = [first, second, second, first]
    const samples = new Set()
    const deployments = new Set()
    const client = rounds[0].rows[0]?.clientSha256
    assert.ok(typeof client === 'string' && hash.test(client), 'Missing client hash.')
    for (const [i, round] of rounds.entries()) {
        assert.equal(round.engine, order[i % 4], 'Run fresh services in a balanced order.')
        assert.equal(round.revision, round.engine === 'bundled' ? released : candidate, 'Mixed engine revisions.')
        assert.deepEqual(round.config, config, 'Measured configurations differ.')
        assert.ok(
            typeof round.deployment === 'string' && round.deployment.trim() && !deployments.has(round.deployment),
            'Identify each fresh service and database restore.'
        )
        deployments.add(round.deployment)
        assert.deepEqual(
            round.rows.map((r) => r.cohort),
            phases,
            'Missing fresh or warm cohort.'
        )
        const id = round.rows[0].sampleId
        assert.ok(typeof id === 'string' && id.length > 0 && !samples.has(id), 'Repeated or missing load sample.')
        samples.add(id)
        for (const r of round.rows) {
            assert.equal(r.sampleId, id, 'Fresh and warm must reuse the same chats.')
            assert.equal(r.clientSha256, client, 'Run the same load client on both engines.')
            assert.equal(r.engine, round.engine, 'Runtime trace disagrees with the declared engine.')
            assert.equal(r.submitted, config.clients, 'Submitted load differs.')
            assert.equal(r.verified, config.clients, 'Missing verified answer.')
            assert.equal(r.recorded, config.clients, 'Missing matching run receipt.')
            assert.equal(r.tcpConnections, config.clients, 'Expected distinct connections.')
            assert.equal(r.peakRequestsOnWire, config.clients, 'The full requested load did not overlap on the wire.')
            assert.ok(Number.isInteger(r.peakOpenSseResponses) && r.peakOpenSseResponses >= 1 && r.peakOpenSseResponses <= config.clients)
            assert.ok(Number.isFinite(r.wallMs) && r.wallMs > 0, 'Missing elapsed time.')
            for (const times of [r.turnDurationsMs, r.headerDurationsMs, r.pingDurationsMs])
                assert.ok(
                    Array.isArray(times) && times.length > 0 && times.every((ms) => Number.isFinite(ms) && ms >= 0),
                    'Invalid timings.'
                )
            assert.equal(r.turnDurationsMs.length, config.clients)
            assert.equal(r.headerDurationsMs.length, config.clients)
            assert.equal(r.ping?.http200, r.pingDurationsMs.length)
            assert.ok(r.turnDurationsMs.every((ms, index) => ms > 0 && r.headerDurationsMs[index] <= ms && ms <= r.wallMs))
        }
    }
    const cohorts = phases.map((cohort, i) => {
        const group = (engine) => measure(rounds.filter((r) => r.engine === engine).map((r) => r.rows[i]))
        const bundled = group('bundled'),
            native = group('native')
        const latencyPass = native.p95Ms <= bundled.p95Ms
        const throughputPass = native.turnsPerSecond >= bundled.turnsPerSecond
        return { cohort, bundled, native, latencyPass, throughputPass }
    })
    return {
        passed: cohorts.every((r) => r.latencyPass && r.throughputPass),
        config,
        released,
        candidate,
        client,
        repeats: rounds.length / 2,
        cohorts
    }
}

export function compareCalculatorMatrix(groups) {
    const cells = groups.map(compareCalculatorRounds)
    const configurations = cells.map(({ config }) => [config.clients, config.workers]).sort(([a, b], [c, d]) => a - c || b - d)
    assert.deepEqual(
        configurations,
        [
            [1, 1],
            [8, 1],
            [32, 1],
            [32, 2],
            [32, 4]
        ],
        'Provide each required client and worker count once.'
    )
    const { candidate, client } = cells[0]
    for (const cell of cells) {
        assert.equal(cell.candidate, candidate, 'The performance matrix requires a single tested candidate.')
        assert.equal(cell.client, client, 'The performance matrix requires the same load client.')
    }
    return { passed: cells.every((cell) => cell.passed), released, candidate, client, cells }
}

function loadRounds(manifest) {
    return JSON.parse(fs.readFileSync(manifest, 'utf8')).rounds.map(({ report, ...metadata }) => {
        const filename = path.resolve(path.dirname(manifest), report)
        return {
            ...metadata,
            rows: fs
                .readFileSync(filename, 'utf8')
                .trim()
                .split(/\r?\n/)
                .map((line) => JSON.parse(line))
        }
    })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const args = process.argv.slice(2)
    const matrix = args[0] === '--matrix'
    assert.ok(matrix ? args.length === 6 : args.length === 1, 'Provide one manifest, or --matrix followed by all five manifests.')
    const result = matrix ? compareCalculatorMatrix(args.slice(1).map(loadRounds)) : compareCalculatorRounds(loadRounds(args[0]))
    console.log(JSON.stringify(result, null, 2))
    if (!result.passed) process.exitCode = 1
}
