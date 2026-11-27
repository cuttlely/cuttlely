// Independent server and worker processes, synthetic credentials and a disposable database for each installation.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { dataEnv, freePort, request, startServer, waitForPing } from './upgrade-check.mjs'
import { smokeFlow } from './smoke-server.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = createRequire(path.join(root, 'packages/server/package.json'))

function runtimeMessage(env, write, message, member) {
    const python = process.env.HERMES_PYTHON || path.join(root, 'hermes', '.venv', 'bin', 'python')
    const script = `
import os, signal, sys
from pathlib import Path
from hermes_state import SessionDB
file = Path(os.environ["HERMES_HOME"]) / "profiles" / "research" / "state.db"
if sys.argv[1] == "read" and not file.is_file():
    print("missing")
    sys.exit(0)
db = SessionDB(file, read_only=sys.argv[1] == "read")
if sys.argv[1] == "write":
    db.create_session(sys.argv[3], "cli")
    from gateway.config import GatewayConfig
    from gateway.session import SessionStore
    store = SessionStore(file.parent / "sessions", GatewayConfig())
    store._db = db
    store.append_to_transcript(sys.argv[3], {"role": "assistant", "content": sys.argv[2]})
print("present" if any(row["content"] == sys.argv[2] for row in db.get_messages(sys.argv[3])) else "missing", flush=True)
if sys.argv[1] == "write":
    os.kill(os.getpid(), signal.SIGKILL)
db.close()
`
    const result = spawnSync(python, ['-c', script, write ? 'write' : 'read', message, 'recovery-fixture-' + member], {
        cwd: path.join(root, 'hermes'),
        env,
        encoding: 'utf8',
        timeout: 30000
    })
    if (result.error) throw result.error
    if (write) assert.equal(result.signal, 'SIGKILL', 'writer must crash with its session database still open')
    else assert.equal(result.status, 0, 'replacement runtime session read failed')
    return result.stdout.trim() === 'present'
}

function saveRuntimeSetting(env, member, value) {
    const profile = path.join(env.CUTTLELY_HERMES_HOME, 'profiles/research')
    const python = process.env.HERMES_PYTHON || path.join(root, 'hermes', '.venv', 'bin', 'python')
    const script = `
import sys
from hermes_cli.config import atomic_config_replace, get_config_path, save_env_value
from tools.memory_tool import MemoryStore
if sys.argv[1] == "web":
    save_env_value(*sys.argv[2].split("=", 1))
else:
    atomic_config_replace(get_config_path(), {"fixture": sys.argv[2].split(": ", 1)[1]})
    memory = MemoryStore()
    memory.load_from_disk()
    assert memory.add("user", "Remember the replacement check")["success"]
`
    execFileSync(python, ['-c', script, member, value], {
        cwd: path.join(root, 'hermes'),
        env: { ...env, HERMES_HOME: profile },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000
    })
}

async function runWorker() {
    const { loadWorkerSettings, startWorkerStorage } = await import('../packages/harness/worker-storage.mjs')
    loadWorkerSettings()
    const close = await startWorkerStorage()
    try {
        const components = server('@cuttlely/components')
        const key = process.env.QA_CREDENTIAL
        const { flowiseNodeOptions } = await import('../packages/harness/offline-options.mjs')
        const opts = flowiseNodeOptions()
        const Node = createRequire(server.resolve('@cuttlely/components/nodes'))('./tools/MCP/PostgreSQL/PostgreSQLMCP').nodeClass
        const [tool] = await new Node().getTools({ credential: key, inputs: {} }, opts)
        const reply = await tool.invoke({ sql: 'SELECT 516 AS recovered LIMIT 1' })
        assert.match(String(reply), /"recovered"\s*:\s*516/)
        const [org, flow, chat] = JSON.parse(process.env.QA_SCOPE)
        const { stage, crash } = JSON.parse(process.env.QA_ACTION)
        if (stage === 'seed')
            await components.addSingleFileToStorage('text/plain', Buffer.from('verified input'), 'source.txt', org, flow, chat)
        assert.equal((await components.getFileFromStorage('source.txt', org, flow, chat)).toString(), 'verified input')
        if (crash) {
            const config = path.join(process.env.HERMES_HOME, 'profiles/research/config.yaml')
            fs.mkdirSync(path.dirname(config), { recursive: true })
            if (crash.managed) saveRuntimeSetting(process.env, 'worker', crash.edit)
            else fs.writeFileSync(config, crash.edit, { flush: true })
            assert.ok(runtimeMessage(process.env, true, crash.message, 'worker'), 'worker runtime acknowledged the message')
        }
        await new Promise((resolve, reject) => process.send({ verified: stage }, (err) => (err ? reject(err) : resolve())))
        if (crash) process.kill(process.pid, 'SIGKILL')
    } finally {
        await close()
    }
}

if (process.argv.includes('--fixture-worker')) {
    try {
        await runWorker()
    } catch (error) {
        process.stderr.write(String(error.stack) + '\n')
        process.exitCode = 1
    }
} else {
    const { createTestDatabase, skipReason } = await import('../packages/etl/check/pg-source.mjs')
    if (process.env.CUTTLELY_VERIFY_DISK_LOSS === '1' && skipReason) {
        throw new Error('Release verification requires the PostgreSQL disk-loss tests to run. ' + skipReason)
    }
    for (const initial of ['new-postgres', 'existing-postgres', 'sqlite', 'shell-post-cutover-crash', 'managed-post-cutover-crash'])
        test(initial + ' recovers on empty server and worker disks', { skip: skipReason }, async () => {
            const crash = initial.endsWith('post-cutover-crash')
            const managed = initial === 'managed-post-cutover-crash'
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
            const runtimeData = {
                '.env': 'FIXTURE=' + randomUUID(),
                'config.yaml': 'fixture: replacement',
                'profiles/research/.env': 'PROFILE_FIXTURE=' + randomUUID(),
                'profiles/research/config.yaml': 'fixture: before-cutover',
                'profiles/compiled/harness-roster.json': '{}',
                'profiles/research/memories/MEMORY.md': 'Existing research notes',
                'profiles/compiled/skills/harness-playbooks/report/SKILL.md': '# Report',
                'profiles/research/skills/.usage.json': '{"report":2}',
                'profiles/research/cache/spillover/result.txt': 'retained output',
                'cache/mcp_schema_cache.json': '{}'
            }
            function verifyRuntime(dir) {
                const home = dataEnv(dir, port).CUTTLELY_HERMES_HOME
                for (const [name, value] of Object.entries(runtimeData))
                    assert.ok(fs.readFileSync(path.join(home, name), 'utf8') === value, 'runtime file recovery: ' + name)
                assert.ok(fs.statSync(path.join(home, 'cache/scratch')).isDirectory())
            }
            const revised = 'REVISED_FIXTURE=' + randomUUID()
            const workerEdit = 'fixture: ' + randomUUID()
            const message = randomUUID()
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
            async function worker(dir, stage, crash) {
                fs.mkdirSync(dir, { recursive: true })
                const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--fixture-worker'], {
                    env: dataEnv(dir, port, {
                        ...pg,
                        ...host,
                        ...stores,
                        QA_ACTION: JSON.stringify({ stage, crash }),
                        QA_SCOPE: JSON.stringify([orgId, flowId, 'chat']),
                        QA_CREDENTIAL: credentialId
                    }),
                    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
                })
                let diagnostic = ''
                let verified = false
                child.on('message', (message) => {
                    if (message?.verified === stage) verified = true
                })
                child.stderr.on('data', (data) => {
                    diagnostic = (diagnostic + data).slice(-9000)
                })
                const [code, signal] = await once(child, 'close')
                assert.equal(
                    signal || code,
                    crash ? 'SIGKILL' : 0,
                    'worker ' +
                        stage +
                        ' failed: ' +
                        [sqlPassword, secret, password, c.password, auxiliary.connection.password]
                            .filter(Boolean)
                            .reduce((message, value) => message.replaceAll(value, '[redacted]'), diagnostic)
                )
                assert.ok(verified, 'worker exited before verifying its data')
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
                if (initial !== 'new-postgres') {
                    const home = dataEnv(first, port).CUTTLELY_HERMES_HOME
                    for (const [name, value] of Object.entries(runtimeData)) {
                        fs.mkdirSync(path.dirname(path.join(home, name)), { recursive: true })
                        fs.writeFileSync(path.join(home, name), value)
                    }
                    fs.mkdirSync(path.join(home, 'cache/scratch'), { recursive: true })
                }
                await boot(first, { ...pg, ...stores, ...operator })
                if ((await api('server-settings/storage')).phase === 'sqlite')
                    assert.equal((await api('server-settings/storage/upgrade', { availableBytes: 1e9 })).phase, 'postgres')
                const firstWorker = path.join(rootDir, 'worker-before')
                if (crash) {
                    if (managed) saveRuntimeSetting(dataEnv(first, port, { ...host, ...pg, ...stores }), 'web', revised)
                    else {
                        const edit = fs.openSync(path.join(dataEnv(first, port).HERMES_HOME, 'profiles/research/.env'), 'w')
                        try {
                            fs.writeFileSync(edit, revised)
                            fs.fsyncSync(edit)
                        } finally {
                            fs.closeSync(edit)
                        }
                    }
                    assert.equal(
                        runtimeMessage(dataEnv(first, port, { ...host, ...pg, ...stores }), true, message, 'web'),
                        true,
                        'runtime acknowledged and read back the message'
                    )
                    const exit = once(running.child, 'exit')
                    running.child.kill('SIGKILL')
                    await exit
                } else await running.stop()
                running = null
                fs.rmSync(first, { recursive: true })
                await worker(firstWorker, 'seed', crash ? { edit: workerEdit, message, managed } : undefined)
                fs.rmSync(firstWorker, { recursive: true })
                await boot(fresh, { ...pg, ...stores, ...operator })
                if (initial !== 'new-postgres') {
                    if (!crash) verifyRuntime(fresh)
                    const blobs = await client.query(`SELECT c.content FROM cuttlely_files.chunks c JOIN cuttlely_files.files f USING(id)
                        WHERE f.segments[1]='runtime-file-backup'`)
                    assert.ok(blobs.rows.length >= Object.keys(runtimeData).length)
                    assert.ok(blobs.rows.every(({ content }) => !content.includes(runtimeData['.env'])))
                }
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
                if (managed) {
                    assert.match(
                        fs.readFileSync(path.join(dataEnv(fresh, port).HERMES_HOME, 'profiles/research/memories/USER.md'), 'utf8'),
                        /Remember the replacement check/
                    )
                    // A stale cache on another host must read the first writer's commit and retain it on append.
                    const peer = path.join(rootDir, 'concurrent-worker')
                    await worker(peer, 'recover')
                    const envFor = (dir) => dataEnv(dir, port, { ...host, ...pg, ...stores })
                    const python = process.env.HERMES_PYTHON || path.join(root, 'hermes', '.venv', 'bin', 'python')
                    const run = async (dir, statement) => {
                        const { stdout } = await promisify(execFile)(
                            python,
                            [
                                '-c',
                                `
import os
from pathlib import Path
from hermes_state import SessionDB
db = SessionDB(Path(os.environ["HERMES_HOME"]) / "profiles" / "research" / "state.db")
` + statement
                            ],
                            { cwd: path.join(root, 'hermes'), env: envFor(dir), timeout: 30000 }
                        )
                        return stdout.trim()
                    }
                    const session = "'recovery-fixture-web'"
                    await run(peer, 'assert db.get_messages(' + session + '); db.append_message(' + session + ', "assistant", "peer")')
                    assert.equal(await run(fresh, 'print(db.get_messages(' + session + ')[-1]["content"])'), 'peer')
                    // Force the durable write to fail after SQLite has executed the callback.
                    await run(
                        peer,
                        `from gateway.config import GatewayConfig
from gateway.session import SessionStore
from cuttlely_session_store import connect
from contextlib import closing
store = SessionStore(Path(db.db_path).parent / "sessions", GatewayConfig())
store._db = db
with closing(connect()) as pg:
    pg.run("ALTER TABLE cuttlely_runtime.session_heads ADD CONSTRAINT unavailable CHECK (false) NOT VALID")
    try:
        try:
            store.append_to_transcript(${session}, {"role": "assistant", "content": "unacknowledged"})
        except RuntimeError as error:
            assert "did not acknowledge" in str(error)
        else:
            raise AssertionError("gateway acknowledged a refused PostgreSQL commit")
        assert not store._dirty_transcripts
    finally:
        pg.run("ALTER TABLE cuttlely_runtime.session_heads DROP CONSTRAINT unavailable")`
                    )
                    assert.equal(await run(fresh, 'print(db.get_messages(' + session + ')[-1]["content"])'), 'peer')
                    await Promise.all(
                        [peer, fresh].map((hostDir, index) =>
                            run(hostDir, `db.append_message(${session}, "assistant", "parallel-${index}")`)
                        )
                    )
                    assert.equal(
                        await run(
                            fresh,
                            `print(sorted(row["content"] for row in db.get_messages(${session}) if row["content"].startswith("parallel-")))`
                        ),
                        "['parallel-0', 'parallel-1']"
                    )
                    await client.query(
                        "ALTER TABLE cuttlely_runtime.runtime_settings ADD CONSTRAINT setting_unavailable CHECK (scope <> 'profiles/research/.env') NOT VALID"
                    )
                    try {
                        assert.throws(() => saveRuntimeSetting(envFor(peer), 'web', 'REVISED_FIXTURE=refused'))
                    } finally {
                        await client.query('ALTER TABLE cuttlely_runtime.runtime_settings DROP CONSTRAINT setting_unavailable')
                    }
                    const peerEnv = fs.readFileSync(path.join(envFor(peer).CUTTLELY_HERMES_HOME, 'profiles/research/.env'), 'utf8')
                    assert.ok(peerEnv.split(/\r?\n/).includes(revised), 'a refused settings save must preserve the prior file')
                }
                await worker(path.join(rootDir, 'worker-after'), 'recover')
                if (initial === 'existing-postgres' || initial === 'sqlite') verifyRuntime(path.join(rootDir, 'worker-after'))
                if (crash) {
                    const freshWorker = path.join(rootDir, 'worker-after')
                    // Managed saves supersede the verified upgrade copy. A direct shell write
                    // changes only the disposable host, so recover the last committed setting.
                    const saved = (dir, name, edited) => {
                        const scope = 'profiles/research/' + name
                        const file = path.join(dataEnv(dir, port).HERMES_HOME, scope)
                        const expected = managed ? edited : runtimeData[scope]
                        return fs.readFileSync(file, 'utf8').split(/\r?\n/).includes(expected)
                    }
                    assert.deepEqual(
                        {
                            webSetting: saved(fresh, '.env', revised),
                            webMessage: runtimeMessage(dataEnv(fresh, port, { ...host, ...pg, ...stores }), false, message, 'web'),
                            workerSetting: saved(freshWorker, 'config.yaml', workerEdit),
                            workerMessage: runtimeMessage(
                                dataEnv(freshWorker, port, { ...host, ...pg, ...stores }),
                                false,
                                message,
                                'worker'
                            )
                        },
                        { webSetting: true, webMessage: true, workerSetting: true, workerMessage: true },
                        'restore the last committed settings and acknowledged messages after all host disks are lost'
                    )
                }
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
}
