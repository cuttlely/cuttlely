import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { nativePackageRoot } from './kraken-package-fixture.mjs'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const cases = [
    {
        sample: 'chief-of-staff',
        question: 'Which embeddings built the vectors in the sample note?',
        answer: 'Local Hash Embeddings built the vectors.',
        tool: 'In-Memory_Vector_Store',
        documents: true
    },
    {
        sample: 'research',
        question: 'When does the example archive open?',
        answer: '09:00 UTC. Source: Research Handbook.',
        tool: 'Custom_Retriever',
        documents: false
    }
]

test(
    'scoped public predictions run the complete saved local research templates through the native agent and router',
    { timeout: 120000 },
    async (t) => {
        const nativeInstall = nativePackageRoot()
        const install = nativeInstall || root
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-local-research-'))
        const calls = path.join(dir, 'calls')
        const port = await freePort(),
            base = 'http://127.0.0.1:' + port
        const auth = { email: 'research@example.invalid', password: randomUUID() + 'aA1!' },
            modelKey = randomUUID()
        let app
        t.after(async () => {
            try {
                await app?.stop()
            } finally {
                fs.rmSync(dir, { recursive: true, force: true })
            }
        })
        fs.writeFileSync(calls, '')
        app = await startServer(
            install,
            dataEnv(dir, port, {
                CUTTLELY_NATIVE_PRIME_TEAMS: cases.map((item) => 'qa-' + item.sample).join(','),
                CUTTLELY_LOCAL_USERS: 'true',
                CUTTLELY_INITIAL_OWNER_EMAIL: auth.email,
                CUTTLELY_INITIAL_OWNER_PASSWORD: auth.password,
                CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
                CUTTLELY_HARNESS_QUEUE: 'off',
                CUTTLELY_HARNESS_WORKERS: '0',
                CUTTLELY_ANALYST: 'off',
                INBOUND_ACCESS_V2: 'on',
                KRAKEN_FIXTURE_MODEL_KEY: modelKey,
                KRAKEN_RESEARCH_CALLS: calls
            }),
            { preload: [path.join(root, 'scripts/fixtures/kraken-local-research-provider.cjs')], launcher: Boolean(nativeInstall) }
        )
        await waitForPing(base, app)
        const login = await request(base + '/api/v1/auth/local/login', { method: 'POST', body: auth })
        assert.equal(login.status, 200)
        async function post(route, body) {
            const r = await request(base + '/api/v1/' + route, { method: 'POST', cookie: login.cookie, body })
            assert.equal(r.status, 200, route)
            return r.json
        }
        const credential = await post('credentials', {
            name: 'Local simulated research',
            credentialName: 'xaiApi',
            plainDataObj: { xaiApiKey: modelKey }
        })
        const saved = []
        for (const item of cases) {
            const name = 'qa-' + item.sample
            const wrapper = JSON.parse(fs.readFileSync(path.join(install, 'samples/harnesses', item.sample + '.canvas.json')))
            const graph = JSON.parse(wrapper.flowData)
            const models = graph.nodes.filter((n) => n.data.name === 'chatXAI')
            assert.equal(models.length, 1)
            models[0].data.credential = credential.id
            const flow = await post('chatflows', { ...wrapper, name, apiAccessMode: 'private', flowData: JSON.stringify(graph) })
            const keys = await post('apikey', {
                keyName: name,
                permissions: ['chatflows:view', 'agentflows:view'],
                accessPolicy: { scopes: ['predict', 'harness:run', 'harness:read'] },
                resources: [{ resourceType: 'HARNESS', resourceId: flow.id }]
            })
            const key = keys.find((entry) => entry.keyName === name)?.apiKey
            assert.ok(key)
            saved.push({ ...item, id: flow.id, key, source: graph.nodes.find((n) => n.data.name === 'plainText').data.inputs.text })
        }
        // Reuse the same caller-provided chat ID across teams and identities.
        const chatId = randomUUID()
        for (const item of saved) {
            const other = saved.find((team) => team !== item)
            for (const mode of ['router', 'agent']) {
                const predict = (key) =>
                    fetch(base + '/api/v1/prediction/' + item.id, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
                        body: JSON.stringify({ question: item.question, mode, chatId }),
                        signal: AbortSignal.timeout(30000)
                    })
                const before = fs.statSync(calls).size
                for (const key of [other.key, null]) {
                    const denied = await predict(key)
                    assert.ok([401, 403].includes(denied.status), 'foreign or absent credential returned ' + denied.status)
                    await denied.arrayBuffer()
                }
                assert.equal(fs.statSync(calls).size, before)
                const response = await predict(item.key)
                assert.equal(response.status, 200)
                const run = await response.json()
                assert.equal(run.trace.engine, 'native')
                assert.equal(run.text, item.answer)
                assert.deepEqual(
                    run.agents.map((a) => a.name),
                    ['researcher']
                )
                const researcher = run.agents[0]
                assert.equal(researcher.status, 'completed')
                assert.ok(researcher.tools.some((tool) => String(tool.name || tool).includes(item.tool)))
                const docs = run.sources || []
                if (item.documents && mode === 'router')
                    assert.deepEqual(
                        docs.map((doc) => doc.pageContent),
                        [item.source]
                    )
                else assert.deepEqual(docs, [])
                assert.ok(fs.statSync(calls).size > before)
                if (mode === 'agent') {
                    const received = fs.readFileSync(calls, 'utf8').slice(before).split('\n')
                    assert.ok(received.includes(item.documents ? 'staff-source' : 'research-source'))
                    assert.deepEqual(researcher.sources || [], [])
                }
            }
        }
    }
)
