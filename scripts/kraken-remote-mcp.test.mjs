import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'
import { good, statusResponder } from './fixtures/kraken-remote-mcp.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
test('authenticated saved native team uses the authorized workspace MCP server and encrypted header', { timeout: 90000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-workspace-mcp-'))
    const account = { email: 'qa@example.invalid', password: randomUUID() + 'aA1!' }
    const port = await freePort()
    const url = 'http://127.0.0.1:' + port
    const name = 'native-warehouse'
    const modelKey = randomUUID(),
        token = randomUUID()
    const responder = await statusResponder('http', token)
    const endpoint = responder.origin + '/stream'
    let api, cookie
    const common = {
        CUTTLELY_LOCAL_USERS: 'true',
        CUTTLELY_INITIAL_OWNER_EMAIL: account.email,
        CUTTLELY_INITIAL_OWNER_PASSWORD: account.password,
        CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
        CUTTLELY_NATIVE_PRIME_TEAMS: name,
        HTTP_ALLOW_LOCALHOST: 'true',
        CUSTOM_MCP_PROTOCOL: 'sse',
        KRAKEN_OPS_MODEL_KEY: modelKey,
        CUTTLELY_HARNESS_QUEUE: 'off',
        CUTTLELY_ANALYST: 'off',
        HERMES_API_URL: 'http://127.0.0.1:' + (await freePort())
    }
    t.after(async () => {
        try {
            await api?.stop()
        } finally {
            await responder.close()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
    async function boot(grants) {
        api = await startServer(root, dataEnv(dir, port, { ...common, CUTTLELY_NATIVE_MCP_ENDPOINTS: JSON.stringify(grants) }), {
            preload: [path.join(root, 'scripts/fixtures/kraken-ops-provider.cjs')]
        })
        await waitForPing(url, api)
        const login = await request(url + '/api/v1/auth/local/login', { method: 'POST', body: account })
        assert.equal(login.status, 200)
        cookie = login.cookie
    }
    const post = async (route, body) => {
        const response = await request(url + '/api/v1/' + route, { method: 'POST', cookie, body })
        assert.ok(
            response.status >= 200 && response.status < 300,
            route + ' returned ' + response.status + ' ' + (response.json?.message || '')
        )
        return response.json
    }
    await boot([])
    const saved = await post('custom-mcp-servers', {
        name: 'Warehouse status',
        serverUrl: endpoint,
        authType: 'CUSTOM_HEADERS',
        authConfig: { headers: { authorization: 'Bearer ' + token } }
    })
    assert.ok(saved.id && saved.workspaceId)
    await post('custom-mcp-servers/' + saved.id + '/authorize', {})
    const credential = await post('credentials', { name: 'Model fixture', credentialName: 'xaiApi', plainDataObj: { xaiApiKey: modelKey } })
    const graph = JSON.parse(JSON.parse(fs.readFileSync(path.join(root, 'samples/harnesses/ops.canvas.json'))).flowData)
    graph.nodes.find((n) => n.data.name === 'chatXAI').data.credential = credential.id
    const remote = graph.nodes.find((n) => n.data.name === 'customMCP')
    remote.data.name = 'customMcpServerTool'
    remote.data.inputs = { mcpServerId: saved.id, mcpActions: ['ops_status'] }
    await post('chatflows', { name, type: 'HARNESS', flowData: JSON.stringify(graph), deployed: false, isPublic: false })
    await api.stop()
    api = undefined
    await boot([{ workspaceId: saved.workspaceId, serverId: saved.id, url: endpoint, actions: ['ops_status'] }])
    const answer = await post('harnesses/' + name + '/runs', { mode: 'agent', chatId: randomUUID(), question: 'Get the ops status.' })
    assert.equal(answer.trace.engine, 'native')
    assert.ok(answer.text.includes(good))
    assert.ok(responder.seen.filter((r) => r.url).every((r) => r.authorized))
    assert.deepEqual(
        responder.seen.filter((r) => r.name),
        [{ name: 'ops_status', args: {} }]
    )
})
