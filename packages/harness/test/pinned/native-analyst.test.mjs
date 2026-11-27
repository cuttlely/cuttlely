import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { openNativeRecall } from '../../runtime/native-memory.mjs'
import { createTestDatabase, skipReason } from '../../../etl/check/pg-source.mjs'
import { latestAnalystCursor, takeAnalystResults } from '../../analyst-capture.mjs'
import { renderTrustedOutputs } from '../../trusted-output.mjs'
import { specialistSessionId } from '../../specialist-run.mjs'
import { analystScopeKey, endAnalystRun } from '../../runtime/analyst-store.mjs'
import {
    analystCaptureIdentity,
    nativeAnalystBinding,
    nativeAnalystSpecialistSupported,
    openNativeAnalyst
} from '../../runtime/native-analyst.mjs'
import { compilePinned } from '../../runtime/pinned-query.mjs'
import { computeStamp, stampPayload } from '../../runtime/pinned-stamp.mjs'

test('an admitted PostgreSQL specialist uses the signed saved report and relation guard on real rows', { skip: skipReason }, async (t) => {
    const database = await createTestDatabase()
    t.after(() => database.cleanup())
    const { connection } = database
    const { Client } = createRequire(new URL('../../../etl/package.json', import.meta.url))('pg')
    const admin = new Client(connection)
    await admin.connect()
    try {
        await admin.query('CREATE TABLE public.native_reports(id integer PRIMARY KEY, report text NOT NULL)')
        await admin.query(
            "INSERT INTO public.native_reports VALUES (1,'First sourced report'),(2,'Second sourced report'),(3,'Third sourced report')"
        )
        await admin.query('ALTER TABLE public.native_reports ADD COLUMN table_payload text')
        for (const [id, value] of [
            [1, 'North'],
            [2, 'South']
        ])
            await admin.query('UPDATE public.native_reports SET table_payload = $1 WHERE id = $2', [
                JSON.stringify({ headers: ['Region'], complete_rows: [[value]], total_rows: 1, complete: true, truncated: false }),
                id
            ])
        await admin.query('CREATE TABLE public.unselected(id integer)')
    } finally {
        await admin.end()
    }
    const url = new URL('postgres://127.0.0.1')
    url.hostname = connection.host
    url.port = String(connection.port)
    url.username = connection.user
    url.password = connection.password || ''
    url.pathname = connection.database
    const secret = randomUUID()
    const disk = fs.mkdtempSync(path.join(os.tmpdir(), 'native-analyst-'))
    const teamName = 'qa-analyst-' + randomUUID().slice(0, 8)
    t.after(() => fs.rmSync(disk, { force: true, recursive: true }))
    const env = {
        CUTTLELY_DATA_DIR: disk,
        CUTTLELY_HERMES_HOME: path.join(disk, 'runtime'),
        CUTTLELY_NATIVE_PRIME_TEAMS: teamName,
        CUTTLELY_POSTGRES_URL: url.href,
        CUTTLELY_PINNED_QUERIES: '1',
        CUTTLELY_SECRETKEY_OVERWRITE: secret,
        DATABASE_TYPE: 'sqlite'
    }
    for (const [name, value] of Object.entries(env)) {
        const previous = process.env[name]
        process.env[name] = value
        t.after(() => {
            if (previous === undefined) delete process.env[name]
            else process.env[name] = previous
        })
    }
    const workspaceId = 'qa-analyst'
    const relations = ['public.native_reports']
    const pin = {
        name: 'pq_first_report',
        sql: 'SELECT report FROM public.native_reports WHERE id = 1 LIMIT 1',
        id: randomUUID(),
        version: 1,
        params: [],
        testedColumns: [{ name: 'report', type: 'text' }]
    }
    const { statementHash } = compilePinned(pin)
    pin.testedStamp = computeStamp(
        createHmac('sha256', secret).update('cuttlely-pinned-query-v1').digest(),
        stampPayload({
            workspaceId,
            cred: '',
            statementHash,
            params: [],
            relations,
            allowedFunctions: [],
            testedColumns: pin.testedColumns
        })
    )
    const binding = {
        nodeId: 'pg1',
        nodeName: 'postgreSQLMCP',
        category: 'Tools (MCP)',
        inputs: { mcpActions: ['query'], analystRelations: relations, analystRowCap: 2, allowPinDefinitions: true, pinnedQueries: [pin] }
    }
    const specialist = {
        name: 'reader',
        profileName: 'qa-team--reader',
        mcpServers: [binding],
        trustedOutputs: [{ pin: pin.name, hash: statementHash, mode: 'markdown', fields: [{ path: 'rows.0.report' }] }]
    }
    assert.equal(nativeAnalystBinding(binding), true)
    assert.equal(nativeAnalystBinding({ ...binding, inputs: { ...binding.inputs, analystRelations: [] } }), false)
    assert.equal(nativeAnalystBinding({ ...binding, nodeData: { credential: 'other' } }), false)
    assert.equal(nativeAnalystBinding({ ...binding, inputs: { ...binding.inputs, postgresUrl: 'unexpected' } }), false)
    assert.equal(nativeAnalystBinding({ ...binding, upstream: { arbitrary: {} } }), false)
    assert.equal(nativeAnalystSpecialistSupported(specialist), true)
    assert.equal(nativeAnalystSpecialistSupported({ ...specialist, trustedOutputs: [{ pin: 'pq_other' }] }), false)
    const record = {
        name: 'qa-team',
        createdAt: new Date().toISOString(),
        chatflowId: randomUUID(),
        workspaceId,
        specialists: [specialist]
    }
    const context = {
        name: record.name,
        nativeSpecialists: true,
        roster: record,
        chatId: randomUUID(),
        turnId: randomUUID(),
        moduleOptions: {
            componentNodes: {
                postgreSQLMCP: {
                    filePath: new URL('../../../components/dist/nodes/tools/MCP/PostgreSQL/PostgreSQLMCP.js', import.meta.url).pathname
                }
            },
            flowOptions: { appDataSource: {}, workspaceId }
        }
    }
    const person = { via: 'session', tryOwner: 'user:alice' }
    function asCaller(caller, options = {}) {
        const next = { ...context, ...options, turnId: randomUUID() }
        next.recall = openNativeRecall({ ...next, caller, assertCurrent() {} })
        return next
    }
    context.recall = asCaller(person).recall
    assert.ok(context.recall.receipt?.ownerScope)
    const identity = analystCaptureIdentity(context)
    t.after(() => endAnalystRun(analystScopeKey(identity.harness, identity.chatId)))
    let revoked = false
    const options = {
        context,
        specialist,
        assertCurrent() {
            if (revoked) throw Error('revoked')
        }
    }
    const opened = await openNativeAnalyst(options)
    t.after(() => opened.close())
    assert.deepEqual(opened.tools.map((t) => t.function.name).sort(), ['describe', 'pin_definition', 'pq_first_report', 'query'])
    const raw = await opened.execute(pin.name, {})
    assert.ok(!raw.includes('_cuttlelyTraceSql'))
    const sourceTurn = specialistSessionId(specialist.profileName, context.chatId, context.turnId)
    const captured = takeAnalystResults({ ...identity, specialist: specialist.name, sourceTurn })
    assert.equal(captured.length, 1)
    assert.equal(captured[0].pinned.hash, statementHash)
    assert.equal((await renderTrustedOutputs(specialist, captured)).text, 'First sourced report')
    const first = JSON.parse(await opened.execute('query', { sql: 'SELECT id, report FROM public.native_reports ORDER BY id LIMIT 3' }))
    assert.ok(Array.isArray(first.rows), first.error)
    assert.deepEqual(
        first.rows.map((row) => Number(row.id)),
        [1, 2]
    )
    assert.ok(first.cursor)
    assert.equal(first._cuttlelyReadOnlyQuery, undefined)
    assert.equal(latestAnalystCursor(identity).token, first.cursor)
    const outsiderContext = asCaller({ via: 'session', tryOwner: 'user:bob' })
    const outsiderIdentity = analystCaptureIdentity(outsiderContext)
    assert.ok(!latestAnalystCursor(outsiderIdentity)?.token)
    assert.ok(!latestAnalystCursor({ harness: record.name, chatId: identity.chatId })?.token)
    assert.notDeepEqual(analystCaptureIdentity({ ...context, recall: undefined }), identity)
    assert.notDeepEqual(
        analystCaptureIdentity({ ...context, recall: undefined, turnId: randomUUID() }),
        analystCaptureIdentity({ ...context, recall: undefined })
    )
    t.after(() => endAnalystRun(analystScopeKey(outsiderIdentity.harness, outsiderIdentity.chatId)))
    const outsider = await openNativeAnalyst({ ...options, context: outsiderContext })
    t.after(() => outsider.close())
    const otherPage = await outsider.execute('query', { cursor: first.cursor })
    assert.equal(otherPage.error, true)
    assert.ok(JSON.parse(otherPage.content).error)
    for (const foreign of [
        asCaller({ via: 'api_key', apiKeyId: 'other-key' }),
        asCaller(person, { roster: { ...record, createdAt: new Date(Date.now() - 10000).toISOString() } }),
        asCaller(undefined)
    ]) {
        assert.ok(!latestAnalystCursor(analystCaptureIdentity(foreign))?.token)
        const foreignReader = await openNativeAnalyst({ ...options, context: foreign })
        try {
            assert.equal((await foreignReader.execute('query', { cursor: first.cursor })).error, true)
        } finally {
            foreignReader.close()
            const key = analystCaptureIdentity(foreign)
            await endAnalystRun(analystScopeKey(key.harness, key.chatId))
        }
    }
    const resumed = asCaller(person)
    assert.deepEqual(analystCaptureIdentity(resumed), identity)
    const resumedReader = await openNativeAnalyst({ ...options, context: resumed })
    t.after(() => resumedReader.close())
    const continued = JSON.parse(await resumedReader.execute('query', { cursor: first.cursor }))
    assert.deepEqual(
        continued.rows.map((row) => Number(row.id)),
        [3]
    )
    const denied = await opened.execute('query', { sql: 'SELECT id FROM public.unselected LIMIT 1' })
    assert.equal(denied.error, true)
    assert.ok(!JSON.parse(denied.content).rows)
    await assert.rejects(opened.execute('not_on_card', {}), { code: 'forbidden' })
    revoked = true
    await assert.rejects(opened.execute(pin.name, {}), /revoked/)
    revoked = false
    opened.close()
    await assert.rejects(opened.execute(pin.name, {}), { code: 'forbidden' })
    const staleBinding = {
        ...binding,
        inputs: { ...binding.inputs, mcpActions: [], pinnedQueries: [{ ...pin, testedStamp: '00'.repeat(32) }] }
    }
    const stale = await openNativeAnalyst({ ...options, specialist: { ...specialist, mcpServers: [staleBinding] } })
    t.after(() => stale.close())
    assert.deepEqual(stale.tools, [])
    await assert.rejects(stale.execute(pin.name, {}), { code: 'forbidden' })

    // Hold the actual relation lock until two separate query backends reach it. Cancel only the first chat.
    const controller = new AbortController()
    const makeReader = async (signal) => {
        const chatId = randomUUID()
        const localContext = {
            ...context,
            recall: { receipt: { ownerScope: randomUUID() } },
            chatId,
            turnId: randomUUID(),
            workSignal: signal
        }
        const reader = await openNativeAnalyst({ ...options, context: localContext })
        const localIdentity = analystCaptureIdentity(localContext)
        t.after(() => {
            reader.close()
            return endAnalystRun(analystScopeKey(localIdentity.harness, localIdentity.chatId))
        })
        return reader
    }
    const interrupted = await makeReader(controller.signal)
    const sibling = await makeReader(undefined)
    const lock = new Client(connection)
    await lock.connect()
    try {
        await lock.query('BEGIN')
        await lock.query('LOCK TABLE public.native_reports IN ACCESS EXCLUSIVE MODE')
        const args = { sql: 'SELECT id FROM public.native_reports ORDER BY id LIMIT 1' }
        const cancelled = assert.rejects(interrupted.execute('query', args), { name: 'AbortError' })
        const retained = sibling.execute('query', args)
        const waiters = async () =>
            Number(
                (
                    await lock.query(
                        "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'cuttlely-analyst' AND wait_event_type = 'Lock'"
                    )
                ).rows[0].count
            )
        const waitFor = async (count) => {
            const until = Date.now() + 6000
            while (Date.now() < until) {
                // PostgreSQL's statistics snapshot is stable within a transaction until explicitly cleared.
                await lock.query('SELECT pg_stat_clear_snapshot()')
                if ((await waiters()) === count) return
                await new Promise((resolve) => setTimeout(resolve, 20))
            }
            assert.fail('Expected ' + count + ' blocked Analyst query backends')
        }
        await waitFor(2)
        controller.abort()
        await cancelled
        await waitFor(1)
        await lock.query('ROLLBACK')
        assert.equal(Number(JSON.parse(await retained).rows[0].id), 1)
    } finally {
        controller.abort()
        await lock.end()
    }

    // Exercise normal admission, the specialist model loop, trusted delivery and persisted history.
    const { rosterFromFlow } = await import('../../sync-from-flow.mjs')
    const { saveHarness } = await import('../../store.mjs')
    const { runHarness } = await import('../../run.mjs')
    const { readMessages, closeSessions } = await import('../../session.mjs')
    const { closeQueueDb } = await import('../../lock.mjs')
    t.after(() => {
        closeSessions()
        closeQueueDb()
    })
    const canvas = JSON.parse(
        JSON.parse(fs.readFileSync(new URL('../../../../samples/harnesses/ops.canvas.json', import.meta.url))).flowData
    )
    const node = canvas.nodes.find((n) => n.data.name === 'customMCP')
    node.data.name = 'postgreSQLMCP'
    node.data.inputs = binding.inputs
    const worker = canvas.nodes.find((n) => n.data.name === 'harnessSpecialist')
    worker.data.inputs.trustedOutputs = JSON.stringify(specialist.trustedOutputs)
    const saved = rosterFromFlow({ name: teamName, chatflowId: randomUUID(), workspaceId, flowData: canvas })
    saveHarness(saved)
    let skipSource = false
    let bypassDelegation = false
    let primeText = 'Unverified fabricated model answer'
    class Model {
        async init() {
            return {
                async invoke() {
                    return { content: 'Simulated conversation title' }
                },
                bindTools(tools) {
                    const chief = tools.some((t) => t.function.name === 'run_specialist')
                    return {
                        async invoke(messages) {
                            if ((chief && bypassDelegation) || messages.at(-1)._getType() === 'tool' || (!chief && skipSource))
                                return { content: chief && bypassDelegation ? primeText : 'Unverified fabricated model answer' }
                            return {
                                content: '',
                                tool_calls: [
                                    {
                                        id: randomUUID(),
                                        name: chief ? 'run_specialist' : pin.name,
                                        args: chief ? { name: saved.specialists[0].name, task: 'Return the verified report.' } : {}
                                    }
                                ]
                            }
                        }
                    }
                }
            }
        }
    }
    const run = {
        name: teamName,
        chatId: randomUUID(),
        input: 'Return the verified report.',
        mode: 'agent',
        fetchImpl: assert.fail,
        flowOptions: { workspaceId, appDataSource: {}, harnessCaller: { via: 'session' } },
        loadNode: async (node) => {
            if (node === 'chatXAI') return Model
            assert.equal(node, 'postgreSQLMCP')
            return createRequire(import.meta.url)(context.moduleOptions.componentNodes[node].filePath).nodeClass
        }
    }
    const completed = await runHarness(run).catch((e) => {
        throw new Error('Verified report failed: ' + e.message, { cause: e })
    })
    assert.equal(completed.text, 'First sourced report')
    assert.equal(completed.trace.engine, 'native')
    assert.equal(completed.trustedOutput, true)
    assert.equal(completed.agents[0].status, 'completed')
    assert.equal(readMessages(teamName, run.chatId).at(-1).content, completed.text)
    bypassDelegation = true
    const direct = await runHarness({ ...run, input: 'Return an updated report.' })
    assert.equal(direct.text, 'First sourced report')
    assert.equal(direct.trustedOutput, true)
    assert.equal(direct.agents[0].status, 'completed')
    skipSource = true
    const rejectedEvents = []
    await assert.rejects(runHarness({ ...run, input: 'Return a fresh verified report.', onEvent: (event) => rejectedEvents.push(event) }), {
        code: 'trusted_output'
    })
    assert.ok(!rejectedEvents.some((event) => event.type === 'final' || (event.type === 'partial' && event.phase === 'answer')))
    assert.equal(readMessages(teamName, run.chatId).at(-1).content, 'First sourced report')
    // A specialist's source contract also applies to mixed or conditional requests.
    // An exact caller-supplied literal is an ordinary reply with no data or attachment claim.
    for (const [input, expected] of [
        ['Please repeat verbatim "Ready for review".', 'Ready for review'],
        ['Return only TICKET-47. Do not delegate or use any tools.', 'TICKET-47']
    ]) {
        primeText = expected
        const echo = await runHarness({ ...run, chatId: randomUUID(), input })
        assert.equal(echo.text, expected)
        assert.ok(!echo.trustedOutput)
        assert.deepEqual(echo.agents, [])
        assert.equal(echo.artifacts?.length || 0, 0)
    }
    for (const [input, reply] of [
        ['Return only TICKET-47.', 'A different reply'],
        ['Return only TICKET-47 if the verified report confirms it.', 'TICKET-47'],
        ['Echo "Ready for review". Also return the verified report.', 'Ready for review'],
        ['Echo "database rows".', 'database rows']
    ]) {
        primeText = reply
        await assert.rejects(runHarness({ ...run, chatId: randomUUID(), input }), { code: 'trusted_output' })
    }

    // Two independent delegations must preserve both attachments, their bytes, and their references.
    const csvTeam = teamName + '-files'
    process.env.CUTTLELY_NATIVE_PRIME_TEAMS = csvTeam
    const reports = ['north', 'south'].map((name, index) => {
        const query = {
            ...pin,
            name: 'pq_' + name,
            id: randomUUID(),
            sql: 'SELECT table_payload FROM public.native_reports WHERE id = ' + (index + 1) + ' LIMIT 1',
            testedColumns: [{ name: 'table_payload', type: 'text' }]
        }
        const { statementHash } = compilePinned(query)
        query.testedStamp = computeStamp(
            createHmac('sha256', secret).update('cuttlely-pinned-query-v1').digest(),
            stampPayload({
                workspaceId,
                cred: '',
                statementHash,
                params: [],
                relations,
                allowedFunctions: [],
                testedColumns: query.testedColumns
            })
        )
        return { name, query, contract: { pin: query.name, hash: statementHash, mode: 'table-payload-csv' } }
    })
    const csvRoster = {
        ...saved,
        name: csvTeam,
        chatflowId: randomUUID(),
        specialists: reports.map(({ name, query, contract }, index) => ({
            ...saved.specialists[0],
            name,
            trustedOutputs: [contract],
            mcpServers: [{ ...binding, nodeId: 'csv' + index, inputs: { ...binding.inputs, mcpActions: [], pinnedQueries: [query] } }]
        }))
    }
    saveHarness(csvRoster)
    class CsvModel {
        async init() {
            return {
                invoke: async () => ({ content: 'Title' }),
                bindTools(tools) {
                    const offered = tools.map((tool) => tool.function.name)
                    return {
                        async invoke(messages) {
                            if (messages.at(-1)._getType() === 'tool') return { content: 'Fabricated file report' }
                            const calls = offered.includes('run_specialist')
                                ? reports.map(({ name }) => ({ name: 'run_specialist', args: { name, task: 'Return the region CSV' } }))
                                : [{ name: offered.find((n) => n.startsWith('pq_')), args: {} }]
                            return { content: '', tool_calls: calls.map((c) => ({ ...c, id: randomUUID() })) }
                        }
                    }
                }
            }
        }
    }
    const fileEvents = []
    const files = await runHarness({
        ...run,
        onEvent: (event) => fileEvents.push(event),
        name: csvTeam,
        chatId: randomUUID(),
        input: 'Return the two source reports as CSV files.',
        loadNode: async (node) => (node === 'chatXAI' ? CsvModel : run.loadNode(node))
    })
    const delivered = fileEvents.filter((event) => event.type === 'final' || (event.type === 'partial' && event.phase === 'answer'))
    assert.deepEqual(
        delivered.map(({ type, text, trustedOutput }) => [type, text, trustedOutput]),
        [
            ['partial', files.text, true],
            ['final', files.text, true]
        ]
    )
    assert.equal(files.trustedOutputComplete, true)
    assert.equal(files.artifacts.length, 2)
    assert.deepEqual(
        files.agents.map((step) => step.status),
        ['completed', 'completed']
    )
    for (const [index, file] of files.artifacts.entries()) {
        assert.equal(file.specialist, reports[index].name)
        assert.equal(Buffer.from(file.base64, 'base64').toString(), '"Region"\r\n"' + ['North', 'South'][index] + '"\r\n')
        assert.ok(files.text.includes(file.name))
    }
    assert.ok(!files.text.includes('Fabricated file report'))
})
