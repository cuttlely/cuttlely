import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createTestDatabase, skipReason } from '../packages/etl/check/pg-source.mjs'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'

import { nativePackageRoot, rejectCorruptRecovery, seedLegacyRuntime, verifyLegacyRecovery } from './kraken-package-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

test('the saved Ops canvas initializes, discovers and calls its allowlisted tool with the installed MCP client', async () => {
    const components = createRequire(new URL('../packages/components/package.json', import.meta.url))
    const { Client } = components('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = components('@modelcontextprotocol/sdk/client/stdio.js')
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'samples/harnesses/ops.canvas.json')))
    const { mcpServerConfig, mcpActions } = JSON.parse(saved.flowData).nodes.find((node) => node.data.name === 'customMCP').data.inputs
    const config = JSON.parse(mcpServerConfig)
    assert.deepEqual(config, { command: 'node', args: ['samples/ops-mcp-server.mjs'] })
    const transport = new StdioClientTransport({ command: process.execPath, args: config.args, cwd: root })
    const client = new Client({ name: 'compatibility-check', version: '1' })
    try {
        await client.connect(transport, { timeout: 5000 })
        const { tools } = await client.listTools()
        assert.deepEqual(
            tools.map((tool) => tool.name),
            mcpActions
        )
        const result = await client.callTool({ name: 'ops_status', arguments: {} })
        assert.equal(result.isError, false)
        assert.equal(result.content[0].text, 'ops-status: allowlisted MCP tool responded')
        await assert.rejects(client.callTool({ name: 'unknown', arguments: {} }), { code: -32602 })
    } finally {
        await client.close()
    }
})

test(
    'a saved team keeps its ID, credential and chat through native cutover, empty disk and engine rollback',
    { skip: skipReason },
    async (t) => {
        const db = await createTestDatabase()
        const { host, port: pgPort, user, password, database } = db.connection
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-upgrade-'))
        const name = 'kraken-calculator'
        const bookTeam = name + '-playbook'
        const chatId = randomUUID()
        const modelKey = randomUUID()
        const busyKey = randomUUID()
        const secretKey = randomUUID()
        const account = { email: 'qa@example.invalid', password: randomUUID() + 'aA1!' }
        const nativeInstall = nativePackageRoot()
        const historySession = randomUUID()
        const historyMessage = 'preserved ' + randomUUID()
        let current, restartApi, restartWorker
        let worker
        const provider = path.join(root, 'scripts/fixtures/kraken-provider.cjs')
        async function stopWorker() {
            if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
            const exited = once(worker, 'exit')
            worker.kill('SIGTERM')
            const timer = setTimeout(() => worker.kill('SIGKILL'), 5000)
            try {
                await exited
            } finally {
                clearTimeout(timer)
            }
        }
        let stage = 'original'
        const legacyCalls = []
        const legacy = http.createServer(async (req, res) => {
            try {
                assert.equal(req.method, 'POST')
                assert.ok([name, bookTeam].some((team) => req.url === '/p/' + team + '/v1/runs'))
                assert.match(req.headers.authorization, /^Bearer .+/)
                let raw = ''
                for await (const chunk of req) raw += chunk
                const body = JSON.parse(raw)
                if (stage === 'rollback') assert.ok(body.conversation_history.some((m) => m.content === 'Native verified 51.'))
                legacyCalls.push(stage)
                res.writeHead(200, { 'content-type': 'application/json' }).end(
                    JSON.stringify({ status: 'completed', output: 'Legacy verified 51.' })
                )
            } catch {
                res.writeHead(400).end()
            }
        })
        await new Promise((resolve) => legacy.listen(0, '127.0.0.1', resolve))
        t.after(async () => {
            try {
                await stopWorker()
                await current?.stop()
            } finally {
                legacy.closeAllConnections()
                await new Promise((resolve) => legacy.close(resolve))
                await db.cleanup()
                fs.rmSync(dir, { recursive: true, force: true })
            }
        })
        const port = await freePort()
        const url = 'http://127.0.0.1:' + port
        let cookie
        async function boot() {
            await stopWorker()
            await current?.stop()
            current = undefined
            const disk = path.join(dir, stage)
            fs.mkdirSync(disk)
            const cfg = {
                DATABASE_TYPE: 'postgres',
                DATABASE_HOST: host,
                DATABASE_PORT: String(pgPort),
                DATABASE_USER: user,
                DATABASE_PASSWORD: password,
                DATABASE_NAME: database,
                CUTTLELY_APP_DATABASE_STORES: '1',
                CUTTLELY_SECRETKEY_OVERWRITE: secretKey,
                CUTTLELY_LOCAL_USERS: 'true',
                ...(stage === 'original'
                    ? { CUTTLELY_INITIAL_OWNER_EMAIL: account.email, CUTTLELY_INITIAL_OWNER_PASSWORD: account.password }
                    : {}),
                CUTTLELY_NATIVE_PRIME_TEAMS: stage === 'native' ? [name, bookTeam].join(',') : '',
                CUTTLELY_HARNESS_QUEUE: stage === 'original' ? 'off' : 'external',
                KRAKEN_FIXTURE_MODEL_KEY: modelKey,
                KRAKEN_FIXTURE_BUSY_KEY: busyKey,
                HERMES_API_URL: 'http://127.0.0.1:' + legacy.address().port,
                CUTTLELY_ANALYST: 'off'
            }
            const packaged = stage === 'native' && nativeInstall
            const install = packaged || root
            const apiEnv = dataEnv(disk, port, cfg)
            if (packaged) {
                apiEnv.CUTTLELY_NATIVE_PRIME_TEAMS = ''
                apiEnv.CUTTLELY_HARNESS_WORKERS = '0'
                apiEnv.HERMES_PYTHON = path.join(install, 'missing-python')
            }
            restartApi = async () => {
                current = await startServer(install, apiEnv, { preload: [provider], launcher: Boolean(packaged) })
                await waitForPing(url, current)
            }
            await restartApi()
            if (nativeInstall && stage === 'original') seedLegacyRuntime(root, apiEnv, historySession, historyMessage)
            if (nativeInstall && stage !== 'original') verifyLegacyRecovery(disk, historySession, historyMessage)
            if (packaged) {
                assert.ok(current.logs.some((line) => line.includes('using the native agent runtime')))
                rejectCorruptRecovery(
                    install,
                    dataEnv(path.join(dir, 'wrong-key'), port, { ...cfg, CUTTLELY_SECRETKEY_OVERWRITE: randomUUID() })
                )
            }
            if (stage !== 'original') {
                const workerDisk = path.join(dir, stage + '-worker')
                fs.mkdirSync(workerDisk)
                // Exercise a replacement worker with the opposite canary setting and an empty local disk.
                restartWorker = () =>
                    spawn(process.execPath, ['-r', provider, path.join(install, 'packages/harness/worker.mjs')], {
                        cwd: install,
                        env: dataEnv(workerDisk, port, {
                            ...cfg,
                            CUTTLELY_NATIVE_PRIME_TEAMS: stage === 'native' ? '' : [name, bookTeam].join(',')
                        }),
                        stdio: 'ignore'
                    })
                worker = restartWorker()
            }
            const login = await request(url + '/api/v1/auth/local/login', { method: 'POST', body: account })
            assert.equal(login.status, 200)
            cookie = login.cookie
        }
        async function api(route, body, method = body ? 'POST' : 'GET') {
            t.diagnostic(stage + ' ' + route.split('/')[0])
            const r = await request(url + '/api/v1/' + route, { method, body, cookie }).catch((error) => {
                throw new Error(stage + ' ' + route + ' failed: ' + error.name)
            })
            assert.ok(r.status >= 200 && r.status < 300, route + ' returned ' + r.status + ' ' + (r.json?.message || ''))
            return r.json
        }
        await boot()
        const cred = await api('credentials', { name: 'QA model', credentialName: 'xaiApi', plainDataObj: { xaiApiKey: modelKey } })
        const canvas = JSON.parse(fs.readFileSync(path.join(root, 'samples/harnesses/calculator.canvas.json')))
        const graph = JSON.parse(canvas.flowData)
        graph.nodes.find((n) => n.data.name === 'chatXAI').data.credential = cred.id
        const saved = await api('chatflows', { name, type: 'HARNESS', flowData: JSON.stringify(graph), deployed: false, isPublic: false })
        const stored = await api('chatflows/' + saved.id)
        const bookGraph = structuredClone(graph)
        bookGraph.nodes.find((n) => n.data.name === 'harnessSpecialist').data.inputs.playbooks = [
            {
                name: 'inventory',
                description: 'Inventory reconciliation',
                content: 'Stock check step.\n'.repeat(3000) + 'Inventory formula: 17 * 3'
            }
        ]
        // This team keeps separate saved primary and fallback bindings for its specialist.
        const busy = await api('credentials', { name: 'QA busy primary', credentialName: 'xaiApi', plainDataObj: { xaiApiKey: busyKey } })
        const backup = bookGraph.nodes.find((node) => node.data.name === 'chatXAI')
        const primary = structuredClone(backup)
        primary.id = primary.data.id = 'chatXAI_primary'
        primary.data.credential = busy.id
        primary.data.inputs.modelName = 'qa-primary'
        bookGraph.nodes.push(primary)
        const specialistId = bookGraph.nodes.find((node) => node.data.name === 'harnessSpecialist').id
        for (const [binding, input] of [
            [primary, 'chatModel'],
            [backup, 'fallbackModel']
        ]) {
            bookGraph.edges.push({
                id: binding.id + '-' + specialistId + '-' + input,
                source: binding.id,
                target: specialistId,
                targetHandle: specialistId + '-input-' + input
            })
        }
        const bookFlow = await api('chatflows', {
            name: bookTeam,
            type: 'HARNESS',
            flowData: JSON.stringify(bookGraph),
            deployed: false,
            isPublic: false
        })
        const originalBookFlow = await api('chatflows/' + bookFlow.id)
        const callerSample = JSON.parse(fs.readFileSync(path.join(root, 'samples/chatflows/ops.chatflow.json')))
        const callerGraph = JSON.parse(callerSample.flowData)
        callerGraph.nodes.find((node) => node.data.name === 'harness').data.inputs.harnessName = name
        const caller = await api('chatflows', {
            name: 'qa-caller',
            type: 'CHATFLOW',
            flowData: JSON.stringify(callerGraph),
            deployed: true,
            isPublic: false
        })
        const savedCaller = (await api('chatflows/' + caller.id)).flowData
        async function predict() {
            const response = await api('prediction/' + caller.id, { question: '17 * 3', overrideConfig: { sessionId: randomUUID() } })
            assert.equal(response.text, '51')
        }
        await predict()
        const scheduleRoute = 'harnesses/' + name + '/schedule'
        const savedSchedule = await api(scheduleRoute, { cron: '0 0 * * *', timezone: 'UTC', question: '17 * 3', status: 'paused' }, 'PUT')
        assert.equal(savedSchedule.schedule.status, 'paused')
        const run = (team = name) => api('harnesses/' + team + '/runs', { mode: 'agent', question: '17 * 3', chatId })
        assert.equal((await run()).text, 'Legacy verified 51.')
        assert.equal((await run(bookTeam)).text, 'Legacy verified 51.')
        stage = 'native'
        await boot()
        assert.equal((await api('chatflows/' + saved.id)).flowData, stored.flowData)
        const result = await run()
        assert.equal(result.text, 'Native verified 51.')
        assert.equal(result.trace.engine, 'native')
        if (nativeInstall) verifyLegacyRecovery(path.join(dir, 'native-worker'), historySession, historyMessage)
        assert.deepEqual(
            result.agents.map((a) => [a.name, a.status]),
            [['math', 'completed']]
        )
        assert.equal((await api('chatflows/' + bookFlow.id)).flowData, originalBookFlow.flowData)
        const bookResult = await run(bookTeam)
        assert.equal(bookResult.text, 'Native verified 51.')
        assert.match(bookResult.agents[0].fallback, /grok-4\.7/)
        assert.equal(bookResult.agents[0].model, bookResult.agents[0].fallback)
        assert.deepEqual(
            bookResult.agents.map((agent) => agent.status),
            ['completed']
        )
        const tools = bookResult.agents[0].tools
        assert.equal(tools[0], 'skills_list done')
        assert.equal(tools.at(-1), 'calculator done')
        assert.ok(tools.length > 4 && tools.slice(1, -1).every((tool) => tool === 'skill_view done'))
        assert.deepEqual(legacyCalls, ['original', 'original'])
        assert.equal((await api('chatflows/' + caller.id)).flowData, savedCaller)
        await predict()
        assert.equal((await api(scheduleRoute)).schedule.status, 'paused')
        const { Pool } = createRequire(path.join(root, 'packages/server/package.json'))('pg')
        const pool = new Pool(db.connection)
        try {
            // The HTTP waiter is gone before the external worker accepts the answer. A temporary
            // accounting failure must leave enough proof to return that exact answer after restart.
            const route = 'harnesses/' + name + '/runs'
            const usage = async () =>
                (await pool.query('SELECT COALESCE(sum("inputTokens"),0)::int n FROM token_usage_day WHERE "flowId"=$1', [name])).rows[0].n
            const previous = await usage()
            await stopWorker()
            await pool.query('ALTER TABLE token_usage_day ADD CONSTRAINT qa_hold_usage CHECK ("inputTokens" < 0) NOT VALID')
            const pending = await api(route + '/async', { mode: 'agent', question: '17 * 3', chatId })
            const jobStatus = async () =>
                (await pool.query("SELECT status FROM cuttlely_harness_queue.jobs WHERE payload::jsonb->>'runId'=$1", [pending.runId]))
                    .rows[0]?.status
            async function waitForJob(expected) {
                const deadline = Date.now() + 30000
                while ((await jobStatus()) !== expected) {
                    assert.ok(Date.now() < deadline, 'Expected external job status ' + expected)
                    await new Promise((resolve) => setTimeout(resolve, 100))
                }
            }
            await waitForJob('queued')
            await current.stop()
            worker = restartWorker()
            await waitForJob('succeeded')
            assert.equal(await usage(), previous)
            await restartApi()
            const path = route + '/' + pending.runId + '/result'
            const unavailable = await request(url + '/api/v1/' + path, { cookie })
            assert.equal(unavailable.status, 503)
            await pool.query('ALTER TABLE token_usage_day DROP CONSTRAINT qa_hold_usage')
            // No client asks again until the external worker has independently committed its charge.
            const settling = Date.now() + 30000
            while ((await usage()) === previous) {
                assert.ok(Date.now() < settling, 'Worker must settle the accepted result without another HTTP read')
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
            for (let n = 0; n < 2; n++) {
                const recovered = await api(path)
                assert.equal(recovered.status, 'succeeded')
                assert.equal(recovered.result.text, result.text)
                assert.equal(await usage(), previous + 9)
            }
            await api(scheduleRoute + '/resume', {})
            // Make the fixture due now. The real web scheduler claims it and the external worker executes it.
            const due = await pool.query(
                "UPDATE cuttlely_harness_queue.harness_schedules SET next_run_at = $1 WHERE harness_name = $2 AND status = 'active'",
                [Date.now() - 1000, name]
            )
            assert.equal(due.rowCount, 1)
        } finally {
            await pool.end()
        }
        let occurrence
        const deadline = Date.now() + 60000
        do {
            const { schedule } = await api(scheduleRoute)
            if (schedule.lastResult === 'failed') assert.fail('The due schedule failed.')
            if (schedule.lastResult === 'succeeded' && schedule.lastRunId) {
                occurrence = schedule.lastRunId
                break
            }
            await new Promise((resolve) => setTimeout(resolve, 1000))
        } while (Date.now() < deadline)
        assert.ok(occurrence, 'The due schedule must record its completed run')
        await api(scheduleRoute + '/pause', {})
        stage = 'rollback'
        await boot()
        const rolledBack = await run()
        assert.equal(rolledBack.text, 'Legacy verified 51.')
        assert.equal(rolledBack.trace.engine, 'hermes')
        assert.equal((await run(bookTeam)).text, 'Legacy verified 51.')
        await predict()
        const restored = (await api(scheduleRoute)).schedule
        assert.equal(restored.status, 'paused')
        assert.equal(restored.lastRunId, occurrence)
        const scheduled = await api('harnesses/' + name + '/runs/' + occurrence + '/result')
        assert.equal(scheduled.source, 'schedule')
        assert.equal(scheduled.result.text, '51')
        assert.deepEqual(legacyCalls, ['original', 'original', 'rollback', 'rollback'])
    }
)

test(
    'PostgreSQL background usage follows the admitted workspace and commits once with its completed result',
    { skip: skipReason },
    async (t) => {
        const db = await createTestDatabase()
        const requireServer = createRequire(new URL('../packages/server/package.json', import.meta.url))
        const { Pool } = requireServer('pg')
        const { AddTokenUsageDay1791900000000 } = requireServer('./dist/database/migrations/postgres/1791900000000-AddTokenUsageDay.js')
        const { recordCompletedRun } = requireServer('./dist/services/usage/store.js')
        const { configureHarnessPostgres } = await import('../packages/harness/side-store-postgres.mjs')
        const { closeQueueDb, database } = await import('../packages/harness/lock.mjs')
        const { queueHarnessRun, beginHarnessRun, finishHarnessRun, getRun, getRunResult, accountReturnedBackgroundRun } = await import(
            '../packages/harness/history.mjs'
        )
        const connection = { ...db.connection, options: '-c search_path=paper_accounts,public' }
        const pool = new Pool(connection)
        t.after(async () => {
            closeQueueDb()
            configureHarnessPostgres(null)
            await pool.end()
            await db.cleanup()
        })
        await pool.query('CREATE SCHEMA paper_accounts')
        await new AddTokenUsageDay1791900000000().up(pool)
        configureHarnessPostgres(connection)
        database()
        // A previously installed PostgreSQL schema gains the accounting fields when reopened.
        await pool.query('ALTER TABLE cuttlely_harness_queue.run_history DROP COLUMN usage_workspace_id, DROP COLUMN usage_recorded')
        closeQueueDb()
        configureHarnessPostgres(connection)
        const owner = randomUUID(),
            other = randomUUID(),
            name = 'Paper',
            creditTime = Date.UTC(2026, 4, 25, 23, 59, 58)
        const payload = {
            text: 'Approved 51.',
            trace: {
                route: { model: 'first-model', tokens: { prompt: 7, completion: 2 } },
                specialists: [{ model: 'second-model', tokens: { prompt: 6, completion: 3 } }]
            }
        }
        const totals = async () =>
            (
                await pool.query(
                    'SELECT "workspaceId","flowId",day,model,"inputTokens","outputTokens" FROM token_usage_day ORDER BY day,model'
                )
            ).rows
        const begin = (workspaceId) => {
            const args = { name, workspaceId, chatId: randomUUID(), input: 'Count.' }
            const pending = queueHarnessRun(args)
            return beginHarnessRun({ ...args, id: pending.id })
        }
        const done = (pending, workspaceId = owner) =>
            finishHarnessRun(pending, { result: payload, finishedAt: creditTime, saveResult: true, usageWorkspace: workspaceId })
        const first = begin(owner)
        // Failure on the second bucket must roll back the first bucket, the result and the credit marker.
        await pool.query("ALTER TABLE token_usage_day ADD CONSTRAINT block_second_model CHECK(model <> 'second-model')")
        assert.throws(() => done(first), /PostgreSQL operation failed/)
        assert.equal(getRun(name, first.id).status, 'running')
        assert.equal(getRunResult(name, first.id), null)
        assert.deepEqual(await totals(), [])
        await pool.query('ALTER TABLE token_usage_day DROP CONSTRAINT block_second_model')
        done(first)
        assert.equal(getRunResult(name, first.id).text, payload.text)
        finishHarnessRun(first, { result: { text: 'Late reply.' }, finishedAt: creditTime, saveResult: true, usageWorkspace: owner })
        assert.equal(getRunResult(name, first.id).text, payload.text)
        const expected = [
            { workspaceId: owner, flowId: name, day: '2026-05-25', model: 'first-model', inputTokens: 7, outputTokens: 2 },
            { workspaceId: owner, flowId: name, day: '2026-05-25', model: 'second-model', inputTokens: 6, outputTokens: 3 }
        ]
        assert.deepEqual(await totals(), expected)
        closeQueueDb()
        configureHarnessPostgres(connection)
        assert.equal(accountReturnedBackgroundRun(name, first.id, owner, payload), true)
        assert.deepEqual(await totals(), expected)
        // New API, older worker: repair from the accepted run; a foreign caller cannot take the credit.
        const mixed = begin(owner)
        finishHarnessRun(mixed, { result: payload, finishedAt: creditTime })
        accountReturnedBackgroundRun(name, mixed.id, other, payload)
        assert.deepEqual(await totals(), expected)
        for (let n = 0; n < 2; n++) accountReturnedBackgroundRun(name, mixed.id, owner, payload)
        let factor = 2
        const scaled = () =>
            expected.map((line) => ({ ...line, inputTokens: line.inputTokens * factor, outputTokens: line.outputTokens * factor }))
        assert.deepEqual(await totals(), scaled())
        // Older API, new worker: its admission has no accounting owner, so its original callback writes once.
        done(begin(undefined))
        assert.deepEqual(await totals(), scaled())
        await recordCompletedRun(
            { options: { type: 'postgres' }, query: (sql, args) => pool.query(sql, args) },
            { workspaceId: owner, flowId: name, result: payload, at: new Date(creditTime) }
        )
        factor = 3
        assert.deepEqual(await totals(), scaled())
        const { enqueueHarnessJob, finishJob, reconcilePublicQueueRun } = await import('../packages/harness/queue.mjs')
        for (const [apiKeyId, workspaceId, requestWorkspace] of [
            [null, owner, other],
            ['another-key', owner, owner],
            [null, other, owner]
        ]) {
            const pending = begin(owner)
            const job = enqueueHarnessJob({ name, chatId: pending.chatId, runId: pending.id, apiKeyId, flowOptions: { workspaceId } })
            finishJob(job.id, { status: 'succeeded', result: { ...payload, runId: pending.id } })
            assert.equal(reconcilePublicQueueRun(pending, requestWorkspace), false)
            assert.equal(getRunResult(name, pending.id), null)
        }
        assert.deepEqual(await totals(), scaled())
        // Two polls may both have read the unfinished status before either gets to the job.
        const stale = begin(owner)
        const job = enqueueHarnessJob({ name, chatId: stale.chatId, runId: stale.id, flowOptions: { workspaceId: owner } })
        finishJob(job.id, { status: 'succeeded', result: { ...payload, runId: stale.id } })
        for (let i = 0; i < 2; i++) assert.equal(reconcilePublicQueueRun(stale, owner), true)
        assert.equal(getRunResult(name, stale.id).text, payload.text)
        // A running admission and an older interrupted receipt for the same team must survive
        // 101 later admissions and completions, with independent chats and a separate API key.
        const team = 'Retention'
        const admission = (key) => {
            const args = { name: team, workspaceId: owner, apiKeyId: key, chatId: randomUUID() }
            const row = queueHarnessRun(args)
            return beginHarnessRun({ ...args, id: row.id })
        }
        const long = admission('first')
        const held = admission('second')
        const saved = enqueueHarnessJob({
            name: team,
            chatId: held.chatId,
            runId: held.id,
            apiKeyId: 'second',
            flowOptions: { workspaceId: owner }
        })
        finishJob(saved.id, { status: 'succeeded', result: { ...payload, runId: held.id } })
        const { interruptOpenRuns } = await import('../packages/harness/history.mjs')
        interruptOpenRuns({ before: Date.now() + 1 })
        // An older API could have generically interrupted the accepted run, whereas this job really is active.
        const active = admission('first')
        let oldest
        for (let n = 0; n < 101; n++) {
            const later = admission('other')
            if (!oldest) oldest = later
            finishHarnessRun(later, { result: { text: 'Later.' }, saveResult: true, usageWorkspace: owner })
        }
        assert.equal(getRun(team, active.id)?.status, 'running')
        assert.equal(getRun(team, held.id)?.error?.code, 'interrupted')
        assert.equal(getRun(team, oldest.id), null)
        assert.equal(getRun(team, long.id), null)
        assert.equal(getRun(team, active.id, { apiKeyId: 'other' }), null)
        assert.ok(reconcilePublicQueueRun(getRun(team, held.id), owner))
        finishHarnessRun(active, { result: payload, saveResult: true, usageWorkspace: owner })
        assert.equal(getRunResult(team, held.id)?.text, payload.text)
        assert.equal(getRunResult(team, active.id)?.text, payload.text)
        assert.equal(getRunResult(team, oldest.id), null)
        assert.equal(
            (await pool.query('SELECT count(*)::int AS n FROM cuttlely_harness_queue.run_history WHERE harness_name=$1', [team])).rows[0].n,
            100
        )

        // A permanently rejected workspace must not monopolize the next sweep.
        const { recoverAcceptedUsage } = await import('../packages/harness/queue.mjs')
        const awaiting = (name, workspaceId) => {
            const args = { name, workspaceId, chatId: randomUUID() }
            const pending = queueHarnessRun(args)
            const row = beginHarnessRun({ ...args, id: pending.id })
            const job = enqueueHarnessJob({ name, chatId: row.chatId, runId: row.id, flowOptions: { workspaceId } })
            finishJob(job.id, { status: 'succeeded', result: { ...payload, runId: row.id } })
            return row
        }
        const rejected = awaiting('Unsettled', owner),
            healthy = awaiting('Independent', other)
        // An older worker closed its history but did not preserve the detached request's result or charge.
        finishHarnessRun(healthy, { result: payload })
        assert.equal(getRun(healthy.harness, healthy.id).status, 'completed_with_errors')
        assert.equal(getRunResult(healthy.harness, healthy.id), null)
        await pool.query(`ALTER TABLE token_usage_day ADD CONSTRAINT block_first_team CHECK ("flowId" <> 'Unsettled') NOT VALID`)
        let cursor = ''
        for (let n = 0; n < 10 && !getRunResult(healthy.harness, healthy.id); n++) cursor = recoverAcceptedUsage(cursor)
        assert.equal(getRunResult(healthy.harness, healthy.id)?.text, payload.text)
        assert.equal(getRunResult(rejected.harness, rejected.id), null)
        assert.deepEqual(
            (await pool.query('SELECT DISTINCT "workspaceId" FROM token_usage_day WHERE "flowId"=$1', [healthy.harness])).rows,
            [{ workspaceId: other }]
        )
        await pool.query('ALTER TABLE token_usage_day DROP CONSTRAINT block_first_team')
        for (let n = 0; n < 10 && !getRunResult(rejected.harness, rejected.id); n++) cursor = recoverAcceptedUsage(cursor)
        assert.equal(getRunResult(rejected.harness, rejected.id)?.text, payload.text)
    }
)

test('PostgreSQL queue poll snapshots deliver ordered public events once and preserve terminal fences', { skip: skipReason }, async (t) => {
    const db = await createTestDatabase()
    const { configureHarnessPostgres } = await import('../packages/harness/side-store-postgres.mjs')
    const { database, closeQueueDb } = await import('../packages/harness/lock.mjs')
    const { enqueueHarnessJob, claimJob, appendEvent, finishJob, waitForJob, markCancel, cancelRequested, readJob } = await import(
        '../packages/harness/queue.mjs'
    )
    const { Pool } = createRequire(new URL('../packages/server/package.json', import.meta.url))('pg')
    const connection = { ...db.connection, options: '-c lock_timeout=1000ms -c search_path=paper_operations,pg_catalog' }
    const pool = new Pool(connection)
    configureHarnessPostgres(connection)
    t.after(async () => {
        closeQueueDb()
        configureHarnessPostgres(null)
        await pool.end()
        await db.cleanup()
    })
    await pool.query('CREATE SCHEMA paper_operations')
    // The operator's own schema can legitimately contain unrelated tables with these names.
    await pool.query('CREATE TABLE paper_operations.jobs (id BIGINT PRIMARY KEY)')
    await pool.query('CREATE TABLE paper_operations.job_events (id BIGINT PRIMARY KEY)')
    assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, 'paper_operations')
    const enqueue = () => enqueueHarnessJob({ name: 'Paper', chatId: randomUUID() }).id
    const other = enqueue()
    appendEvent(other, { type: 'foreign' })
    finishJob(other, { status: 'succeeded', result: { text: 'unrelated' } })
    const job = enqueue()
    appendEvent(job, { type: 'nativeToolReceipt', phase: 'dispatched' })
    appendEvent(job, { type: 'partial', text: 'Approved' })
    const events = []
    const result = await waitForJob(job, {
        timeoutMs: 3000,
        onEvent(event) {
            events.push(event)
            if (event.type === 'partial') {
                // This writer commits after the waiter's first statement snapshot.
                appendEvent(job, { type: 'final', tokens: { prompt: 7, completion: 2 } })
                finishJob(job, { status: 'succeeded', result: { text: 'Approved' } })
            }
        }
    })
    assert.deepEqual(events, [
        { type: 'partial', text: 'Approved' },
        { type: 'final', tokens: { prompt: 7, completion: 2 } }
    ])
    assert.deepEqual(result, { text: 'Approved' })
    // A writer holds the normal queue fence and has not committed the final event or status.
    // The reader can observe the previous state and its visible event, then the terminal pair.
    const concurrent = enqueue()
    appendEvent(concurrent, { type: 'visible' })
    const writer = await pool.connect()
    try {
        await writer.query('BEGIN')
        await writer.query("SELECT pg_advisory_xact_lock(hashtext('cuttlely_harness_queue'))")
        await writer.query('INSERT INTO cuttlely_harness_queue.job_events(job_id,seq,event) VALUES ($1,2,$2)', [
            concurrent,
            JSON.stringify({ type: 'final' })
        ])
        await writer.query("UPDATE cuttlely_harness_queue.jobs SET status='succeeded', result=$2 WHERE id=$1", [
            concurrent,
            JSON.stringify({ text: 'committed' })
        ])
        const before = database().pollJob(concurrent, 0, '{"type":"nativeToolReceipt",%')
        assert.equal(before.status, 'queued')
        assert.deepEqual(
            before.events.map((event) => JSON.parse(event)),
            [{ type: 'visible' }]
        )
        await writer.query('COMMIT')
        const visible = []
        assert.deepEqual(await waitForJob(concurrent, { onEvent: (event) => visible.push(event) }), { text: 'committed' })
        assert.deepEqual(visible, [{ type: 'visible' }, { type: 'final' }])
    } finally {
        await writer.query('ROLLBACK')
        writer.release()
    }
    const cancelled = enqueue(),
        controller = new AbortController(),
        runId = 'run_' + randomUUID()
    appendEvent(cancelled, { type: 'starting' })
    await assert.rejects(
        waitForJob(cancelled, {
            signal: controller.signal,
            timeoutMs: 3000,
            onEvent() {
                controller.abort()
                assert.ok(cancelRequested(cancelled))
                finishJob(cancelled, { status: 'cancelled', errorCode: 'aborted', errorMessage: 'cancelled', result: { runId } })
            }
        }),
        (error) => error.code === 'aborted' && error.runId === runId
    )
    const lost = enqueue()
    assert.equal(claimJob().id, lost)
    appendEvent(lost, { type: 'nativeToolReceipt', callId: 'paper-call', phase: 'dispatched' })
    database().prepare('UPDATE jobs SET updated_at = 1 WHERE id = ?').run(lost)
    const visible = []
    await assert.rejects(waitForJob(lost, { onEvent: (event) => visible.push(event), timeoutMs: 3000 }), { code: 'worker_lost' })
    assert.deepEqual(visible, [])
    assert.equal(readJob(lost).errorCode, 'worker_lost')
    assert.equal(
        database().prepare('SELECT count(*) AS n FROM job_events WHERE job_id=? AND event LIKE ?').get(lost, '%"phase":"uncertain"%').n,
        1
    )
    await assert.rejects(waitForJob('job_' + randomUUID()), { code: 'not_found' })
    // Change the real job immediately after capturing a snapshot. The waiter then reaches exactly
    // its deadline, without relying on the listener, wall-clock delays or interprocess timing.
    async function atDeadline(id, action, expectedPolls, onEvent) {
        const store = database()
        const original = store.pollJob.bind(store)
        let now = Date.now()
        let polls = 0
        const clock = t.mock.method(Date, 'now', () => now)
        const reader = t.mock.method(store, 'pollJob', (...args) => {
            const snapshot = original(...args)
            if (++polls === 1) {
                action()
                now += 30
            } else now++
            return snapshot
        })
        try {
            return await waitForJob(id, { timeoutMs: 30, onEvent })
        } finally {
            reader.mock.restore()
            clock.mock.restore()
            assert.equal(polls, expectedPolls)
        }
    }
    const crossing = enqueue()
    appendEvent(crossing, { type: 'partial' })
    const delivered = []
    const outcome = await atDeadline(
        crossing,
        () => {
            appendEvent(crossing, { type: 'final' })
            finishJob(crossing, { status: 'succeeded', result: { text: 'settled' } })
        },
        2,
        (event) => delivered.push(event.type)
    )
    assert.equal(outcome.text, 'settled')
    assert.deepEqual(delivered, ['partial', 'final'])
    const failed = enqueue()
    await assert.rejects(
        atDeadline(failed, () => finishJob(failed, { status: 'failed', errorCode: 'bad_model', errorMessage: 'rejected' }), 2),
        { code: 'bad_model' }
    )
    const expired = enqueue()
    markCancel(expired)
    const beforeTimeout = readJob(expired).updatedAt
    await assert.rejects(
        atDeadline(expired, () => {}, 1),
        { code: 'worker_timeout' }
    )
    assert.equal(cancelRequested(expired), true)
    assert.equal(readJob(expired).updatedAt, beforeTimeout)
    const active = enqueue()
    await assert.rejects(
        atDeadline(active, () => {}, 1),
        { code: 'worker_timeout' }
    )
    assert.equal(cancelRequested(active), true)
    const removed = enqueue()
    await assert.rejects(
        atDeadline(removed, () => database().prepare('DELETE FROM jobs WHERE id = ?').run(removed), 1),
        { code: 'not_found' }
    )
    const corrupt = enqueue()
    database().prepare('INSERT INTO job_events(job_id,seq,event) VALUES (?,1,?)').run(corrupt, 'incomplete public event')
    await assert.rejects(waitForJob(corrupt), SyntaxError)
})
