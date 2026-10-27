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
const { analystStartCapture, beginAnalystCalls, endAnalystCalls, resetAnalystCapture, sqlTraceFields, takeAnalystResults } = await import(
    '../../analyst-capture.mjs'
)

const { chiefInstructions, specialistSoul, hermesToolsetsFor } = await import('../../profile.mjs')
const { hermesToolEvent } = await import('../../run.mjs')
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
