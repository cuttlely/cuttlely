import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { managedFilesReady } from '../packages/harness/runtime/native-files.mjs'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const sample = (file) => JSON.parse(JSON.parse(fs.readFileSync(path.join(root, 'samples', file))).flowData)
test(
    'public predictions preserve small inline CSV text and admit its actual bytes only for the scoped caller',
    {
        skip: !managedFilesReady() && process.env.CUTTLELY_TEST_NATIVE_FILES_REQUIRED !== '1' && 'requires the managed file worker',
        timeout: 120000
    },
    async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-inline-')),
            port = await freePort(),
            url = 'http://127.0.0.1:' + port + '/api/v1/'
        const name = 'catalog-test',
            account = { email: 'catalog@example.invalid', password: randomUUID() + 'Pa1!' },
            modelKey = randomUUID()
        let server, worker
        async function stopWorker() {
            if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
            const exited = once(worker, 'exit')
            worker.kill('SIGTERM')
            const timer = setTimeout(() => worker.kill('SIGKILL'), 4000)
            try {
                await exited
            } finally {
                clearTimeout(timer)
            }
        }
        t.after(async () => {
            try {
                await stopWorker()
            } finally {
                try {
                    await server?.stop()
                } finally {
                    fs.rmSync(dir, { recursive: true, force: true })
                }
            }
        })
        const env = dataEnv(dir, port, {
            INBOUND_ACCESS_V2: 'on',
            CUTTLELY_LOCAL_USERS: 'true',
            CUTTLELY_INITIAL_OWNER_EMAIL: account.email,
            CUTTLELY_INITIAL_OWNER_PASSWORD: account.password,
            CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
            KRAKEN_INLINE_KEY: modelKey,
            CUTTLELY_HARNESS_QUEUE: 'external',
            CUTTLELY_NATIVE_PRIME_TEAMS: name,
            CUTTLELY_ANALYST: 'off'
        })
        server = await startServer(root, env, { preload: [path.join(root, 'scripts/fixtures/kraken-inline-upload-provider.cjs')] })
        await waitForPing(url.slice(0, -8), server)
        // A named canary must also accept uploads when only its native engine is available.
        fs.writeFileSync(path.join(dir, 'hermes-supervisor.json'), JSON.stringify({ state: 'down' }))
        const { cookie, status } = await request(url + 'auth/local/login', { method: 'POST', body: account })
        assert.equal(status, 200)
        assert.ok(cookie)
        const post = async (route, body) => {
            const r = await request(url + route, { method: 'POST', cookie, body })
            assert.ok(r.status < 300, r.json?.message)
            return r.json
        }
        const cred = await post('credentials', {
            name: 'Catalog simulation',
            credentialName: 'xaiApi',
            plainDataObj: { xaiApiKey: modelKey }
        })
        const graph = sample('harnesses/calculator.canvas.json')
        graph.nodes = graph.nodes.filter((n) => n.data.name !== 'calculator')
        graph.edges = graph.edges.filter((e) => e.source !== 'calculator_0')
        graph.nodes.find((n) => n.data.name === 'harnessSpecialist').data.inputs.enableFileAccess = true
        graph.nodes.find((n) => n.data.name === 'chatXAI').data.credential = cred.id
        const team = await post('chatflows', { name, type: 'HARNESS', flowData: JSON.stringify(graph) })
        const card = sample('chatflows/ops.chatflow.json')
        card.nodes[0].data.inputs.harnessName = name
        const outer = await post('chatflows', {
            name: 'Catalog receiver',
            apiAccessMode: 'private',
            type: 'CHATFLOW',
            flowData: JSON.stringify(card),
            chatbotConfig: JSON.stringify({ fullFileUpload: { status: true, allowedUploadFileTypes: 'text/csv' } })
        })
        const keys = await post('apikey', {
            keyName: 'Catalog client',
            permissions: ['chatflows:view', 'agentflows:view'],
            accessPolicy: { scopes: ['predict', 'stream', 'upload', 'harness:run', 'harness:read'] },
            resources: [
                { resourceType: 'CHATFLOW', resourceId: outer.id },
                { resourceType: 'HARNESS', resourceId: team.id }
            ]
        })
        const client = keys.find((k) => k.keyName === 'Catalog client')
        const key = client.apiKey
        assert.ok(key)
        const bytes = Buffer.from('item,value\r\nsample,19\r\n')
        const question = 'Check the small catalog.'
        const predict = async (upload, extra = {}, bearer = key) => {
            const response = await fetch(url + 'prediction/' + outer.id, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
                body: JSON.stringify({ question, uploads: [upload], ...extra }),
                signal: AbortSignal.timeout(45000)
            })
            return { status: response.status, body: await response.json() }
        }
        const actual = {
            type: 'file:full',
            name: 'catalog.csv',
            mime: 'text/csv',
            data: 'data:text/csv;base64,' + bytes.toString('base64')
        }
        const denied = await predict(actual, {}, null)
        assert.ok([401, 403].includes(denied.status), 'public denial ' + denied.status + ' ' + denied.body?.message)
        // Admit and queue the real prediction with its worker stopped. Replace the
        // admitted blob before delivery, then start the external consumer normally.
        // Keep an early request rejection handled until the worker starts.
        const queueFile = path.join(env.CUTTLELY_DATA_DIR, 'harness-queue.sqlite')
        const queued = async () => {
            const until = Date.now() + 15000
            while (Date.now() < until) {
                if (fs.existsSync(queueFile)) {
                    const check = new DatabaseSync(queueFile, { readOnly: true })
                    try {
                        if (check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get()) {
                            const job = check
                                .prepare(
                                    "SELECT id,payload FROM jobs WHERE status='queued' AND json_array_length(payload,'$.managedUploadReceipts')=1"
                                )
                                .get()
                            if (job) return job
                        }
                    } finally {
                        check.close()
                    }
                }
                await new Promise((r) => setTimeout(r, 60))
            }
            assert.fail('The public request must enqueue an authenticated upload for the external worker.')
        }
        const startWorker = (expectedPrivateProof) =>
            spawn(
                process.execPath,
                [
                    '-r',
                    path.join(root, 'scripts/fixtures/kraken-inline-upload-provider.cjs'),
                    path.join(root, 'packages/harness/worker.mjs')
                ],
                { cwd: root, env: { ...env, KRAKEN_PRIVATE_PROOF_CHECK: expectedPrivateProof }, stdio: 'ignore' }
            )
        const pending = predict(actual)
        pending.catch(() => {})
        const changed = await queued()
        const blobs = fs.readdirSync(env.BLOB_STORAGE_PATH, { recursive: true }).filter((f) => f.endsWith('catalog.csv'))
        assert.equal(blobs.length, 1)
        const blob = path.join(env.BLOB_STORAGE_PATH, blobs[0])
        assert.ok(fs.readFileSync(blob).equals(bytes))
        fs.writeFileSync(blob, 'item,value\nsample,999\n')
        worker = startWorker(JSON.parse(changed.payload).managedUploadReceipts[0].proof)
        const tampered = await pending
        assert.ok(tampered.status >= 400, 'Changed bytes must stop the public prediction.')
        assert.match(tampered.body.message, /upload could not be verified/i)
        await stopWorker()
        const recovering = predict(actual)
        recovering.catch(() => {})
        const original = await queued()
        const admitted = JSON.parse(original.payload),
            proof = admitted.managedUploadReceipts[0].proof
        worker = startWorker(proof)
        const ok = await recovering
        assert.equal(ok.status, 200, ok.body.message)
        assert.equal(ok.body.text, 'Read the admitted catalog.')
        const queue = new DatabaseSync(queueFile, { readOnly: true })
        t.after(() => queue.close())
        for (const id of [changed.id, original.id]) {
            const row = queue.prepare('SELECT status,payload,result,error_message FROM jobs WHERE id=?').get(id)
            assert.ok(['failed', 'succeeded'].includes(row.status))
            assert.ok(!Object.hasOwn(JSON.parse(row.payload), 'managedUploadReceipts'))
            assert.ok(!JSON.stringify(row).includes(proof))
        }
        const events = queue.prepare('SELECT event FROM job_events WHERE job_id=?').all(original.id)
        assert.ok(events.length > 0 && !JSON.stringify(events).includes(proof))
        const { runId } = JSON.parse(queue.prepare('SELECT result FROM jobs WHERE id=?').get(original.id).result)
        assert.ok(runId)
        const remoteRun = 'harnesses/' + name + '/runs'
        for (const route of [
            remoteRun,
            remoteRun + '/' + runId,
            remoteRun + '/' + runId + '/result',
            remoteRun + '/' + runId + '/diagnostics'
        ]) {
            const response = await fetch(url + route, { headers: { authorization: 'Bearer ' + key } })
            if (route.endsWith('/diagnostics')) assert.ok([200, 403].includes(response.status))
            else assert.equal(response.status, 200, route)
            assert.ok(!(await response.text()).includes(proof), route + ' returned a private admission handle')
        }
        assert.ok(proof.length > 40)
        assert.ok(!admitted.input.includes(proof))
        assert.ok(
            admitted.input.includes('<doc') && admitted.input.includes('sample') && admitted.input.includes('19'),
            'Expected inline document and extracted CSV content. Received ' + admitted.input.slice(0, 280)
        )
        assert.ok(!JSON.stringify(ok.body).includes(proof))
        const app = new DatabaseSync(path.join(env.DATABASE_PATH, 'database.sqlite'), { readOnly: true })
        const session = new DatabaseSync(path.join(env.HERMES_HOME, 'profiles', name, 'sessions.sqlite'), { readOnly: true })
        try {
            const visible = app.prepare('SELECT * FROM chat_message WHERE chatId=?').all(ok.body.chatId)
            assert.ok(visible.length > 0)
            assert.ok(!JSON.stringify(visible).includes(proof))
            const turns = session.prepare('SELECT content FROM messages').all()
            assert.ok(turns.length > 0 && !JSON.stringify(turns).includes(proof))
            const owned = session.prepare('SELECT manifest FROM managed_file_workspaces').all()
            assert.ok(
                owned.some((row) => JSON.parse(row.manifest).files['uploads/catalog.csv'] === bytes.toString('base64')),
                'Managed workspace must preserve exact CSV bytes, including CRLF.'
            )
        } finally {
            app.close()
            session.close()
        }
        const large = await predict({
            ...actual,
            data: 'data:text/csv;base64,' + Buffer.from('item,value\n' + 'sample,19\n'.repeat(1300)).toString('base64')
        })
        assert.equal(large.status, 200, large.body.message)
        assert.equal(large.body.text, 'Read the admitted catalog.')
        const largeJob = JSON.parse(
            queue.prepare("SELECT payload FROM jobs WHERE json_extract(payload,'$.chatId')=?").get(large.body.chatId).payload
        )
        assert.ok(
            largeJob.input.includes('<file ') && !largeJob.input.includes('proof='),
            'New stubs must not expose their admission proof in histories.'
        )
        assert.ok(!Object.hasOwn(largeJob, 'managedUploadReceipts'))
        const form = new FormData()
        form.append('files', new Blob([bytes], { type: 'text/csv' }), 'catalog.csv')
        form.append('question', question)
        const multi = await fetch(url + 'prediction/' + outer.id, {
            method: 'POST',
            headers: { authorization: 'Bearer ' + key },
            body: form
        })
        const delivery = await multi.json()
        assert.equal(multi.status, 200, delivery.message)
        assert.equal(delivery.text, 'Read the admitted catalog.')
        const forged = await predict(
            { type: 'file:full', name: 'catalog.csv', mime: 'text/csv', data: bytes.toString() },
            {
                managedUploadReceipts: admitted.managedUploadReceipts,
                overrideConfig: { managedUploadReceipts: admitted.managedUploadReceipts }
            }
        )
        assert.equal(forged.status, 200, forged.body.message)
        assert.equal(forged.body.text, 'No verified catalog.')
    }
)
