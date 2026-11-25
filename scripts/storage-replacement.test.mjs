// Independent server and worker processes, synthetic credentials and a disposable database for each installation.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createTestDatabase, skipReason } from '../packages/etl/check/pg-source.mjs'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'
import { smokeFlow } from './smoke-server.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = createRequire(path.join(root, 'packages/server/package.json'))

async function runWorker() {
    const { loadWorkerSettings, startWorkerStorage } = await import('../packages/harness/worker-storage.mjs')
    loadWorkerSettings()
    const close = await startWorkerStorage()
    try {
        const components = server('@cuttlely/components')
        const key = process.env.QA_CREDENTIAL
        const { flowiseNodeOptions } = await import('../packages/harness/offline-options.mjs')
        const opts = flowiseNodeOptions()
        const Node = server('@cuttlely/components/dist/nodes/tools/MCP/PostgreSQL/PostgreSQLMCP').nodeClass
        const [tool] = await new Node().getTools({ credential: key, inputs: {} }, opts)
        const reply = await tool.invoke({ sql: 'SELECT 516 AS recovered' })
        assert.match(String(reply), /"recovered"\s*:\s*516/)
        const [org, flow, chat] = JSON.parse(process.env.QA_SCOPE)
        const { stage } = JSON.parse(process.env.QA_ACTION)
        if (stage === 'seed')
            await components.addSingleFileToStorage('text/plain', Buffer.from('verified input'), 'source.txt', org, flow, chat)
        assert.equal((await components.getFileFromStorage('source.txt', org, flow, chat)).toString(), 'verified input')
    } finally {
        await close()
    }
}

if (process.argv.includes('--fixture-worker')) {
    await runWorker()
} else
    for (const initial of ['new-postgres', 'existing-postgres', 'sqlite'])
        test(initial + ' recovers on empty server and worker disks', { skip: skipReason }, async () => {
            const app = await createTestDatabase()
            const c = app.connection
            const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskless-recovery-'))
            const port = await freePort()
            const url = 'http://127.0.0.1:' + port
            const secret = randomUUID()
            const email = 'recovery@example.invalid'
            const password = randomUUID() + 'aA1!'
            const first = path.join(rootDir, 'original')
            const fresh = path.join(rootDir, 'replacement')
            const pg = {
                DATABASE_TYPE: 'postgres',
                DATABASE_HOST: c.host,
                DATABASE_PORT: String(c.port),
                DATABASE_USER: c.user,
                DATABASE_PASSWORD: c.password || '',
                DATABASE_NAME: c.database
            }
            const host = { CUTTLELY_LOCAL_USERS: 'true', CUTTLELY_SECRETKEY_OVERWRITE: secret, CUTTLELY_ANALYST: 'off' }
            const buyer = { CUTTLELY_INITIAL_OWNER_EMAIL: email, CUTTLELY_INITIAL_OWNER_PASSWORD: password }
            const stores = { CUTTLELY_APP_DATABASE_STORES: '1' }
            let running, cookie, operator, credentialId, orgId, flowId
            async function boot(dir, extra) {
                running = await startServer(root, dataEnv(dir, port, { ...host, ...extra }), {
                    preload: [path.join(root, 'scripts/smoke-fake-model.cjs')]
                })
                await waitForPing(url, running)
                const login = await request(url + '/api/v1/auth/local/login', { method: 'POST', body: { email, password } })
                assert.equal(login.status, 200)
                cookie = login.cookie
            }
            async function api(route, body) {
                const res = await request(url + '/api/v1/' + route, { method: body ? 'POST' : 'GET', cookie, body })
                assert.ok(res.status >= 200 && res.status < 300, route + ' status ' + res.status + ' ' + (res.json?.message || ''))
                return res.json
            }
            const { Client } = server('pg')
            const client = new Client(c)
            const auxiliary = await createTestDatabase()
            const sqlRole = 'qa_' + randomUUID().replaceAll('-', '')
            const sqlPassword = randomUUID()
            const toolClient = new Client(auxiliary.connection)
            async function worker(dir, stage) {
                fs.mkdirSync(dir, { recursive: true })
                const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture-worker'], {
                    env: dataEnv(dir, port, {
                        ...pg,
                        ...host,
                        ...stores,
                        QA_ACTION: JSON.stringify({ stage }),
                        QA_SCOPE: JSON.stringify([orgId, flowId, 'chat']),
                        QA_CREDENTIAL: credentialId
                    }),
                    stdio: ['ignore', 'ignore', 'pipe']
                })
                let diagnostic = ''
                child.stderr.on('data', (data) => {
                    diagnostic = (diagnostic + data).slice(-9000)
                })
                const [code] = await once(child, 'exit')
                assert.equal(
                    code,
                    0,
                    'worker ' +
                        stage +
                        ' failed: ' +
                        [sqlPassword, secret, password, c.password, auxiliary.connection.password]
                            .filter(Boolean)
                            .reduce((message, value) => message.replaceAll(value, '[redacted]'), diagnostic)
                )
            }
            try {
                await client.connect()
                await toolClient.connect()
                await toolClient.query('CREATE ROLE ' + sqlRole + " LOGIN PASSWORD '" + sqlPassword + "'")
                const target = new URL('postgres://localhost')
                target.hostname = auxiliary.connection.host
                target.port = String(auxiliary.connection.port)
                target.pathname = '/' + auxiliary.connection.database
                target.username = sqlRole
                target.password = sqlPassword
                await boot(first, {
                    ...buyer,
                    ...(initial === 'sqlite' ? { DATABASE_TYPE: 'sqlite' } : pg),
                    ...(initial === 'new-postgres' ? stores : {})
                })
                const model = await api('credentials', {
                    name: 'Model fixture',
                    credentialName: 'openAIApi',
                    plainDataObj: { openAIApiKey: 'smoke-local-placeholder' }
                })
                const tool = await api('credentials', {
                    name: 'Read-only tool fixture',
                    credentialName: 'PostgresApi',
                    plainDataObj: { postgresUrl: target.href }
                })
                credentialId = tool.id
                flowId = (
                    await api('chatflows', {
                        name: 'Recovery',
                        type: 'CHATFLOW',
                        deployed: false,
                        isPublic: false,
                        flowData: JSON.stringify(smokeFlow(model.id))
                    })
                ).id
                assert.ok(flowId)
                // The legacy store saves Git versions asynchronously. Quiesce its writer before stopping the source.
                const repo = path.join(first, 'versions')
                let committed = false
                for (let attempt = 0; attempt < 100 && !committed; attempt++) {
                    try {
                        committed = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only', 'HEAD'], {
                            encoding: 'utf8',
                            stdio: ['ignore', 'pipe', 'ignore']
                        }).includes('/flow.json')
                    } catch {
                        /* Git may still be initializing the repository. */
                    }
                    if (!committed) await new Promise((resolve) => setTimeout(resolve, 100))
                }
                assert.ok(committed, 'original flow revision was not committed')
                await running.stop()
                running = null
                if (initial === 'sqlite') {
                    const { copySqliteApplication } = server('./dist/settings/copySqliteApplication')
                    await copySqliteApplication(path.join(dataEnv(first, port).DATABASE_PATH, 'database.sqlite'), { ...host, ...pg })
                }
                const owner = (await client.query('SELECT id FROM "user" WHERE email=$1', [email])).rows[0]
                orgId = (
                    await client.query(
                        'SELECT w."organizationId" AS id FROM workspace w JOIN chat_flow f ON f."workspaceId"=w.id WHERE f.id=$1',
                        [flowId]
                    )
                ).rows[0].id
                const { operatorDatabaseFingerprint } = server('./dist/identity/instanceOperator')
                operator = {
                    CUTTLELY_INSTANCE_OPERATOR: JSON.stringify({
                        userId: owner.id,
                        database: operatorDatabaseFingerprint({
                            type: 'postgres',
                            host: c.host,
                            port: c.port,
                            username: c.user,
                            password: c.password,
                            database: c.database
                        })
                    })
                }
                await boot(first, { ...pg, ...stores, ...operator })
                if ((await api('server-settings/storage')).phase === 'sqlite')
                    assert.equal((await api('server-settings/storage/upgrade', { availableBytes: 1e9 })).phase, 'postgres')
                await running.stop()
                running = null
                await worker(path.join(rootDir, 'worker-before'), 'seed')
                fs.rmSync(first, { recursive: true })
                fs.rmSync(path.join(rootDir, 'worker-before'), { recursive: true })
                await boot(fresh, { ...pg, ...stores, ...operator })
                const storageCheck = await api('server-settings/test', { kind: 'storage', values: {} })
                assert.equal(storageCheck.ok, true, storageCheck.summary)
                assert.match(storageCheck.summary, /PostgreSQL file store/)
                assert.equal(
                    (await client.query("SELECT count(*)::int AS n FROM cuttlely_files.files WHERE segments[1]='connection-tests'")).rows[0]
                        .n,
                    0
                )
                const response = await api('prediction/' + flowId, { question: 'Say smoke-ok', streaming: false })
                assert.match(JSON.stringify(response), /smoke-ok/)
                await running.stop()
                running = null
                await worker(path.join(rootDir, 'worker-after'), 'recover')
            } finally {
                await running?.stop()
                await toolClient.query('DROP ROLE IF EXISTS ' + sqlRole).catch(() => {})
                await toolClient.end()
                await auxiliary.cleanup()
                await client.end()
                await app.cleanup()
                fs.rmSync(rootDir, { recursive: true, force: true })
            }
        })
