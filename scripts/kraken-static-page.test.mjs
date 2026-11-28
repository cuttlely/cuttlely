import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { nativePackageRoot } from './kraken-package-fixture.mjs'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'

const root = path.resolve(import.meta.dirname, '..'),
    page = 'http://catalog.example.invalid/shipping'
test(
    'signed static-page specialist uses the original message and the published generation on prediction and named runs',
    {
        skip:
            process.env.CUTTLELY_TEST_STATIC_PAGE_REQUIRED !== '1' &&
            'requires an isolated loopback namespace with the local synthetic catalog and sandboxed Chromium',
        timeout: 120000
    },
    async (t) => {
        // The public-shaped address terminates on this namespace's private loopback. No host network is permitted.
        assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo'])
        const ip = '11.111.32.2'
        assert.ok(os.networkInterfaces().lo.some((a) => a.address === ip))
        assert.deepEqual(
            (await lookup('catalog.example.invalid', { all: true })).map((x) => x.address),
            [ip]
        )
        assert.equal(
            fs
                .readFileSync('/proc/net/route', 'utf8')
                .split('\n')
                .some((row) => /^\S+\s+00000000\s/.test(row)),
            false
        )
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-static-')),
            port = await freePort(),
            base = 'http://127.0.0.1:' + port
        const acct = { email: 'reader@example.invalid', password: randomUUID() + 'Test1!' },
            model = randomUUID(),
            name = 'field-team'
        const marker = 'Shipping reference ' + randomUUID().slice(0, 8) + '.',
            hits = []
        const fixture = http.createServer((req, res) => {
            const ok = req.method === 'GET' && req.headers.host === 'catalog.example.invalid' && req.url === '/shipping'
            hits.push({ authorized: ok, authenticated: Boolean(req.headers.cookie || req.headers.authorization) })
            res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/html', 'Set-Cookie': 'sample=discard; Path=/' })
            res.end(
                ok
                    ? '<html><head><title>Shipping desk</title></head><body><main><h1>Shipping desk</h1><p>' +
                          marker +
                          '</p></main></body></html>'
                    : ''
            )
        })
        let app, worker
        t.after(async () => {
            try {
                if (worker && worker.exitCode === null && !worker.signalCode) {
                    const exited = once(worker, 'exit')
                    worker.kill('SIGTERM')
                    const grace = setTimeout(() => worker.kill('SIGKILL'), 6000)
                    try {
                        await exited
                    } finally {
                        clearTimeout(grace)
                    }
                }
                await app?.stop()
            } finally {
                fixture.closeAllConnections()
                await new Promise((r) => fixture.close(r))
                fs.rmSync(dir, { recursive: true, force: true })
            }
        })
        fixture.listen(80, ip)
        await once(fixture, 'listening')
        const env = dataEnv(dir, port, {
            CUTTLELY_NATIVE_PRIME_TEAMS: name,
            CUTTLELY_NATIVE_ROLE_POLICY: 'on-demand',
            CUTTLELY_LOCAL_USERS: 'true',
            CUTTLELY_INITIAL_OWNER_EMAIL: acct.email,
            CUTTLELY_INITIAL_OWNER_PASSWORD: acct.password,
            INBOUND_ACCESS_V2: 'on',
            CUTTLELY_HARNESS_QUEUE: 'external',
            CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
            CUTTLELY_ANALYST: 'off',
            QA_STATIC_MODEL_PIDS: path.join(dir, 'model-pids'),
            QA_STATIC_MODEL: model
        })
        delete env.CUTTLELY_NATIVE_STATIC_PAGES
        const boot = async () => {
            app = await startServer(nativePackageRoot() || root, env, {
                preload: [path.join(import.meta.dirname, 'fixtures/kraken-static-page-provider.cjs')]
            })
            await waitForPing(base, app)
        }
        await boot()
        const login = await request(base + '/api/v1/auth/local/login', { method: 'POST', body: acct })
        assert.equal(login.status, 200)
        const operator = async (route, body) => {
            const r = await request(base + '/api/v1/' + route, { method: body ? 'POST' : 'GET', body, cookie: login.cookie })
            assert.equal(r.status, 200, route)
            return r.json
        }
        const credential = await operator('credentials', {
            name: 'Synthetic QA model',
            credentialName: 'xaiApi',
            plainDataObj: { xaiApiKey: model }
        })
        const graph = JSON.parse(JSON.parse(fs.readFileSync(path.join(root, 'samples/harnesses/field-team.canvas.json'))).flowData)
        graph.nodes.find((n) => n.data.name === 'chatXAI').data.credential = credential.id
        const flow = await operator('chatflows', { type: 'HARNESS', name, apiAccessMode: 'private', flowData: JSON.stringify(graph) })
        const roster = await operator('harnesses/' + name)
        assert.ok(roster.workspaceId && roster.createdAt && roster.chatflowId === flow.id)
        const keys = await operator('apikey', {
            keyName: 'page-reader',
            permissions: ['chatflows:view'],
            accessPolicy: { scopes: ['predict', 'harness:run', 'harness:read'] },
            resources: [{ resourceType: 'HARNESS', resourceId: flow.id }]
        })
        const key = keys.find((k) => k.keyName === 'page-reader').apiKey
        env.CUTTLELY_NATIVE_STATIC_PAGES = JSON.stringify([
            { workspaceId: roster.workspaceId, flowId: flow.id, generation: roster.createdAt, role: 'browser', url: page }
        ])
        await app.stop()
        await boot()
        worker = spawn(
            process.execPath,
            [
                '-r',
                path.join(import.meta.dirname, 'fixtures/kraken-static-page-provider.cjs'),
                path.join(nativePackageRoot() || root, 'packages/harness/worker.mjs')
            ],
            { cwd: nativePackageRoot() || root, env, stdio: 'ignore' }
        )
        const call = async (route, question, mode = 'agent', signed = true) => {
            const response = await fetch(base + '/api/v1/' + route, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(signed && { authorization: 'Bearer ' + key }) },
                body: JSON.stringify({ question, mode, chatId: randomUUID() }),
                signal: AbortSignal.timeout(30000)
            })
            return { status: response.status, body: await response.json() }
        }
        const prediction = 'prediction/' + flow.id,
            named = 'harnesses/' + name + '/runs'
        assert.equal((await call(prediction, 'Read ' + page, 'agent', false)).status, 401)
        for (const [route, question, mode] of [
            [prediction, 'What hours are on ' + page + '?', 'agent'],
            [prediction, '¿Qué dice ' + page + '?', 'router'],
            [named, 'Read ' + page, 'agent']
        ]) {
            const result = await call(route, question, mode)
            assert.equal(result.status, 200, result.body.message)
            assert.equal(result.body.text, marker)
            if (route === named)
                assert.ok(
                    fs.readFileSync(env.QA_STATIC_MODEL_PIDS, 'utf8').trim().split('\n').includes(String(worker.pid)),
                    'named turn needs its actual external worker'
                )
        }
        for (const question of [
            'Read the page we discussed.',
            'Compare ' + page + ' with http://other.example.invalid/catalog',
            'Test our other action at ' + page
        ]) {
            const before = hits.length
            assert.equal((await call(prediction, question)).status, 422)
            assert.equal(hits.length, before)
        }
        assert.deepEqual(
            hits,
            Array.from({ length: 3 }, () => ({ authorized: true, authenticated: false }))
        )
    }
)
