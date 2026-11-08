// Real CLI functions, App.config, SQL sessions/RBAC, two organizations and disposable SQLite.
// No model calls, live accounts, external database, process restart or deployment changes.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createRequire } = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const serverRequire = createRequire(path.join(__dirname, '../packages/server/package.json'))
serverRequire('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
        module: 'commonjs',
        target: 'ES2022',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true
    }
})
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-breakglass-'))
for (const name of ['CUTTLELY_INSTANCE_OPERATOR', 'INBOUND_ACCESS_V2', 'CUTTLELY_SETTINGS_HOST_KEYS', 'CUTTLELY_IGNORE_ADMIN_SETTINGS'])
    delete process.env[name]
Object.assign(process.env, {
    CUTTLELY_DATA_DIR: root,
    LOG_PATH: path.join(root, 'logs'),
    BLOB_STORAGE_PATH: path.join(root, 'blobs'),
    CUTTLELY_HERMES_HOME: path.join(root, 'runtime'),
    FLOWISE_SECRETKEY_OVERWRITE: 'fixture-breakglass-pepper',
    CUTTLELY_LOCAL_ADMIN: 'true',
    CUTTLELY_LOCAL_USERS: 'true',
    CUTTLELY_VERSIONS: 'false',
    CUTTLELY_DASH_FLOWS: 'false'
})
const { DataSource } = serverRequire('typeorm')
const { entities } = serverRequire('./src/database/entities/index.ts')
const { sqliteMigrations } = serverRequire('./src/database/migrations/sqlite/index.ts')
const { runUserCommand } = serverRequire('./src/identity/cli.ts')
const { OPERATOR_BINDING_FILE } = serverRequire('./src/identity/operatorBinding.ts')
const { operatorDatabaseFingerprint } = serverRequire('./src/identity/instanceOperator.ts')
const { applyAdminSettings } = serverRequire('./src/settings/apply.ts')
const { setServerSettingsDeps } = serverRequire('./src/routes/server-settings/index.ts')
const { readHistory } = serverRequire('./src/settings/history.ts')
const request = serverRequire('supertest')
const file = path.join(root, 'settings', OPERATOR_BINDING_FILE)
const password = 'F1xture-Password!'

test('host break-glass provisioning and default operator authority', async (t) => {
    const data = new DataSource({
        type: 'sqlite',
        database: path.join(root, 'identity.sqlite'),
        entities: Object.values(entities),
        migrations: sqliteMigrations
    })
    let app, ownerId, cookies, binding
    const cli = (input) => runUserCommand(data, input)
    const view = (cookie = cookies.owner) => request(app.app).get('/api/v1/server-settings').set('Cookie', cookie)
    const put = (values, cookie = cookies.owner) =>
        request(app.app).put('/api/v1/server-settings').set('x-request-from', 'internal').set('Cookie', cookie).send({ values })
    try {
        await data.initialize()
        await data.runMigrations()
        serverRequire('./src/DataSource.ts').getDataSource = () => data
        await t.test('CLI first owner creates a private host binding before real App.config', async () => {
            const result = await cli({ email: 'owner@example.invalid', password, localAdmin: true })
            assert.equal(result.ok, true, result.lines.join('\n'))
            ownerId = result.operatorUserId
            binding = fs.readFileSync(file, 'utf8')
            const parsed = JSON.parse(binding)
            assert.deepEqual(Object.keys(parsed).sort(), ['createdAt', 'database', 'userId', 'version'])
            assert.equal(parsed.userId, ownerId)
            assert.equal(parsed.database, operatorDatabaseFingerprint(data.options))
            assert.equal(parsed.version, 1)
            assert.ok(Number.isFinite(Date.parse(parsed.createdAt)))
            assert.equal(fs.statSync(file).mode & 0o777, 0o600)
        })
        // Explicitly create another active owner in a separate organization, and a workspace admin.
        const { User, Organization, Workspace, Role, OrganizationUser, WorkspaceUser } = entities
        for (const id of ['other', 'admin']) {
            await data
                .getRepository(User)
                .save({ id, name: 'Fixture', email: id + '@example.invalid', status: 'active', createdBy: id, updatedBy: id })
            await data.getRepository(Organization).save({ id: 'org-' + id, name: 'Fixture', createdBy: id, updatedBy: id })
            await data
                .getRepository(Workspace)
                .save({ id: 'team-' + id, organizationId: 'org-' + id, name: 'Fixture', createdBy: id, updatedBy: id })
            await data.getRepository(Role).save({ id: 'role-' + id, name: id === 'other' ? 'owner' : 'admin', permissions: '["*"]' })
            await data
                .getRepository(OrganizationUser)
                .save({ organizationId: 'org-' + id, userId: id, roleId: 'role-' + id, status: 'active', createdBy: id, updatedBy: id })
            await data
                .getRepository(WorkspaceUser)
                .save({ workspaceId: 'team-' + id, userId: id, roleId: 'role-' + id, status: 'active', createdBy: id, updatedBy: id })
        }
        const production = serverRequire('./src/identity/production.ts')
        await production.applyAuthKitSwitchOnBoot(data)
        const ctx = await production.buildAuthContext({ cookies: {}, headers: {}, query: {}, protocol: 'http' })
        const { issueApplicationSession } = serverRequire('./src/identity/handlers.ts')
        cookies = {}
        for (const [name, id] of [
            ['owner', ownerId],
            ['other', 'other'],
            ['admin', 'admin']
        ]) {
            const session = await issueApplicationSession(ctx, id, 'local')
            assert.ok(session)
            cookies[name] = 'cuttlely-local-session=' + session.token
        }
        const { App } = serverRequire('./src/index.ts')
        const state = applyAdminSettings(process.env)
        setServerSettingsDeps(() => ({ env: process.env, state, key: async () => process.env.FLOWISE_SECRETKEY_OVERWRITE }))
        app = new App()
        app.AppDataSource = data
        app.identityManager = { getPlatformType: () => 'open_source' }
        app.sseStreamer = new (serverRequire('./src/utils/SSEStreamer.ts').SSEStreamer)()
        serverRequire('./src/utils/getRunningExpressApp.ts').getRunningExpressApp = () => app
        await app.config()
        await t.test('bound first owner configures by default; other owner, admin and anonymous gain nothing', async () => {
            assert.equal((await view()).body.instanceOperator, true)
            assert.equal((await put({ LOG_LEVEL: 'info' })).status, 200)
            for (const cookie of [cookies.other, cookies.admin]) {
                const response = await view(cookie)
                if (cookie === cookies.other) assert.equal(response.body.instanceOperator, false)
                else assert.equal(response.status, 403)
                assert.equal((await put({ LOG_LEVEL: 'info' }, cookie)).status, 403)
            }
            assert.equal(
                (
                    await request(app.app)
                        .put('/api/v1/server-settings')
                        .set('x-request-from', 'internal')
                        .send({ values: { LOG_LEVEL: 'info' } })
                ).status,
                401
            )
        })
        await t.test('CLI reset records the default operator and a rejected credential never writes a binding', async () => {
            fs.rmSync(file)
            assert.equal((await view()).body.instanceOperator, false, 'upgrade or removed file never infers an owner')
            const result = await cli({ email: 'owner@example.invalid', password: 'New-Fixture9!', localAdmin: false })
            assert.equal(result.ok, true, result.lines.join('\n'))
            assert.equal((await view()).body.instanceOperator, true)
            binding = fs.readFileSync(file, 'utf8')
            assert.equal((await cli({ email: 'owner@example.invalid', password: 'bad', localAdmin: false })).ok, false)
            assert.equal(fs.readFileSync(file, 'utf8'), binding)
            const store = serverRequire('./src/identity/sqlStore.ts').SqlIdentityStore.prototype
            const original = store.setCredential
            store.setCredential = async () => {
                throw new Error('fixture credential write failed')
            }
            try {
                await assert.rejects(cli({ email: 'owner@example.invalid', password, localAdmin: false }))
            } finally {
                store.setCredential = original
            }
            assert.equal(fs.readFileSync(file, 'utf8'), binding)
        })
        await t.test('explicit bind uses CLI acceptance and active ownership without resetting a password', async () => {
            const before = (await data.query('SELECT credential FROM user WHERE id = ?', [ownerId]))[0].credential
            fs.rmSync(file)
            assert.equal((await cli({ email: 'other@example.invalid', bindOperator: true, localAdmin: false })).ok, false)
            assert.equal(fs.existsSync(file), false, 'no oldest-owner auto-bind')
            assert.equal((await cli({ email: 'admin@example.invalid', bindOperator: true, localAdmin: true })).ok, false)
            assert.equal((await cli({ bindOperator: true, localAdmin: true })).ok, false)
            assert.equal((await cli({ email: 'owner@example.invalid', bindOperator: true, password, localAdmin: true })).ok, false)
            const result = await cli({ email: 'owner@example.invalid', bindOperator: true, localAdmin: false })
            assert.equal(result.ok, true, result.lines.join('\n'))
            assert.equal((await data.query('SELECT credential FROM user WHERE id = ?', [ownerId]))[0].credential, before)
            assert.equal((await view()).body.instanceOperator, true)
            binding = fs.readFileSync(file, 'utf8')
        })
        await t.test('local-admin non-owner password reset retains its semantics without acquiring file authority', async () => {
            const result = await cli({ email: 'admin@example.invalid', password, localAdmin: true })
            assert.equal(result.ok, true)
            assert.equal(result.operatorUserId, undefined)
            assert.equal(fs.readFileSync(file, 'utf8'), binding)
            assert.equal((await view()).body.instanceOperator, true)
            assert.equal((await put({ LOG_LEVEL: 'info' }, cookies.admin)).status, 403)
        })
        await t.test('explicit env override wins and none revokes without falling back to the file', async () => {
            process.env.CUTTLELY_INSTANCE_OPERATOR = JSON.stringify({
                userId: 'other',
                database: operatorDatabaseFingerprint(data.options)
            })
            assert.equal((await view()).body.instanceOperator, false)
            assert.equal((await view(cookies.other)).body.instanceOperator, true)
            fs.writeFileSync(file, '{corrupt-file')
            assert.equal((await view(cookies.other)).body.instanceOperator, true, 'valid host override ignores an invalid file')
            fs.writeFileSync(file, binding)
            process.env.CUTTLELY_INSTANCE_OPERATOR = 'none'
            for (const cookie of [cookies.owner, cookies.other]) assert.equal((await put({ LOG_LEVEL: 'info' }, cookie)).status, 403)
            process.env.CUTTLELY_INSTANCE_OPERATOR = ''
            assert.equal((await view()).body.instanceOperator, false, 'empty explicit override fails closed too')
            delete process.env.CUTTLELY_INSTANCE_OPERATOR
            assert.equal((await view()).body.instanceOperator, true)
        })
        await t.test('bad JSON, version, fields, date, permissions, symlinks and fingerprint fail closed', async () => {
            const valid = JSON.parse(binding)
            for (const raw of [
                '{',
                'null',
                '[]',
                JSON.stringify({ ...valid, version: 2 }),
                JSON.stringify({ ...valid, extra: true }),
                JSON.stringify({ ...valid, userId: '' }),
                JSON.stringify({ ...valid, createdAt: 'invalid' }),
                JSON.stringify({ ...valid, database: '0'.repeat(64) })
            ]) {
                fs.writeFileSync(file, raw, { mode: 0o600 })
                assert.equal((await view()).body.instanceOperator, false)
                assert.equal((await put({ LOG_LEVEL: 'info' })).status, 403)
            }
            fs.writeFileSync(file, binding)
            fs.chmodSync(file, 0o644)
            assert.equal((await view()).body.instanceOperator, false)
            fs.chmodSync(file, 0o600)
            const target = path.join(root, 'fixture-symlink.json')
            fs.renameSync(file, target)
            fs.symlinkSync(target, file)
            assert.equal((await view()).body.instanceOperator, false)
            fs.unlinkSync(file)
            fs.renameSync(target, file)
            assert.equal((await view()).body.instanceOperator, true)
        })
        await t.test('active user and owner membership are rechecked on every request', async () => {
            await data.query('UPDATE organization_user SET status = ? WHERE userId = ?', ['disable', ownerId])
            try {
                assert.ok([401, 403].includes((await put({ LOG_LEVEL: 'info' })).status))
                assert.equal((await cli({ email: 'owner@example.invalid', bindOperator: true, localAdmin: true })).ok, false)
            } finally {
                await data.query('UPDATE organization_user SET status = ? WHERE userId = ?', ['active', ownerId])
            }
            const session = await issueApplicationSession(ctx, ownerId, 'local')
            cookies.owner = 'cuttlely-local-session=' + session.token
            assert.equal((await view()).body.instanceOperator, true)
        })
        await t.test('copied identity DB with the same userId and valid session cannot inherit the file binding', async () => {
            const foreignPath = path.join(root, 'copied.sqlite')
            await data.query('PRAGMA wal_checkpoint(TRUNCATE)')
            fs.copyFileSync(data.options.database, foreignPath)
            const foreign = new DataSource({ ...data.options, database: foreignPath })
            await foreign.initialize()
            serverRequire('./src/DataSource.ts').getDataSource = () => foreign
            app.AppDataSource = foreign
            try {
                const response = await view()
                assert.equal(response.status, 200, 'copied real session remains valid')
                assert.equal(response.body.instanceOperator, false)
                assert.equal((await put({ LOG_LEVEL: 'info' })).status, 403)
            } finally {
                serverRequire('./src/DataSource.ts').getDataSource = () => data
                app.AppDataSource = data
                await foreign.destroy()
            }
        })
        await t.test('settings PUT and restore cannot create, change or restore the host file', async () => {
            for (const key of ['CUTTLELY_INSTANCE_OPERATOR', OPERATOR_BINDING_FILE, 'operatorUserId'])
                assert.equal((await put({ [key]: binding })).status, 400)
            assert.equal(fs.readFileSync(file, 'utf8'), binding)
            const poisoned = JSON.stringify({
                version: 1,
                values: {
                    CUTTLELY_INSTANCE_OPERATOR: JSON.stringify(JSON.parse(binding)),
                    [OPERATOR_BINDING_FILE]: binding,
                    LOG_LEVEL: 'info'
                }
            })
            fs.writeFileSync(path.join(root, 'settings', 'server.last-good.json'), poisoned)
            fs.writeFileSync(path.join(root, 'settings', 'server.rolled-back.json'), poisoned)
            assert.equal(
                (
                    await request(app.app)
                        .post('/api/v1/server-settings/retry')
                        .set('x-request-from', 'internal')
                        .set('Cookie', cookies.owner)
                        .send({})
                ).status,
                200
            )
            const { runSettingsCli } = serverRequire('./src/settings/cli.ts')
            assert.equal(runSettingsCli(['restore']).code, 0)
            assert.equal(fs.readFileSync(file, 'utf8'), binding)
            fs.rmSync(file)
            applyAdminSettings(process.env)
            assert.equal(runSettingsCli(['restore']).code, 0)
            assert.equal(fs.existsSync(file), false)
            assert.equal((await view()).body.instanceOperator, false)
            fs.writeFileSync(file, binding, { mode: 0o600 })
        })
        await t.test('failed first-owner binding reports completed creation and recovers without another password change', async () => {
            const install = path.join(root, 'failed-create')
            const env = { CUTTLELY_DATA_DIR: install }
            const first = new DataSource({ ...data.options, database: path.join(root, 'failed-create.sqlite') })
            const history = path.join(install, 'settings', 'history.jsonl')
            const hostFile = path.join(install, 'settings', OPERATOR_BINDING_FILE)
            await first.initialize()
            try {
                await first.runMigrations()
                fs.mkdirSync(history, { recursive: true })
                const result = await runUserCommand(first, { email: 'first@example.invalid', password, localAdmin: true }, env)
                assert.equal(result.ok, false)
                assert.match(result.lines.join('\n'), /Super User created/)
                assert.match(result.lines.join('\n'), /already completed/)
                assert.equal((await first.query('SELECT id FROM user')).length, 1)
                assert.equal(fs.existsSync(hostFile), false, 'new authority removed after audit failure')
                const before = (await first.query('SELECT credential FROM user'))[0].credential
                fs.rmdirSync(history)
                const recover = await runUserCommand(first, { email: 'first@example.invalid', bindOperator: true, localAdmin: true }, env)
                assert.equal(recover.ok, true, recover.lines.join('\n'))
                assert.equal((await first.query('SELECT credential FROM user'))[0].credential, before)
                assert.equal(JSON.parse(fs.readFileSync(hostFile, 'utf8')).database, operatorDatabaseFingerprint(first.options))
            } finally {
                await first.destroy()
            }
        })
        await t.test('binding/audit failure is nonzero with explicit credential status and bind-only recovery', async () => {
            const history = path.join(root, 'settings', 'history.jsonl')
            const historyBefore = fs.readFileSync(history, 'utf8')
            fs.rmSync(history)
            fs.mkdirSync(history)
            try {
                const result = await cli({ email: 'owner@example.invalid', password, localAdmin: false })
                assert.equal(result.ok, false)
                assert.match(result.lines.join('\n'), /Password updated/)
                assert.match(result.lines.join('\n'), /already completed/)
                assert.match(result.lines.join('\n'), /--bind-operator/)
                assert.equal(fs.readFileSync(file, 'utf8'), binding, 'audit failure restores exact previous binding')
            } finally {
                fs.rmdirSync(history)
                fs.writeFileSync(history, historyBefore)
            }
            const result = await cli({ email: 'owner@example.invalid', bindOperator: true, localAdmin: false })
            assert.equal(result.ok, true, result.lines.join('\n'))
            const audit = readHistory(path.join(root, 'settings'))
            assert.ok(audit.some((e) => e.event === 'instance_operator_binding' && e.by === 'command line'))
            const raw = fs.readFileSync(history, 'utf8')
            for (const sensitive of [password, JSON.parse(binding).database, cookies.owner]) assert.ok(!raw.includes(sensitive))
        })
    } finally {
        if (app)
            for (const handle of ['compactorTimer', 'itWorkedCleanupTimer', 'auditCleanupTimer'])
                if (app[handle]) clearInterval(app[handle])
        if (data.isInitialized) await data.destroy()
        fs.rmSync(root, { recursive: true, force: true })
    }
})
