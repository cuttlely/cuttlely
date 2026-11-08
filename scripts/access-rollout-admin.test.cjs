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
delete process.env.CUTTLELY_INSTANCE_OPERATOR
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
const { operatorDatabaseFingerprint } = serverRequire('./src/identity/instanceOperator.ts')
const { rolloutState } = serverRequire('./src/settings/accessRollout.ts')
const request = serverRequire('supertest')

test('instance operator and service rollout production contract', async (t) => {
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
        for (const id of ['owner', 'admin', 'other'])
            await data
                .getRepository(User)
                .save({ id, name: 'Fixture', email: id + '@example.invalid', status: 'active', createdBy: id, updatedBy: id })
        await data.getRepository(Organization).save({ id: 'org', name: 'Fixture', createdBy: 'owner', updatedBy: 'owner' })
        await data
            .getRepository(Workspace)
            .save({ id: 'team', organizationId: 'org', name: 'Fixture', createdBy: 'owner', updatedBy: 'owner' })
        await data.getRepository(Organization).save({ id: 'org-b', name: 'Other organization', createdBy: 'other', updatedBy: 'other' })
        await data
            .getRepository(Workspace)
            .save({ id: 'team-b', organizationId: 'org-b', name: 'Other team', createdBy: 'other', updatedBy: 'other' })
        process.env.CUTTLELY_INSTANCE_OPERATOR = JSON.stringify({ userId: 'owner', database: operatorDatabaseFingerprint(data.options) })
        for (const id of ['owner', 'admin', 'other']) {
            await data.getRepository(Role).save({ id: 'role-' + id, name: id === 'other' ? 'owner' : id, permissions: '["*"]' })
            await data.getRepository(OrganizationUser).save({
                organizationId: id === 'other' ? 'org-b' : 'org',
                userId: id,
                roleId: 'role-' + id,
                status: 'active',
                createdBy: 'owner',
                updatedBy: 'owner'
            })
            await data.getRepository(WorkspaceUser).save({
                workspaceId: id === 'other' ? 'team-b' : 'team',
                userId: id,
                roleId: 'role-' + id,
                status: 'active',
                createdBy: 'owner',
                updatedBy: 'owner'
            })
        }
        const production = serverRequire('./src/identity/production.ts')
        await production.applyAuthKitSwitchOnBoot(data)
        const { issueApplicationSession } = serverRequire('./src/identity/handlers.ts')
        const ctx = await production.buildAuthContext({ cookies: {}, headers: {}, query: {}, protocol: 'http' })
        const cookies = {}
        for (const id of ['owner', 'admin', 'other']) {
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

        const operatorBinding = process.env.CUTTLELY_INSTANCE_OPERATOR
        const call = (method, route, body, cookie = cookies.owner) =>
            request(app.app)
                [method]('/api/v1/' + route)
                .set('Cookie', cookie)
                .set('x-request-from', 'internal')
                .send(body)
        const blockedPaths = [
            ['put', 'server-settings', { values: { INBOUND_ACCESS_V2: 'on' } }],
            ['put', 'server-settings', { values: { DATABASE_TYPE: 'postgres', DATABASE_HOST: 'attacker.invalid' } }],
            ['put', 'server-settings', { values: { STORAGE_TYPE: 's3' } }],
            ['get', 'server-settings/history'],
            ['get', 'server-settings/read-only'],
            ['get', 'server-settings/read-only/PORT'],
            ['post', 'server-settings/restart'],
            ['post', 'server-settings/discard'],
            ['post', 'server-settings/retry'],
            ['post', 'server-settings/test', { kind: 'database', values: {} }],
            ['post', 'server-settings/database/check'],
            ['post', 'server-settings/database/switch', { confirm: 'RESTART' }],
            ['post', 'server-settings/database/restore', { confirm: 'RESTART' }],
            ['post', 'server-settings/authkit/check'],
            ['post', 'server-settings/authkit/test'],
            ['get', 'server-settings/authkit/test'],
            ['post', 'server-settings/authkit/apply'],
            ['patch', 'server-settings'],
            ['delete', 'server-settings'],
            ['put', 'server-settings/read-only/PORT'],
            ['patch', 'server-settings/read-only'],
            ['patch', 'server-settings/read-only/PORT'],
            ['delete', 'server-settings/read-only'],
            ['delete', 'server-settings/read-only/PORT']
        ]
        await t.test(
            'two organization owners: only designated operator sees service config; all other paths deny without metadata',
            async () => {
                const before = rolloutState()
                const visible = await call('get', 'server-settings', undefined, cookies.other)
                assert.equal(visible.status, 200)
                assert.deepEqual(visible.body, {
                    instanceOperator: false,
                    message: 'Only the instance operator can change server-wide settings'
                })
                for (const cookie of [cookies.other, cookies.admin])
                    for (const [method, route, body] of blockedPaths) {
                        const response = await call(method, route, body, cookie)
                        assert.equal(response.status, 403, method + ' ' + route + ': ' + response.text)
                        assert.ok(
                            !response.text.includes(root) &&
                                !response.text.includes('DATABASE_HOST') &&
                                !response.text.includes(operatorBinding)
                        )
                    }
                assert.deepEqual(rolloutState(), before)
                assert.equal((await get()).body.instanceOperator, true)
            }
        )
        await t.test('anonymous, API keys and bearer sessions cannot reach any service administration path', async () => {
            for (const [method, route, body] of blockedPaths) {
                for (const bearer of [null, secret, legacyBearer, cookies.owner.split('=')[1]]) {
                    let pending = request(app.app)[method]('/api/v1/' + route)
                    if (bearer) pending = pending.set('Authorization', 'Bearer ' + bearer)
                    const response = await pending.send(body)
                    assert.ok([401, 503].includes(response.status), method + route + ': ' + response.text)
                    assert.ok(!response.text.includes(root) && !response.text.includes(operatorBinding))
                }
            }
        })
        await t.test('missing, malformed, foreign and revoked host designations fail closed on the next request', async () => {
            for (const value of [
                undefined,
                '',
                '{}',
                'invalid',
                JSON.stringify({ userId: 'owner', database: 'x' }),
                JSON.stringify({ userId: 'owner', database: '0'.repeat(64) }),
                JSON.stringify({ userId: 'owner', database: operatorDatabaseFingerprint(data.options), extra: true })
            ]) {
                if (value === undefined) delete process.env.CUTTLELY_INSTANCE_OPERATOR
                else process.env.CUTTLELY_INSTANCE_OPERATOR = value
                assert.equal((await get()).body.instanceOperator, false)
                for (const [method, route, body] of blockedPaths) assert.equal((await call(method, route, body)).status, 403, route)
            }
            process.env.CUTTLELY_INSTANCE_OPERATOR = operatorBinding
            assert.equal((await get()).body.instanceOperator, true)
        })
        await t.test('a different SQLite identity database with a copied operator ID cannot inherit host authority', async () => {
            const foreign = new DataSource({ ...data.options, database: path.join(root, 'foreign.sqlite') })
            await foreign.initialize()
            await foreign.runMigrations()
            // Copy the actual identity/session rows, so the tested rejection is the connection binding, not missing rows.
            for (const table of [
                'user',
                'organization',
                'workspace',
                'role',
                'organization_user',
                'workspace_user',
                ...(await data.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'identity_%'")).map((r) => r.name)
            ]) {
                const rows = await data.query('SELECT * FROM "' + table + '"')
                for (const row of rows) {
                    const keys = Object.keys(row)
                    await foreign.query(
                        'INSERT OR REPLACE INTO "' +
                            table +
                            '" (' +
                            keys.map((k) => '"' + k + '"').join(',') +
                            ') VALUES (' +
                            keys.map(() => '?').join(',') +
                            ')',
                        Object.values(row)
                    )
                }
            }
            serverRequire('./src/DataSource.ts').getDataSource = () => foreign
            app.AppDataSource = foreign
            try {
                assert.equal((await save('on')).status, 403)
                const foreignView = await get()
                assert.equal(foreignView.status, 200, 'real copied session remains valid in substituted DB')
                assert.equal(foreignView.body.instanceOperator, false)
            } finally {
                serverRequire('./src/DataSource.ts').getDataSource = () => data
                app.AppDataSource = data
                await foreign.destroy()
            }
            assert.equal(rolloutState().value, 'off')
        })
        await t.test('operator can save DB/storage and use test, history, restart and restore paths', async () => {
            const routes = serverRequire('./src/routes/server-settings/index.ts')
            const dbDrivers = {
                ...serverRequire('./src/settings/connection.ts').defaultDrivers(),
                home: () => root,
                pg: () => ({
                    connect: async () => {},
                    end: async () => {},
                    query: async (text) => ({
                        rows: text.includes('version()')
                            ? [{ version: 'PostgreSQL 16.4' }]
                            : text.includes('has_schema_privilege')
                            ? [{ allowed: true }]
                            : []
                    })
                })
            }
            routes.setConnectionDrivers(() => dbDrivers)
            assert.equal(
                (
                    await call('post', 'server-settings/database/switch', {
                        confirm: 'RESTART',
                        values: {
                            DATABASE_TYPE: 'postgres',
                            DATABASE_HOST: 'fixture.invalid',
                            DATABASE_PORT: '5432',
                            DATABASE_NAME: 'fixture',
                            DATABASE_USER: 'fixture'
                        }
                    })
                ).status,
                200
            )
            assert.equal((await call('put', 'server-settings', { values: { STORAGE_TYPE: 'local' } })).status, 200)
            assert.equal((await call('get', 'server-settings/history')).status, 200)
            assert.equal((await call('get', 'server-settings/read-only')).status, 200)
            assert.equal((await call('post', 'server-settings/restart')).status, 202)
            const storageTest = await call('post', 'server-settings/test', { kind: 'storage', values: { STORAGE_TYPE: 'local' } })
            assert.equal(storageTest.status, 200, storageTest.text)
            assert.equal(storageTest.body.ok, true)
            const tested = await call('post', 'server-settings/test', {
                kind: 'database',
                values: { DATABASE_TYPE: 'postgres', DATABASE_HOST: 'fixture.invalid', DATABASE_NAME: 'fixture', DATABASE_USER: 'fixture' }
            })
            assert.equal(tested.status, 200, tested.text)
            assert.equal(tested.body.ok, true)
            // Same running DB: writing draft settings never changes the binding before restart.
            assert.equal((await get()).body.instanceOperator, true)
            const switched = await call('post', 'server-settings/database/switch', {
                confirm: 'RESTART',
                values: { DATABASE_TYPE: 'sqlite' }
            })
            assert.equal(switched.status, 200, switched.text)
            const restored = await call('post', 'server-settings/database/restore', { confirm: 'RESTART' })
            assert.equal(restored.status, 200, restored.text)
            assert.equal((await call('post', 'server-settings/discard')).status, 200)
            routes.setConnectionDrivers(serverRequire('./src/settings/connection.ts').defaultDrivers)
        })
        await t.test('the audit list cannot disclose service settings history through tenant ownership', async () => {
            const hidden = await call('get', 'audit?type=setting_change', undefined, cookies.other)
            assert.equal(hidden.status, 200, hidden.text)
            assert.deepEqual(hidden.body.events, [])
            const visible = await call('get', 'audit?type=setting_change')
            assert.equal(visible.status, 200, visible.text)
            assert.ok(visible.body.events.length > 0)
            assert.ok(visible.body.events.every((e) => !e.organizationId || e.organizationId === 'org'))
        })
        await t.test('global authentication, OIDC and version host settings require the operator too', async () => {
            for (const [method, route] of [
                ['post', 'authentication-settings/stage'],
                ['post', 'authentication-settings/apply'],
                ['put', 'authentication-settings/oidc'],
                ['get', 'authentication-settings/oidc'],
                ['put', 'flow-versions/environment'],
                ['get', 'flow-versions/github']
            ]) {
                const denied = await call(method, route, {}, cookies.other)
                assert.equal(denied.status, 403, route + ': ' + denied.text)
            }
            const revokedCallback = await request(app.app)
                .get('/api/v1/auth/callback?state=dfst.fixture&code=fake')
                .set('Cookie', cookies.other)
            assert.equal(revokedCallback.status, 403)
            const operatorCallback = await request(app.app)
                .get('/api/v1/auth/callback?state=dfst.fixture&code=fake')
                .set('Cookie', cookies.owner)
            assert.equal(operatorCallback.status, 302, 'current real operator session reaches the callback handler')
        })
        await t.test('designation is kept out of generic/guided writes, restore, bootstrap, batch helper and CLI injection', async () => {
            const attempt = await call('put', 'server-settings', {
                values: { CUTTLELY_INSTANCE_OPERATOR: operatorBinding, INBOUND_ACCESS_V2: 'on' }
            })
            assert.equal(attempt.status, 400, attempt.text)
            assert.equal(rolloutState().value, 'off')
            for (const route of ['owner', 'authkit/check', 'authkit/test', 'authkit/apply', 'open']) {
                const denied = await request(app.app)
                    .post('/api/v1/server-setup/' + route)
                    .set('x-request-from', 'internal')
                    .send({ values: { CUTTLELY_INSTANCE_OPERATOR: operatorBinding } })
                assert.equal(denied.status, 403, route + denied.text)
            }
            // Poison historical bytes exactly as a restore/file injection might; no host designation is synthesized.
            const injected = JSON.stringify({ version: 1, values: { CUTTLELY_INSTANCE_OPERATOR: operatorBinding, LOG_LEVEL: 'info' } })
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, 'server.rolled-back.json'), injected)
            assert.equal((await call('post', 'server-settings/retry')).status, 200)
            delete process.env.CUTTLELY_INSTANCE_OPERATOR
            assert.equal(applyAdminSettings(process.env).atStart.CUTTLELY_INSTANCE_OPERATOR, undefined)
            assert.equal(process.env.CUTTLELY_INSTANCE_OPERATOR, undefined)
            const records = serverRequire('./src/settings/env-cli.ts').startRecords(process.env, null, () => {})
            assert.ok(!records.some((r) => r.startsWith('CUTTLELY_INSTANCE_OPERATOR=')))
            assert.equal((await save('on')).status, 403)
            const cli = serverRequire('./src/settings/cli.ts').runSettingsCli(['restore'], process.env)
            assert.equal(cli.code, 0)
            assert.equal(process.env.CUTTLELY_INSTANCE_OPERATOR, undefined)
            process.env.CUTTLELY_INSTANCE_OPERATOR = operatorBinding
            assert.equal((await call('post', 'server-settings/discard')).status, 200)
        })
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
        await t.test('another organization owner cannot disable the first organization enforcement or read its flow', async () => {
            assert.equal((await save('off', cookies.other)).status, 403)
            assert.equal(rolloutState().value, 'on')
            assert.equal(
                (
                    await request(app.app)
                        .get('/api/v1/chatflows/' + flow.id)
                        .set('Cookie', cookies.other)
                ).status,
                404
            )
            const foreignFlow = await data.getRepository(ChatFlow).save({
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                name: 'Other tenant',
                type: 'CHATFLOW',
                workspaceId: 'team-b',
                flowData: '{"nodes":[],"edges":[]}'
            })
            assert.equal(
                (
                    await request(app.app)
                        .get('/api/v1/chatflows/' + foreignFlow.id)
                        .set('Cookie', cookies.owner)
                ).status,
                404,
                'operator designation does not grant cross-org data access'
            )
            const before = await data.getRepository(ApiKeyUsage).findBy({ principalId: scoped.id })
            assert.equal((await predict(secret)).status, 200)
            const after = await data.getRepository(ApiKeyUsage).findBy({ principalId: scoped.id })
            for (const row of after) assert.equal(row.accepted, before.find((old) => old.id === row.id).accepted + 1)
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
            for (const sensitive of [secret, legacyBearer, key, JSON.parse(operatorBinding).database, 'fixture-invalid-sensitive-value'])
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
        await t.test('restore/retry/CLI/safe-boot audit failures keep the exact current settings', async () => {
            const history = path.join(dir, 'history.jsonl')
            const priorHistory = fs.readFileSync(history)
            const file = path.join(dir, 'server.json')
            const prior = fs.readFileSync(file)
            writeSettingsFile(dir, { LOG_LEVEL: 'info', INBOUND_ACCESS_V2: 'off' }, { key })
            const current = fs.readFileSync(file)
            fs.writeFileSync(path.join(dir, 'server.rolled-back.json'), JSON.stringify({ version: 1, values: { LOG_LEVEL: 'debug' } }))
            fs.writeFileSync(path.join(dir, 'server.last-good.json'), JSON.stringify({ version: 1, values: { LOG_LEVEL: 'error' } }))
            fs.unlinkSync(history)
            fs.mkdirSync(history)
            try {
                for (const route of ['discard', 'retry']) {
                    assert.equal((await call('post', 'server-settings/' + route)).status, 500)
                    assert.deepEqual(fs.readFileSync(file), current)
                }
                const cli = serverRequire('./src/settings/cli.ts').runSettingsCli
                for (const args of [['restore'], ['unset', 'LOG_LEVEL']]) {
                    assert.throws(() => cli(args, process.env))
                    assert.deepEqual(fs.readFileSync(file), current)
                }
                fs.writeFileSync(path.join(dir, 'boot.json'), JSON.stringify({ pending: 2 }))
                assert.throws(() => serverRequire('./src/settings/safeboot.ts').beginStart(dir, key))
                assert.deepEqual(fs.readFileSync(file), current)
            } finally {
                fs.rmdirSync(history)
                fs.writeFileSync(history, priorHistory)
                fs.writeFileSync(file, prior)
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
