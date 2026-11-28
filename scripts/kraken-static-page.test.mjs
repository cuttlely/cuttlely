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
        let catalogMode = 'linked',
            pauseDetails,
            detailMarker = marker
        const fixture = http.createServer(async (req, res) => {
            const route = req.url
            if (req.method === 'GET' && req.headers.host === 'catalog.example.invalid' && ['/index', '/details'].includes(route)) {
                hits.push({ authorized: true, authenticated: Boolean(req.headers.cookie || req.headers.authorization), route })
                res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'discarded=1' })
                if (route === '/index' && catalogMode === 'unlinked')
                    res.end('<html><body><p>The scope does not link to the destination.</p></body></html>')
                else if (route === '/index' && catalogMode === 'form')
                    res.end('<html><body><form action="/details"><button>Shipping details</button></form></body></html>')
                else if (route === '/index')
                    res.end(
                        '<html><head><title>Catalog</title></head><body><main><h1>Catalog</h1><a href="/details">Shipping details</a><a href="/unapproved">Other text</a></main></body></html>'
                    )
                else {
                    if (pauseDetails) await pauseDetails()
                    res.end(
                        '<html><head><title>Reviewed detail</title></head><body><main><h1>Details</h1><p>' +
                            detailMarker +
                            '</p></main></body></html>'
                    )
                }
                return
            }
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
        const secondKeys = await operator('apikey', {
            keyName: 'second-page-reader',
            permissions: ['chatflows:view'],
            accessPolicy: { scopes: ['predict', 'harness:run', 'harness:read'] },
            resources: [{ resourceType: 'HARNESS', resourceId: flow.id }]
        })
        const second = secondKeys.find((k) => k.keyName === 'second-page-reader').apiKey
        env.CUTTLELY_NATIVE_STATIC_PAGES = JSON.stringify([
            ...[page, 'http://catalog.example.invalid/index', 'http://catalog.example.invalid/details'].map((url) => ({
                workspaceId: roster.workspaceId,
                flowId: flow.id,
                generation: roster.createdAt,
                role: 'browser',
                url
            }))
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
        const call = async (route, question, mode = 'agent', signed = true, session = {}) => {
            const response = await fetch(base + '/api/v1/' + route, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(signed && { authorization: 'Bearer ' + (typeof signed === 'string' ? signed : key) })
                },
                body: JSON.stringify({ question, mode, chatId: randomUUID(), ...session }),
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
        const source = 'http://catalog.example.invalid/index',
            destination = 'http://catalog.example.invalid/details'
        const follow = 'Follow the link from ' + source + ' to ' + destination + ' and report its text.'
        const initial = hits.length
        for (const [route, mode] of [
            [prediction, 'agent'],
            [prediction, 'router'],
            [named, 'router']
        ]) {
            const option = route === named ? ' refresh ref' : mode === 'router' ? ' bare ref' : ''
            const got = await call(route, follow + option, mode)
            assert.equal(got.status, 200, got.body.message)
            assert.equal(got.body.text, marker)
        }
        assert.deepEqual(
            hits.slice(initial).map((x) => [x.route, x.authenticated]),
            Array.from({ length: 3 }, () => [
                ['/index', false],
                ['/details', false]
            ]).flat()
        )
        for (const route of [prediction, named]) {
            const begin = hits.length
            const got = await call(route, follow + ' Then return to the index.', 'agent')
            assert.equal(got.status, 200, got.body.message)
            assert.equal(got.body.text, marker)
            assert.deepEqual(
                hits.slice(begin).map((hit) => hit.route),
                ['/index', '/details']
            )
        }
        for (const control of ['back before reading', 'back twice']) {
            const begin = hits.length
            const denied = await call(prediction, follow + ' ' + control, 'agent')
            assert.equal(denied.status, 422, denied.body.message)
            assert.deepEqual(
                hits.slice(begin).map((hit) => hit.route),
                ['/index', '/details']
            )
        }
        for (const q of [
            'Compare ' + source + ' with ' + destination,
            'Click @e4 from our previous message.',
            'Follow the link from ' + source + ' to http://catalog.example.invalid/unapproved'
        ]) {
            const before = hits.length
            const got = await call(prediction, q)
            assert.equal(got.status, 422, got.body.message)
            assert.equal(hits.length, before)
        }
        for (const mode of ['unlinked', 'form']) {
            catalogMode = mode
            const n = hits.length,
                got = await call(prediction, follow)
            assert.equal(got.status, 422, got.body.message)
            assert.deepEqual(
                hits.slice(n).map((x) => x.route),
                ['/index']
            )
        }
        catalogMode = 'linked'
        detailMarker = 'Shipping reference ' + randomUUID().slice(0, 8) + '.'
        const firstOwned = await call(prediction, follow)
        assert.equal(firstOwned.body.text, detailMarker)
        assert.ok(firstOwned.body.sessionToken)
        const n = hits.length,
            stolen = { chatId: firstOwned.body.chatId, sessionToken: firstOwned.body.sessionToken }
        const denied = await call(prediction, 'Read the previous link reference @e4.', 'agent', second, stolen)
        assert.equal(denied.status, 422)
        assert.equal(hits.length, n)
        assert.ok(!JSON.stringify(denied.body).includes(detailMarker))
        detailMarker = 'Shipping reference ' + randomUUID().slice(0, 8) + '.'
        const own = await call(prediction, follow, 'agent', second, stolen)
        assert.equal(own.status, 200, own.body.message)
        assert.equal(own.body.text, detailMarker)
        assert.notEqual(own.body.sessionToken, firstOwned.body.sessionToken)
        assert.notEqual(own.body.chatId, firstOwned.body.chatId)
        const before = hits.length
        for (const wrong of ['bad ref', 'other ref']) {
            const bad = await call(prediction, follow + ' ' + wrong)
            assert.equal(bad.status, 422, bad.body.message)
        }
        assert.deepEqual(
            hits.slice(before).map((x) => x.route),
            ['/index', '/index']
        )
        let signalReached, release
        const reached = new Promise((r) => {
                signalReached = r
            }),
            held = new Promise((r) => {
                release = r
            })
        pauseDetails = async () => {
            signalReached()
            await held
        }
        const pending = call(named, follow, 'router')
        try {
            await Promise.race([
                reached,
                pending.then(() => {
                    throw new Error('destination request was never observed')
                })
            ])
            const edit = structuredClone(graph)
            edit.nodes.find(
                (x) => x.data.name === 'harnessSpecialist' && x.data.inputs.specialistName === 'browser'
            ).data.inputs.instructions += ' Report only the published text.'
            const updated = await request(base + '/api/v1/chatflows/' + flow.id, {
                method: 'PUT',
                cookie: login.cookie,
                body: { id: flow.id, name, type: 'HARNESS', flowData: JSON.stringify(edit) }
            })
            assert.equal(updated.status, 200, 'ordinary publication replacement')
        } finally {
            release()
        }
        const changed = await pending
        assert.ok([409, 422].includes(changed.status), 'changed publication got ' + changed.status)
        assert.ok(!JSON.stringify(changed.body).includes(detailMarker), 'stale destination contents escaped')
        t.diagnostic(
            `Reviewed links matched the released snapshot on signed agent, router and named worker requests. Publication change returned HTTP ${changed.status}.`
        )
    }
)
