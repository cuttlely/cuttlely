import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const python = process.env.HERMES_PYTHON || path.join(root, 'hermes', '.venv', 'bin', 'python')
test(
    'the authenticated saved team recalls its bundled exchange after switching to the native engine',
    { skip: !fs.existsSync(python) && 'the released runtime Python environment is required', timeout: 120000 },
    async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-recall-api-'))
        const account = { email: 'qa@example.invalid', password: randomUUID() + 'aA1!' }
        const modelKey = randomUUID()
        const name = 'kraken-recall'
        const chatId = randomUUID()
        const port = await freePort()
        const legacyPort = await freePort()
        const url = 'http://127.0.0.1:' + port
        const runtimeEnv = {
            CUTTLELY_LOCAL_USERS: 'true',
            CUTTLELY_INITIAL_OWNER_EMAIL: account.email,
            CUTTLELY_INITIAL_OWNER_PASSWORD: account.password,
            CUTTLELY_ANALYST: 'off',
            INBOUND_ACCESS_V2: 'on',
            CUTTLELY_HARNESS_QUEUE: 'off',
            KRAKEN_RECALL_MODEL_KEY: modelKey,
            HERMES_API_URL: 'http://127.0.0.1:' + legacyPort,
            API_SERVER_PORT: String(legacyPort),
            API_SERVER_KEY: randomUUID(),
            CUSTOM_MCP_PROTOCOL: 'stdio',
            CUSTOM_MCP_SECURITY_CHECK: 'true',
            CUSTOM_MCP_ALLOWED_COMMANDS: 'node',
            CUSTOM_MCP_ALLOWED_ABSOLUTE_SCRIPT_PATHS: 'samples/ops-mcp-server.mjs',
            CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
            HF_HUB_OFFLINE: '1',
            HTTP_PROXY: 'http://127.0.0.1:1',
            HTTPS_PROXY: 'http://127.0.0.1:1',
            NO_PROXY: 'localhost,127.0.0.1,::1'
        }
        let legacy, api, cookie
        const stopLegacy = async () => {
            if (!legacy || legacy.exitCode !== null || legacy.signalCode !== null) return
            const stopped = once(legacy, 'exit')
            process.kill(-legacy.pid, 'SIGTERM')
            const timer = setTimeout(() => {
                try {
                    process.kill(-legacy.pid, 'SIGKILL')
                } catch {
                    // The subprocess can exit before the signal or readiness check.
                }
            }, 5000)
            try {
                await stopped
            } finally {
                clearTimeout(timer)
            }
        }
        t.after(async () => {
            try {
                await api?.stop()
            } finally {
                try {
                    await stopLegacy()
                } finally {
                    fs.rmSync(dir, { recursive: true, force: true })
                }
            }
        })
        const boot = async (engine) => {
            const env = dataEnv(dir, port, {
                ...runtimeEnv,
                KRAKEN_RECALL_ENGINE: engine,
                CUTTLELY_NATIVE_PRIME_TEAMS: engine === 'native' ? name : ''
            })
            api = await startServer(root, env, { preload: [path.join(root, 'scripts/fixtures/kraken-recall-provider.cjs')] })
            await waitForPing(url, api)
            const login = await request(url + '/api/v1/auth/local/login', { method: 'POST', body: account })
            assert.equal(login.status, 200)
            assert.ok(login.cookie)
            cookie = login.cookie
        }
        const post = async (route, body) => {
            const response = await request(url + '/api/v1/' + route, { method: 'POST', cookie, body, timeoutMs: 45000 })
            assert.ok(
                response.status >= 200 && response.status < 300,
                route + ' returned ' + response.status + ' ' + (response.json?.message || '')
            )
            return response.json
        }
        legacy = spawn(python, [path.join(root, 'scripts/cuttlely-hermes-api.py')], {
            cwd: root,
            env: dataEnv(dir, port, runtimeEnv),
            stdio: 'ignore',
            detached: true
        })
        // The status lives in the disposable runtime home. Check only local process readiness.
        const deadline = Date.now() + 30000
        let ready = false
        while (!ready && Date.now() < deadline) {
            if (legacy.exitCode !== null || legacy.signalCode !== null) break
            try {
                const status = await fetch(runtimeEnv.HERMES_API_URL + '/health', { signal: AbortSignal.timeout(1000) })
                ready = status.status < 500
            } catch {
                // The subprocess can exit before the signal or readiness check.
            }
            if (!ready) await new Promise((r) => setTimeout(r, 150))
        }
        assert.ok(ready, 'The bundled runtime must bind its local port.')
        await boot('bundled')
        const credential = await post('credentials', {
            name: 'Recall test provider',
            credentialName: 'xaiApi',
            plainDataObj: { xaiApiKey: modelKey }
        })
        const canvas = JSON.parse(fs.readFileSync(path.join(root, 'samples/harnesses/ops.canvas.json')))
        const graph = JSON.parse(canvas.flowData)
        graph.nodes.find((n) => n.data.name === 'chatXAI').data.credential = credential.id
        const team = await post('chatflows', { name, type: 'HARNESS', flowData: JSON.stringify(graph), deployed: false, isPublic: false })
        const route = 'harnesses/' + name + '/runs'
        const denied = await request(url + '/api/v1/' + route, { method: 'POST', body: { mode: 'agent', chatId, question: 'No caller.' } })
        assert.ok([401, 403].includes(denied.status))
        const before = await post(route, { mode: 'agent', chatId, question: 'Log the saffron parcel receipt.' })
        assert.equal(before.text, 'The synthetic parcel arrived at gate 17.')
        assert.equal(before.trace.engine, 'hermes')
        await api.stop()
        api = undefined
        await stopLegacy()
        await boot('native')
        const after = await post(route, { mode: 'agent', chatId, question: 'Find the earlier receipt.' })
        assert.equal(after.trace.engine, 'native')
        assert.equal(after.text, 'Recovered the signed exchange through session_search.')
        const repeat = await post(route, { mode: 'agent', chatId, question: 'Find the saved native reply.' })
        assert.equal(repeat.text, 'Confirmed the saved native reply.')
        const other = await post(route, { mode: 'agent', chatId: randomUUID(), question: 'Find the earlier receipt.' })
        assert.equal(other.text, 'No owned receipt.')
        const fixtureStore = new DatabaseSync(path.join(dir, 'data', 'database.sqlite'), { readOnly: true })
        let workspace, role
        try {
            workspace = fixtureStore.prepare('SELECT id FROM workspace LIMIT 1').get()
            role = fixtureStore.prepare("SELECT id FROM role WHERE lower(name)='admin' LIMIT 1").get()
        } finally {
            fixtureStore.close()
        }
        assert.ok(workspace?.id && role?.id)
        const second = { email: 'second@example.invalid', password: randomUUID() + 'aA1!' }
        const invite = await post('account/invite', {
            user: { name: 'Second Person', email: second.email },
            workspace: { id: workspace.id },
            role: { id: role.id },
            link: true
        })
        const inviteToken = decodeURIComponent(new URL(invite.link).hash.replace(/^#token=/, ''))
        const accepted = await request(url + '/api/v1/auth/local/accept', {
            method: 'POST',
            body: { token: inviteToken, password: second.password }
        })
        assert.equal(accepted.status, 200)
        const login = await request(url + '/api/v1/auth/local/login', { method: 'POST', body: second })
        assert.equal(login.status, 200)
        cookie = login.cookie
        const shared = await post(route, { mode: 'agent', chatId, question: 'Find the record for my separate account.' })
        assert.equal(shared.text, 'No owned receipt.')

        const card = JSON.parse(fs.readFileSync(path.join(root, 'samples/chatflows/ops.chatflow.json')))
        const cardGraph = JSON.parse(card.flowData)
        cardGraph.nodes[0].data.inputs.harnessName = name
        const outer = await post('chatflows', {
            name: 'recall card',
            type: 'CHATFLOW',
            flowData: JSON.stringify(cardGraph),
            deployed: true,
            isPublic: false
        })
        const mint = async (keyName) => {
            const keys = await post('apikey', {
                keyName,
                accessPolicy: { scopes: ['predict', 'harness:run'] },
                permissions: ['chatflows:view', 'agentflows:view'],
                resources: [
                    { resourceType: 'HARNESS', resourceId: team.id },
                    { resourceType: 'CHATFLOW', resourceId: outer.id }
                ]
            })
            const key = keys.find((k) => k.keyName === keyName)
            assert.ok(key?.apiKey)
            return key.apiKey
        }
        const key = await mint('Recall application A')
        const otherKey = await mint('Recall application B')
        const keyRequest = async (principal, endpoint, body) => {
            const res = await fetch(url + '/api/v1/' + endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + principal },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30000)
            })
            const result = await res.json()
            return { status: res.status, result }
        }
        const keyPost = async (principal, endpoint, body) => {
            const { status, result } = await keyRequest(principal, endpoint, body)
            assert.equal(status, 200, result?.message)
            return result
        }
        const forged = await keyRequest(key, route, { mode: 'agent', chatId, question: 'Find the earlier receipt.' })
        assert.equal(forged.status, 403)
        const appChat = randomUUID()
        const appWrite = await keyPost(key, route, { mode: 'agent', chatId: appChat, question: 'Store the azurite case via the API.' })
        assert.equal(appWrite.text, 'A sealed blue file was delivered.')
        const appRead = await keyPost(key, route, { mode: 'agent', chatId: appChat, question: 'Find the prior blue case.' })
        assert.equal(appRead.text, 'Recovered the application exchange.')
        const foreign = await keyRequest(otherKey, route, { mode: 'agent', chatId: appChat, question: 'Find the prior blue case.' })
        assert.equal(foreign.status, 403)
        const viaCard = await keyPost(key, 'prediction/' + outer.id, { question: 'Store the azurite case from my card.' })
        assert.equal(viaCard.text, 'A sealed blue file was delivered.')
        assert.ok(viaCard.chatId && viaCard.sessionToken)
        const cardRead = await keyPost(key, route, { mode: 'agent', chatId: viaCard.chatId, question: 'Find the prior blue case.' })
        assert.equal(cardRead.text, 'Recovered the application exchange.')
        const deniedCard = await keyRequest(otherKey, route, {
            mode: 'agent',
            chatId: viaCard.chatId,
            question: 'Find the prior blue case.'
        })
        assert.equal(deniedCard.status, 403)
        const rebound = await keyPost(otherKey, 'prediction/' + outer.id, {
            chatId: viaCard.chatId,
            sessionToken: viaCard.sessionToken,
            question: 'Store the azurite case from my card.'
        })
        assert.notEqual(rebound.chatId, viaCard.chatId)
        assert.ok(rebound.sessionToken && rebound.sessionToken !== viaCard.sessionToken)
        const foreignRebound = await keyRequest(key, route, {
            mode: 'agent',
            chatId: rebound.chatId,
            question: 'Find the prior blue case.'
        })
        assert.equal(foreignRebound.status, 403)
    }
)
