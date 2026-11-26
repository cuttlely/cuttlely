import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
        const chatId = randomUUID()
        const modelKey = randomUUID()
        const secretKey = randomUUID()
        const account = { email: 'qa@example.invalid', password: randomUUID() + 'aA1!' }
        let current
        let stage = 'original'
        const legacyCalls = []
        const legacy = http.createServer(async (req, res) => {
            try {
                assert.equal(req.method, 'POST')
                assert.equal(req.url, '/p/' + name + '/v1/runs')
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
                CUTTLELY_NATIVE_PRIME_TEAMS: stage === 'native' ? name : '',
                KRAKEN_FIXTURE_MODEL_KEY: modelKey,
                HERMES_API_URL: 'http://127.0.0.1:' + legacy.address().port,
                CUTTLELY_ANALYST: 'off'
            }
            current = await startServer(root, dataEnv(disk, port, cfg), {
                preload: [path.join(root, 'scripts/fixtures/kraken-provider.cjs')]
            })
            await waitForPing(url, current)
            const login = await request(url + '/api/v1/auth/local/login', { method: 'POST', body: account })
            assert.equal(login.status, 200)
            cookie = login.cookie
        }
        async function api(route, body) {
            t.diagnostic(stage + ' ' + route.split('/')[0])
            const r = await request(url + '/api/v1/' + route, { method: body ? 'POST' : 'GET', body, cookie }).catch((error) => {
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
        const run = () => api('harnesses/' + name + '/runs', { mode: 'agent', question: '17 * 3', chatId })
        assert.equal((await run()).text, 'Legacy verified 51.')
        stage = 'native'
        await boot()
        assert.equal((await api('chatflows/' + saved.id)).flowData, stored.flowData)
        const result = await run()
        assert.equal(result.text, 'Native verified 51.')
        assert.deepEqual(
            result.agents.map((a) => [a.name, a.status]),
            [['math', 'completed']]
        )
        assert.deepEqual(legacyCalls, ['original'])
        stage = 'rollback'
        await boot()
        assert.equal((await run()).text, 'Legacy verified 51.')
        assert.deepEqual(legacyCalls, ['original', 'rollback'])
    }
)
