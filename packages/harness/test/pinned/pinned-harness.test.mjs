import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, test } from 'node:test'
import { isAnalystQueryTool } from '../../context.mjs'
import {
    beginAnalystCalls,
    endAnalystCalls,
    noteAnalystGatewayCall,
    recordAnalystResult,
    resetAnalystCapture,
    sqlTraceFields,
    takeAnalystResults
} from '../../analyst-capture.mjs'
import { analystResultJson, withAnalystScope } from '../../runtime/analyst-store.mjs'
import { publicToolStep } from '../../trace.mjs'
import { refuseSqlTools } from '../../gateway.mjs'
import { ANALYST_TOOL_REQUIRED, ANALYST_TOOL_REQUIRED_WITH_PINS, SPECIALIST_REPAIR_ONCE, specialistSoul } from '../../profile.mjs'
import {
    PINNED_MISSING_ERROR,
    PINNED_OFF_ERROR,
    PINNED_QUERY_GUIDANCE,
    PINNED_TOOL_RE,
    assertPinnedQueryRoster,
    capturePinnedParams,
    isPinnedToolName,
    pinnedQueriesEnabled,
    pinnedToolRefusal
} from '../../pinned-names.mjs'
import { HarnessError } from '../../errors.mjs'
import { syncHarnessFromFlow } from '../../sync-from-flow.mjs'
import { deleteHarness } from '../../store.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ZZ-TEST-pq-node-'))
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'runtime')
after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
afterEach(() => {
    resetAnalystCapture()
    delete process.env.CUTTLELY_PINNED_QUERIES
})

const analyst = {
    name: 'analyst',
    instructions: 'Query the demo bakery warehouse.',
    mcpServers: [{ nodeName: 'postgreSQLMCP', credential: 'ZZ-TEST-cred' }]
}

function withPin(env) {
    return {
        ...analyst,
        mcpServers: [
            {
                nodeName: 'postgreSQLMCP',
                credential: 'ZZ-TEST-cred',
                inputs: { pinnedQueries: JSON.stringify([{ name: 'pq_revenue', testedStamp: 'ab'.repeat(32) }]) }
            }
        ],
        ...env
    }
}

test('pinned tool names match the shared pattern without backtracking', () => {
    const samples = [
        'pq_a',
        'pq_',
        '__pq_',
        '__pq_a',
        'x__pq_a',
        'x__pq_a-b',
        'a-b__pq_c',
        'pq_a__pq_b',
        'pq_a-b',
        '__pq__pq_',
        'MCP__Data__pq_x',
        ' pq_a ',
        '',
        'pq',
        '_pq_a',
        'x_pq_a'
    ]
    const alphabet = ['_', 'p', 'q', 'a', '-', '__pq_', 'pq_']
    for (let i = 0; i < 2000; i++) {
        let text = ''
        for (let j = (i * 7) % 6; j >= 0; j--) text += alphabet[(i * 31 + j * 17) % alphabet.length]
        samples.push(text)
    }
    for (const name of samples) {
        assert.equal(isPinnedToolName(name), PINNED_TOOL_RE.test(name.trim().toLowerCase()), JSON.stringify(name))
    }
    const hostile = 'pq_' + '__pq_'.repeat(50000) + '-'
    const started = Date.now()
    assert.equal(isPinnedToolName(hostile), false)
    assert.ok(Date.now() - started < 500)
})

test('pq_ tools match capture predicates', () => {
    assert.equal(String(PINNED_TOOL_RE), '/(^|__)pq_[a-z0-9_]+$/')
    assert.equal(isPinnedToolName('pq_revenue'), true)
    assert.equal(isAnalystQueryTool('pq_revenue'), true)
    assert.equal(isAnalystQueryTool('mcp__data__pq_revenue'), true)
    assert.equal(isAnalystQueryTool('MCP__Data__pq_revenue'), true)
    assert.equal(isPinnedToolName('pq_'), false)
    assert.equal(isAnalystQueryTool('my_pq_revenue'), false)
    assert.equal(isAnalystQueryTool('query'), true)
    assert.equal(isAnalystQueryTool('tool_search'), false)
    const hash = 'cd'.repeat(32)
    const step = publicToolStep(
        {
            name: 'mcp__data__pq_revenue',
            status: 'done',
            timings: { dbMs: 1, guardMs: 2, roundTrips: 3, serializeMs: 0.1 },
            sqlHash: hash,
            pinned: { id: 'ZZ-TEST-pin', name: 'pq_revenue', version: 1, hash, params: { region: 'east' }, rowCount: 1 },
            detail: JSON.stringify({
                result: JSON.stringify({ rows: [{ region: 'east' }], pinned: { id: 'ZZ-TEST-pin', name: 'pq_revenue', version: 1, hash } })
            })
        },
        { CUTTLELY_ANALYST_TRACE_PREVIEW: 'false' }
    )
    assert.equal(step.timings.dbMs, 1)
    assert.equal(step.timings.guardMs, 2)
    assert.equal(step.timings.roundTrips, 3)
    assert.equal(step.sqlHash, hash)
    assert.equal(step.sql, undefined)
    assert.equal(step.pinned.id, 'ZZ-TEST-pin')
    assert.equal(step.pinned.hash, hash)
    assert.equal(step.pinned.params.region, 'east')
    assert.equal(step.rowCount, 1)
})

test('pinned call serialises through analystResultJson with timing fields', async () => {
    const timings = []
    const hash = 'ab'.repeat(32)
    const text = await withAnalystScope(
        'ZZ-TEST-harness:ZZ-TEST-chat',
        async () => {
            timings.push({ dbMs: 3, guardMs: 1, roundTrips: 4, totalMs: 5, connectMs: 0, cuttlelyMs: 2, statementRuns: 1 })
            return analystResultJson({ rows: [{ region: 'east' }], pinned: { id: 'ZZ-TEST-pin', name: 'pq_revenue', version: 1, hash } })
        },
        { timings }
    )
    const body = JSON.parse(text)
    assert.equal(body.pinned.id, 'ZZ-TEST-pin')
    assert.equal(body.pinned.hash, hash)
    assert.equal(typeof timings.at(-1).serializeMs, 'number')
    assert.equal(timings.at(-1).dbMs, 3)
    assert.equal(timings.at(-1).guardMs, 1)
    assert.equal(timings.at(-1).roundTrips, 4)
})

test('non-analyst bridge mcp__data__pq_ captures rows and timings', () => {
    const scope = { harness: 'ZZ-TEST-harness', specialist: 'ZZ-TEST-data', chatId: 'ZZ-TEST-chat' }
    const name = 'mcp__data__pq_revenue'
    assert.equal(isAnalystQueryTool(name), true)
    beginAnalystCalls(scope.harness, scope.specialist, scope.chatId)
    const callId = noteAnalystGatewayCall({ ...scope, toolName: name, pinned: { params: { region: 'east' } } })
    const timings = { dbMs: 4, guardMs: 1, roundTrips: 2, serializeMs: 0.2, totalMs: 6 }
    const pinned = { id: 'ZZ-TEST-pin', name: 'pq_revenue', version: 1, hash: 'ef'.repeat(32), params: { region: 'east' }, rowCount: 1 }
    recordAnalystResult({ ...scope, callId, result: { rows: [{ region: 'east' }], pinned }, timings, pinned })
    const [captured] = takeAnalystResults(scope)
    const step = publicToolStep(
        {
            name,
            status: 'done',
            ...captured.traceFields,
            timings: captured.timings,
            pinned: captured.pinned,
            detail: JSON.stringify({ result: JSON.stringify(captured.result) })
        },
        { CUTTLELY_ANALYST_TRACE_PREVIEW: 'true' }
    )
    assert.deepEqual(step.timings, timings)
    assert.equal(step.rowCount, 1)
    assert.equal(step.pinned.id, 'ZZ-TEST-pin')
    assert.equal(step.pinned.params.region, 'east')
    assert.equal(step.preview.rows[0][0], 'east')
    endAnalystCalls(scope.harness, scope.specialist, scope.chatId)
})

test('secure params are redacted and other values follow the preview switch', () => {
    const on = capturePinnedParams({ region: 'east', token: 'ZZ-TEST-secret' }, ['token'], true)
    const off = capturePinnedParams({ region: 'east', token: 'ZZ-TEST-secret' }, ['token'], false)
    assert.deepEqual(on, { region: 'east', token: '[redacted]' })
    assert.deepEqual(off, { token: '[redacted]' })
    assert.equal(JSON.stringify(off).includes('ZZ-TEST-secret'), false)
    assert.equal(JSON.stringify(on).includes('ZZ-TEST-secret'), false)
})

test('flag off: no pq_ tools and calls refused', () => {
    for (const value of [undefined, '', 'false', 'yes', 'on', 'TRUE']) {
        assert.equal(pinnedQueriesEnabled({ CUTTLELY_PINNED_QUERIES: value }), false)
    }
    assert.deepEqual(pinnedToolRefusal('pq_revenue', {}), { error: PINNED_OFF_ERROR, cuttlelyOutcome: 'expected' })
    const off = specialistSoul(withPin(), { DATABASE_TYPE: 'sqlite' })
    const plain = specialistSoul(analyst, { DATABASE_TYPE: 'sqlite' })
    assert.equal(off, plain)
    assert.equal(off.includes(PINNED_QUERY_GUIDANCE), false)
})

test('flag on, no pins: byte-identical tools, prompts, descriptions', () => {
    const envOff = { DATABASE_TYPE: 'sqlite', CUTTLELY_POSTGRES_URL: 'postgres://demo/warehouse' }
    const envOn = { ...envOff, CUTTLELY_PINNED_QUERIES: 'true' }
    assert.equal(specialistSoul(analyst, envOn), specialistSoul(analyst, envOff))
    const unstamped = {
        ...analyst,
        mcpServers: [
            {
                nodeName: 'postgreSQLMCP',
                credential: 'ZZ-TEST-cred',
                inputs: { pinnedQueries: JSON.stringify([{ name: 'pq_revenue' }]) }
            }
        ]
    }
    assert.equal(specialistSoul(unstamped, envOn), specialistSoul(analyst, envOff))
    assert.equal(specialistSoul(analyst, envOff).includes(ANALYST_TOOL_REQUIRED), true)
    assert.equal(specialistSoul(analyst, envOff).includes(SPECIALIST_REPAIR_ONCE), true)
})

test('prompts change only when a stamped pin is offered', () => {
    const env = { DATABASE_TYPE: 'sqlite', CUTTLELY_PINNED_QUERIES: 'true', CUTTLELY_POSTGRES_URL: 'postgres://demo/warehouse' }
    const soul = specialistSoul(withPin(), env)
    assert.equal(soul.includes(PINNED_QUERY_GUIDANCE), true)
    assert.equal(soul.includes(ANALYST_TOOL_REQUIRED_WITH_PINS), true)
    assert.equal(soul.includes(ANALYST_TOOL_REQUIRED), false)
    assert.equal(soul.includes('Do not rewrite a pinned query tool call as your own SQL.'), true)
    const isolated = {
        name: 'analyst',
        mcpServers: [
            {
                nodeName: 'postgreSQLMCP',
                inputs: { pinnedQueries: JSON.stringify([{ name: 'pq_revenue', testedStamp: 'ab'.repeat(32) }]) }
            }
        ]
    }
    const sqlite = { CUTTLELY_PINNED_QUERIES: 'true', DATABASE_TYPE: 'sqlite' }
    assert.equal(specialistSoul(isolated, sqlite), specialistSoul({ name: 'analyst', mcpServers: [{ nodeName: 'postgreSQLMCP' }] }, sqlite))
})

test('duplicate pinned names fail at sync with the flag on and are ignored with it off', async () => {
    const entry = { name: 'pq_revenue', testedStamp: '' }
    const roster = {
        specialists: [
            {
                name: 'analyst',
                mcpServers: [
                    { nodeName: 'postgreSQLMCP', inputs: { pinnedQueries: [entry] } },
                    { nodeName: 'postgreSQLMCP', inputs: { pinnedQueries: [{ name: 'pq_revenue' }] } }
                ]
            }
        ]
    }
    const on = { CUTTLELY_PINNED_QUERIES: 'true' }
    assert.doesNotThrow(() => assertPinnedQueryRoster(roster, {}))
    assert.doesNotThrow(() => assertPinnedQueryRoster(roster, { CUTTLELY_PINNED_QUERIES: '0' }))
    assert.throws(
        () => assertPinnedQueryRoster(roster, on),
        (error) => {
            assert.equal(error instanceof HarnessError, true)
            assert.equal(error.code, 'duplicate_pinned_query')
            assert.match(error.message, /pq_revenue/)
            assert.match(error.message, /analyst/)
            assert.match(error.message, /Rename one of them/)
            return true
        }
    )
    const separate = {
        specialists: [
            { name: 'analyst', mcpServers: [{ nodeName: 'postgreSQLMCP', inputs: { pinnedQueries: [entry] } }] },
            { name: 'other', mcpServers: [{ nodeName: 'postgreSQLMCP', inputs: { pinnedQueries: [entry] } }] }
        ]
    }
    assert.doesNotThrow(() => assertPinnedQueryRoster(separate, on))
    const pin = JSON.stringify([{ name: 'pq_revenue' }])
    const flowData = {
        nodes: [
            { id: 'chief', data: { name: 'harnessChief', inputs: { instructions: 'ZZ-TEST' } } },
            { id: 'model', data: { name: 'chatXai', category: 'Chat Models', label: 'ZZ-TEST model', inputs: {} } },
            { id: 'spec', data: { name: 'harnessSpecialist', inputs: { specialistName: 'analyst', instructions: 'ZZ-TEST' } } },
            {
                id: 'pg1',
                data: { name: 'postgreSQLMCP', category: 'Tools (MCP)', label: 'ZZ-TEST pg', inputs: { pinnedQueries: pin } }
            },
            {
                id: 'pg2',
                data: { name: 'postgreSQLMCP', category: 'Tools (MCP)', label: 'ZZ-TEST pg 2', inputs: { pinnedQueries: pin } }
            }
        ],
        edges: [
            { source: 'model', target: 'chief' },
            { source: 'pg1', target: 'spec' },
            { source: 'pg2', target: 'spec' }
        ]
    }
    const name = 'zztestpqdup'
    try {
        delete process.env.CUTTLELY_PINNED_QUERIES
        await syncHarnessFromFlow({ name, flowData, caller: { via: 'session' } })
        deleteHarness(name)
        process.env.CUTTLELY_PINNED_QUERIES = 'true'
        await assert.rejects(
            () => syncHarnessFromFlow({ name, flowData, caller: { via: 'session' } }),
            (error) => {
                assert.equal(error instanceof HarnessError, true)
                assert.equal(error.code, 'duplicate_pinned_query')
                assert.match(error.message, /pq_revenue/)
                return true
            }
        )
    } finally {
        deleteHarness(name)
    }
})

test('SQL-tool refusal does not drop pinned tools on this node', () => {
    const specs = [
        {
            name: 'pq_revenue',
            description: 'Run the pinned SQL for revenue.',
            inputSchema: { type: 'object', properties: { region: { type: 'string' } } }
        },
        { name: 'pq_orders', description: 'Orders', inputSchema: { type: 'object', properties: {} } }
    ]
    const refused = new Set()
    const kept = refuseSqlTools('ZZ-TEST', 'analyst', { nodeName: 'postgreSQLMCP' }, specs, refused, 'analyst')
    assert.deepEqual(
        kept.map((spec) => spec.name),
        ['pq_revenue', 'pq_orders']
    )
    assert.equal(refused.size, 0)
    const dropped = new Set()
    const other = refuseSqlTools('ZZ-TEST', 'analyst', { nodeName: 'customMCP' }, specs, dropped, 'other')
    assert.deepEqual(
        other.map((spec) => spec.name),
        ['pq_orders']
    )
    assert.equal(dropped.has('pq_revenue'), true)
    assert.equal(dropped.has('pq_orders'), false)
})

test('a free query step records the pin names offered on that node', () => {
    const step = publicToolStep(
        {
            name: 'mcp__data__query',
            status: 'done',
            freeSqlWithPin: ['pq_revenue', 'pq_orders'],
            sqlHash: 'ab'.repeat(32),
            detail: JSON.stringify({ result: JSON.stringify({ rows: [{ region: 'east' }] }) })
        },
        { CUTTLELY_ANALYST_TRACE_PREVIEW: 'false' }
    )
    assert.deepEqual(step.freeSqlWithPin, ['pq_revenue', 'pq_orders'])
    const pinStep = publicToolStep(
        {
            name: 'pq_revenue',
            status: 'done',
            freeSqlWithPin: ['pq_revenue'],
            detail: JSON.stringify({ result: JSON.stringify({ rows: [] }) })
        },
        {}
    )
    assert.equal(pinStep.freeSqlWithPin, undefined)
})

test('gateway refuses a pinned call when the flag is off and strips builder SQL from the model result', async () => {
    const { saveHarness, deleteHarness } = await import('../../store.mjs')
    const { registerProfileToken, forgetProfileToken, setGatewayContext, startGateway } = await import('../../gateway.mjs')
    const name = 'zz-test-pq-gateway'
    const specialist = 'data'
    const called = []
    const sql = 'SELECT region FROM public.demo_sales LIMIT 5'
    const prior = setGatewayContext(async () => ({
        flowOptions: { appDataSource: {} },
        loadNode: async () =>
            class {
                async init() {
                    return [
                        {
                            name: 'query',
                            description: 'ZZ-TEST query',
                            schema: { type: 'object', properties: { sql: { type: 'string' } } },
                            async invoke(args) {
                                called.push(['query', args])
                                return JSON.stringify({ rows: [{ region: 'east' }] })
                            }
                        },
                        {
                            name: 'pq_revenue',
                            description: 'ZZ-TEST pin',
                            schema: { type: 'object', properties: { region: { type: 'string' } } },
                            async invoke(args) {
                                called.push(['pq_revenue', args])
                                return JSON.stringify({
                                    rows: [{ region: 'east' }],
                                    pinned: { id: 'ZZ-TEST-pin', name: 'pq_revenue', version: 1, hash: 'ab'.repeat(32) },
                                    sqlHash: sqlTraceFields(sql).sqlHash,
                                    _cuttlelyTraceSql: sql
                                })
                            }
                        }
                    ]
                }
            }
    }))
    const token = crypto.randomBytes(32).toString('base64url')
    let gateway
    try {
        saveHarness(
            {
                name,
                chief: { instructions: 'ZZ-TEST-route', model: { nodeName: 'ZZ-TEST-model' } },
                specialists: [
                    {
                        name: specialist,
                        instructions: 'ZZ-TEST-query',
                        mcpServers: [
                            {
                                nodeId: 'ZZ-TEST-node',
                                nodeName: 'postgreSQLMCP',
                                category: 'Tools (MCP)',
                                inputs: {
                                    pinnedQueries: JSON.stringify([
                                        { name: 'pq_revenue', params: [{ name: 'token', secure: true }, { name: 'region' }] }
                                    ])
                                }
                            }
                        ]
                    }
                ]
            },
            { overwrite: true }
        )
        registerProfileToken({
            token,
            harnessName: name,
            specialistName: specialist,
            profileName: `${name}--data`,
            modelKey: 'ZZ-TEST-key'
        })
        gateway = await startGateway({ port: 0 })
        const call = async (toolName, args) => {
            const response = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/call`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ name: toolName, arguments: args, scope: `${name}:ZZ-TEST-chat` })
            })
            return { status: response.status, body: await response.json() }
        }
        delete process.env.CUTTLELY_PINNED_QUERIES
        const refused = await call('pq_revenue', { region: 'east', token: 'ZZ-TEST-secret' })
        assert.equal(refused.status, 200)
        assert.deepEqual(JSON.parse(refused.body.result), { error: PINNED_OFF_ERROR, cuttlelyOutcome: 'expected' })
        assert.deepEqual(called, [])
        process.env.CUTTLELY_PINNED_QUERIES = 'true'
        process.env.CUTTLELY_ANALYST_TRACE_PREVIEW = 'true'
        beginAnalystCalls(name, specialist, 'ZZ-TEST-chat')
        const allowed = await call('pq_revenue', { region: 'east', token: 'ZZ-TEST-secret' })
        assert.equal(allowed.status, 200)
        const shown = JSON.parse(allowed.body.result)
        assert.equal(shown._cuttlelyTraceSql, undefined)
        assert.equal(JSON.stringify(shown).includes('SELECT region'), false)
        assert.equal(shown.pinned.id, 'ZZ-TEST-pin')
        const [captured] = takeAnalystResults({ harness: name, specialist, chatId: 'ZZ-TEST-chat' })
        assert.equal(captured.traceFields.sqlHash, sqlTraceFields(sql).sqlHash)
        assert.equal(captured.traceFields.sql, sql)
        assert.equal(captured.pinned.params.token, '[redacted]')
        assert.equal(captured.pinned.params.region, 'east')
        assert.equal(JSON.stringify(captured).includes('ZZ-TEST-secret'), false)
        const free = await call('query', { sql })
        assert.equal(free.status, 200)
        const [freeCapture] = takeAnalystResults({ harness: name, specialist, chatId: 'ZZ-TEST-chat' })
        assert.equal(freeCapture.pinned, undefined)
        assert.deepEqual(freeCapture.freeSqlWithPin, ['pq_revenue'])
        const missing = await call('pq_missing', {})
        assert.equal(missing.status, 200)
        assert.deepEqual(JSON.parse(missing.body.result), { error: PINNED_MISSING_ERROR, cuttlelyOutcome: 'expected' })
        assert.deepEqual(
            called.map((item) => item[0]),
            ['pq_revenue', 'query']
        )
        endAnalystCalls(name, specialist, 'ZZ-TEST-chat')
    } finally {
        endAnalystCalls(name, specialist, 'ZZ-TEST-chat')
        resetAnalystCapture()
        forgetProfileToken(`${name}--data`)
        if (gateway) await gateway.close()
        setGatewayContext(prior)
        deleteHarness(name)
        delete process.env.CUTTLELY_PINNED_QUERIES
        delete process.env.CUTTLELY_ANALYST_TRACE_PREVIEW
    }
})

test('a missing pinned tool is refused instead of running another tool', () => {
    assert.deepEqual(pinnedToolRefusal('pq_missing', { CUTTLELY_PINNED_QUERIES: '1' }), {
        error: PINNED_MISSING_ERROR,
        cuttlelyOutcome: 'expected'
    })
})
