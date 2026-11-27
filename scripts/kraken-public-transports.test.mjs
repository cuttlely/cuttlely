import assert from 'node:assert/strict'
import { createHmac, randomInt, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createClient } from '../packages/chat-widget/src/api.js'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'

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
