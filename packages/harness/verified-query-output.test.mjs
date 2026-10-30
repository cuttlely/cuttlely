import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { after, test } from 'node:test'
import {
    guardedQueryEvidence,
    verifiedQueryCapture,
    reserveGuardedQueryAttempt,
    forgetGuardedQueryAttempts,
    VERIFIED_QUERY_POLICY
} from './verified-query-output.mjs'
import { sqlTraceFields } from './analyst-capture.mjs'
import { verifiedUnmappedOutput } from './trusted-output.mjs'

const profileName = 'fixture--data'
const sourceTurn = `${profileName}:chat#turn-1234`
const sql = 'SELECT amount FROM example.sales LIMIT 100'
const sqlHash = sqlTraceFields(sql).sqlHash
const context = {
    specialist: { trustedOutputPolicy: VERIFIED_QUERY_POLICY },
    binding: {
        nodeName: 'postgreSQLMCP',
        inputs: { allowPinDefinitions: true, mcpActions: ['query'], analystRowCap: 100, analystTimeoutSeconds: 15 }
    },
    toolName: 'query',
    profileName,
    sourceTurn,
    sqlHash,
    receipt: { readOnly: true, rowCap: 100, statementTimeoutMs: 15000 },
    result: { rows: [{ amount: '8.20' }] }
}
const clone = (value) => structuredClone(value)
const capture = () => ({
    callId: 'server-call',
    sourceTurn,
    toolName: 'query',
    result: context.result,
    traceFields: { sqlHash },
    queryEvidence: guardedQueryEvidence(context)
})

test('only the explicit policy accepts server-attested successful native query evidence', () => {
    assert.ok(verifiedQueryCapture(capture()))
    assert.equal(verifiedUnmappedOutput(context.specialist, [capture()], { dataTask: true }), true)
    for (const policy of [undefined, 'strict', 'verified-passthrough']) {
        assert.equal(verifiedUnmappedOutput({ trustedOutputPolicy: policy }, [capture()], { dataTask: true }), false)
    }
    assert.equal(verifiedUnmappedOutput(context.specialist, [], { dataTask: true }), false)
})

test('a native receipt cannot bypass binding, turn, query, result or configured limits', () => {
    const mutations = [
        (v) => {
            v.binding.nodeName = 'customMCP'
        },
        (v) => {
            v.binding.inputs.allowPinDefinitions = false
        },
        (v) => {
            v.binding.inputs.mcpActions = []
        },
        (v) => {
            v.sourceTurn = 'another-profile:chat#turn-1234'
        },
        (v) => {
            v.sourceTurn = `${profileName}:chat`
        },
        (v) => {
            v.toolName = 'describe'
        },
        (v) => {
            v.receipt.readOnly = false
        },
        (v) => {
            v.receipt.rowCap = 101
        },
        (v) => {
            v.receipt.statementTimeoutMs = 16000
        },
        (v) => {
            v.result.error = 'guard refused'
        },
        (v) => {
            v.result.columnsChanged = true
        },
        (v) => {
            v.result.cuttlelyOutcome = 'expected'
        },
        (v) => {
            v.sqlHash = sqlTraceFields('').sqlHash
        }
    ]
    for (const mutate of mutations) {
        const value = clone(context)
        mutate(value)
        assert.equal(guardedQueryEvidence(value), null)
    }
    const value = clone(context)
    value.binding.inputs.mcpActions = '["query"]'
    assert.ok(guardedQueryEvidence(value))
})

test('copied, missing or mismatched capture metadata is never verified', () => {
    for (const mutate of [
        (v) => {
            v.callId = ''
        },
        (v) => {
            v.sourceTurn = ''
        },
        (v) => {
            v.queryEvidence = null
        },
        (v) => {
            v.traceFields.sqlHash = 'f'.repeat(64)
        },
        (v) => {
            v.result = { error: 'failed', rows: [] }
        }
    ]) {
        const value = clone(capture())
        mutate(value)
        assert.equal(verifiedQueryCapture(value), false)
    }
})

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-query-gateway-'))
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'runtime')
const { saveHarness, deleteHarness } = await import('./store.mjs')
const { setGatewayContext, registerProfileToken, forgetProfileToken, startGateway } = await import('./gateway.mjs')
const { beginAnalystCalls, endAnalystCalls, takeAnalystResults, resetAnalystCapture } = await import('./analyst-capture.mjs')
after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

test('real gateway retains free-query evidence in the active turn and strips private receipts', async () => {
    const name = 'verified-query-fixture',
        specialist = 'data',
        profile = `${name}--data`,
        chatId = 'chat'
    const turn = `${profile}:${chatId}#turn-1234`,
        token = crypto.randomBytes(32).toString('base64url')
    let calls = 0,
        fail = false
    const prior = setGatewayContext(async () => ({
        flowOptions: { appDataSource: {} },
        loadNode: async () =>
            class {
                async init() {
                    return [
                        {
                            name: 'query',
                            description: 'SQL query',
                            schema: { type: 'object', properties: { sql: { type: 'string' } } },
                            async invoke() {
                                calls++
                                return JSON.stringify(
                                    fail
                                        ? { error: 'read-only refusal', cuttlelyOutcome: 'expected' }
                                        : {
                                              rows: [{ amount: '8.20' }],
                                              _cuttlelyReadOnlyQuery: { readOnly: true, rowCap: 100, statementTimeoutMs: 15000 }
                                          }
                                )
                            }
                        }
                    ]
                }
            }
    }))
    let gateway
    try {
        saveHarness({
            name,
            chief: { model: { nodeName: 'unusedModel' } },
            specialists: [
                {
                    name: specialist,
                    trustedOutputPolicy: VERIFIED_QUERY_POLICY,
                    trustedOutputs: [{ pin: 'pq_existing', hash: 'f'.repeat(64), mode: 'markdown', fields: [{ path: 'rows.0.report' }] }],
                    mcpServers: [{ ...context.binding, category: 'Tools (MCP)' }]
                }
            ]
        })
        registerProfileToken({ token, harnessName: name, specialistName: specialist, profileName: profile, modelKey: 'fixture-model-key' })
        gateway = await startGateway({ port: 0 })
        beginAnalystCalls(name, specialist, chatId)
        const invoke = async (scope) => {
            const response = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/call`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'query', arguments: { sql }, scope, callId: `call-${calls}` })
            })
            return (await response.json()).result
        }
        const reply = await invoke(turn)
        assert.deepEqual(JSON.parse(reply), { rows: [{ amount: '8.20' }] })
        const actual = takeAnalystResults({ harness: name, specialist, chatId, sourceTurn: turn })
        assert.equal(actual.length, 1)
        assert.equal(verifiedQueryCapture(actual[0]), true, JSON.stringify(actual[0]))
        assert.equal(actual[0].traceFields.sqlHash, sqlHash)
        assert.match(await invoke(`${profile}:${chatId}`), /turn-scoped/)
        assert.equal(calls, 1)
        fail = true
        await invoke(turn)
        assert.equal(takeAnalystResults({ harness: name, specialist, chatId, sourceTurn: turn }).length, 0)
        assert.match(await invoke(turn), /at most two query calls/)
        assert.equal(calls, 2)
    } finally {
        endAnalystCalls(name, specialist, chatId)
        resetAnalystCapture()
        forgetProfileToken(profile)
        if (gateway) await gateway.close()
        setGatewayContext(prior)
        deleteHarness(name)
    }
})

test('fallback query calls are bounded by specialist turn and profile revocation clears old counters', () => {
    const profile = 'bounded-fixture'
    assert.equal(reserveGuardedQueryAttempt(profile, 'turn-a'), true)
    assert.equal(reserveGuardedQueryAttempt(profile, 'turn-a'), true)
    assert.equal(reserveGuardedQueryAttempt(profile, 'turn-a'), false)
    assert.equal(reserveGuardedQueryAttempt(profile, 'turn-b'), true)
    forgetGuardedQueryAttempts(profile)
    assert.equal(reserveGuardedQueryAttempt(profile, 'turn-a'), true)
})
