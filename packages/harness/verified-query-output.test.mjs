import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import {
    beginGuardedQueryTurns,
    guardedQueryEvidence,
    guardedQueryLimit,
    guardedQueryUsage,
    verifiedQueryCapture,
    reserveGuardedQueryAttempt,
    forgetGuardedQueryAttempts,
    VERIFIED_QUERY_POLICY
} from './verified-query-output.mjs'
import { sqlTraceFields } from './analyst-capture.mjs'
import { verifiedUnmappedOutput } from './trusted-output.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-query-gateway-'))
process.env.CUTTLELY_DATA_DIR = dataDir
process.env.CUTTLELY_PINNED_QUERIES = '1'
process.env.CUTTLELY_HERMES_HOME = path.join(dataDir, 'runtime')
const { acquireTurn, releaseTurn, closeQueueDb } = await import('./lock.mjs')
const { saveHarness, deleteHarness } = await import('./store.mjs')
const { setGatewayContext, registerProfileToken, forgetProfileToken, startGateway } = await import('./gateway.mjs')
const { beginAnalystCalls, endAnalystCalls, takeAnalystResults, resetAnalystCapture } = await import('./analyst-capture.mjs')
after(() => {
    closeQueueDb()
    fs.rmSync(dataDir, { recursive: true, force: true })
})

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

test('real gateway enforces each specialist allowance before SQL and retains verified receipts', async (t) => {
    const setting = 'CUTTLELY_HARNESS_MAX_AD_HOC_SQL_ATTEMPTS'
    const before = process.env[setting]
    delete process.env[setting]
    t.after(() => {
        if (before === undefined) delete process.env[setting]
        else process.env[setting] = before
    })
    const snapshots = new DatabaseSync(':memory:')
    snapshots.exec('CREATE TABLE snapshots (period INTEGER, units INTEGER); INSERT INTO snapshots VALUES (1, 20), (2, 26)')
    t.after(() => snapshots.close())
    const pin = {
        id: 'fixture',
        name: 'pq_existing',
        version: 1,
        testedStamp: 'f'.repeat(64),
        sql: 'SELECT units FROM snapshots WHERE period = 1',
        params: []
    }
    let pinCalls = 0
    const name = 'verified-query-fixture',
        specialist = 'data',
        profile = `${name}--data`,
        chatId = 'chat'
    const turn = `${profile}:${chatId}#turn-1234`,
        token = crypto.randomBytes(32).toString('base64url')
    let calls = 0,
        fail = false
    const prior = setGatewayContext(async () => ({
        flowOptions: { appDataSource: {}, workspaceId: 'fixture-team' },
        loadNode: async () =>
            class {
                async init() {
                    return [
                        {
                            name: 'query',
                            description: 'SQL query',
                            schema: { type: 'object', properties: { sql: { type: 'string' } } },
                            async invoke(args) {
                                calls++
                                return JSON.stringify(
                                    fail
                                        ? { error: 'read-only refusal', cuttlelyOutcome: 'expected' }
                                        : {
                                              rows: args.sql === sql ? [{ amount: '8.20' }] : snapshots.prepare(args.sql).all(),
                                              _cuttlelyReadOnlyQuery: { readOnly: true, rowCap: 100, statementTimeoutMs: 15000 }
                                          }
                                )
                            }
                        },
                        {
                            name: pin.name,
                            description: 'Saved snapshot',
                            schema: { type: 'object', properties: {} },
                            async invoke() {
                                pinCalls++
                                return JSON.stringify({ rows: snapshots.prepare(pin.sql).all() })
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
            workspaceId: 'fixture-team',
            chief: { model: { nodeName: 'unusedModel' } },
            specialists: [
                {
                    name: specialist,
                    trustedOutputPolicy: VERIFIED_QUERY_POLICY,
                    trustedOutputs: [{ pin: 'pq_existing', hash: 'f'.repeat(64), mode: 'markdown', fields: [{ path: 'rows.0.report' }] }],
                    mcpServers: [
                        {
                            ...context.binding,
                            category: 'Tools (MCP)',
                            inputs: { ...context.binding.inputs, pinnedQueries: JSON.stringify([pin]) }
                        }
                    ]
                }
            ]
        })
        registerProfileToken({ token, harnessName: name, specialistName: specialist, profileName: profile, modelKey: 'fixture-model-key' })
        gateway = await startGateway({ port: 0 })
        beginAnalystCalls(name, specialist, chatId)
        const invoke = async (scope, statement = sql, tool = 'query', bearer = token) => {
            const response = await fetch(`http://127.0.0.1:${gateway.port}/harness/tools/call`, {
                method: 'POST',
                headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                    name: tool,
                    arguments: tool === 'query' ? { sql: statement } : {},
                    scope,
                    callId: crypto.randomUUID()
                })
            })
            const reply = await response.json()
            assert.equal(response.status, 200, JSON.stringify(reply))
            return reply.result
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
        assert.match(await invoke(turn), /limit 2/)
        assert.equal(calls, 2)
        assert.deepEqual(guardedQueryUsage(profile, turn), { used: 2, limit: 2, exhausted: true })
        // The allowance is fixed before the remote runtime takes its first SQL action.
        process.env[setting] = '4'
        const held = acquireTurn(name, chatId)
        const next = `${profile}:${chatId}#turn-reconcile`
        try {
            beginGuardedQueryTurns(
                [{ profileName: profile, trustedOutputPolicy: VERIFIED_QUERY_POLICY }],
                chatId,
                'reconcile',
                held.key,
                guardedQueryLimit()
            )
            process.env[setting] = '1'
            fail = false
            const first = JSON.parse(await invoke(next, 'SELECT units FROM snapshots ORDER BY period LIMIT 1')).rows[0].units
            const saved = JSON.parse(await invoke(next, '', pin.name))
            assert.equal(saved.rows?.[0]?.units, first, JSON.stringify(saved))
            assert.equal(pinCalls, 1)
            assert.equal(guardedQueryUsage(profile, next).used, 1)
            const second = JSON.parse(await invoke(next, 'SELECT units FROM snapshots ORDER BY period LIMIT 1 OFFSET 1')).rows[0].units
            const deltaSql = 'SELECT max(units) - min(units) AS delta FROM snapshots'
            assert.equal(JSON.parse(await invoke(next, deltaSql)).rows[0].delta, second - first)
            const boundary = await Promise.all([
                invoke(next, 'SELECT units FROM snapshots WHERE period = 3'),
                invoke(next, 'SELECT units FROM snapshots WHERE period = 3')
            ])
            assert.equal(boundary.filter((reply) => JSON.parse(reply).rows?.length === 0).length, 1)
            assert.equal(boundary.filter((reply) => /limit 4/.test(reply)).length, 1)
            assert.deepEqual(guardedQueryUsage(profile, next), { used: 4, limit: 4, exhausted: true })
            assert.equal(calls, 6)
        } finally {
            releaseTurn(held)
        }
        assert.match(await invoke(next), /limit 4/, 'a late request must not reset its budget')
        const fresh = `${profile}:${chatId}#turn-new`
        await invoke(fresh)
        assert.match(await invoke(fresh), /limit 1/)
        assert.equal(calls, 7)
        // Only the model reply is scripted. Admission, profile compilation, the bridge
        // token, SQL dispatch and the persisted operator trace follow the normal run.
        const { runHarness } = await import('./run.mjs')
        const { readProfileEnv } = await import('./profile.mjs')
        const { recordAgentStep } = await import('./agent-run-context.mjs')
        for (const limit of [2, 4]) {
            process.env[setting] = String(limit)
            const before = calls
            const result = await runHarness({
                name,
                mode: 'agent',
                chatId: 'live-config-' + limit,
                input: 'Compare the two snapshots. Respond in JSON.',
                flowOptions: { workspaceId: 'fixture-team', harnessCaller: { via: 'session' } },
                async fetchImpl(url, init) {
                    assert.match(String(url), /\/v1\/runs$/)
                    const { session_id: parent } = JSON.parse(init.body)
                    const source = parent.replace(name + ':', profile + ':')
                    process.env[setting] = '1'
                    const bearer = readProfileEnv(profile).OPENAI_API_KEY
                    const query = async (statement) => JSON.parse(await invoke(source, statement, 'query', bearer))
                    const first = await query('SELECT units FROM snapshots WHERE period = 1')
                    const second = await query('SELECT units FROM snapshots WHERE period = 2')
                    const reconciliation = await query('SELECT max(units)-min(units) AS delta FROM snapshots')
                    if (limit === 4) assert.equal(second.rows[0].units - first.rows[0].units, reconciliation.rows[0].delta)
                    recordAgentStep(name, parent, { name: specialist, task: 'Compare', status: 'completed', startedAt: Date.now() })
                    const answer = reconciliation.rows?.[0] || { incomplete: true }
                    return Response.json({ run_id: 'synthetic', status: 'completed', output: JSON.stringify(answer) })
                }
            })
            const used = Math.min(3, limit)
            assert.equal(calls - before, used)
            assert.deepEqual(JSON.parse(result.text), limit === 4 ? { delta: 6 } : { incomplete: true })
            assert.deepEqual(result.trace.specialists[0].adHocSqlAttempts, { used, limit, exhausted: used === limit })
        }
    } finally {
        endAnalystCalls(name, specialist, chatId)
        resetAnalystCapture()
        forgetProfileToken(token)
        if (gateway) await gateway.close()
        setGatewayContext(prior)
        deleteHarness(name)
    }
})

test('host values accept whole decimal spellings and fall back to two for invalid input', () => {
    const key = 'CUTTLELY_HARNESS_MAX_AD_HOC_SQL_ATTEMPTS'
    assert.equal(guardedQueryLimit({ [key]: '04.0' }), 4)
    for (const raw of [undefined, '', '0', '-1', '2.5', '7', '4e0', '0x4']) assert.equal(guardedQueryLimit({ [key]: raw }), 2)
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

test('separate gateway processes share one remaining slot and keep specialists independent', () => {
    const profile = 'shared--first'
    const sibling = 'shared--second'
    const held = acquireTurn('shared', 'chat')
    try {
        beginGuardedQueryTurns(
            [profile, sibling].map((profileName) => ({ profileName, trustedOutputPolicy: VERIFIED_QUERY_POLICY })),
            'chat',
            'id',
            held.key,
            2
        )
        const turn = `${profile}:chat#turn-id`
        assert.equal(reserveGuardedQueryAttempt(profile, turn), true)
        const moduleUrl = new URL('./verified-query-output.mjs', import.meta.url).href
        const child = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import { reserveGuardedQueryAttempt } from ${JSON.stringify(
                    moduleUrl
                )}; console.log(reserveGuardedQueryAttempt(process.argv[1], process.argv[2]))`,
                profile,
                turn
            ],
            { encoding: 'utf8' }
        )
        assert.equal(child.status, 0, child.stderr)
        assert.equal(child.stdout.trim(), 'true')
        assert.equal(reserveGuardedQueryAttempt(profile, turn), false)
        assert.deepEqual(guardedQueryUsage(sibling, `${sibling}:chat#turn-id`), { used: 0, limit: 2, exhausted: false })
    } finally {
        releaseTurn(held)
        forgetGuardedQueryAttempts(profile)
        forgetGuardedQueryAttempts(sibling)
    }
})
