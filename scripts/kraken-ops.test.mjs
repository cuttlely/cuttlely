import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createTestDatabase, skipReason } from '../packages/etl/check/pg-source.mjs'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
test(
    'the saved Ops team runs its actual granted MCP tool through the authenticated API and an external native worker',
    { skip: skipReason },
    async (t) => {
        const db = await createTestDatabase()
        const { host, port: pgPort, user, password, database } = db.connection
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-ops-'))
        const name = 'kraken-ops'
        const key = randomUUID()
        const account = { email: 'qa@example.invalid', password: randomUUID() + 'Aa1!' }
        const port = await freePort()
        const url = 'http://127.0.0.1:' + port
        const provider = path.join(root, 'scripts/fixtures/kraken-ops-provider.cjs')
        const config = {
            DATABASE_TYPE: 'postgres',
            DATABASE_HOST: host,
            DATABASE_PORT: String(pgPort),
            DATABASE_USER: user,
            DATABASE_PASSWORD: password,
            DATABASE_NAME: database,
            CUTTLELY_APP_DATABASE_STORES: '1',
            CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
            CUTTLELY_LOCAL_USERS: 'true',
            CUTTLELY_INITIAL_OWNER_EMAIL: account.email,
            CUTTLELY_INITIAL_OWNER_PASSWORD: account.password,
            CUTTLELY_NATIVE_PRIME_TEAMS: [name, name + '-unsupported'].join(','),
            CUTTLELY_HARNESS_QUEUE: 'external',
            CUTTLELY_ANALYST: 'off',
            CUSTOM_MCP_PROTOCOL: 'stdio',
            CUSTOM_MCP_SECURITY_CHECK: 'true',
            CUSTOM_MCP_ALLOWED_COMMANDS: 'node',
            CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS: 'samples/ops-mcp-server.mjs',
            KRAKEN_OPS_MODEL_KEY: key,
            HERMES_API_URL: 'http://127.0.0.1:' + (await freePort())
        }
        let api, worker
        t.after(async () => {
            try {
                if (worker && worker.exitCode === null && worker.signalCode === null) {
                    const exited = once(worker, 'exit')
                    worker.kill('SIGTERM')
                    const timer = setTimeout(() => worker.kill('SIGKILL'), 5000)
                    try {
                        await exited
                    } finally {
                        clearTimeout(timer)
                    }
                }
            } finally {
                try {
                    await api?.stop()
                } finally {
                    await db.cleanup()
                    fs.rmSync(dir, { recursive: true, force: true })
                }
            }
        })
        api = await startServer(root, dataEnv(path.join(dir, 'api'), port, config), { preload: [provider] })
        await waitForPing(url, api)
        worker = spawn(process.execPath, ['-r', provider, path.join(root, 'packages/harness/worker.mjs')], {
            cwd: root,
            env: dataEnv(path.join(dir, 'worker'), port, { ...config, CUTTLELY_NATIVE_PRIME_TEAMS: '' }),
            stdio: 'ignore'
        })
        const workerExit = once(worker, 'exit')
        const { cookie, status } = await request(url + '/api/v1/auth/local/login', { method: 'POST', body: account })
        assert.equal(status, 200)
        async function post(route, body) {
            const res = await Promise.race([
                request(url + '/api/v1/' + route, { method: 'POST', cookie, body, timeoutMs: 60000 }),
                workerExit.then(([code, signal]) => {
                    throw new Error('Fixture worker stopped before dispatch completed: ' + (signal || code))
                })
            ])
            assert.ok(res.status >= 200 && res.status < 300, route + ' returned ' + res.status + ' ' + (res.json?.message || ''))
            return res.json
        }
        const credential = await post('credentials', { name: 'Fixture model', credentialName: 'xaiApi', plainDataObj: { xaiApiKey: key } })
        const canvas = JSON.parse(fs.readFileSync(path.join(root, 'samples/harnesses/ops.canvas.json')))
        const graph = JSON.parse(canvas.flowData)
        graph.nodes.find((node) => node.data.name === 'chatXAI').data.credential = credential.id
        await post('chatflows', { name, type: 'HARNESS', flowData: JSON.stringify(graph), deployed: false, isPublic: false })
        const legacyName = name + '-legacy'
        await post('chatflows', { name: legacyName, type: 'HARNESS', flowData: JSON.stringify(graph), deployed: false, isPublic: false })
        const unsupported = structuredClone(graph)
        unsupported.nodes.find((n) => n.data.name === 'harnessSpecialist').data.inputs.enableShell = true
        await post('chatflows', {
            name: name + '-unsupported',
            type: 'HARNESS',
            flowData: JSON.stringify(unsupported),
            deployed: false,
            isPublic: false
        })
        const callerGraph = JSON.parse(JSON.parse(fs.readFileSync(path.join(root, 'samples/chatflows/ops.chatflow.json'))).flowData)
        callerGraph.nodes.find((n) => n.data.name === 'harness').data.inputs.harnessName = name
        const caller = await post('chatflows', {
            name: 'native-ops-caller',
            type: 'CHATFLOW',
            flowData: JSON.stringify(callerGraph),
            deployed: true,
            isPublic: false
        })
        // Stale supervisor state on BOTH disks must not strand native jobs. The worker has no canary enabled.
        for (const child of ['api', 'worker']) {
            fs.mkdirSync(path.join(dir, child), { recursive: true })
            fs.writeFileSync(path.join(dir, child, 'hermes-supervisor.json'), JSON.stringify({ state: 'down' }))
        }
        async function unavailable(route, body) {
            const res = await request(url + '/api/v1/' + route, { method: 'POST', cookie, body })
            assert.equal(res.status, 503, route + ' ' + res.status)
            assert.ok(JSON.stringify(res.json).includes('RUNTIME_UNAVAILABLE'))
        }
        for (const team of [legacyName, name + '-unsupported'])
            await unavailable('harnesses/' + team + '/runs', { mode: 'agent', chatId: randomUUID(), question: 'Check the ops status.' })
        await unavailable('prediction/' + caller.id, { question: 'Check the ops status.', overrideConfig: { harnessName: legacyName } })
        const called = await post('prediction/' + caller.id, {
            question: 'Check the ops status.',
            overrideConfig: { sessionId: randomUUID() }
        })
        assert.ok(called.text.includes('ops-status: allowlisted MCP tool responded'))
        for (const mode of ['agent', 'router']) {
            const run = await post('harnesses/' + name + '/runs', { question: 'Check the ops status.', chatId: randomUUID(), mode })
            if (mode === 'agent') assert.equal(run.trace.engine, 'native')
            assert.deepEqual(
                run.agents.map((s) => [s.name, s.status]),
                [['operator', 'completed']]
            )
            assert.ok(run.text.includes('ops-status: allowlisted MCP tool responded'))
            if (mode === 'agent') assert.ok(run.agents[0].tools.includes('ops_status done'))
            assert.ok(run.report.tokens.prompt > 0)
            t.diagnostic(mode + ' received the MCP response using the saved specialist binding')
        }
    }
)
