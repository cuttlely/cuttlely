import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { managedFilesReady } from '../packages/harness/runtime/native-files.mjs'
import { nativePackageRoot } from './kraken-package-fixture.mjs'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
test(
    'Field Team preserves the saved GET contract for concurrent scoped router and agent turns',
    {
        timeout: 120000,
        skip: !managedFilesReady() && process.env.CUTTLELY_TEST_NATIVE_FILES_REQUIRED !== '1' && 'requires the managed file worker'
    },
    async (t) => {
        const name = 'field-contract',
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-field-'))
        const port = await freePort(),
            base = 'http://127.0.0.1:' + port,
            calls = path.join(dir, 'calls')
        const auth = { email: 'field@example.invalid', password: randomUUID() + 'aA1!' },
            modelKey = randomUUID()
        const install = nativePackageRoot() || root
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
                CUTTLELY_NATIVE_PRIME_TEAMS: name,
                CUTTLELY_NATIVE_ROLE_POLICY: 'on-demand',
                CUTTLELY_LOCAL_USERS: 'true',
                CUTTLELY_INITIAL_OWNER_EMAIL: auth.email,
                CUTTLELY_INITIAL_OWNER_PASSWORD: auth.password,
                INBOUND_ACCESS_V2: 'on',
                CUTTLELY_SECRETKEY_OVERWRITE: randomUUID(),
                CUTTLELY_HARNESS_QUEUE: 'off',
                CUTTLELY_ANALYST: 'off',
                KRAKEN_FIELD_KEY: modelKey,
                KRAKEN_FIELD_CALLS: calls
            }),
            { preload: [path.join(root, 'scripts/fixtures/kraken-field-team-provider.cjs')], launcher: Boolean(nativePackageRoot()) }
        )
        await waitForPing(base, app)
        const login = await request(base + '/api/v1/auth/local/login', { method: 'POST', body: auth })
        assert.equal(login.status, 200)
        async function post(route, body) {
            const response = await request(base + '/api/v1/' + route, { method: 'POST', cookie: login.cookie, body })
            assert.ok([200, 201].includes(response.status), route + ' ' + response.status)
            return response.json
        }
        const credential = await post('credentials', { name: 'Field QA', credentialName: 'xaiApi', plainDataObj: { xaiApiKey: modelKey } })
        const graph = JSON.parse(JSON.parse(fs.readFileSync(path.join(install, 'samples/harnesses/field-team.canvas.json'))).flowData)
        graph.nodes.find((n) => n.data.name === 'chatXAI').data.credential = credential.id
        const flow = await post('chatflows', {
            name,
            type: 'HARNESS',
            flowData: JSON.stringify(graph),
            deployed: false,
            isPublic: false,
            apiAccessMode: 'private'
        })
        const keys = []
        for (const keyName of ['field-one', 'field-two']) {
            const issued = await post('apikey', {
                keyName,
                permissions: ['chatflows:view'],
                accessPolicy: { scopes: ['harness:run'] },
                resources: [{ resourceType: 'HARNESS', resourceId: flow.id }]
            })
            keys.push(issued.find((k) => k.keyName === keyName).apiKey)
        }
        async function run(mode, key, chatId) {
            const ticket = mode + '-' + randomUUID()
            const response = await fetch(base + '/api/v1/harnesses/' + name + '/runs', {
                method: 'POST',
                headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'x-qa-ticket': ticket },
                body: JSON.stringify({
                    mode,
                    chatId,
                    streaming: true,
                    question: 'Ask only the api specialist for the current sensor reading.'
                }),
                signal: AbortSignal.timeout(30000)
            })
            const text = await response.text()
            const frames = text.split(/\r?\n\r?\n/).flatMap((frame) =>
                frame
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => JSON.parse(line.slice(5)))
            )
            return {
                ticket,
                chatId,
                status: response.status,
                errors: frames.filter((e) => e.event === 'error').map((e) => e.data?.message),
                finals: frames.filter((e) => e.event === 'harness.final').map((e) => e.data)
            }
        }
        const chats = [randomUUID(), randomUUID()]
        const results = await Promise.all([run('router', keys[0], chats[0]), run('agent', keys[1], chats[1])])
        assert.equal((await run('router', keys[1], chats[0])).status, 403)
        assert.equal((await run('router', 'invalid-synthetic', randomUUID())).status, 401)
        const observed = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
        assert.deepEqual(
            new Set(observed.filter((row) => row.kind !== 'arrival').map((row) => row.ticket)),
            new Set(results.map((r) => r.ticket))
        )
        assert.ok(
            observed.some((row) => row.kind === 'arrival' && row.open >= 2 && results.some((r) => r.ticket === row.ticket)),
            'two signed requests overlapped at the HTTP server'
        )
        const readings = []
        for (const r of results) {
            assert.equal(r.status, 200)
            assert.equal(
                r.finals.length,
                1,
                JSON.stringify({ mode: r.ticket.split('-')[0], errors: r.errors, observed: observed.filter((x) => x.ticket === r.ticket) })
            )
            const final = r.finals[0],
                own = observed.filter((x) => x.ticket === r.ticket),
                gets = own.filter((x) => x.kind === 'get')
            assert.equal(final.chatId, r.chatId)
            assert.deepEqual(final.sources || [], [])
            assert.deepEqual(
                final.agents.flatMap((a) => a.sources || []),
                []
            )
            assert.deepEqual(
                final.agents.map((a) => [a.name, a.status]),
                [['api', 'completed']]
            )
            assert.equal(gets.length, 1)
            assert.deepEqual(final.text.match(/field-reading-[0-9a-f-]{36}/g), [gets[0].reading])
            assert.equal(own.filter((x) => x.kind === 'model').length, r.ticket.startsWith('agent-') ? 4 : 3)
            readings.push(gets[0].reading)
        }
        assert.equal(new Set(readings).size, 2)
    }
)
