import assert from 'node:assert/strict'
import { createHmac, randomInt, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import http from 'node:http'
import { createTestSource, skipReason } from '../packages/etl/check/pg-source.mjs'
import { fileURLToPath } from 'node:url'
import { createClient } from '../packages/chat-widget/src/api.js'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'

import { nativePackageRoot } from './kraken-package-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const sample = (name) => JSON.parse(JSON.parse(fs.readFileSync(path.join(root, 'samples', name))).flowData)
const origin = 'https://embed.example.invalid'

function calculation() {
    const a = randomInt(20, 90),
        b = randomInt(3, 13)
    return { question: a + ' * ' + b, answer: String(a * b) }
}

function agentNode(name, label, type, inputs) {
    const id = name + '_0'
    return {
        id,
        type: 'agentFlow',
        position: { x: 0, y: 0 },
        data: {
            id,
            name,
            label,
            type,
            category: 'Agent Flows',
            inputs,
            inputParams: Object.keys(inputs).map((name) => ({ name, type: 'string', acceptVariable: true })),
            inputAnchors: [],
            outputAnchors: [],
            outputs: {}
        }
    }
}

test(
    'published teams accept widget continuations and signed webhook flows through the public endpoints',
    { timeout: 120000 },
    async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-public-'))
        const port = await freePort(),
            host = 'http://127.0.0.1:' + port
        const name = 'transport-math',
            key = randomUUID()
        const account = { email: 'transport@example.invalid', password: randomUUID() + 'aA1!' }
        let app
        t.after(async () => {
            try {
                await app?.stop()
            } finally {
                fs.rmSync(dir, { force: true, recursive: true })
            }
        })
        app = await startServer(
            root,
            dataEnv(dir, port, {
                CUTTLELY_NATIVE_PRIME_TEAMS: name,
                CUTTLELY_LOCAL_USERS: 'true',
                CUTTLELY_INITIAL_OWNER_EMAIL: account.email,
                CUTTLELY_INITIAL_OWNER_PASSWORD: account.password,
                CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
                CUTTLELY_HARNESS_QUEUE: 'off',
                CUTTLELY_ANALYST: 'off',
                KRAKEN_FIXTURE_MODEL_KEY: key
            }),
            { preload: [path.join(root, 'scripts/fixtures/kraken-provider.cjs')] }
        )
        await waitForPing(host, app)
        const login = await request(host + '/api/v1/auth/local/login', { method: 'POST', body: account })
        assert.equal(login.status, 200)
        async function post(route, body) {
            const r = await request(host + '/api/v1/' + route, { cookie: login.cookie, method: 'POST', body })
            assert.ok(r.status >= 200 && r.status < 300, route + ' ' + r.status)
            return r.json
        }
        const credential = await post('credentials', {
            name: 'QA simulated transport model',
            credentialName: 'xaiApi',
            plainDataObj: { xaiApiKey: key }
        })
        const graph = sample('harnesses/calculator.canvas.json')
        graph.nodes.find((n) => n.data.name === 'chatXAI').data.credential = credential.id
        const saved = await post('chatflows', {
            name,
            type: 'HARNESS',
            isPublic: true,
            deployed: true,
            flowData: JSON.stringify(graph),
            chatbotConfig: JSON.stringify({ allowedOrigins: [origin] })
        })

        await t.test('widget streams the final and recorded events, isolates chat owners and enforces the embed origin', async () => {
            const client = (embedOrigin) =>
                createClient({
                    apiHost: host,
                    flowId: saved.id,
                    fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init.headers, Origin: embedOrigin } })
                })
            const widget = client(origin)
            await widget.loadConfig()
            async function turn(continuation = {}) {
                const { question, answer } = calculation(),
                    events = []
                await widget.send({ question, ...continuation }, { onEvent: (e) => events.push(e) }, AbortSignal.timeout(20000))
                const final = events.findIndex((e) => e.event === 'harness.final'),
                    recorded = events.findIndex((e) => e.event === 'harness.recorded')
                assert.ok(final >= 0 && final < recorded)
                assert.equal(events[final].data.text, answer)
                assert.equal(events.at(-1).event, 'end')
                const { run, chatId, sessionToken } = events[recorded].data
                assert.ok(run && chatId && sessionToken)
                return { chatId, sessionToken }
            }
            const first = await turn()
            assert.equal((await turn(first)).chatId, first.chatId)
            assert.notEqual((await turn({ chatId: first.chatId })).chatId, first.chatId)
            await assert.rejects(client('https://other.example.invalid').send({ question: calculation().question }), (e) =>
                [401, 403].includes(e.status)
            )
        })

        await t.test('a signed webhook passes the request to its nested Execute Flow and an unsigned request is refused', async () => {
            const caller = sample('chatflows/ops.chatflow.json')
            caller.nodes.find((n) => n.data.name === 'harness').data.inputs.harnessName = name
            const flow = await post('chatflows', {
                name: 'Calculator caller',
                type: 'CHATFLOW',
                flowData: JSON.stringify(caller),
                isPublic: false,
                deployed: true
            })
            const start = agentNode('startAgentflow', 'Start', 'Start', {
                startInputType: 'webhookTrigger',
                webhookInputMode: 'text',
                webhookDefaultInput: '{{ $webhook.body.question }}',
                webhookEnableAuth: true,
                webhookMethod: 'POST',
                webhookSignatureType: 'hmac-sha256',
                webhookResponseMode: 'sync'
            })
            const execute = agentNode('executeFlowAgentflow', 'Run saved flow', 'ExecuteFlow', {
                executeFlowSelectedFlow: flow.id,
                executeFlowInput: '{{ question }}',
                executeFlowReturnResponseAs: 'assistantMessage'
            })
            const wf = await post('chatflows', {
                name: 'QA calculator trigger',
                type: 'AGENTFLOW',
                isPublic: false,
                deployed: true,
                flowData: JSON.stringify({
                    nodes: [start, execute],
                    edges: [
                        {
                            id: 'start-execute',
                            source: start.id,
                            target: execute.id,
                            sourceHandle: start.id + '-output-startAgentflow',
                            targetHandle: execute.id,
                            type: 'agentFlow'
                        }
                    ]
                })
            })
            const { webhookSecret } = await post('chatflows/' + wf.id + '/webhook-secret', {})
            assert.ok(webhookSecret)
            const { question, answer } = calculation(),
                body = JSON.stringify({ question })
            const send = (signature) =>
                fetch(host + '/api/v1/webhook/' + wf.id, {
                    method: 'POST',
                    body,
                    signal: AbortSignal.timeout(20000),
                    headers: { 'Content-Type': 'application/json', ...(signature ? { 'x-webhook-signature': 'sha256=' + signature } : {}) }
                })
            assert.equal((await send()).status, 401)
            assert.equal(
                (
                    await send(
                        createHmac('sha256', webhookSecret)
                            .update(body + ' ')
                            .digest('hex')
                    )
                ).status,
                401
            )
            const response = await send(createHmac('sha256', webhookSecret).update(body).digest('hex'))
            assert.equal(response.status, 200)
            const message = await response.json()
            assert.equal(message.text, answer)
            assert.ok(message.chatId)
        })
    }
)

for (const postgresStores of [false, true])
    test(
        'published native predictions admit distinct chats from one key and fence a shared chat and superseded publication on ' +
            (postgresStores ? 'PostgreSQL' : 'hybrid storage'),
        { timeout: 100000, skip: skipReason },
        async (t) => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-tickets-'))
            const port = await freePort(),
                base = 'http://127.0.0.1:' + port + '/api/v1/'
            const db = await createTestSource(),
                pg = db.connection
            let sidecarRequests = 0
            const sidecar = http.createServer((_req, res) => {
                sidecarRequests++
                res.writeHead(503).end()
            })
            await new Promise((r) => sidecar.listen(0, '127.0.0.1', r))
            const name = 'published-tickets',
                modelKey = randomUUID()
            const account = { email: 'fixture@example.invalid', password: randomUUID() + 'Aa1!' }
            const env = dataEnv(dir, port, {
                DATABASE_TYPE: 'postgres',
                DATABASE_HOST: pg.host,
                DATABASE_PORT: String(pg.port),
                DATABASE_NAME: pg.database,
                DATABASE_USER: pg.user,
                DATABASE_PASSWORD: pg.password,
                CUTTLELY_APP_DATABASE_STORES: postgresStores ? '1' : '0',
                HERMES_API_URL: 'http://127.0.0.1:' + sidecar.address().port,
                CUTTLELY_LOCAL_USERS: 'true',
                CUTTLELY_INITIAL_OWNER_EMAIL: account.email,
                CUTTLELY_INITIAL_OWNER_PASSWORD: account.password,
                CUTTLELY_NATIVE_PRIME_TEAMS: name + ',' + name + '-guide',
                CUTTLELY_HARNESS_QUEUE: 'external',
                CUTTLELY_HARNESS_WORKERS: '0',
                CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
                INBOUND_ACCESS_V2: 'on',
                KRAKEN_TICKET_KEY: modelKey,
                KRAKEN_TICKET_DIR: dir
            })
            let app, cookie
            async function boot() {
                app = await startServer(nativePackageRoot() || root, env, {
                    preload: [path.join(root, 'scripts/fixtures/kraken-published-prediction-provider.cjs')]
                })
                await waitForPing(base.slice(0, -8), app)
                const login = await request(base + 'auth/local/login', { method: 'POST', body: account })
                assert.equal(login.status, 200)
                cookie = login.cookie
            }
            t.after(async () => {
                try {
                    await app?.stop()
                } finally {
                    sidecar.closeAllConnections()
                    await new Promise((r) => sidecar.close(r))
                    await db.cleanup()
                    fs.rmSync(dir, { recursive: true, force: true })
                }
            })
            await boot()
            async function api(route, body) {
                const r = await request(base + route, { method: body === undefined ? 'GET' : 'POST', body, cookie })
                assert.equal(r.status, 200, route)
                return r.json
            }
            const credential = await api('credentials', {
                name: 'Fixture model',
                credentialName: 'xaiApi',
                plainDataObj: { xaiApiKey: modelKey }
            })
            const graph = sample('harnesses/calculator.canvas.json')
            graph.nodes.find((node) => node.data.name === 'chatXAI').data.credential = credential.id
            const published = await api('chatflows', { name, type: 'HARNESS', apiAccessMode: 'private', flowData: JSON.stringify(graph) })
            async function scopedKey(label, resourceId = published.id) {
                const rows = await api('apikey', {
                    keyName: label,
                    permissions: ['chatflows:view'],
                    accessPolicy: { scopes: ['predict', 'harness:run'] },
                    resources: [{ resourceType: 'HARNESS', resourceId }]
                })
                return rows.find((r) => r.keyName === label).apiKey
            }
            const first = await scopedKey('publisher'),
                second = await scopedKey('other')
            async function predict(token, question, session, resourceId = published.id) {
                const res = await fetch(base + 'prediction/' + resourceId, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        ...(token ? { authorization: 'Bearer ' + token } : {})
                    },
                    body: JSON.stringify({
                        mode: 'agent',
                        question,
                        ...(session && { chatId: session.chatId, sessionToken: session.sessionToken })
                    }),
                    signal: AbortSignal.timeout(30000)
                })
                const body = await res.json()
                return { status: res.status, error: body.message, text: body.text, chatId: body.chatId, sessionToken: body.sessionToken }
            }
            const hold = (ticket) => fs.writeFileSync(path.join(dir, ticket + '.hold'), '')
            const release = (ticket) => fs.rmSync(path.join(dir, ticket + '.hold'), { force: true })
            async function waitFor(tickets) {
                const deadline = Date.now() + 10000
                while (Date.now() < deadline) {
                    if (tickets.every((ticket) => fs.existsSync(path.join(dir, ticket + '.entered')))) return
                    await new Promise((r) => setTimeout(r, 15))
                }
                throw new Error('Provider did not receive all ' + tickets.length + ' concurrent predictions.')
            }
            assert.equal((await predict(null, 'Open TKT-999')).status, 401)
            const profileDir = path.join(env.CUTTLELY_HERMES_HOME, 'profiles')
            const activeTryPaths = () =>
                fs.existsSync(profileDir) ? fs.readdirSync(profileDir).filter((n) => /^try(?:x)?[a-f0-9]{8,32}(?:--|$)/.test(n)) : []
            const sidecarBefore = sidecarRequests
            const tickets = Array.from({ length: 8 }, (_, i) => 'TKT-10' + i)
            tickets.forEach(hold)
            const wave = Promise.all(tickets.map((ticket) => predict(first, 'Open ' + ticket)))
            try {
                await waitFor(tickets)
                assert.deepEqual(activeTryPaths(), [])
            } finally {
                tickets.forEach(release)
            }
            const sessions = await wave
            sessions.forEach((r, i) => {
                assert.equal(r.status, 200)
                assert.equal(r.text, 'Receipt ' + tickets[i])
                assert.ok(r.chatId && r.sessionToken)
            })
            assert.equal(new Set(sessions.map((r) => r.chatId)).size, 8)
            const a = sessions[0],
                b = sessions[1]
            // Replacing the API must preserve both the original chat token and native recall scope.
            await app.stop()
            await boot()
            const prior = await predict(first, 'Look up TKT-100', a)
            assert.equal(prior.status, 200, prior.error)
            assert.equal(prior.chatId, a.chatId)
            assert.equal(prior.text, 'Recovered TKT-100')
            const other = await predict(second, 'Look up TKT-100', a)
            assert.equal(other.status, 200)
            assert.notEqual(other.chatId, a.chatId)
            assert.equal(other.text, 'No prior ticket')
            const cross = await predict(first, 'Look up TKT-100', b)
            assert.equal(cross.status, 200)
            assert.equal(cross.chatId, b.chatId)
            assert.equal(cross.text, 'No prior ticket')
            hold('TKT-201')
            hold('TKT-202')
            const declined = predict(first, 'Decline TKT-201', a),
                healthy = predict(first, 'Open TKT-202', b)
            try {
                await waitFor(['TKT-201', 'TKT-202'])
                assert.equal((await predict(first, 'Open TKT-203', a)).status, 409)
                assert.ok(!fs.existsSync(path.join(dir, 'TKT-203.entered')))
                release('TKT-201')
                assert.ok((await declined).status >= 400)
            } finally {
                release('TKT-201')
                release('TKT-202')
            }
            assert.equal((await healthy).text, 'Receipt TKT-202')
            hold('TKT-301')
            const stale = predict(first, 'Open TKT-301', a)
            try {
                await waitFor(['TKT-301'])
                const record = await api('harnesses/' + name)
                await api('harnesses', { ...record, description: 'New published revision', overwrite: true })
            } finally {
                release('TKT-301')
            }
            const failed = await stale
            assert.ok(failed.status >= 400)
            assert.ok(!failed.text)
            assert.equal((await predict(first, 'Calculate 17 * 3.', b)).text, 'Checked 51')
            assert.deepEqual(activeTryPaths(), [])
            assert.equal(sidecarRequests, sidecarBefore)
            const role = graph.nodes.find((node) => node.data.name === 'harnessSpecialist')
            role.data.inputs.playbooks = [{ name: 'guide', description: 'Desk guide', content: 'Review the dispatch receipt.' }]
            const guide = await api('chatflows', {
                name: name + '-guide',
                type: 'HARNESS',
                apiAccessMode: 'private',
                flowData: JSON.stringify(graph)
            })
            const guideKey = await scopedKey('guide-reader', guide.id)
            assert.equal((await predict(guideKey, 'Open TKT-799')).status, 403)
            assert.ok(!fs.existsSync(path.join(dir, 'TKT-799.entered')))
            hold('TKT-401')
            const exclusive = predict(guideKey, 'Open TKT-401', undefined, guide.id)
            try {
                await waitFor(['TKT-401'])
                assert.ok(activeTryPaths().length > 0)
                assert.equal((await predict(guideKey, 'Open TKT-402', undefined, guide.id)).status, 409)
            } finally {
                release('TKT-401')
            }
            assert.equal((await exclusive).text, 'Receipt TKT-401')
            assert.deepEqual(activeTryPaths(), [])
        }
    )
