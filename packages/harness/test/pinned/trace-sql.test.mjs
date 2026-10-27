import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { afterEach, test } from 'node:test'
import fs from 'node:fs'
import {
    analystStartCapture,
    analystSqlTrace,
    beginAnalystCalls,
    endAnalystCalls,
    noteAnalystGatewayCall,
    recordAnalystResult,
    resetAnalystCapture,
    sqlTraceFields,
    takeAnalystResults,
    dropAnalystCapture
} from '../../analyst-capture.mjs'
import {
    publicToolStep,
    snapshotSpecialist,
    reduceHarnessEvent,
    emptyTrace,
    buildRunTrace,
    traceQuestionForCaption,
    TRACE_JSON_LIMIT
} from '../../trace.mjs'
import { isAnalystQueryTool } from '../../context.mjs'
import { analystBridgeQueryName, hermesMcpToolName } from '../../profile.mjs'

const scope = { harness: 'ZZ-TEST-trace', specialist: 'ZZ-TEST-data', chatId: 'ZZ-TEST-chat' }
const off = { CUTTLELY_ANALYST_TRACE_PREVIEW: 'false' }
const on = { CUTTLELY_ANALYST_TRACE_PREVIEW: 'true' }
const sql = "SELECT 'ZZ-TEST-value' AS value;"
afterEach(() => resetAnalystCapture())

test('sqlHash always present', () => {
    const expected = crypto.createHash('sha256').update("SELECT 'ZZ-TEST-value' AS value").digest('hex')
    assert.deepEqual(sqlTraceFields("  SELECT\n'ZZ-TEST-value' AS value; ;  "), { sqlHash: expected })
    assert.equal(expected.length, 64)
})

test('preview off hides sql', () => {
    const fields = analystSqlTrace({ ...scope, sql }, off)
    assert.deepEqual(publicToolStep({ name: 'mcp__data__query', status: 'done', ...fields }, off), {
        name: 'mcp__data__query',
        status: 'done',
        sqlHash: sqlTraceFields(sql).sqlHash
    })
    const preview = sqlTraceFields(sql, { preview: true })
    assert.equal(publicToolStep({ name: 'query', ...preview }, off).sql, undefined)
})

test('sql text capped at 4 KB with sqlTruncated', () => {
    for (const character of ['é', '漢', '😀']) {
        const text = `SELECT '${character.repeat(4096)}'`
        const fields = sqlTraceFields(text, { preview: true })
        assert.ok(Buffer.byteLength(fields.sql) <= 4096)
        assert.ok(Buffer.byteLength(fields.sql) >= 4093)
        assert.equal(fields.sqlTruncated, true)
        assert.ok(!fields.sql.includes('\ufffd'))
        assert.equal(fields.sqlHash, sqlTraceFields(text).sqlHash)
    }
    assert.equal(sqlTraceFields('x'.repeat(4096), { preview: true }).sqlTruncated, undefined)
    assert.equal(sqlTraceFields('x'.repeat(4097), { preview: true }).sqlTruncated, true)
})

test('refused call keeps sql', () => {
    for (const status of ['failed', 'done']) {
        const fields = analystSqlTrace({ ...scope, sql }, on)
        const step = publicToolStep({ name: 'mcp__data__query', status, detail: '{"error":"ZZ-TEST-refused"}', ...fields }, on)
        assert.equal(step.sql, sql)
        assert.equal(step.sqlHash, sqlTraceFields(sql).sqlHash)
        assert.equal(step.detail, '{"error":"ZZ-TEST-refused"}')
    }
})

test('page call carries original hash', () => {
    beginAnalystCalls(scope.harness, scope.specialist, scope.chatId)
    const callId = noteAnalystGatewayCall({ ...scope, sql })
    recordAnalystResult({ ...scope, callId, result: { rows: [], cursor: 'ZZ-TEST-cursor' } })
    endAnalystCalls(scope.harness, scope.specialist, scope.chatId)
    const page = analystSqlTrace({ ...scope, cursor: 'ZZ-TEST-cursor' }, on)
    assert.deepEqual(page, sqlTraceFields(sql, { preview: true }))
    assert.deepEqual(analystSqlTrace({ ...scope, cursor: 'ZZ-TEST-cursor' }, off), sqlTraceFields(sql))
    dropAnalystCapture(scope)
    assert.notEqual(analystSqlTrace({ ...scope, cursor: 'ZZ-TEST-cursor' }, on).sqlHash, page.sqlHash)
})

test('non-analyst bridge captures stream start, SQL and timings', () => {
    const events = []
    beginAnalystCalls(scope.harness, scope.specialist, scope.chatId, (data) => events.push(data))
    const name = 'mcp__data__query'
    assert.equal(isAnalystQueryTool(name), true)
    const callId = noteAnalystGatewayCall({ ...scope, sql, toolName: name })
    assert.equal(events[0].sql, sql)
    assert.equal(events[0].sqlHash, sqlTraceFields(sql).sqlHash)
    const timings = { totalMs: 9, dbMs: 4, connectMs: 1, cuttlelyMs: 4, statementRuns: 1, roundTrips: 2 }
    recordAnalystResult({ ...scope, callId, result: { rows: [{ value: 'ZZ-TEST-value' }] }, timings })
    const [captured] = takeAnalystResults(scope)
    const step = publicToolStep({ name, status: 'done', ...captured.traceFields, timings: captured.timings }, on)
    assert.deepEqual(step.timings, timings)
    assert.equal(step.sqlHash, events[0].sqlHash)
    const trace = reduceHarnessEvent(emptyTrace(), { type: 'tool', phase: 'start', specialist: scope.specialist, ...events[0] })
    assert.equal(trace.specialists[0].tools[0].sqlHash, events[0].sqlHash)
    assert.equal(trace.specialists[0].tools[0].sql, sql)
})

test('existing run trace unchanged apart from added fields', () => {
    // Recorded with ae8394e7 trace.mjs, preview off and on. No git history is needed in CI.
    const fixtures = JSON.parse(fs.readFileSync(new URL('./trace-golden.json', import.meta.url)))
    for (const { input, env, expected, expectedRun } of fixtures) {
        const after = snapshotSpecialist({
            ...input,
            env,
            tools: input.tools.map((tool) =>
                isAnalystQueryTool(tool.name) ? { ...tool, ...sqlTraceFields(sql, { preview: true }) } : tool
            )
        })
        assert.equal(after.tools[0].sqlHash, sqlTraceFields(sql).sqlHash)
        const run = buildRunTrace({ harness: 'ZZ-TEST-trace', agents: [{ name: input.name, ...after }], question: 'ZZ-TEST-question' })
        assert.equal(run.specialists[0].tools[0].sqlHash, sqlTraceFields(sql).sqlHash)
        for (const tools of [after.tools, run.specialists[0].tools]) {
            for (const tool of tools) for (const field of ['sqlHash', 'sql', 'sqlTruncated']) delete tool[field]
        }
        assert.equal(JSON.stringify(after), JSON.stringify(expected))
        assert.equal(JSON.stringify(run), JSON.stringify(expectedRun))
    }
})

test('SQL preview applies existing secret redaction before its byte cap', () => {
    const fields = sqlTraceFields("SELECT 'sk-ZZTESTabcdefgh1234'", { preview: true })
    assert.equal(fields.sql, "SELECT '[redacted]'")
    assert.equal(fields.sqlHash, sqlTraceFields("SELECT 'sk-ZZTESTabcdefgh1234'").sqlHash)
})

test('stream start joins gateway SQL with the public bridge name in either arrival order', () => {
    for (const gatewayFirst of [true, false]) {
        const events = []
        const capture = analystStartCapture((event) => events.push(event))
        const start = { phase: 'start', specialist: scope.specialist, name: 'mcp__data__query', detail: 'ZZ-TEST-original-preview' }
        const metadata = { name: 'query', ...sqlTraceFields(sql, { preview: true }) }
        if (gatewayFirst) {
            capture.gatewayStarted(metadata)
            capture.hermesStarted(start)
        } else {
            capture.hermesStarted(start)
            capture.gatewayStarted(metadata)
        }
        capture.flush()
        assert.deepEqual(events, [{ ...start, ...metadata, name: start.name }])
    }
})

test('ZZ-TEST-raw MCP query emits its start immediately', () => {
    const events = []
    const specialist = { name: scope.specialist, mcpServers: [{ command: 'ZZ-TEST-mcp', args: [] }] }
    assert.equal(analystBridgeQueryName(specialist), '')
    const capture = analystStartCapture((event) => events.push(event), { gatewayName: analystBridgeQueryName(specialist) })
    const start = { phase: 'start', specialist: scope.specialist, name: 'mcp__ZZ_TEST_search__query' }
    capture.hermesStarted(start)
    assert.deepEqual(events, [start])
    capture.flush()
    assert.deepEqual(events, [start])
    assert.equal(
        analystBridgeQueryName({ name: scope.specialist, mcpServers: [{ nodeName: 'postgreSQLMCP', category: 'Tools (MCP)' }] }),
        `mcp__${scope.specialist.replace(/[^A-Za-z0-9_]/g, '_')}__query`
    )
})

test('ZZ-TEST- a hyphenated specialist pairs its bridge query start under the name Hermes gives it', () => {
    const bridged = (name) => ({ name, mcpServers: [{ nodeName: 'postgreSQLMCP', category: 'Tools (MCP)' }] })
    // Expected values come from mcp_prefixed_tool_name in hermes/tools/mcp_tool_schema.py.
    assert.equal(analystBridgeQueryName(bridged('sales-data')), 'mcp__sales_data__query')
    assert.equal(hermesMcpToolName('zz-test.db', 'query'), 'mcp__zz_test_db__query')
    const long = `zz-test-${'x'.repeat(60)}`
    assert.equal(analystBridgeQueryName(bridged(long)), 'mcp__zz_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx_445cf378')
    assert.equal(analystBridgeQueryName(bridged(long)).length, 64)
    const events = []
    const capture = analystStartCapture((event) => events.push(event), { gatewayName: analystBridgeQueryName(bridged('sales-data')) })
    const start = { phase: 'start', specialist: 'sales-data', name: 'mcp__sales_data__query', callId: 'ZZ-TEST-call-1' }
    capture.hermesStarted(start)
    assert.deepEqual(events, [])
    const metadata = { name: 'query', ...sqlTraceFields(sql, { preview: true }) }
    capture.gatewayStarted(metadata)
    assert.deepEqual(events, [{ ...start, ...metadata, name: start.name, callId: start.callId }])
})

test('page hash remains available while other live cursors accumulate', () => {
    for (let index = 0; index <= 200; index += 1) {
        recordAnalystResult({ ...scope, sql: `${sql} -- ZZ-TEST-${index}`, result: { rows: [], cursor: `ZZ-TEST-cursor-${index}` } })
    }
    assert.equal(analystSqlTrace({ ...scope, cursor: 'ZZ-TEST-cursor-0' }, off).sqlHash, sqlTraceFields(`${sql} -- ZZ-TEST-0`).sqlHash)
})

test('many long SQL previews keep the trace under the history limit', () => {
    for (const [count, character] of [
        [5, 'x'],
        [12, '"'],
        [12, '😀']
    ]) {
        const tools = Array.from({ length: count }, (_, index) =>
            publicToolStep(
                {
                    name: 'query',
                    status: 'done',
                    ...sqlTraceFields(character.repeat(character === '😀' ? 1024 : 4096), { preview: true }),
                    timings: { totalMs: index + 1, dbMs: index }
                },
                on
            )
        )
        const original = structuredClone(tools)
        const input = { harness: scope.harness, agents: [{ name: scope.specialist, tools }], question: 'ZZ-TEST-question' }
        const trace = buildRunTrace(input)
        assert.ok(JSON.stringify(trace).length <= TRACE_JSON_LIMIT)
        assert.deepEqual(buildRunTrace(input), trace)
        assert.deepEqual(tools, original)
        const saved = trace.specialists[0].tools
        assert.ok(saved.some((tool, index) => tool.sql !== original[index].sql))
        if (count === 12) assert.ok(saved.some((tool) => tool.sql === undefined))
        saved.forEach((tool, index) => {
            assert.equal(tool.sqlHash, original[index].sqlHash)
            assert.deepEqual(tool.timings, original[index].timings)
            if (tool.sql !== original[index].sql) assert.equal(tool.sqlTruncated, true)
            if (tool.sql !== undefined) {
                assert.ok(original[index].sql.startsWith(tool.sql))
                assert.ok(!tool.sql.includes('\ufffd'))
                assert.equal(Buffer.from(tool.sql).toString('utf8'), tool.sql)
            }
        })
    }
})

test('ZZ-TEST-eight 4 KB queries preserve the question and every hash', () => {
    const question = 'ZZ-TEST-show all demo_sales rows'
    const tools = Array.from({ length: 8 }, (_, index) => ({
        name: 'query',
        status: 'done',
        ...sqlTraceFields(`SELECT * FROM demo_sales /* ZZ-TEST-${index} ${'x'.repeat(4096)} */`, { preview: true })
    }))
    const trace = buildRunTrace({ harness: scope.harness, agents: [{ name: scope.specialist, tools }], question })
    assert.equal(trace.question, question)
    assert.equal(traceQuestionForCaption(trace), question)
    assert.deepEqual(
        trace.specialists[0].tools.map((tool) => tool.sqlHash),
        tools.map((tool) => tool.sqlHash)
    )
    assert.ok(JSON.stringify(trace).length <= TRACE_JSON_LIMIT)
})

test('ZZ-TEST-parallel queries keep their own SQL and call ids in reverse completion order', () => {
    const events = []
    const capture = analystStartCapture((event) => events.push(event))
    const starts = [1, 2].map((index) => ({ name: 'mcp__data__query', callId: `ZZ-TEST-call-${index}`, phase: 'start' }))
    const calls = starts.map((start, index) => ({
        name: 'query',
        callId: start.callId,
        ...sqlTraceFields(`SELECT * FROM demo_sales WHERE id = ${index + 1}`, { preview: true })
    }))
    starts.forEach(capture.hermesStarted)
    capture.gatewayStarted(calls[1], { pairById: true })
    capture.gatewayStarted(calls[0], { pairById: true })
    capture.flush()
    assert.deepEqual(
        events,
        [1, 0].map((index) => ({ ...starts[index], ...calls[index], name: starts[index].name }))
    )
    const fallback = analystStartCapture((event) => events.push(event))
    fallback.hermesStarted(starts[0])
    fallback.gatewayStarted({ name: 'query', ...sqlTraceFields(sql) })
    assert.equal(events[2].callId, starts[0].callId)
    // Hermes sent no call id to the gateway, so the gateway id is a sequence id and the pair is made by name.
    const sequence = analystStartCapture((event) => events.push(event))
    sequence.hermesStarted(starts[1])
    sequence.gatewayStarted({ name: 'query', callId: '1:ZZ-TEST-seq', ...sqlTraceFields(sql) }, { pairById: false })
    assert.equal(events.length, 4)
    assert.equal(events[3].callId, starts[1].callId)
    assert.equal(events[3].sqlHash, sqlTraceFields(sql).sqlHash)
})
