import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'
import { PLAYBOOK_DIR, specialistProfileName } from '../packages/harness/profile.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
test('public Live prediction and canvas fallback read the owned handbook while an unpublished draft keeps its private Try scope', async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-owner-')),
        port = await freePort(),
        base = 'http://127.0.0.1:' + port + '/api/v1/'
    const name = 'qa-stock-handbook',
        account = { email: 'qa@example.invalid', password: randomUUID() + 'X1a!' }
    const manifest = path.join(temp, 'manifest.json')
    const env = dataEnv(temp, port, {
        INBOUND_ACCESS_V2: 'on',
        CUTTLELY_LOCAL_USERS: 'true',
        CUTTLELY_INITIAL_OWNER_EMAIL: account.email,
        CUTTLELY_INITIAL_OWNER_PASSWORD: account.password,
        CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
        CUTTLELY_NATIVE_PRIME_TEAMS: name,
        CUTTLELY_HOST_FILE_MANIFEST: manifest,
        CUTTLELY_DRAFTS: '1',
        CUTTLELY_ANALYST: 'off'
    })
    fs.writeFileSync(manifest, '[]')
    let server
    t.after(async () => {
        try {
            await server?.stop()
        } finally {
            fs.rmSync(temp, { recursive: true, force: true })
        }
    })
    server = await startServer(root, env, { preload: [path.join(root, 'scripts/fixtures/kraken-canvas-book-provider.cjs')] })
    await waitForPing(base.slice(0, -8), server)
    const { cookie, status } = await request(base + 'auth/local/login', { method: 'POST', body: account })
    assert.equal(status, 200)
    async function post(route, body, method = 'POST') {
        const r = await request(base + route, { method, body, cookie })
        assert.ok(r.status >= 200 && r.status < 300, route + ' ' + r.status + ' ' + r.json?.message)
        return r.json
    }
    const cred = await post('credentials', { name: 'Stock model', credentialName: 'xaiApi', plainDataObj: { xaiApiKey: randomUUID() } })
    const graph = JSON.parse(JSON.parse(fs.readFileSync(path.join(root, 'samples/harnesses/calculator.canvas.json'))).flowData)
    graph.nodes.find((n) => n.data.name === 'chatXAI').data.credential = cred.id
    const role = graph.nodes.find((n) => n.data.name === 'harnessSpecialist')
    role.data.inputs.playbooks = [{ name: 'handbook', description: 'Stock rules', content: 'Read references/rules.md.' }]
    const saved = await post('chatflows', { name, type: 'HARNESS', apiAccessMode: 'private', flowData: JSON.stringify(graph) })
    const record = (await request(base + 'harnesses/' + name, { cookie })).json
    assert.equal(record.chatflowId, saved.id)
    assert.equal(record.specialists[0].name, 'math')
    assert.ok(record.createdAt)
    const profile = specialistProfileName(name, 'math')
    const relative = 'profiles/' + profile + '/skills/' + PLAYBOOK_DIR + '/handbook/references/rules.md'
    const filename = path.join(env.CUTTLELY_HERMES_HOME, relative),
        marker = 'Stock rule ' + randomUUID()
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, marker)
    const declaration = {
        path: 'runtime/' + relative,
        sha256: createHash('sha256').update(marker).digest('hex'),
        playbook: { workspaceId: record.workspaceId, chatflowId: saved.id, generation: record.createdAt }
    }
    fs.writeFileSync(manifest, JSON.stringify([declaration]))
    const keys = await post('apikey', {
        keyName: 'Handbook client',
        permissions: ['chatflows:view', 'agentflows:view'],
        accessPolicy: { scopes: ['predict', 'harness:run', 'harness:read'] },
        resources: [{ resourceType: 'HARNESS', resourceId: saved.id }]
    })
    const token = keys.find((k) => k.keyName === 'Handbook client').apiKey
    assert.ok(token)
    fs.writeFileSync(path.join(temp, 'hermes-supervisor.json'), '{"state":"down"}')
    async function predict(internal = false) {
        const res = await fetch(base + (internal ? 'internal-prediction/' : 'prediction/') + saved.id, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(internal ? { cookie, 'x-request-from': 'internal' } : { authorization: 'Bearer ' + token })
            },
            body: JSON.stringify({ question: 'Read the signed handbook.', mode: 'agent', chatId: randomUUID() }),
            signal: AbortSignal.timeout(40000)
        })
        return { status: res.status, body: await res.json() }
    }
    async function succeeds(internal) {
        const { status, body } = await predict(internal)
        assert.equal(status, 200, body.message)
        assert.equal(body.trace.engine, 'native')
        assert.equal(body.agents[0].status, 'completed', body.agents[0].error)
        assert.ok(body.agents[0].tools.some((x) => x === 'skill_view done' || (x.name === 'skill_view' && x.status === 'done')))
        assert.ok(JSON.stringify(body).includes(marker), JSON.stringify({ text: body.text, agents: body.agents }))
    }
    await succeeds(false)
    await succeeds(true)
    const draft = structuredClone(graph)
    draft.nodes.find((n) => n.data.name === 'harnessChief').data.inputs.instructions += ' Unpublished draft.'
    await post('flow-drafts/' + saved.id, { flowData: JSON.stringify(draft) }, 'PUT')
    assert.equal((await predict(true)).status, 503, 'The private draft cannot use the published handbook grant.')
    await succeeds(false)
    const changed = await post('harnesses', {
        ...record,
        specialists: record.specialists.map((s) => ({ ...s, shell: true })),
        createdAt: 'client-assigned',
        tryId: '5555555555555555',
        tryOwner: 'user:forged',
        overwrite: true
    })
    assert.equal(changed.createdAt, record.createdAt)
    assert.equal(changed.tryId, undefined)
    assert.equal(changed.tryOwner, undefined)
    assert.equal(changed.specialists[0].shell, true)
    // This API-only roster update did not change the published canvas graph. Named and canvas selections differ.
    await succeeds(false)
    const named = await request(base + 'harnesses/' + name + '/runs', {
        method: 'POST',
        cookie,
        body: { question: 'Read the saved roster.' }
    })
    assert.equal(named.status, 503)
    fs.writeFileSync(manifest, JSON.stringify([{ ...declaration, playbook: { ...declaration.playbook, generation: 'retired' } }]))
    assert.equal((await predict(false)).status, 503)
})
