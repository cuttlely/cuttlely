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
        let current
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
            current = await startServer(root, dataEnv(disk, port, cfg), {
                preload: [provider]
            })
            await waitForPing(url, current)
            if (stage !== 'original') {
                const workerDisk = path.join(dir, stage + '-worker')
                fs.mkdirSync(workerDisk)
                // Exercise a replacement worker with the opposite canary setting and an empty local disk.
                worker = spawn(process.execPath, ['-r', provider, path.join(root, 'packages/harness/worker.mjs')], {
                    cwd: root,
                    env: dataEnv(workerDisk, port, {
                        ...cfg,
                        CUTTLELY_NATIVE_PRIME_TEAMS: stage === 'native' ? '' : [name, bookTeam].join(',')
                    }),
                    stdio: 'ignore'
                })
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
        await api(scheduleRoute + '/resume', {})
        // Make the fixture due now. The real web scheduler claims it and the external worker executes it.
        const { Pool } = createRequire(path.join(root, 'packages/server/package.json'))('pg')
        const pool = new Pool(db.connection)
        try {
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
