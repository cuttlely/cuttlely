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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-panelclaim-'))
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

test('panel host-proof operator lifecycle using actual App.config', async (t) => {
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
            assert.equal(parsed.state, 'Active')
            assert.equal(parsed.userId, ownerId)
            assert.equal(parsed.database, operatorDatabaseFingerprint(data.options))
            assert.equal(parsed.version, 2)
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
        const logger = serverRequire('./src/utils/logger.ts').default
        const originalInfo = logger.info
        const codes = []
        logger.info = function (message, ...args) {
            if (typeof message === 'string' && message.startsWith('[instance operator] Panel designation proof')) {
                codes.push(message.slice(message.lastIndexOf(': ') + 2))
                return
            }
            return originalInfo.call(this, message, ...args)
        }
        const post = (action, body = {}, cookie = cookies.owner) =>
            request(app.app)
                .post('/api/v1/server-settings/operator/' + action)
                .set('x-request-from', 'internal')
                .set('Cookie', cookie)
                .send(body)
        const status = (cookie = cookies.owner) => request(app.app).get('/api/v1/server-settings/operator').set('Cookie', cookie)
        const proofFile = path.join(root, 'settings', 'operator-claim.json')
        const resetProofBudget = () => fs.rmSync(proofFile, { force: true })
        const requestCode = async (purpose = 'claim', cookie = cookies.owner) => {
            const before = codes.length
            const res = await post('request', { purpose, confirm: purpose.toUpperCase() }, cookie)
            assert.equal(res.status, 200, JSON.stringify(res.body))
            assert.equal(codes.length, before + 1)
            assert.ok(!JSON.stringify(res.body).includes(codes.at(-1)))
            assert.ok(!fs.readFileSync(proofFile, 'utf8').includes(codes.at(-1)))
            return codes.at(-1)
        }
        const redeem = (code, purpose = 'claim', cookie = cookies.owner) => post(purpose, { code, confirm: purpose.toUpperCase() }, cookie)
        try {
            fs.rmSync(file)
            await t.test('Unclaimed does not inherit authority; wrong, unrelated-session/user codes do not consume proof', async () => {
                assert.equal((await view()).body.instanceOperator, false)
                assert.equal((await status()).body.state, 'Unclaimed')
                const code = await requestCode()
                const session = await issueApplicationSession(ctx, ownerId, 'local')
                cookies.unrelated = 'cuttlely-local-session=' + session.token
                assert.equal((await redeem('wrong')).status, 403)
                assert.equal((await redeem(code, 'claim', cookies.unrelated)).status, 403)
                assert.equal((await redeem(code, 'claim', cookies.other)).status, 403)
                assert.equal((await redeem(code)).status, 200)
                assert.equal((await view()).body.instanceOperator, true)
                assert.equal((await view(cookies.other)).body.instanceOperator, false)
                assert.equal((await redeem(code)).status, 403)
                const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
                assert.equal(saved.source, 'admin panel')
                assert.equal(saved.audit.purpose, 'claim')
                assert.equal(fs.statSync(file).mode & 0o777, 0o600)
                for (const response of [await status(), await view()]) assert.ok(!JSON.stringify(response.body).includes(code))
            })
            await t.test('explicit env none/JSON/empty/invalid blocks every proof and lifecycle mutation', async () => {
                const before = fs.readFileSync(file, 'utf8')
                for (const value of [
                    'none',
                    '',
                    'invalid',
                    JSON.stringify({ userId: ownerId, database: operatorDatabaseFingerprint(data.options) })
                ]) {
                    process.env.CUTTLELY_INSTANCE_OPERATOR = value
                    for (const action of ['request', 'claim', 'recover', 'rebind', 'transfer', 'revoke'])
                        assert.equal((await post(action, { purpose: 'claim', confirm: 'CLAIM', code: 'wrong' })).status, 403)
                    assert.equal(fs.readFileSync(file, 'utf8'), before)
                }
                delete process.env.CUTTLELY_INSTANCE_OPERATOR
            })
            await t.test(
                'other organization cannot see management or transfer/revoke; only active same-org owner is eligible',
                async () => {
                    assert.equal((await status(cookies.other)).body.operator, undefined)
                    assert.equal((await post('revoke', { confirm: 'REVOKE' }, cookies.other)).status, 403)
                    assert.equal((await post('transfer', { confirm: 'TRANSFER', userId: 'other' })).status, 403)
                    const owner = await data.getRepository(User).findOneByOrFail({ id: ownerId })
                    const membership = await data.getRepository(OrganizationUser).findOneByOrFail({ userId: ownerId })
                    const team = await data.getRepository(WorkspaceUser).findOneByOrFail({ userId: ownerId })
                    await data.getRepository(User).save({
                        id: 'successor',
                        name: 'Fixture',
                        email: 'successor@example.invalid',
                        status: 'active',
                        createdBy: ownerId,
                        updatedBy: ownerId
                    })
                    await data.getRepository(OrganizationUser).save({ ...membership, id: undefined, userId: 'successor' })
                    await data.getRepository(WorkspaceUser).save({ ...team, id: undefined, userId: 'successor' })
                    const session = await issueApplicationSession(ctx, 'successor', 'local')
                    cookies.successor = 'cuttlely-local-session=' + session.token
                    assert.equal((await post('transfer', { userId: 'successor' })).status, 400)
                    assert.equal((await post('transfer', { confirm: 'TRANSFER', userId: 'successor' })).status, 200)
                    assert.equal((await view()).body.instanceOperator, false)
                    assert.equal((await view(cookies.successor)).body.instanceOperator, true)
                    assert.equal((await post('transfer', { confirm: 'TRANSFER', userId: owner.id }, cookies.successor)).status, 200)
                }
            )
            await t.test(
                'revoke persists Disabled tombstone, denies ordinary claim, and requires distinct host-proven recovery',
                async () => {
                    assert.equal((await post('revoke', { confirm: 'REVOKE' })).status, 200)
                    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).state, 'Disabled')
                    assert.equal((await view()).body.instanceOperator, false)
                    assert.equal((await status()).body.state, 'Disabled')
                    assert.equal((await post('request', { purpose: 'claim', confirm: 'CLAIM' })).status, 403)
                    resetProofBudget()
                    const code = await requestCode('recover')
                    assert.equal((await redeem(code, 'claim')).status, 403)
                    assert.equal((await redeem(code, 'recover')).status, 200)
                }
            )
            await t.test('invalid file is RecoveryRequired and unchanged until explicit recovery proof', async () => {
                fs.writeFileSync(file, '{invalid', { mode: 0o600 })
                assert.equal((await status()).body.state, 'RecoveryRequired')
                assert.equal((await redeem('wrong')).status, 403)
                assert.equal(fs.readFileSync(file, 'utf8'), '{invalid')
                resetProofBudget()
                const code = await requestCode('recover')
                assert.equal(fs.readFileSync(file, 'utf8'), '{invalid')
                assert.equal((await redeem('wrong', 'recover')).status, 403)
                assert.equal((await redeem(code, 'recover')).status, 200)
            })
            await t.test('wrong DB needs a fresh rebind purpose proof; only the previously bound owner can rebind', async () => {
                const original = data.options.database
                data.options.database = path.join(root, 'different.sqlite')
                try {
                    assert.equal((await view()).body.instanceOperator, false)
                    assert.equal((await status()).body.state, 'RecoveryRequired')
                    assert.equal((await status(cookies.other)).body.proofPurpose, null)
                    assert.equal((await post('request', { purpose: 'claim', confirm: 'CLAIM' })).status, 403)
                    assert.equal((await redeem(codes[0], 'rebind')).status, 403)
                    resetProofBudget()
                    const code = await requestCode('rebind')
                    assert.equal((await redeem(code, 'recover')).status, 403)
                    assert.equal((await redeem(code, 'rebind')).status, 200)
                    assert.equal((await view()).body.instanceOperator, true)
                } finally {
                    data.options.database = original
                }
                resetProofBudget()
                const code = await requestCode('rebind')
                assert.equal((await redeem(code, 'rebind')).status, 200)
            })
            await t.test('expired proof rejected; request cooldown and wrong-attempt budgets do not invalidate correct proof', async () => {
                fs.rmSync(file)
                resetProofBudget()
                let code = await requestCode()
                const clock = Date.now
                const now = clock()
                Date.now = () => now + 5 * 60 * 1000 + 1
                try {
                    assert.equal((await redeem(code)).status, 403)
                } finally {
                    Date.now = clock
                }
                resetProofBudget()
                code = await requestCode()
                const before = codes.length
                for (let i = 0; i < 6; i++)
                    assert.equal((await post('request', { purpose: 'claim', confirm: 'CLAIM' }, cookies.other)).status, 429)
                assert.equal(codes.length, before)
                for (let i = 0; i < 5; i++) assert.equal((await redeem('wrong', 'claim', cookies.other)).status, 403)
                assert.equal((await redeem('wrong', 'claim', cookies.other)).status, 429)
                assert.equal((await redeem(code)).status, 200)
            })
            await t.test('concurrent double claim has exactly one winner; old proof cannot cross host recovery generation', async () => {
                fs.rmSync(file)
                resetProofBudget()
                const code = await requestCode()
                const results = await Promise.all([redeem(code), redeem(code)])
                assert.deepEqual(results.map((r) => r.status).sort(), [200, 403])
                fs.rmSync(file)
                resetProofBudget()
                const stale = await requestCode()
                assert.equal((await cli({ email: 'owner@example.invalid', bindOperator: true, localAdmin: true })).ok, true)
                assert.equal((await redeem(stale)).status, 403)
            })
            await t.test('audit failure restores exact prior binding for transfer and revoke and missing state for claim', async () => {
                const history = path.join(root, 'settings', 'history.jsonl')
                const raw = fs.readFileSync(history, 'utf8'),
                    authority = fs.readFileSync(file, 'utf8')
                fs.rmSync(history)
                fs.mkdirSync(history)
                try {
                    for (const [action, payload] of [
                        ['transfer', { confirm: 'TRANSFER', userId: 'successor' }],
                        ['revoke', { confirm: 'REVOKE' }]
                    ]) {
                        assert.equal((await post(action, payload)).status, 500)
                        assert.equal(fs.readFileSync(file, 'utf8'), authority)
                    }
                    fs.rmSync(file)
                    resetProofBudget()
                    const code = await requestCode()
                    assert.equal((await redeem(code)).status, 500)
                    assert.equal(fs.existsSync(file), false)
                    assert.equal((await redeem(code)).status, 403)
                } finally {
                    fs.rmdirSync(history)
                    fs.writeFileSync(history, raw)
                }
            })
            await t.test('request budgets survive reloads and bound host-log issuance globally and per user', async () => {
                fs.rmSync(file, { force: true })
                resetProofBudget()
                const clock = Date.now,
                    base = clock()
                let elapsed = 0
                Date.now = () => base + elapsed
                const before = codes.length
                try {
                    for (let i = 0; i < 4; i++) {
                        const name = i < 2 ? 'owner' : 'successor'
                        const id = name === 'owner' ? ownerId : 'successor'
                        const session = await issueApplicationSession({ ...ctx, now: Date.now() }, id, 'local')
                        cookies[name] = 'cuttlely-local-session=' + session.token
                        await data.query('UPDATE identity_local_session SET createdDate = ? WHERE token = ?', [
                            new Date(Date.now()).toISOString(),
                            session.tokenHash
                        ])
                        await requestCode('claim', cookies[name])
                        const pending = await status(cookies[name])
                        assert.equal(pending.body.proofPending, true)
                        elapsed += 5 * 60 * 1000 + 1
                        const next = await issueApplicationSession({ ...ctx, now: Date.now() }, id, 'local')
                        cookies[name] = 'cuttlely-local-session=' + next.token
                        await data.query('UPDATE identity_local_session SET createdDate = ? WHERE token = ?', [
                            new Date(Date.now()).toISOString(),
                            next.tokenHash
                        ])
                        if (i === 1) {
                            const blocked = await post('request', { purpose: 'claim', confirm: 'CLAIM' }, cookies.owner)
                            assert.equal(blocked.status, 429, JSON.stringify(blocked.body))
                        }
                    }
                    const fresh = await issueApplicationSession({ ...ctx, now: Date.now() }, 'other', 'local')
                    cookies.other = 'cuttlely-local-session=' + fresh.token
                    await data.query('UPDATE identity_local_session SET createdDate = ? WHERE token = ?', [
                        new Date(Date.now()).toISOString(),
                        fresh.tokenHash
                    ])
                    assert.equal((await post('request', { purpose: 'claim', confirm: 'CLAIM' }, cookies.other)).status, 429)
                    assert.equal(codes.length, before + 4)
                } finally {
                    Date.now = clock
                }
                // Return to real time with real-time sessions; fixture budgets reset only between independent cases.
                for (const [name, id] of [
                    ['owner', ownerId],
                    ['other', 'other'],
                    ['successor', 'successor']
                ]) {
                    const session = await issueApplicationSession({ ...ctx, now: clock() }, id, 'local')
                    cookies[name] = 'cuttlely-local-session=' + session.token
                }
            })
            await t.test('unsafe files cannot issue or redeem proof; API logs never expose host-delivery codes', async () => {
                fs.writeFileSync(file, '{invalid', { mode: 0o600 })
                fs.chmodSync(file, 0o644)
                resetProofBudget()
                try {
                    assert.equal((await status()).body.proofPurpose, null)
                    assert.notEqual((await post('request', { purpose: 'recover', confirm: 'RECOVER' })).status, 200)
                    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid')
                } finally {
                    fs.chmodSync(file, 0o600)
                    fs.rmSync(file)
                }
                const code = await requestCode()
                const now = new Date(),
                    pad = (n) => String(n).padStart(2, '0')
                const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}`
                fs.mkdirSync(process.env.LOG_PATH, { recursive: true })
                fs.appendFileSync(
                    path.join(process.env.LOG_PATH, 'server.log.' + stamp),
                    `${stamp.slice(0, 10)} ${pad(
                        now.getHours()
                    )}:00:00 [INFO]: [instance operator] Panel designation proof (expires in 5 minutes; use in the requesting session): ${code}\n`
                )
                const response = await request(app.app)
                    .get('/api/v1/logs')
                    .set('Cookie', cookies.other)
                    .query({ startDate: stamp, endDate: stamp })
                assert.equal(response.status, 200)
                assert.ok(!JSON.stringify(response.body).includes(code))
                assert.equal(
                    (await post('claim', { confirm: 'CLAIM', code }).set('Origin', 'https://unrelated.example.invalid')).status,
                    403
                )
                assert.equal((await redeem(code)).status, 200)
            })
            await t.test('recent authentication is required even for a live active owner session', async () => {
                const clock = Date.now,
                    now = clock()
                Date.now = () => now + 11 * 60 * 1000
                try {
                    assert.equal((await post('request', { purpose: 'claim', confirm: 'CLAIM' })).body.code, 'RECENT_AUTH_REQUIRED')
                    assert.equal((await put({ INBOUND_ACCESS_V2: 'on' })).body.code, 'RECENT_AUTH_REQUIRED')
                } finally {
                    Date.now = clock
                }
            })
            await t.test('root recovery refuses a foreign-owned data directory before credential work', async () => {
                const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'panelclaim-uid-'))
                try {
                    // Actual different POSIX ownership when running this fixture as root.
                    const euid = process.geteuid
                    if (euid() === 0) fs.chownSync(foreign, 65534, 65534)
                    else process.geteuid = () => 0
                    try {
                        const result = await runUserCommand(
                            data,
                            { email: 'owner@example.invalid', password: 'irrelevant', localAdmin: true },
                            { CUTTLELY_DATA_DIR: foreign }
                        )
                        assert.equal(result.ok, false)
                        assert.match(result.lines.join(' '), /setpriv --reuid=node --regid=node --init-groups/)
                        assert.equal(fs.existsSync(path.join(foreign, 'settings', 'instance-operator.json')), false)
                        if (euid() === 0) {
                            const child = `const {createRequire}=require('module');const r=createRequire(${JSON.stringify(
                                path.join(__dirname, '../packages/server/package.json')
                            )});r('ts-node').register({transpileOnly:true,skipProject:true,compilerOptions:{module:'commonjs',esModuleInterop:true,target:'ES2022'}});const b=r('./src/identity/operatorBinding.ts');const env={CUTTLELY_DATA_DIR:${JSON.stringify(
                                foreign
                            )}};b.writeOperatorBinding({userId:'fixture',database:'a'.repeat(64)},env);if(!b.readOperatorBinding(env))process.exit(2)`
                            const result = require('node:child_process').spawnSync(
                                'setpriv',
                                ['--reuid=65534', '--regid=65534', '--clear-groups', '--', process.execPath, '-e', child],
                                {
                                    env: {
                                        PATH: process.env.PATH,
                                        LOG_PATH: path.join(foreign, 'logs'),
                                        BLOB_STORAGE_PATH: path.join(foreign, 'blobs'),
                                        CUTTLELY_DATA_DIR: foreign
                                    },
                                    encoding: 'utf8'
                                }
                            )
                            assert.equal(result.status, 0, result.stderr)
                            assert.equal(fs.statSync(path.join(foreign, 'settings', 'instance-operator.json')).uid, 65534)
                            assert.equal(fs.statSync(path.join(foreign, 'settings', 'instance-operator.json')).mode & 0o777, 0o600)
                            const { readOperatorBinding } = serverRequire('./src/identity/operatorBinding.ts')
                            assert.equal(readOperatorBinding({ CUTTLELY_DATA_DIR: foreign }), null, 'different uid still refused')
                        }
                    } finally {
                        process.geteuid = euid
                    }
                } finally {
                    fs.rmSync(foreign, { recursive: true, force: true })
                }
            })
            const audit = fs.readFileSync(path.join(root, 'settings', 'history.jsonl'), 'utf8')
            for (const code of codes) assert.ok(!audit.includes(code))
            assert.ok(!audit.includes(cookies.owner))
        } finally {
            logger.info = originalInfo
        }
    } finally {
        if (app)
            for (const handle of ['compactorTimer', 'itWorkedCleanupTimer', 'auditCleanupTimer'])
                if (app[handle]) clearInterval(app[handle])
        if (data.isInitialized) await data.destroy()
        fs.rmSync(root, { recursive: true, force: true })
    }
})
