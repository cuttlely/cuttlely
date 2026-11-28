import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativePackageRoot } from './kraken-package-fixture.mjs'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'
import fixtures from './fixtures/kraken-workbook.cjs'
import { normalizeCanvasFlow, specsByName } from '../packages/ui/src/utils/normalizeCanvasFlow.js'

const root = fileURLToPath(new URL('../', import.meta.url)),
    install = nativePackageRoot() || root
const model = path.join(root, 'scripts/fixtures/kraken-workbook-provider.cjs')
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
function graph(file) {
    return JSON.parse(JSON.parse(fs.readFileSync(path.join(install, 'samples', file))).flowData)
}

test(
    'original Upload chatflow and team sample the owning caller’s workbook through their actual saved nodes',
    { timeout: 120000 },
    async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-workbook-http-')),
            port = await freePort(),
            base = 'http://127.0.0.1:' + port,
            url = base + '/api/v1/'
        const account = { email: 'workbook@example.invalid', password: randomUUID() + 'Pa1!' },
            stages = path.join(dir, 'stages')
        const env = dataEnv(dir, port, {
            INBOUND_ACCESS_V2: 'on',
            CUTTLELY_LOCAL_USERS: 'true',
            CUTTLELY_INITIAL_OWNER_EMAIL: account.email,
            CUTTLELY_INITIAL_OWNER_PASSWORD: account.password,
            CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
            KRAKEN_WORKBOOK_MODEL: randomUUID(),
            KRAKEN_WORKBOOK_STAGES: stages,
            CUTTLELY_HARNESS_QUEUE: 'external',
            CUTTLELY_NATIVE_PRIME_TEAMS: 'upload',
            CUTTLELY_NATIVE_ROLE_POLICY: 'on-demand',
            CUTTLELY_ANALYST: 'off'
        })
        let server, worker
        t.after(async () => {
            try {
                if (worker && worker.exitCode === null && worker.signalCode === null) {
                    const ex = once(worker, 'exit')
                    worker.kill('SIGTERM')
                    const timer = setTimeout(() => worker.kill('SIGKILL'), 4000)
                    try {
                        await ex
                    } finally {
                        clearTimeout(timer)
                    }
                }
            } finally {
                try {
                    await server?.stop()
                } finally {
                    fs.rmSync(dir, { recursive: true, force: true })
                }
            }
        })
        server = await startServer(install, env, { preload: [model], launcher: Boolean(nativePackageRoot()) })
        await waitForPing(base, server)
        worker = spawn(process.execPath, ['-r', model, path.join(install, 'packages/harness/worker.mjs')], {
            cwd: install,
            env,
            stdio: 'ignore'
        })
        const login = await request(url + 'auth/local/login', { method: 'POST', body: account })
        assert.equal(login.status, 200)
        const post = async (route, body) => {
            const r = await request(url + route, { method: 'POST', cookie: login.cookie, body })
            assert(r.status < 300, route + ' ' + r.status)
            return r.json
        }
        const cred = await post('credentials', {
            name: 'Workbook simulation',
            credentialName: 'xaiApi',
            plainDataObj: { xaiApiKey: env.KRAKEN_WORKBOOK_MODEL }
        })
        const inner = graph('harnesses/upload.canvas.json'),
            outer = graph('chatflows/upload.chatflow.json')
        const catalog = await request(url + 'nodes', { cookie: login.cookie })
        assert.equal(catalog.status, 200)
        // Marketplace samples store inputs only. The actual canvas load hydrates their
        // editor/engine param/anchor arrays from the installed node catalog.
        const authored = structuredClone(outer)
        normalizeCanvasFlow(outer, specsByName(catalog.json))
        for (let i = 0; i < authored.nodes.length; i++) {
            assert.equal(outer.nodes[i].id, authored.nodes[i].id)
            for (const [key, value] of Object.entries(authored.nodes[i].data.inputs))
                assert.deepEqual(outer.nodes[i].data.inputs[key], value)
        }
        const endpoints = (graph) => graph.edges.map(({ source, target }) => [source, target])
        assert.deepEqual(endpoints(outer), endpoints(authored))
        for (const g of [inner, outer]) g.nodes.find((n) => n.data.name === 'chatXAI').data.credential = cred.id
        assert.equal(outer.nodes.find((n) => n.data.name === 'harness').data.inputs.harnessName, 'upload')
        const team = await post('chatflows', { name: 'upload', type: 'HARNESS', flowData: JSON.stringify(inner) })
        const flow = await post('chatflows', {
            name: 'Upload workbook receiver',
            type: 'CHATFLOW',
            apiAccessMode: 'private',
            flowData: JSON.stringify(outer),
            chatbotConfig: JSON.stringify({ fullFileUpload: { status: true, allowedUploadFileTypes: mime } })
        })
        async function key(keyName) {
            const list = await post('apikey', {
                keyName,
                permissions: ['chatflows:view', 'agentflows:view'],
                accessPolicy: { scopes: ['predict', 'stream', 'upload', 'harness:run', 'harness:read'] },
                resources: [
                    { resourceType: 'CHATFLOW', resourceId: flow.id },
                    { resourceType: 'HARNESS', resourceId: team.id }
                ]
            })
            return list.find((k) => k.keyName === keyName).apiKey
        }
        const a = await key('Workbook A'),
            b = await key('Workbook B'),
            chatId = randomUUID()
        async function predict(
            token,
            bytes,
            question = 'Sample the attached workbook. Give sheet names, the row sample and total amount.',
            overrideConfig
        ) {
            const uploads = bytes
                ? [{ type: 'file:full', mime, name: 'book.xlsx', data: 'data:' + mime + ';base64,' + bytes.toString('base64') }]
                : []
            const response = await fetch(url + 'prediction/' + flow.id, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
                body: JSON.stringify({ chatId, question, uploads, overrideConfig }),
                signal: AbortSignal.timeout(35000)
            })
            return { status: response.status, body: await response.json() }
        }
        const denied = await predict(null, fixtures.book(false))
        assert([401, 403].includes(denied.status))
        for (const [client, data, answer] of [
            [a, fixtures.book(false), 'Sales has seven rows totalling 28.'],
            [b, fixtures.book(true), 'Sales has one row totalling 42.']
        ]) {
            const r = await predict(client, data)
            assert.equal(r.status, 200, r.body?.message)
            assert.equal(r.body.text, answer)
            assert(!JSON.stringify(r.body).includes('PRIVATE-HIDDEN-VALUE'))
        }
        assert.equal(
            fs
                .readFileSync(stages, 'utf8')
                .split('\n')
                .filter((x) => x === 'verified-workbook-result').length,
            2
        )
        assert(fs.readFileSync(stages, 'utf8').includes('outer-tool'))
        const bad = await predict(b, fixtures.book(true, 'link'))
        // The real outer Tool Agent returns a model-authored business response over HTTP 200.
        assert.equal(bad.status, 200)
        assert.equal(bad.body.text, 'Workbook could not be sampled.')
        const seen = fs.readFileSync(stages, 'utf8').trim().split('\n')
        assert.equal(seen.filter((x) => x === 'verified-workbook-result').length, 2)
        assert.equal(seen.filter((x) => x === 'verified-refusal').length, 1)
        const selector = { harnessName: 'another-team' }
        const inert = await predict(a, fixtures.book(), undefined, selector)
        assert.equal(inert.status, 200)
        assert.equal(inert.body.text, 'Sales has seven rows totalling 28.')
        const observations = fs.readFileSync(stages, 'utf8')
        assert.equal(observations.split('\n').filter((x) => x === 'verified-workbook-result').length, 3)
        if (nativePackageRoot()) {
            const edit = await request(url + 'chatflows/' + flow.id, {
                method: 'PUT',
                cookie: login.cookie,
                body: { apiConfig: JSON.stringify({ overrideConfig: { status: true, nodes: {}, variables: [] } }) }
            })
            assert.equal(edit.status, 200)
            const enabled = await predict(a, fixtures.book(), undefined, selector)
            assert.equal(enabled.status, 503)
            assert.equal(fs.readFileSync(stages, 'utf8'), observations)
        }
    }
)

test('the confined workbook tool retains bounds and shows only visible, selected, verified sheets', async () => {
    const { openUploadSampler } = await import(path.join(install, 'packages/harness/runtime/native-files.mjs'))
    const source = 'uploads/book.xlsx'
    function sample(bytes) {
        return openUploadSampler({
            managedFileOwner: 'fixture-owner',
            sampleInputs: new Set([source]),
            managedUploads: { [source]: bytes.toString('base64') },
            assertNativeAuthority() {}
        })
    }
    const sampler = sample(fixtures.book())
    assert.deepEqual(sampler.workbookTool.function.parameters.properties.source.enum, [source])
    assert.equal(sampler.accepts('import subprocess'), false)
    for (const args of [{ source: 'uploads/other.xlsx' }, { source, sheet: 5 }, { source, location: '/tmp' }, { source, sheet: '' }])
        assert.throws(() => sampler.validateWorkbook(args), { code: 'native_unsupported' })
    const note = JSON.parse(await sampler.executeWorkbook({ source, sheet: 'Notes' }))
    assert.deepEqual(note.sheets, ['Sales', 'Notes'])
    assert.equal(note.sheet, 'Notes')
    assert.deepEqual(note.first, [['recorded', '2026-01-02T00:00:00']])
    assert.deepEqual(note.aggregate, { operation: 'count', rows: 1 })
    for (const sheet of ['Internal', 'Missing']) await assert.rejects(sampler.executeWorkbook({ source, sheet }), { code: 'sample_failed' })
    for (const kind of ['formula', 'link', 'row-limit'])
        await assert.rejects(sample(fixtures.book(false, kind)).executeWorkbook({ source }), { code: 'sample_failed' })
    const report = await sample(fixtures.book(false, 'wide')).executeWorkbook({ source })
    assert([...report].length <= 4000)
    const preview = JSON.parse(report)
    assert.equal(preview.preview_truncated, true)
    assert.equal(preview.row_count, 20)
    assert.deepEqual(preview.aggregate, { operation: 'sum', column: 'amount', observations: 20, value: '20' })
    assert(preview.first.length <= 5 && preview.last.length <= 5)
})
