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
import { publicToolStep, snapshotSpecialist, reduceHarnessEvent, emptyTrace, buildRunTrace } from '../../trace.mjs'
import { isAnalystQueryTool } from '../../context.mjs'

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
        for (const tool of after.tools) for (const field of ['sqlHash', 'sql', 'sqlTruncated']) delete tool[field]
        assert.equal(JSON.stringify(after), JSON.stringify(expected))
        const run = buildRunTrace({ harness: 'ZZ-TEST-trace', agents: [{ name: input.name, ...after }], question: 'ZZ-TEST-question' })
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

test('a raw MCP start without gateway arguments retains its lifecycle event', () => {
    const events = []
    const capture = analystStartCapture((event) => events.push(event))
    const start = { phase: 'start', specialist: scope.specialist, name: 'mcp__ZZ-TEST-search__query' }
    capture.hermesStarted(start)
    capture.flush()
    assert.deepEqual(events, [start])
})

test('page hash remains available while other live cursors accumulate', () => {
    for (let index = 0; index <= 200; index += 1) {
        recordAnalystResult({ ...scope, sql: `${sql} -- ZZ-TEST-${index}`, result: { rows: [], cursor: `ZZ-TEST-cursor-${index}` } })
    }
    assert.equal(analystSqlTrace({ ...scope, cursor: 'ZZ-TEST-cursor-0' }, off).sqlHash, sqlTraceFields(`${sql} -- ZZ-TEST-0`).sqlHash)
})
