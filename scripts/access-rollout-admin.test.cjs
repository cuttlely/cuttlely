// Production contract: actual App.config, session cookies, SQL RBAC and key admission; no model calls.
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-rollout-admin-'))
// Explicitly isolate this fixture from the full gate's INBOUND_ACCESS_V2=on.
delete process.env.INBOUND_ACCESS_V2
delete process.env.CUTTLELY_SETTINGS_HOST_KEYS
delete process.env.CUTTLELY_IGNORE_ADMIN_SETTINGS
Object.assign(process.env, {
    CUTTLELY_DATA_DIR: root,
    LOG_PATH: path.join(root, 'logs'),
    BLOB_STORAGE_PATH: path.join(root, 'blobs'),
    CUTTLELY_HERMES_HOME: path.join(root, 'runtime'),
    FLOWISE_SECRETKEY_OVERWRITE: 'fixture-rollout-admin-pepper',
    CUTTLELY_LOCAL_ADMIN: 'true',
    CUTTLELY_LOCAL_USERS: 'true',
    CUTTLELY_API_KEY_INSTANCES: '1',
    CUTTLELY_VERSIONS: 'false',
    CUTTLELY_DASH_FLOWS: 'false'
})
const { DataSource } = serverRequire('typeorm')
const { entities } = serverRequire('./src/database/entities/index.ts')
const { sqliteMigrations } = serverRequire('./src/database/migrations/sqlite/index.ts')
const { applyAdminSettings } = serverRequire('./src/settings/apply.ts')
const { setServerSettingsDeps } = serverRequire('./src/routes/server-settings/index.ts')
const { readHistory } = serverRequire('./src/settings/history.ts')
const { readSettingsFile, writeSettingsFile } = serverRequire('./src/settings/store.ts')
const { rolloutState } = serverRequire('./src/settings/accessRollout.ts')
const request = serverRequire('supertest')

test('service rollout admin production contract', async (t) => {
    const data = new DataSource({
        type: 'sqlite',
        database: path.join(root, 'fixture.sqlite'),
        entities: Object.values(entities),
        migrations: sqliteMigrations
    })
    let app, build, predictions
    const key = process.env.FLOWISE_SECRETKEY_OVERWRITE
    const dir = path.join(root, 'settings')
    try {
        await data.initialize()
        await data.runMigrations()
        serverRequire('./src/DataSource.ts').getDataSource = () => data
        const { User, Organization, Workspace, Role, OrganizationUser, WorkspaceUser, ApiKey, ApiKeyResource, ApiKeyUsage, ChatFlow } =
            entities
        for (const id of ['owner', 'admin'])
            await data
                .getRepository(User)
                .save({ id, name: 'Fixture', email: id + '@example.invalid', status: 'active', createdBy: id, updatedBy: id })
        await data.getRepository(Organization).save({ id: 'org', name: 'Fixture', createdBy: 'owner', updatedBy: 'owner' })
        await data
            .getRepository(Workspace)
            .save({ id: 'team', organizationId: 'org', name: 'Fixture', createdBy: 'owner', updatedBy: 'owner' })
        for (const id of ['owner', 'admin']) {
            await data.getRepository(Role).save({ id: 'role-' + id, name: id, permissions: '["*"]' })
            await data
                .getRepository(OrganizationUser)
                .save({ organizationId: 'org', userId: id, roleId: 'role-' + id, status: 'active', createdBy: 'owner', updatedBy: 'owner' })
            await data
                .getRepository(WorkspaceUser)
                .save({ workspaceId: 'team', userId: id, roleId: 'role-' + id, status: 'active', createdBy: 'owner', updatedBy: 'owner' })
        }
        const production = serverRequire('./src/identity/production.ts')
        await production.applyAuthKitSwitchOnBoot(data)
        const { issueApplicationSession } = serverRequire('./src/identity/handlers.ts')
        const ctx = await production.buildAuthContext({ cookies: {}, headers: {}, query: {}, protocol: 'http' })
        const cookies = {}
        for (const id of ['owner', 'admin']) {
            const session = await issueApplicationSession(ctx, id, 'local')
            assert.ok(session, 'real application session issued')
            cookies[id] = 'cuttlely-local-session=' + session.token
        }
        const { App } = serverRequire('./src/index.ts')
        async function reload() {
            const state = applyAdminSettings(process.env)
            assert.equal(process.env.INBOUND_ACCESS_V2, undefined, 'restart never promotes an admin choice into host env')
            setServerSettingsDeps(() => ({ env: process.env, state, key: async () => key }))
            app = new App()
            app.AppDataSource = data
            app.identityManager = { getPlatformType: () => 'open_source' }
            app.sseStreamer = new (serverRequire('./src/utils/SSEStreamer.ts').SSEStreamer)()
            serverRequire('./src/utils/getRunningExpressApp.ts').getRunningExpressApp = () => app
            await app.config()
        }
        await reload()
        predictions = serverRequire('./src/services/predictions/index.ts').default
        build = predictions.buildChatflow
        predictions.buildChatflow = async () => ({ text: 'fixture only' })
        const { parsePolicy } = serverRequire('./src/services/accessKeys/policy.ts')
        const flow = await data.getRepository(ChatFlow).save({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            chatbotConfig: '{"postProcessing":{"enabled":true}}',
            name: 'Fixture',
            type: 'CHATFLOW',
            workspaceId: 'team',
            apiAccessMode: 'private',
            flowData: '{"nodes":[],"edges":[]}'
        })
        const scoped = await data.getRepository(ApiKey).save({
            id: 'scoped',
            apiKey: '',
            apiSecret: '',
            keyName: 'Fixture',
            ownerUserId: 'owner',
            workspaceId: 'team',
            permissions: ['chatflows:view'],
            accessPolicy: parsePolicy({ scopes: ['predict'], rpm: 0, daily: 10 })
        })
        await data.getRepository(ApiKeyResource).save({ principalId: scoped.id, resourceType: 'CHATFLOW', resourceId: flow.id })
        const secret = (await data.transaction((m) => serverRequire('./src/services/accessKeys/credentials.ts').mintCredential(m, scoped)))
            .secret
        const apiKeys = serverRequire('./src/utils/apiKey.ts')
        const legacyBearer = 'fixture-retained-legacy-bearer'
        await data.getRepository(ApiKey).save({
            id: 'legacy',
            apiKey: apiKeys.storedApiKeyLookup(legacyBearer),
            apiSecret: apiKeys.generateSecretHash(legacyBearer),
            keyName: 'Legacy fixture',
            ownerUserId: 'owner',
            workspaceId: 'team',
            permissions: ['chatflows:view'],
            harnesses: [],
            accessPolicy: { ...parsePolicy({ scopes: ['predict'], rpm: 0 }), legacy: true }
        })
        await data.getRepository(ApiKeyResource).save({ principalId: 'legacy', resourceType: 'CHATFLOW', resourceId: flow.id })
        await data.getRepository(ChatFlow).update(flow.id, { apikeyid: 'legacy' })
        const get = () => request(app.app).get('/api/v1/server-settings').set('Cookie', cookies.owner)
        const setting = (response) => response.body.settings.find((s) => s.key === 'INBOUND_ACCESS_V2')
        const save = (mode, cookie = cookies.owner) =>
            request(app.app)
                .put('/api/v1/server-settings')
                .set('x-request-from', 'internal')
                .set('Cookie', cookie)
                .send({ values: { INBOUND_ACCESS_V2: mode } })
        const predict = (bearer) =>
            request(app.app)
                .post('/api/v1/prediction/' + flow.id)
                .set('Authorization', 'Bearer ' + bearer)
                .send({ question: 'fixture' })

        await t.test('default off without activation and no scoped admission', async () => {
            assert.equal((await get()).status, 200)
            assert.deepEqual(rolloutState(), { value: 'off', source: 'default', locked: false })
            assert.equal(setting(await get()).effective, 'off')
            assert.equal((await predict(secret)).status, 503)
            assert.equal((await predict(legacyBearer)).status, 200)
            assert.equal((await data.getRepository(ApiKeyUsage).find()).length, 0)
        })
        await t.test('workspace admin, API key, anonymous and noninteractive writes rejected', async () => {
            assert.equal((await save('on', cookies.admin)).status, 403)
            for (const bearer of [secret, legacyBearer, cookies.owner.split('=')[1]]) {
                const result = await request(app.app)
                    .put('/api/v1/server-settings')
                    .set('Authorization', 'Bearer ' + bearer)
                    .send({ values: { INBOUND_ACCESS_V2: 'on' } })
                assert.ok([401, 503].includes(result.status), 'noninteractive caller is rejected')
            }
            assert.equal(
                (
                    await request(app.app)
                        .put('/api/v1/server-settings')
                        .send({ values: { INBOUND_ACCESS_V2: 'on' } })
                ).status,
                401
            )
            assert.equal(
                (
                    await request(app.app)
                        .put('/api/v1/server-settings')
                        .set('Cookie', cookies.owner)
                        .send({ values: { INBOUND_ACCESS_V2: 'on' } })
                ).status,
                401,
                'cookie write requires interactive request marker'
            )
            assert.equal(rolloutState().value, 'off')
        })
        await t.test('owner activates enforcement and admission charges exactly once', async () => {
            const result = await save('on')
            assert.equal(result.status, 200, result.text)
            assert.equal(setting(result).effective, 'on')
            assert.equal(setting(result).source, 'panel')
            assert.equal(setting(result).changed, false)
            assert.equal(process.env.INBOUND_ACCESS_V2, undefined)
            assert.equal((await predict(secret)).status, 200)
            const usage = await data.getRepository(ApiKeyUsage).findBy({ principalId: scoped.id })
            assert.ok(usage.length > 0)
            assert.ok(
                usage.every((row) => row.accepted === 1),
                'preflight and controller do not double charge'
            )
            assert.equal((await predict(legacyBearer)).status, 200)
            assert.equal(
                (
                    await request(app.app)
                        .put('/api/v1/server-settings')
                        .set('Authorization', 'Bearer ' + secret)
                        .send({ values: { INBOUND_ACCESS_V2: 'off' } })
                ).status,
                401
            )
        })
        await t.test('saved choice survives new App.config and startup reload', async () => {
            await reload()
            assert.equal(setting(await get()).effective, 'on')
            assert.equal(setting(await get()).source, 'panel')
            assert.equal((await predict(secret)).status, 200)
            assert.equal(readSettingsFile(dir, key).values.INBOUND_ACCESS_V2, 'on')
            const fresh = require('node:child_process').spawnSync(
                process.execPath,
                [
                    '-e',
                    `
                const req = require('node:module').createRequire(${JSON.stringify(
                    path.join(__dirname, '../packages/server/package.json')
                )});
                req('ts-node').register({transpileOnly:true, skipProject:true, compilerOptions:{module:'commonjs',target:'ES2022',esModuleInterop:true}});
                const state = req('./src/settings/accessRollout.ts').rolloutState();
                require('node:assert/strict').deepEqual(state, {value:'on',source:'panel',locked:false});
            `
                ],
                { env: process.env, encoding: 'utf8' }
            )
            assert.equal(fresh.status, 0, fresh.stderr)
        })
        await t.test('host off overrides saved on and locks writes; invalid host retains 503', async () => {
            process.env.INBOUND_ACCESS_V2 = 'off'
            assert.equal(setting(await get()).source, 'host')
            assert.equal(setting(await get()).effective, 'off')
            assert.equal(setting(await get()).locked, true)
            assert.equal((await save('on')).status, 409)
            assert.equal((await predict(secret)).status, 503)
            process.env.INBOUND_ACCESS_V2 = 'invalid'
            assert.equal(setting(await get()).effective, 'invalid')
            assert.equal((await predict(secret)).status, 503)
            delete process.env.INBOUND_ACCESS_V2
        })
        await t.test('invalid stored value fails safe and is identified without echoing it', async () => {
            writeSettingsFile(dir, { INBOUND_ACCESS_V2: 'fixture-invalid-sensitive-value' }, { key })
            const result = await get()
            assert.equal(setting(result).effective, 'off')
            assert.equal(setting(result).source, 'panel')
            assert.match(setting(result).help, /saved value is invalid/)
            assert.ok(!result.text.includes('fixture-invalid-sensitive-value'))
            assert.equal((await predict(secret)).status, 503)
            assert.equal((await save('on')).status, 200)
        })
        await t.test('ignore-admin recovery reports default off unless a host mode wins', async () => {
            process.env.CUTTLELY_IGNORE_ADMIN_SETTINGS = '1'
            try {
                assert.equal(setting(await get()).effective, 'off')
                assert.equal(setting(await get()).source, 'default')
                assert.equal((await predict(secret)).status, 503)
                process.env.INBOUND_ACCESS_V2 = 'on'
                assert.equal(setting(await get()).effective, 'on')
                assert.equal(setting(await get()).source, 'host')
                assert.equal(setting(await get()).locked, true)
            } finally {
                delete process.env.CUTTLELY_IGNORE_ADMIN_SETTINGS
                delete process.env.INBOUND_ACCESS_V2
            }
        })
        await t.test('shadow and reversible off preserve legacy behavior without charging', async () => {
            for (const mode of ['shadow', 'off']) {
                assert.equal((await save(mode)).status, 200)
                const before = await data.getRepository(ApiKeyUsage).find()
                assert.equal((await predict(legacyBearer)).status, 200)
                assert.equal((await predict(secret)).status, 503)
                assert.deepEqual(await data.getRepository(ApiKeyUsage).find(), before)
            }
            assert.equal((await save('typo')).status, 400)
        })
        await t.test('audit contains actor, effective transition and sources without bearer or invalid bytes', async () => {
            const rows = readHistory(dir)
            const activation = rows.find((row) =>
                row.changes?.some((change) => change.key === 'INBOUND_ACCESS_V2' && change.fromSource === 'default' && change.to === 'on')
            )
            assert.ok(activation)
            assert.equal(activation.actorId, 'owner')
            assert.deepEqual(activation.changes, [
                { key: 'INBOUND_ACCESS_V2', from: 'off', to: 'on', fromSource: 'default', toSource: 'panel' }
            ])
            for (const sensitive of [secret, legacyBearer, key, 'fixture-invalid-sensitive-value'])
                assert.ok(!JSON.stringify(rows).includes(sensitive))
        })
        await t.test('audit-write failure rolls the setting back without activation', async () => {
            const history = path.join(dir, 'history.jsonl')
            const prior = fs.readFileSync(history)
            fs.unlinkSync(history)
            fs.mkdirSync(history)
            try {
                assert.equal((await save('on')).status, 500)
                assert.equal(rolloutState().value, 'off')
            } finally {
                fs.rmdirSync(history)
                fs.writeFileSync(history, prior)
            }
        })
        await t.test('safe boot never restores an older rollout choice', async () => {
            const { beginStart } = serverRequire('./src/settings/safeboot.ts')
            fs.writeFileSync(path.join(dir, 'server.last-good.json'), JSON.stringify({ version: 1, values: { INBOUND_ACCESS_V2: 'on' } }))
            fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ pending: 2 }))
            assert.equal(beginStart(dir, key).rolledBack, true)
            assert.equal(rolloutState().value, 'off')
        })
        await t.test('general discard/retry never activates an old rollout choice', async () => {
            fs.writeFileSync(path.join(dir, 'server.rolled-back.json'), JSON.stringify({ version: 1, values: { INBOUND_ACCESS_V2: 'on' } }))
            const rolledFile = serverRequire('./src/settings/safeboot.ts').ROLLED_BACK_FILE
            if (rolledFile !== 'server.rolled-back.json')
                fs.renameSync(path.join(dir, 'server.rolled-back.json'), path.join(dir, rolledFile))
            const retry = await request(app.app)
                .post('/api/v1/server-settings/retry')
                .set('Cookie', cookies.owner)
                .set('x-request-from', 'internal')
            assert.equal(retry.status, 200, retry.text)
            assert.equal(setting(retry).effective, 'off')
            const cli = serverRequire('./src/settings/cli.ts').runSettingsCli(['restore'], process.env)
            assert.equal(cli.code, 0)
            assert.equal(rolloutState().value, 'off')
            const discard = await request(app.app)
                .post('/api/v1/server-settings/discard')
                .set('Cookie', cookies.owner)
                .set('x-request-from', 'internal')
            assert.equal(discard.status, 200, discard.text)
            assert.equal(setting(discard).effective, 'off')
        })
    } finally {
        if (predictions) predictions.buildChatflow = build
        if (data.isInitialized) await data.destroy()
        fs.rmSync(root, { recursive: true, force: true })
    }
})
