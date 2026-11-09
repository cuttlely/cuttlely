// Real App.config/settings service, SQL sessions/RBAC, separate tenants and disposable SQLite.
// Application accessors/platform wiring, external-provider proof and failure-path seams are explicit below.
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-signin-'))
for (const name of ['CUTTLELY_INSTANCE_OPERATOR', 'INBOUND_ACCESS_V2', 'CUTTLELY_SETTINGS_HOST_KEYS', 'CUTTLELY_IGNORE_ADMIN_SETTINGS'])
    delete process.env[name]
Object.assign(process.env, {
    CUTTLELY_DATA_DIR: root,
    LOG_PATH: path.join(root, 'logs'),
    BLOB_STORAGE_PATH: path.join(root, 'blobs'),
    CUTTLELY_HERMES_HOME: path.join(root, 'runtime'),
    FLOWISE_SECRETKEY_OVERWRITE: 'fixture-breakglass-pepper',
    CUTTLELY_LOCAL_ADMIN: 'true',
    CUTTLELY_LOCAL_USERS: 'false',
    CUTTLELY_VERSIONS: 'false',
    CUTTLELY_DASH_FLOWS: 'false'
})
const { DataSource } = serverRequire('typeorm')
const { entities } = serverRequire('./src/database/entities/index.ts')
const { sqliteMigrations } = serverRequire('./src/database/migrations/sqlite/index.ts')
const { runUserCommand } = serverRequire('./src/identity/cli.ts')
const { applyAdminSettings } = serverRequire('./src/settings/apply.ts')
const { setServerSettingsDeps } = serverRequire('./src/routes/server-settings/index.ts')
const { readHistory } = serverRequire('./src/settings/history.ts')
const request = serverRequire('supertest')
const password = 'F1xture-Password!'
const { readSettingsFile, writeSettingsFile, SETTINGS_FILE } = serverRequire('./src/settings/store.ts')
const auth = serverRequire('./src/identity/authenticationState.ts')
const oidc = serverRequire('./src/identity/oidcStore.ts')
const SIGN_IN_KEYS = [
    'CUTTLELY_LOCAL_ADMIN',
    'CUTTLELY_LOCAL_USERS',
    'WORKOS_API_KEY',
    'WORKOS_CLIENT_ID',
    'WORKOS_REDIRECT_URI',
    'WORKOS_COOKIE_PASSWORD'
]
for (const name of SIGN_IN_KEYS.slice(2)) delete process.env[name]

test('ordinary sign-in transition protection through real App.config and SQLite', async (t) => {
    const data = new DataSource({
        type: 'sqlite',
        database: path.join(root, 'identity.sqlite'),
        entities: Object.values(entities),
        migrations: sqliteMigrations
    })
    const dir = path.join(root, 'settings')
    const key = process.env.FLOWISE_SECRETKEY_OVERWRITE
    let app,
        ownerId,
        cookies = {},
        state
    const service = serverRequire('./src/settings/service.ts')
    const production = serverRequire('./src/identity/production.ts')
    const call = (method, route, body, cookie = cookies.owner) => {
        const req = request(app.app)
            [method]('/api/v1/' + route)
            .set('x-request-from', 'internal')
        if (cookie) req.set('Cookie', cookie)
        return body === undefined ? req : req.send(body)
    }
    const put = (values, cookie = cookies.owner) => call('put', 'server-settings', { values }, cookie)
    const snapshot = () => ({
        raw: fs.existsSync(path.join(dir, SETTINGS_FILE)) ? fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8') : null,
        history: readHistory(dir)
    })
    const configure = (values, hosts = []) => {
        for (const name of SIGN_IN_KEYS) delete process.env[name]
        Object.assign(process.env, values)
        state.hostKeys = state.hostKeys.filter((name) => !SIGN_IN_KEYS.includes(name)).concat(hosts)
        writeSettingsFile(dir, values, { key, by: 'fixture initial state' })
    }
    const renew = async (method = 'local') => {
        await auth.refreshAuthenticationState(data, true)
        const ctx = await production.buildAuthContext({ cookies: {}, headers: {}, query: {}, protocol: 'http' })
        for (const [name, id] of [
            ['owner', ownerId],
            ['other', 'other'],
            ['admin', 'admin']
        ]) {
            const issued = await serverRequire('./src/identity/handlers.ts').issueApplicationSession(ctx, id, method, {
                recentAuthenticationAt: Date.now()
            })
            assert.ok(issued)
            cookies[name] = 'cuttlely-local-session=' + issued.token
        }
    }
    const methodPost = (action, body, cookie) => call('post', 'authentication-settings/' + action, body, cookie)
    const applyMethod = async (method) => {
        const before = await auth.readAuthenticationState(data)
        const staged = await methodPost('stage', { method, version: before.version })
        assert.equal(staged.status, 200, JSON.stringify(staged.body))
        const applied = await methodPost('apply', {
            method,
            stage: staged.body.stage,
            stageVersion: staged.body.stageVersion,
            stateVersion: before.version,
            confirm: 'END SESSIONS'
        })
        assert.equal(applied.status, 200, JSON.stringify(applied.body))
        return { before, applied }
    }
    try {
        await data.initialize()
        await data.runMigrations()
        serverRequire('./src/DataSource.ts').getDataSource = () => data
        await auth.initializeAuthenticationState(data, {})
        state = applyAdminSettings(process.env)
        state.hostKeys = state.hostKeys.filter((name) => !SIGN_IN_KEYS.includes(name))
        const deps = () => ({ env: process.env, state, key: async () => key })
        setServerSettingsDeps(deps)
        await t.test('zero-account enable-before-create and real HTTP first-owner setup remain available', async () => {
            await service.writeValues(deps(), { CUTTLELY_LOCAL_ADMIN: 'true' }, 'setup fixture', 'save')
            assert.equal(readSettingsFile(dir, key).values.CUTTLELY_LOCAL_ADMIN, 'true')
            assert.equal((await data.query('SELECT COUNT(*) AS n FROM user'))[0].n, 0)
            production.identityStore()
            const setup = serverRequire('./src/identity/setupCode.ts')
            const code = setup.firstRunSetupCode()
            await setup.setupCodeReady()
            const { App } = serverRequire('./src/index.ts')
            app = new App()
            app.AppDataSource = data
            app.identityManager = { getPlatformType: () => 'open_source' }
            app.sseStreamer = new (serverRequire('./src/utils/SSEStreamer.ts').SSEStreamer)()
            serverRequire('./src/utils/getRunningExpressApp.ts').getRunningExpressApp = () => app
            await app.config()
            assert.equal((await call('post', 'server-setup/begin', { code }, '')).status, 200)
            const created = await call(
                'post',
                'account/register',
                { setupCode: code, user: { email: 'owner@example.invalid', name: 'Fixture', credential: password } },
                ''
            )
            assert.equal(created.status, 200, JSON.stringify(created.body))
            ownerId = created.body.id
            assert.ok(ownerId)
            assert.equal((await auth.readAuthenticationState(data)).activeMethod, 'local')
            const bound = await runUserCommand(data, { email: 'owner@example.invalid', bindOperator: true, localAdmin: false })
            assert.equal(bound.ok, true, bound.lines.join('\n'))
        })
        const { User, Organization, Workspace, Role, OrganizationUser, WorkspaceUser } = entities
        for (const id of ['other', 'admin']) {
            await data
                .getRepository(User)
                .save({ id, name: 'Fixture', email: id + '@example.invalid', status: 'active', createdBy: id, updatedBy: id })
            await data.getRepository(Organization).save({ id: 'org-' + id, name: 'Fixture', createdBy: id, updatedBy: id })
            await data
                .getRepository(Workspace)
                .save({ id: 'team-' + id, organizationId: 'org-' + id, name: 'Fixture', createdBy: id, updatedBy: id })
            await data
                .getRepository(Role)
                .save({ id: 'role-' + id, name: id === 'other' ? 'owner' : 'admin', permissions: '["authentication:manage"]' })
            await data
                .getRepository(OrganizationUser)
                .save({ organizationId: 'org-' + id, userId: id, roleId: 'role-' + id, status: 'active', createdBy: id, updatedBy: id })
            await data
                .getRepository(WorkspaceUser)
                .save({ workspaceId: 'team-' + id, userId: id, roleId: 'role-' + id, status: 'active', createdBy: id, updatedBy: id })
        }
        await production.applyAuthKitSwitchOnBoot(data)
        await renew()
        await t.test(
            'local-users-only unrelated save is 200, persisted and audited without an auth state change or readiness lookup',
            async () => {
                configure({ CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_LOCAL_USERS: 'true' })
                const login = await call('post', 'auth/local/login', { email: 'owner@example.invalid', password }, '')
                assert.equal(login.status, 200)
                const before = await auth.readAuthenticationState(data),
                    history = readHistory(dir)
                const original = auth.readOrdinarySignInReadiness
                let calls = 0
                auth.readOrdinarySignInReadiness = async () => {
                    calls++
                    throw new Error('fixture unavailable readiness')
                }
                try {
                    const res = await put({ CUTTLELY_CHECK_MAX_TOKENS: '5000' })
                    assert.equal(res.status, 200, JSON.stringify(res.body))
                    assert.equal(calls, 0)
                } finally {
                    auth.readOrdinarySignInReadiness = original
                }
                assert.equal(readSettingsFile(dir, key).values.CUTTLELY_CHECK_MAX_TOKENS, '5000')
                assert.equal(readHistory(dir).length, history.length + 1)
                assert.equal(readHistory(dir)[0].changes[0].key, 'CUTTLELY_CHECK_MAX_TOKENS')
                assert.deepEqual(await auth.readAuthenticationState(data), before)
            }
        )
        await t.test(
            'last local-admin and last local-users removal, including mixed writes, are 409 with no file or history write',
            async () => {
                for (const field of ['CUTTLELY_LOCAL_ADMIN', 'CUTTLELY_LOCAL_USERS']) {
                    configure({ CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_LOCAL_USERS: 'false', [field]: 'true' })
                    const before = snapshot(),
                        authBefore = await auth.readAuthenticationState(data)
                    const res = await put({ [field]: 'false', CUTTLELY_CHECK_MAX_TOKENS: '6000' })
                    assert.equal(res.status, 409, JSON.stringify(res.body))
                    assert.equal(res.body.code, 'NO_WAY_IN')
                    assert.deepEqual(snapshot(), before)
                    assert.deepEqual(await auth.readAuthenticationState(data), authBefore)
                }
            }
        )
        await t.test(
            'a usable non-owner local account can retain ordinary login; flags and malformed/inactive credentials cannot',
            async () => {
                const ownerHash = (await data.query('SELECT credential FROM user WHERE id = ?', [ownerId]))[0].credential
                const memberHash = await serverRequire('./src/identity/password.ts').hashPassword(password)
                await data.getRepository(User).update('admin', { credential: memberHash })
                await data.getRepository(User).update(ownerId, { credential: null })
                try {
                    configure({ CUTTLELY_LOCAL_ADMIN: 'true', CUTTLELY_LOCAL_USERS: 'false' })
                    assert.equal((await put({ CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_LOCAL_USERS: 'true' })).status, 200)
                    await data.getRepository(User).update('admin', { credential: 'not-a-password-hash' })
                    const before = snapshot()
                    assert.equal((await put({ CUTTLELY_LOCAL_ADMIN: 'true' })).body.code, 'NO_WAY_IN')
                    assert.deepEqual(snapshot(), before)
                    await data.getRepository(User).update('admin', { credential: memberHash })
                    await data.getRepository(OrganizationUser).update({ userId: 'admin' }, { status: 'disable' })
                    assert.equal((await put({ CUTTLELY_LOCAL_ADMIN: 'true' })).body.code, 'NO_WAY_IN')
                } finally {
                    await data.getRepository(OrganizationUser).update({ userId: 'admin' }, { status: 'active' })
                    await data.getRepository(User).update('admin', { credential: null })
                    await data.getRepository(User).update(ownerId, { credential: ownerHash })
                }
            }
        )
        await t.test('effective no-op skips readiness; unknown database evidence fails closed only on auth changes', async () => {
            configure({ CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_LOCAL_USERS: 'true' })
            const before = snapshot(),
                original = auth.readOrdinarySignInReadiness
            let calls = 0
            auth.readOrdinarySignInReadiness = async () => {
                calls++
                throw new Error('fixture unavailable readiness')
            }
            try {
                assert.equal((await put({ CUTTLELY_LOCAL_USERS: 'true' })).status, 200)
                assert.equal(calls, 0)
                assert.deepEqual(snapshot(), before)
                const blocked = await put({ CUTTLELY_LOCAL_USERS: 'false', CUTTLELY_CHECK_MAX_TOKENS: '7000' })
                assert.equal(blocked.status, 409)
                assert.equal(blocked.body.code, 'NO_WAY_IN')
                assert.equal(calls, 1)
                assert.deepEqual(snapshot(), before)
            } finally {
                auth.readOrdinarySignInReadiness = original
            }
        })
        await t.test('an actual readiness SQL failure refuses auth transitions but not unrelated saves', async () => {
            configure({ CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_LOCAL_USERS: 'true' })
            await data.query('ALTER TABLE identity_provider_link RENAME TO fixture_unavailable_links')
            try {
                const before = snapshot()
                const blocked = await put({ CUTTLELY_LOCAL_USERS: 'false' })
                assert.equal(blocked.status, 409)
                assert.equal(blocked.body.code, 'NO_WAY_IN')
                assert.deepEqual(snapshot(), before)
                assert.equal((await put({ CUTTLELY_CHECK_MAX_TOKENS: '7500' })).status, 200)
            } finally {
                await data.query('ALTER TABLE fixture_unavailable_links RENAME TO identity_provider_link')
            }
        })
        await t.test('real host locks and effective host precedence remain authoritative', async () => {
            configure({ CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_LOCAL_USERS: 'true' }, ['CUTTLELY_LOCAL_USERS'])
            const before = snapshot()
            assert.equal((await put({ CUTTLELY_LOCAL_USERS: 'false' })).status, 400)
            assert.deepEqual(snapshot(), before)
            // A trusted guided caller still resolves the actual host value, not a shadow file value.
            await service.writeValues(deps(), { CUTTLELY_LOCAL_USERS: 'false' }, 'fixture guided', 'save')
            assert.equal(readSettingsFile(dir, key).values.CUTTLELY_LOCAL_USERS, 'false')
            assert.equal((await put({ CUTTLELY_CHECK_MAX_TOKENS: '8000' })).status, 200)
            configure({ CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_LOCAL_USERS: 'true' })
        })
        await t.test(
            'nonoperator tenant owners/authentication managers retain tenant exceptions and cannot alter global configuration',
            async () => {
                for (const cookie of [cookies.other, cookies.admin]) {
                    assert.equal((await put({ CUTTLELY_LOCAL_USERS: 'false' }, cookie)).status, 403)
                    assert.equal((await methodPost('stage', { method: 'local', version: 1 }, cookie)).status, 403)
                    assert.equal((await call('get', 'authentication-settings/oidc', undefined, cookie)).status, 403)
                    assert.equal((await call('get', 'authentication-settings', undefined, cookie)).status, 200)
                }
                const sql = production.applicationSql()
                await data
                    .getRepository(Role)
                    .save({ id: 'mapping-member', name: 'member', permissions: '[]', organizationId: 'org-other' })
                const group = await serverRequire('./src/identity/scimGroups.ts').createGroup(
                    sql,
                    { organizationId: 'org-other', tokenId: 'fixture' },
                    { displayName: 'Fixture group' }
                )
                const preview = await call(
                    'post',
                    'authentication-settings/scim-mappings/preview',
                    { groupId: group.id, workspaceId: 'team-other', roleId: 'mapping-member' },
                    cookies.other
                )
                assert.equal(preview.status, 200, JSON.stringify(preview.body))
                const alert = await serverRequire('./src/identity/recovery.ts').createRecoveryAlert(data, 'other', Date.now())
                assert.equal(
                    (await call('post', 'authentication-settings/acknowledge-recovery-alert', { id: alert.id }, cookies.other)).status,
                    200
                )
                const tokenHash = serverRequire('./src/identity/password.ts').hashSessionToken(cookies.other.split('=')[1])
                await data.query('UPDATE identity_local_session SET createdDate = ? WHERE token = ?', [
                    Date.now() - 11 * 60 * 1000,
                    tokenHash
                ])
                const stale = await call('post', 'authentication-settings/scim-token', {}, cookies.other)
                assert.equal(stale.status, 409)
                assert.equal(stale.body.code, 'REAUTH_REQUIRED')
                await renew()
                const before = snapshot()
                process.env.CUTTLELY_INSTANCE_OPERATOR = 'none'
                assert.equal((await put({ CUTTLELY_CHECK_MAX_TOKENS: '9000' })).status, 403)
                delete process.env.CUTTLELY_INSTANCE_OPERATOR
                assert.deepEqual(snapshot(), before)
            }
        )
        await t.test('persisted tested active OIDC unrelated save is 200 without provider/readiness calls or epoch mutation', async () => {
            configure({ CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_LOCAL_USERS: 'true' })
            process.env.FIXTURE_OIDC_SECRET = 'fixture-only-not-a-live-secret'
            process.env.RENDER_EXTERNAL_URL = ''
            process.env.APP_URL = 'https://app.example.invalid'
            state.hostKeys.push('APP_URL')
            const draft = {
                issuer: 'https://issuer.example.invalid',
                clientId: 'fixture-client',
                clientSecretEnvVar: 'FIXTURE_OIDC_SECRET',
                trustMissingEmailVerification: false,
                privateIssuerHosts: []
            }
            draft.fingerprint = oidc.oidcConfigurationFingerprint(draft)
            draft.discovery = {
                issuer: draft.issuer,
                authorization_endpoint: draft.issuer + '/authorize',
                token_endpoint: draft.issuer + '/token',
                jwks_uri: draft.issuer + '/jwks',
                response_types_supported: ['code'],
                id_token_signing_alg_values_supported: ['RS256']
            }
            await oidc.saveOidcDraft(data, { ...draft, health: 'ready', healthError: null, checkedAt: new Date().toISOString() }, 0)
            // External-provider proof seam only: persist exactly the accepted test result a bound callback records.
            await oidc.recordOidcTestResult(data, draft.fingerprint, {
                passed: true,
                identityAccepted: true,
                email: 'owner@example.invalid'
            })
            const current = await auth.readAuthenticationState(data)
            const providerKey = oidc.oidcProviderKey(current.installationId, draft.issuer, draft.clientId)
            await oidc.createProviderLink(data, {
                providerKey,
                subject: 'fixture-subject',
                userId: ownerId,
                emailAtLink: 'owner@example.invalid',
                assuranceBasis: 'email_verified'
            })
            await applyMethod('oidc')
            await renew('oidc')
            const before = await auth.readAuthenticationState(data),
                history = readHistory(dir)
            assert.equal(before.activeMethod, 'oidc')
            assert.equal((await oidc.readOidcConfiguration(data, 'active')).testedFingerprint, draft.fingerprint)
            const original = auth.readOrdinarySignInReadiness
            const provider = serverRequire('./src/identity/oidcProvider.ts')
            const originalCheck = provider.checkOidcConfiguration
            let calls = 0
            auth.readOrdinarySignInReadiness = async () => {
                calls++
                throw new Error('fixture unavailable adapter')
            }
            provider.checkOidcConfiguration = async () => {
                calls++
                throw new Error('fixture must not probe provider')
            }
            try {
                const res = await put({ CUTTLELY_CHECK_MAX_TOKENS: '10000' })
                assert.equal(res.status, 200, JSON.stringify(res.body))
                assert.equal(calls, 0)
            } finally {
                auth.readOrdinarySignInReadiness = original
                provider.checkOidcConfiguration = originalCheck
            }
            assert.equal(readSettingsFile(dir, key).values.CUTTLELY_CHECK_MAX_TOKENS, '10000')
            assert.equal(readHistory(dir).length, history.length + 1)
            assert.deepEqual(await auth.readAuthenticationState(data), before)
        })
        await t.test(
            'OIDC readiness requires the active tested slot, matching identity and local secret; an inactive draft is insufficient',
            async () => {
                const ok = await put({ CUTTLELY_LOCAL_ADMIN: 'true' })
                assert.equal(ok.status, 200, JSON.stringify(ok.body))
                const active = await oidc.readOidcConfiguration(data, 'active')
                for (const damage of ['health', 'proof', 'secret', 'callback', 'link', 'migration', 'slot']) {
                    const before = snapshot()
                    if (damage === 'health')
                        await data.query("UPDATE identity_oidc_configuration SET health = 'error' WHERE slot = 'active'")
                    if (damage === 'proof')
                        await data.query("UPDATE identity_oidc_configuration SET testedFingerprint = NULL WHERE slot = 'active'")
                    if (damage === 'secret') delete process.env.FIXTURE_OIDC_SECRET
                    if (damage === 'callback') process.env.APP_URL = 'not-an-origin'
                    if (damage === 'link')
                        await data.query('UPDATE identity_provider_link SET providerKey = ? WHERE userId = ?', ['wrong-provider', ownerId])
                    if (damage === 'migration')
                        await data.query("UPDATE identity_provider_link_migration SET error = 'fixture failure' WHERE id = 1")
                    if (damage === 'slot') await data.query("DELETE FROM identity_oidc_configuration WHERE slot = 'active'")
                    const res = await put({ CUTTLELY_LOCAL_ADMIN: 'false' })
                    assert.equal(res.status, 409, damage + ': ' + (res.body.code || 'unexpected settings response'))
                    assert.equal(res.body.code, 'NO_WAY_IN')
                    assert.deepEqual(snapshot(), before)
                    if (damage === 'health')
                        await data.query("UPDATE identity_oidc_configuration SET health = 'ready' WHERE slot = 'active'")
                    if (damage === 'proof')
                        await data.query("UPDATE identity_oidc_configuration SET testedFingerprint = ? WHERE slot = 'active'", [
                            active.fingerprint
                        ])
                    if (damage === 'secret') process.env.FIXTURE_OIDC_SECRET = 'fixture-only-not-a-live-secret'
                    if (damage === 'callback') process.env.APP_URL = 'https://app.example.invalid'
                    if (damage === 'link')
                        await data.query('UPDATE identity_provider_link SET providerKey = ? WHERE userId = ?', [
                            (await auth.readAuthenticationState(data)).providerKey,
                            ownerId
                        ])
                    if (damage === 'migration') await data.query('UPDATE identity_provider_link_migration SET error = NULL WHERE id = 1')
                    if (damage === 'slot')
                        await data.query(
                            "INSERT INTO identity_oidc_configuration SELECT 'active', issuer, clientId, clientSecretEnvVar, trustMissingEmailVerification, privateIssuerHosts, fingerprint, discovery, health, healthError, checkedAt, testedFingerprint, testedAt, testResult, version FROM identity_oidc_configuration WHERE slot = 'draft'"
                        )
                }
            }
        )
        await t.test(
            'OIDC to Local uses real stage/apply, changes durable method and ends old sessions; no DELETE API is invented',
            async () => {
                const oldCookie = cookies.owner
                const { before, applied } = await applyMethod('local')
                assert.equal(applied.body.activeMethod, 'local')
                assert.equal(applied.body.authenticationEpoch, before.authenticationEpoch + 1)
                assert.ok(applied.body.sessionsEnded > 0)
                assert.equal((await call('get', 'server-settings', undefined, oldCookie)).status, 401)
                assert.equal((await auth.readAuthenticationState(data)).activeMethod, 'local')
                assert.ok(
                    await oidc.readOidcConfiguration(data, 'active'),
                    'stored provider data remains; it is no longer the selected ordinary method'
                )
                await renew()
            }
        )
        await t.test('WorkOS requires the selected matching installation identity and exact passed AuthKit proof', async () => {
            const values = {
                CUTTLELY_LOCAL_ADMIN: 'true',
                CUTTLELY_LOCAL_USERS: 'true',
                WORKOS_API_KEY: 'sk_test_fixture',
                WORKOS_CLIENT_ID: 'client_fixture',
                WORKOS_REDIRECT_URI: 'https://app.example.invalid/api/v1/auth/callback',
                WORKOS_COOKIE_PASSWORD: 'fixture-seal-password-at-least-32-characters'
            }
            configure(values)
            const proof = serverRequire('./src/settings/authkit-proof.ts')
            proof.writeAuthKitProof(dir, {
                fingerprint: proof.authKitFingerprint(values, key),
                passedAt: new Date().toISOString(),
                by: 'inactive candidate proof fixture',
                environment: 'staging'
            })
            const localBefore = snapshot()
            const inactive = await put({ CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_LOCAL_USERS: 'false' })
            assert.equal(inactive.status, 409)
            assert.equal(inactive.body.code, 'NO_WAY_IN', 'a tested but unselected WorkOS candidate is not ordinary login')
            assert.deepEqual(snapshot(), localBefore)
            fs.rmSync(path.join(dir, proof.AUTHKIT_PROOF_FILE))
            await applyMethod('workos')
            const selected = await auth.readAuthenticationState(data)
            await oidc.createProviderLink(data, {
                providerKey: selected.providerKey,
                subject: 'fixture-workos-subject',
                userId: ownerId,
                emailAtLink: 'owner@example.invalid',
                assuranceBasis: 'email_verified'
            })
            await renew('workos')
            const before = snapshot()
            const untested = await put({ CUTTLELY_LOCAL_ADMIN: 'false' })
            assert.equal(untested.status, 409)
            assert.equal(untested.body.code, 'AUTHKIT_NOT_TESTED')
            assert.deepEqual(snapshot(), before)
            proof.writeAuthKitProof(dir, {
                fingerprint: proof.authKitFingerprint(values, key),
                passedAt: new Date().toISOString(),
                by: 'provider proof fixture',
                environment: 'staging'
            })
            const passed = await put({ CUTTLELY_LOCAL_ADMIN: 'false' })
            assert.equal(passed.status, 200, JSON.stringify(passed.body))
            const committed = snapshot()
            const changed = await put({ WORKOS_CLIENT_ID: 'client_different' })
            assert.equal(changed.status, 409)
            assert.equal(changed.body.code, 'AUTHKIT_NOT_TESTED')
            assert.deepEqual(snapshot(), committed)
            proof.writeAuthKitProof(dir, {
                fingerprint: proof.authKitFingerprint({ ...values, WORKOS_CLIENT_ID: 'client_different' }, key),
                passedAt: new Date().toISOString(),
                by: 'different candidate proof fixture',
                environment: 'staging'
            })
            const mismatch = await put({ WORKOS_CLIENT_ID: 'client_different' })
            assert.equal(mismatch.status, 409)
            assert.equal(mismatch.body.code, 'NO_WAY_IN')
            assert.deepEqual(snapshot(), committed)
        })
    } finally {
        if (app)
            for (const handle of ['compactorTimer', 'itWorkedCleanupTimer', 'auditCleanupTimer'])
                if (app[handle]) clearInterval(app[handle])
        await data.destroy()
        fs.rmSync(root, { recursive: true, force: true })
    }
})
