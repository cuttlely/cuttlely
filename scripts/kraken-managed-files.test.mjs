import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTestSource } from '../packages/etl/check/pg-source.mjs'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'
import { fileURLToPath } from 'node:url'
import { managedFilesReady } from '../packages/harness/runtime/native-files.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const ready = managedFilesReady()
test(
    'saved file-only role runs on both native modes and restores its workspace on empty replacement disk',
    { skip: !ready && process.env.CUTTLELY_TEST_NATIVE_FILES_REQUIRED !== '1' },
    async (t) => {
        assert.ok(ready, 'Provision the independent managed file decoder and pinned search tool.')
        const db = await createTestSource(),
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-role-')),
            port = await freePort(),
            url = 'http://127.0.0.1:' + port
        const auth = { email: 'qa@example.invalid', password: randomUUID() + 'Z52a!' },
            key = randomUUID(),
            secret = randomUUID(),
            name = 'qa-file-role'
        const cfg = {
            DATABASE_TYPE: 'postgres',
            DATABASE_HOST: db.connection.host,
            DATABASE_PORT: String(db.connection.port),
            DATABASE_USER: db.connection.user,
            DATABASE_PASSWORD: db.connection.password,
            DATABASE_NAME: db.connection.database,
            CUTTLELY_APP_DATABASE_STORES: '1',
            CUTTLELY_INITIAL_OWNER_EMAIL: auth.email,
            CUTTLELY_INITIAL_OWNER_PASSWORD: auth.password,
            CUTTLELY_SECRETKEY_OVERWRITE: secret,
            CUTTLELY_LOCAL_USERS: 'true',
            CUTTLELY_NATIVE_PRIME_TEAMS: name,
            KRAKEN_OPS_MODEL_KEY: key,
            CUTTLELY_NATIVE_FILE_DECODER: process.env.CUTTLELY_NATIVE_FILE_DECODER,
            CUTTLELY_NATIVE_FILE_SEARCH: process.env.CUTTLELY_NATIVE_FILE_SEARCH
        }
        let server, cookie
        t.after(async () => {
            try {
                await server?.stop()
            } finally {
                await db.cleanup()
                fs.rmSync(dir, { recursive: true, force: true })
            }
        })
        async function boot(d) {
            server = await startServer(root, dataEnv(path.join(dir, d), port, cfg), {
                preload: [path.join(root, 'scripts/fixtures/kraken-managed-file-provider.cjs')]
            })
            await waitForPing(url, server)
            cookie = (await request(url + '/api/v1/auth/local/login', { method: 'POST', body: auth })).cookie
        }
        async function post(endpoint, body) {
            const r = await request(url + '/api/v1/' + endpoint, { method: 'POST', cookie, body, timeoutMs: 50000 })
            assert.ok(r.status < 300, endpoint + ' ' + r.status + ' ' + r.text.slice(0, 450))
            return r.json
        }
        await boot('first')
        const credential = await post('credentials', { name: 'QA simulation', credentialName: 'xaiApi', plainDataObj: { xaiApiKey: key } })
        const graph = JSON.parse(JSON.parse(fs.readFileSync(root + '/samples/harnesses/calculator.canvas.json')).flowData)
        graph.nodes = graph.nodes.filter((n) => n.data.name !== 'calculator')
        graph.edges = graph.edges.filter((e) => e.source !== 'calculator_0')
        const model = graph.nodes.find((n) => n.data.name === 'chatXAI').data
        model.credential = credential.id
        model.inputs.modelName = 'gpt-file-qa'
        const role = graph.nodes.find((n) => n.data.name === 'harnessSpecialist')
        role.data.inputs.enableFileAccess = true
        const savedCanvas = await post('chatflows', {
            name,
            type: 'HARNESS',
            isPublic: false,
            deployed: false,
            flowData: JSON.stringify(graph),
            chatbotConfig: JSON.stringify({ fullFileUpload: { status: true, allowedUploadFileTypes: 'text/csv' } })
        })
        let agentOutput
        const chats = { agent: randomUUID(), router: randomUUID() }
        for (const [mode, chatId] of Object.entries(chats)) {
            const run = await post('harnesses/' + name + '/runs', { question: 'WRITE file and calculate report.', mode, chatId })
            assert.equal(run.trace.engine, 'native')
            assert.equal(run.agents[0].status, 'completed', run.agents[0].error)
            assert.match(run.text, /Synthetic receipt 19/)
            assert.ok(run.artifacts?.length)
            assert.equal(Buffer.from(run.artifacts[0].base64, 'base64').toString(), 'result,value\nscore,19')
            if (mode === 'agent') agentOutput = run
        }
        const pg = createRequire(root + '/packages/etl/package.json')('pg')
        const connection = new pg.Client(db.connection)
        await connection.connect()
        const roles = (await connection.query('SELECT id,name FROM role')).rows
        const roleChoice = roles.find((r) => /admin/i.test(r.name)) || roles.find((r) => !/owner/i.test(r.name))
        const second = { email: 'reader@example.invalid', password: randomUUID() + 'Q2a!' }
        const invite = await post('account/invite', {
            user: { name: 'QA Reader', email: second.email, credential: second.password },
            workspace: { id: savedCanvas.workspaceId },
            role: { id: roleChoice.id },
            link: true
        })
        const link = new URL(invite.link)
        const token = link.searchParams.get('token') || new URLSearchParams(link.hash.slice(1)).get('token')
        assert.ok(token, 'expected single-use local fixture invitation')
        const accepted = await request(url + '/api/v1/auth/local/accept', { method: 'POST', body: { token, password: second.password } })
        assert.ok(accepted.status < 300, 'synthetic invite ' + accepted.status + ' ' + accepted.text.slice(0, 160))
        const owner = (await connection.query('SELECT id FROM "user" WHERE email=$1', [auth.email])).rows[0].id
        await connection.end()
        const secondLogin = await request(url + '/api/v1/auth/local/login', { method: 'POST', body: second })
        assert.equal(secondLogin.status, 200)
        const probe = await request(url + '/api/v1/harnesses/' + name + '/runs', {
            method: 'POST',
            cookie: secondLogin.cookie,
            body: { mode: 'agent', chatId: chats.agent, question: 'PROBE isolation.' },
            timeoutMs: 45000
        })
        assert.equal(probe.status, 200, probe.text.slice(0, 220))
        assert.equal(probe.json.agents[0].status, 'completed', probe.json.agents[0].error)
        assert.match(probe.json.text, /Scoped file unavailable/)
        for (const suffix of ['', '/result', '/diagnostics']) {
            const at = url + '/api/v1/harnesses/' + name + '/runs/' + agentOutput.run.id + suffix
            const first = await request(at, { cookie })
            if (suffix !== '/diagnostics') assert.equal(first.status, 200, suffix + ' first ' + first.status)
            const other = await request(at, { cookie: secondLogin.cookie })
            assert.equal(other.status, 404, suffix + ' foreign ' + other.status)
        }
        const list = await request(url + '/api/v1/harnesses/' + name + '/runs', { cookie: secondLogin.cookie })
        assert.equal(list.status, 200)
        assert.ok(!list.text.includes(agentOutput.run.id))

        const require = createRequire(root + '/packages/server/package.json')
        process.env.CUTTLELY_SECRETKEY_OVERWRITE = secret
        const { openPostgresFiles } = await import('../packages/etl/postgres-files.mjs')
        const store = await openPostgresFiles(db)
        require(root + '/packages/server/dist/utils')
            .applicationFileStorage()
            .selectFiles(store)
        const { selectPredictionFiles } = await import('../packages/harness/prediction-files.mjs')
        selectPredictionFiles(store)
        const uploadBytes = Buffer.from('item,value\n' + 'sample,19\n'.repeat(1200))
        const form = new FormData()
        form.append('files', new Blob([uploadBytes], { type: 'text/csv' }), 'catalog.csv')
        const upload = await fetch(url + '/api/v1/attachments/' + savedCanvas.id + '/' + randomUUID() + '?isBase64=true', {
            method: 'POST',
            headers: { cookie, 'x-request-from': 'internal' },
            body: form
        })
        assert.equal(upload.status, 200, (await upload.clone().text()).slice(0, 120))
        const uploadChat = upload.headers.get('x-cuttlely-chat-id')
        const parts = (await store.list(['blobs'])).find((x) => x.segments.at(-1) === 'catalog.csv').segments.slice(1)
        const uploads = require(root + '/packages/server/dist/utils/predictionUploads.js')
        const prepared = await uploads.preparePredictionUpload('catalog.csv', 'text/csv', uploadBytes)
        const stub = await uploads.renderPredictionUploadQuestion('catalog.csv', prepared, undefined, {
            workspace: savedCanvas.workspaceId,
            flow: savedCanvas.id,
            chat: uploadChat,
            parts,
            caller: { via: 'session', tryOwner: 'user:' + owner }
        })
        assert.match(stub, /proof='/)
        const visit = async (visitor, question) => {
            const r = await request(url + '/api/v1/harnesses/' + name + '/runs', {
                method: 'POST',
                cookie: visitor,
                body: { mode: 'agent', chatId: uploadChat, question: 'CATALOG_SCOPE ' + question },
                timeoutMs: 45000
            })
            assert.ok(r.status < 300, 'upload test ' + r.status)
            return r.json
        }
        assert.match((await visit(secondLogin.cookie, stub)).text, /Scoped upload unavailable/)
        assert.match((await visit(cookie, stub)).text, /Owned upload displayed/)
        const publicRow = randomUUID()
        await db.query(
            'INSERT INTO chat_message(id,role,content,chatflowid,"chatId","chatType","harnessPayload",artifacts) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
                publicRow,
                'apiMessage',
                agentOutput.text,
                savedCanvas.id,
                chats.agent,
                'INTERNAL',
                JSON.stringify({ trace: agentOutput.trace, artifacts: agentOutput.artifacts }),
                JSON.stringify(agentOutput.artifacts)
            ]
        )
        for (const route of ['chatmessage', 'internal-chatmessage']) {
            const at = url + '/api/v1/' + route + '/' + savedCanvas.id + '?chatId=' + chats.agent
            const owned = await request(at, { cookie })
            assert.equal(owned.status, 200, owned.text.slice(0, 130))
            assert.ok(owned.text.includes('summary.csv'), route + ' expected owner artifact')
            const foreign = await request(at, { cookie: secondLogin.cookie })
            assert.equal(foreign.status, 200, foreign.text.slice(0, 130))
            assert.ok(!foreign.text.includes('summary.csv'), route + ' disclosed another owner artifact')
        }
        const readUrl =
            url +
            '/api/v1/get-upload-file?' +
            new URLSearchParams({ chatflowId: savedCanvas.id, chatId: uploadChat, fileName: 'catalog.csv' })
        const wrongDownload = await fetch(readUrl, { headers: { cookie: secondLogin.cookie, 'x-request-from': 'internal' } })
        assert.ok(wrongDownload.status === 403 || wrongDownload.status === 404, 'foreign download ' + wrongDownload.status)
        const goodDownload = await fetch(readUrl, { headers: { cookie, 'x-request-from': 'internal' } })
        assert.equal(goodDownload.status, 200)
        assert.ok(Buffer.from(await goodDownload.arrayBuffer()).equals(uploadBytes))

        await server.stop()
        server = null
        fs.rmSync(path.join(dir, 'first'), { recursive: true, force: true })
        await boot('replacement')
        for (const [mode, chatId] of Object.entries(chats)) {
            const r = await post('harnesses/' + name + '/runs', { question: 'RECOVER stored result.', mode, chatId })
            assert.match(r.text, /Recovered 19/)
            assert.equal(r.artifacts.length, 0)
        }
    }
)

test('local receipts bind the actual bytes, admitted user/key and every filesystem ancestor', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-local-'))
    const previous = process.env.CUTTLELY_SECRETKEY_OVERWRITE
    process.env.CUTTLELY_SECRETKEY_OVERWRITE = randomUUID()
    t.after(() => {
        if (previous === undefined) delete process.env.CUTTLELY_SECRETKEY_OVERWRITE
        else process.env.CUTTLELY_SECRETKEY_OVERWRITE = previous
        fs.rmSync(dir, { recursive: true, force: true })
    })
    const { createHash } = await import('node:crypto')
    const { issueManagedUpload, readManagedUpload, selectPredictionFiles } = await import('../packages/harness/prediction-files.mjs')
    selectPredictionFiles(null)
    const org = randomUUID(),
        flow = randomUUID(),
        chat = randomUUID(),
        workspace = randomUUID(),
        parts = [org, flow, chat, 'input.csv']
    const bytes = Buffer.from('synthetic,total\na,19\n')
    const rootDir = path.join(dir, 'storage'),
        own = path.join(rootDir, org, flow, chat)
    fs.mkdirSync(own, { recursive: true })
    fs.writeFileSync(path.join(own, parts.at(-1)), bytes)
    const caller = { via: 'api_key', apiKeyId: randomUUID() },
        scope = { workspace, flow, chat, caller }
    const proof = await issueManagedUpload(scope, parts, createHash('sha256').update(bytes).digest('hex'))
    assert.deepEqual((await readManagedUpload(proof, scope, rootDir, 1000)).body, bytes)
    assert.equal(await readManagedUpload(proof, { ...scope, caller: { ...caller, apiKeyId: randomUUID() } }, rootDir, 1000), null)
    assert.equal(
        await readManagedUpload(proof, { ...scope, caller: { via: 'session', tryOwner: 'user:' + caller.apiKeyId } }, rootDir, 1000),
        null
    )
    assert.equal(
        await issueManagedUpload({ ...scope, caller: { via: 'flow' } }, parts, createHash('sha256').update(bytes).digest('hex')),
        ''
    )
    fs.writeFileSync(path.join(own, parts.at(-1)), 'new contents')
    assert.equal(await readManagedUpload(proof, scope, rootDir, 1000), null)
    fs.renameSync(path.join(rootDir, org), path.join(dir, 'existing'))
    fs.symlinkSync(path.join(dir, 'existing'), path.join(rootDir, org))
    await assert.rejects(readManagedUpload(proof, scope, rootDir, 1000))
})
