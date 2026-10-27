import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ZZ-TEST-trace-'))
process.env.CUTTLELY_ANALYST_TRACE_PREVIEW = 'true'
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'runtime')
const { saveHarness, deleteHarness, getHarness } = await import('../../store.mjs')
const { registerProfileToken, forgetProfileToken, setGatewayContext, startGateway } = await import('../../gateway.mjs')
const {
    analystStartCapture,
    beginAnalystCalls,
    endAnalystCalls,
    latestAnalystCursor,
    recordAnalystResult,
    resetAnalystCapture,
    sqlTraceFields,
    takeAnalystResults
} = await import('../../analyst-capture.mjs')

const { chiefInstructions, specialistSoul, hermesToolsetsFor } = await import('../../profile.mjs')
const { applyAnalystPageRoute, hermesToolEvent, logToolEvent } = await import('../../run.mjs')
// Captured from ae8394e7 gateway, profile and run modules with the same in-process node stub.
const golden = JSON.parse(fs.readFileSync(new URL('./no-pins-golden.json', import.meta.url)))

// In-process node stub: no database or agent runtime is started.
test('gateway captures refused, failed and paged statements before execution on a data bridge', async () => {
    const name = 'zz-test-trace-gateway'
    const specialist = 'data'
    const chatId = 'ZZ-TEST-chat'
    const sql = golden.sql
    const received = []
    const result = { rows: [{ value: 'ZZ-TEST-value' }], cursor: 'ZZ-TEST-cursor' }
    const token = crypto.randomBytes(32).toString('base64url')
    let failure = false
    const prior = setGatewayContext(async () => ({
        flowOptions: { appDataSource: {} },
        loadNode: async () =>
            class {
                async init() {
                    return [
                        {
                            name: 'query',
                            description: 'ZZ-TEST-SQL',
                            schema: { type: 'object', properties: { sql: { type: 'string' }, cursor: { type: 'string' } } },
                            async invoke(args) {
                                received.push(args)
                                if (failure) throw new Error('ZZ-TEST-failed')
                                return JSON.stringify(result)
                            }
                        }
                    ]
                }
            }
    }))
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
                        mcpServers: [{ nodeName: 'postgreSQLMCP', category: 'Tools (MCP)' }]
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
        const events = []
        const capture = analystStartCapture((event) => events.push(event))
        beginAnalystCalls(name, specialist, chatId, capture.gatewayStarted)
        const call = async (args) => {
            capture.hermesStarted(hermesToolEvent(specialist, golden.runtimeStart))
            const response = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/call`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'query', arguments: args, callId: golden.start.callId, scope: `${name}:${chatId}` })
            })
            return { status: response.status, body: await response.json() }
        }
        const listed = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/list`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: '{}'
        })
        const record = getHarness(name)
        const actual = {
            tools: await listed.json(),
            toolsets: hermesToolsetsFor(record.specialists[0]),
            chief: chiefInstructions(record),
            specialist: specialistSoul(record.specialists[0], {}),
            start: hermesToolEvent(specialist, golden.runtimeStart)
        }
        assert.equal(JSON.stringify(actual), JSON.stringify(golden.expected))
        const first = await call({ sql })
        assert.equal(first.status, 200)
        assert.equal(first.body.result, JSON.stringify(result))
        assert.equal(events[0].sqlHash, sqlTraceFields(sql).sqlHash)
        assert.equal(events[0].sql, sql)
        const { sqlHash: hash, sql: preview, sqlTruncated: cut, ...start } = events[0]
        assert.equal(JSON.stringify(start), JSON.stringify(golden.expected.start))
        assert.equal(JSON.stringify(received), JSON.stringify(golden.executed))
        const page = await call({ cursor: result.cursor })
        assert.equal(page.status, 200)
        assert.equal(events[1].sqlHash, events[0].sqlHash)
        assert.equal(events[1].sql, sql)
        failure = true
        const failed = await call({ sql })
        assert.equal(failed.status, 502)
        assert.equal(events[2].sqlHash, events[0].sqlHash)
        assert.equal(events[2].sql, sql)
        assert.deepEqual(received, [{ sql }, { cursor: result.cursor }, { sql }])
        assert.equal(takeAnalystResults({ harness: name, specialist, chatId }).length, 2)
        // A second profile forces discovery of a server that cannot enforce table selection.
        saveHarness(
            {
                name: `${name}-refused`,
                chief: { instructions: 'ZZ-TEST-route', model: { nodeName: 'ZZ-TEST-model' } },
                specialists: [
                    { name: specialist, instructions: 'ZZ-TEST-query', mcpServers: [{ nodeName: 'customMCP', category: 'Tools (MCP)' }] }
                ]
            },
            { overwrite: true }
        )
        const refusedToken = crypto.randomBytes(32).toString('base64url')
        registerProfileToken({
            token: refusedToken,
            harnessName: `${name}-refused`,
            specialistName: specialist,
            profileName: `${name}-refused--data`,
            modelKey: 'ZZ-TEST-key'
        })
        const refusedEvents = []
        beginAnalystCalls(`${name}-refused`, specialist, chatId, (event) => refusedEvents.push(event))
        const refused = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/call`, {
            method: 'POST',
            headers: { authorization: `Bearer ${refusedToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'query', arguments: { sql }, scope: `${name}-refused:${chatId}` })
        })
        assert.equal(refused.status, 200)
        assert.equal(JSON.parse((await refused.json()).result).cuttlelyOutcome, 'expected')
        assert.equal(refusedEvents[0].sqlHash, sqlTraceFields(sql).sqlHash)
        assert.equal(refusedEvents[0].sql, sql)
        assert.equal(received.length, 3)
        process.env.CUTTLELY_ANALYST_TRACE_PREVIEW = 'false'
        try {
            await call({ sql })
            assert.equal(events[3].sqlHash, events[0].sqlHash)
            assert.equal(events[3].sql, undefined)
            const { sqlHash, sql: preview, sqlTruncated, ...start } = events[3]
            assert.equal(JSON.stringify(start), JSON.stringify(golden.expected.start))
        } finally {
            process.env.CUTTLELY_ANALYST_TRACE_PREVIEW = 'true'
        }
        endAnalystCalls(`${name}-refused`, specialist, chatId)
    } finally {
        endAnalystCalls(name, specialist, chatId)
        resetAnalystCapture()
        forgetProfileToken(`${name}--data`)
        forgetProfileToken(`${name}-refused--data`)
        if (gateway) await gateway.close()
        setGatewayContext(prior)
        deleteHarness(name)
        deleteHarness(`${name}-refused`)
        fs.rmSync(dataDir, { recursive: true, force: true })
    }
})

test('ZZ-TEST- a secure pinned parameter never reaches the live start event', () => {
    const secret = 'ZZ-TEST-code-4417'
    const events = []
    // Real wiring passes the bridge's own query tool name (mcp__<server>__query), never a pinned tool name.
    const capture = analystStartCapture((event) => events.push(event), { gatewayName: 'mcp__ZZ-TEST-db__query' })
    for (const tool of ['data__pq_order_status', 'pq_order_status']) {
        const start = hermesToolEvent('data', {
            event: 'tool.started',
            tool,
            tool_call_id: `ZZ-TEST-call-${tool}`,
            preview: JSON.stringify({ code: secret, region: 'east' })
        })
        assert.equal(start.detail, undefined)
        assert.ok(!JSON.stringify(start).includes(secret))
    }
    // A pinned tool's start is emitted at once, unpaired: it carries no detail and no pinned fields.
    capture.hermesStarted(
        hermesToolEvent('data', {
            event: 'tool.started',
            tool: 'mcp__ZZ-TEST-db__pq_order_status',
            tool_call_id: 'ZZ-TEST-call-1',
            preview: JSON.stringify({ code: secret })
        })
    )
    assert.equal(events.length, 1)
    assert.equal(events[0].name, 'mcp__ZZ-TEST-db__pq_order_status')
    assert.equal(events[0].detail, undefined)
    assert.equal(events[0].pinned, undefined)
    capture.gatewayStarted(
        { name: 'pq_order_status', callId: 'ZZ-TEST-call-1', pinned: { id: 'pin-1', params: { code: '[redacted]' } } },
        { pairById: true }
    )
    assert.equal(events.length, 1)
    assert.ok(!JSON.stringify(events).includes(secret))
    // Other tools keep their preview, and a pinned tool's end keeps its own detail.
    assert.equal(hermesToolEvent('data', { event: 'tool.started', tool: 'web_search', preview: 'ZZ-TEST-q' }).detail, 'ZZ-TEST-q')
    assert.equal(
        hermesToolEvent('data', { event: 'tool.completed', tool: 'pq_order_status', preview: 'ZZ-TEST-rows' }).detail,
        'ZZ-TEST-rows'
    )
})

test('ZZ-TEST- show more after a pinned result pages through the same pinned tool', () => {
    resetAnalystCapture()
    const harness = 'zz-test-pinned-page'
    const specialists = [{ name: 'data', mcpServers: [{ nodeName: 'postgreSQLMCP' }] }]
    recordAnalystResult({
        harness,
        specialist: 'data',
        chatId: 'ZZ-TEST-pin',
        result: { rows: [{ value: 1 }], cursor: 'ZZ-TEST-pin-cursor' },
        pinned: { id: 'pin-1', name: 'pq_order_status', version: 1 }
    })
    const pinned = latestAnalystCursor({ harness, chatId: 'ZZ-TEST-pin' })
    assert.equal(pinned.tool, 'pq_order_status')
    const route = applyAnalystPageRoute('show more', [], specialists, pinned)
    assert.equal(route.steps[0].task, 'Call the pq_order_status tool with cursor ZZ-TEST-pin-cursor. Do not write a new SQL statement.')
    recordAnalystResult({
        harness,
        specialist: 'data',
        chatId: 'ZZ-TEST-free',
        sql: 'SELECT 1',
        result: { rows: [{ value: 1 }], cursor: 'ZZ-TEST-free-cursor' }
    })
    const free = latestAnalystCursor({ harness, chatId: 'ZZ-TEST-free' })
    assert.deepEqual(Object.keys(free).sort(), ['specialist', 'summary', 'token'])
    const freeRoute = applyAnalystPageRoute('show more', [], specialists, free)
    assert.equal(freeRoute.steps[0].task, 'Call the query tool with cursor ZZ-TEST-free-cursor. Do not write a new SQL statement.')
    resetAnalystCapture()
})

const start = (callId, sql, sqlHash) => ({ phase: 'start', specialist: 'data', name: 'query', callId, sql, sqlHash })

test('ZZ-TEST- parallel calls to one tool close their own chips by call id', () => {
    const log = []
    logToolEvent(log, start('call-a', 'SELECT 1 FROM demo_sales LIMIT 1', 'hash-a'))
    logToolEvent(log, start('call-b', 'SELECT 2 FROM demo_sales LIMIT 1', 'hash-b'))
    logToolEvent(log, { phase: 'done', specialist: 'data', name: 'query', callId: 'call-a', error: true }, 'ZZ-TEST-failed')
    assert.equal(log[1].status, 'running')
    logToolEvent(log, { phase: 'done', specialist: 'data', name: 'query', callId: 'call-b' })
    assert.deepEqual(log, [
        {
            specialist: 'data',
            name: 'query',
            status: 'failed',
            sqlHash: 'hash-a',
            sql: 'SELECT 1 FROM demo_sales LIMIT 1',
            callId: 'call-a',
            detail: 'ZZ-TEST-failed'
        },
        { specialist: 'data', name: 'query', status: 'done', sqlHash: 'hash-b', sql: 'SELECT 2 FROM demo_sales LIMIT 1', callId: 'call-b' }
    ])
})

test('ZZ-TEST- an end without a call id still closes the newest running chip of that name', () => {
    const log = []
    logToolEvent(log, { phase: 'start', specialist: 'data', name: 'query' })
    logToolEvent(log, { phase: 'start', specialist: 'data', name: 'query' })
    logToolEvent(log, { phase: 'done', specialist: 'data', name: 'query' })
    assert.deepEqual(
        log.map((item) => item.status),
        ['running', 'done']
    )
})

test('ZZ-TEST- an end with an unknown call id does not close another call', () => {
    const log = []
    logToolEvent(log, start('call-a', 'SELECT 1 FROM demo_sales LIMIT 1', 'hash-a'))
    logToolEvent(log, { phase: 'done', specialist: 'data', name: 'query', callId: 'call-z' })
    assert.equal(log[0].status, 'running')
    assert.equal(log[1].status, 'done')
    assert.equal(log[1].sqlHash, undefined)
})
