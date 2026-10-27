import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, test } from 'node:test'
import { callPrepared } from '../../bridge.mjs'
import { pinnedOnlyRefusal, pinnedOnlyTools, pinnedToolHint } from '../../pinned-names.mjs'
import { ANALYST_TOOL_RETRY, analystToolRetry } from '../../run.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ZZ-TEST-pq-only-'))
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'runtime')
after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
afterEach(() => {
    delete process.env.CUTTLELY_PINNED_QUERIES
})

const stamp = 'ab'.repeat(32)
const pinEntry = {
    name: 'pq_sales_by_region',
    testedStamp: stamp,
    params: [
        { name: 'region', type: 'text' },
        { name: 'min_total', type: 'numeric' }
    ]
}

function specialistWith(mcpActions) {
    return {
        name: 'data',
        mcpServers: [
            {
                nodeName: 'postgreSQLMCP',
                category: 'Tools (MCP)',
                credential: 'ZZ-TEST-cred',
                inputs: { mcpActions, pinnedQueries: JSON.stringify([pinEntry]) }
            }
        ]
    }
}

// The pin's tool as the PostgreSQL MCP node builds it: a strict schema plus paging fields.
function pinTool(calls) {
    return {
        name: 'pq_sales_by_region',
        description: 'ZZ-TEST pin',
        schema: {
            type: 'object',
            properties: {
                region: { type: 'string' },
                min_total: { type: ['string', 'number'] },
                cursor: { type: 'string' },
                page: { type: 'number' }
            },
            additionalProperties: false
        },
        async invoke(args) {
            calls.push(['pq_sales_by_region', args])
            return JSON.stringify({ rows: [] })
        }
    }
}

function queryTool(calls) {
    return {
        name: 'query',
        description: 'ZZ-TEST query',
        schema: { type: 'object', properties: { sql: { type: 'string' } } },
        async invoke(args) {
            calls.push(['query', args])
            return JSON.stringify({ rows: [{ region: 'north' }] })
        }
    }
}

const expectedRefusal = pinnedOnlyRefusal(['pq_sales_by_region(region: string, min_total: number)'])

test('pinned-only specialists list their pins with parameters; mixed mode and the flag off list none', () => {
    process.env.CUTTLELY_PINNED_QUERIES = '1'
    assert.deepEqual(pinnedOnlyTools(specialistWith('[]')), [{ name: 'pq_sales_by_region', params: pinEntry.params }])
    assert.deepEqual(pinnedOnlyTools(specialistWith(undefined)), [{ name: 'pq_sales_by_region', params: pinEntry.params }])
    assert.deepEqual(pinnedOnlyTools(specialistWith('["query"]')), [])
    assert.deepEqual(pinnedOnlyTools(specialistWith(['query'])), [])
    delete process.env.CUTTLELY_PINNED_QUERIES
    assert.deepEqual(pinnedOnlyTools(specialistWith('[]')), [])
})

test('the analyst retry names the pins and their parameters when no query tool is offered', () => {
    assert.equal(analystToolRetry([]), ANALYST_TOOL_RETRY)
    const text = analystToolRetry([{ name: 'pq_sales_by_region', params: pinEntry.params }])
    assert.match(text, /pq_sales_by_region\(region: string, min_total: number\)/)
    assert.match(text, /not SQL/)
    assert.doesNotMatch(text, /query tool now/)
    assert.equal(pinnedToolHint('pq_totals'), 'pq_totals()')
})

test("a call by the node's own name on a pinned-only node is refused, naming the pin, and runs nothing", async () => {
    const calls = []
    for (const args of [{ sql: 'SELECT region FROM demo_sales LIMIT 5' }, { input: 'sales by region' }]) {
        const raw = await callPrepared({ runs: false, ready: [pinTool(calls)], toolName: 'postgreSQLMCP' }, args)
        assert.deepEqual(JSON.parse(raw), expectedRefusal)
    }
    assert.deepEqual(calls, [])
})

test("a call by the node's own name in mixed mode runs the free query tool, even when a pin is listed first", async () => {
    const calls = []
    const raw = await callPrepared(
        { runs: false, ready: [pinTool(calls), queryTool(calls)], toolName: 'postgreSQLMCP' },
        { sql: 'SELECT region FROM demo_sales LIMIT 5' }
    )
    assert.deepEqual(JSON.parse(raw), { rows: [{ region: 'north' }] })
    assert.deepEqual(
        calls.map((item) => item[0]),
        ['query']
    )
    const pinned = await callPrepared(
        { runs: false, ready: [queryTool(calls), pinTool(calls)], toolName: 'pq_sales_by_region' },
        { region: 'north' }
    )
    assert.deepEqual(JSON.parse(pinned), { rows: [] })
    assert.deepEqual(calls.at(-1), ['pq_sales_by_region', { region: 'north' }])
})

test('an inline specialist runs the pin it was shown when no tool name is passed', async () => {
    const calls = []
    const pin = pinTool(calls)
    const raw = await callPrepared({ runs: false, ready: [pin], tool: pin }, { region: 'north' })
    assert.deepEqual(JSON.parse(raw), { rows: [] })
    assert.deepEqual(calls, [['pq_sales_by_region', { region: 'north' }]])
})

test("the gateway answers a pinned-only node's own name with the expected refusal", async () => {
    const { saveHarness, deleteHarness } = await import('../../store.mjs')
    const { registerProfileToken, forgetProfileToken, setGatewayContext, startGateway } = await import('../../gateway.mjs')
    const name = 'zz-test-pq-only-gateway'
    const calls = []
    process.env.CUTTLELY_PINNED_QUERIES = '1'
    const prior = setGatewayContext(async () => ({
        flowOptions: { appDataSource: {} },
        loadNode: async () =>
            class {
                async init() {
                    return [pinTool(calls)]
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
                specialists: [{ ...specialistWith('[]'), instructions: 'ZZ-TEST-query' }]
            },
            { overwrite: true }
        )
        registerProfileToken({ token, harnessName: name, specialistName: 'data', profileName: `${name}--data`, modelKey: 'ZZ-TEST-key' })
        gateway = await startGateway({ port: 0 })
        const post = async (route, body) => {
            const response = await fetch(`http://127.0.0.1:${gateway.port}${route}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(body)
            })
            return { status: response.status, body: await response.json() }
        }
        const listed = await post('/harness/tools/list', {})
        assert.deepEqual(
            listed.body.tools.map((item) => item.name),
            ['pq_sales_by_region']
        )
        const own = await post('/harness/tools/call', {
            name: 'postgreSQLMCP',
            arguments: { sql: 'SELECT region FROM demo_sales LIMIT 5' },
            scope: `${name}:ZZ-TEST-chat`
        })
        assert.equal(own.status, 200)
        assert.deepEqual(JSON.parse(own.body.result), expectedRefusal)
        const pinned = await post('/harness/tools/call', {
            name: 'pq_sales_by_region',
            arguments: { region: 'north', min_total: 10 },
            scope: `${name}:ZZ-TEST-chat`
        })
        assert.equal(pinned.status, 200)
        assert.deepEqual(calls, [['pq_sales_by_region', { region: 'north', min_total: 10 }]])
    } finally {
        forgetProfileToken(`${name}--data`)
        if (gateway) await gateway.close()
        setGatewayContext(prior)
        deleteHarness(name)
    }
})
