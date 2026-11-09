// Real upgrade initializer, legacy link migration, readiness and App.config HTTP settings saves.
// Only application accessors, synthetic provider proof and recent session issuance are fixture seams.
// Disposable SQLite; no network, live accounts or readiness boolean mocks.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-warn-'))
for (const name of ['CUTTLELY_INSTANCE_OPERATOR', 'INBOUND_ACCESS_V2', 'CUTTLELY_SETTINGS_HOST_KEYS', 'CUTTLELY_IGNORE_ADMIN_SETTINGS'])
    delete process.env[name]
const workos = {
    WORKOS_API_KEY: 'sk_test_fixture',
    WORKOS_CLIENT_ID: 'client_fixture',
    WORKOS_REDIRECT_URI: 'https://app.example.invalid/api/v1/auth/callback',
    WORKOS_COOKIE_PASSWORD: 'fixture-seal-password-at-least-32-characters'
}
Object.assign(process.env, {
    CUTTLELY_DATA_DIR: root,
    LOG_PATH: path.join(root, 'logs'),
    BLOB_STORAGE_PATH: path.join(root, 'blobs'),
    CUTTLELY_HERMES_HOME: path.join(root, 'runtime'),
    FLOWISE_SECRETKEY_OVERWRITE: 'fixture-breakglass-pepper',
    CUTTLELY_LOCAL_ADMIN: 'false',
    CUTTLELY_LOCAL_USERS: 'true',
    CUTTLELY_VERSIONS: 'false',
    CUTTLELY_DASH_FLOWS: 'false',
    ...workos
})
const { DataSource } = serverRequire('typeorm')
const { entities } = serverRequire('./src/database/entities/index.ts')
const { sqliteMigrations } = serverRequire('./src/database/migrations/sqlite/index.ts')
const { applyAdminSettings } = serverRequire('./src/settings/apply.ts')
const { setServerSettingsDeps } = serverRequire('./src/routes/server-settings/index.ts')
const { writeSettingsFile, SETTINGS_FILE } = serverRequire('./src/settings/store.ts')
const auth = serverRequire('./src/identity/authenticationState.ts')
const oidc = serverRequire('./src/identity/oidcStore.ts')
const proof = serverRequire('./src/settings/authkit-proof.ts')
const request = serverRequire('supertest')
const password = serverRequire('./src/identity/password.ts')
const key = process.env.FLOWISE_SECRETKEY_OVERWRITE
const ownerId = 'owner-1'

test('WorkOS upgrade warning preserves ordinary-login readiness through HTTP', async (t) => {
    const data = new DataSource({
        type: 'sqlite',
        database: path.join(root, 'identity.sqlite'),
        entities: Object.values(entities),
        migrations: sqliteMigrations
    })
    const dir = path.join(root, 'settings')
    const { readHistory } = serverRequire('./src/settings/history.ts')
    const { readSettingsFile } = serverRequire('./src/settings/store.ts')
    const production = serverRequire('./src/identity/production.ts')
    let app, adminState, cookie
    const snapshot = () => ({
        file: fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'),
        history: readHistory(dir)
    })
    const send = (method, route, body) =>
        request(app.app)
            [method]('/api/v1/' + route)
            .set('Cookie', cookie)
            .set('x-request-from', 'internal')
            .send(body)
    const put = (values) => send('put', 'server-settings', { values })
    const renew = async () => {
        await auth.refreshAuthenticationState(data, true)
        const ctx = await production.buildAuthContext({ cookies: {}, headers: {}, query: {}, protocol: 'http' })
        const issued = await serverRequire('./src/identity/handlers.ts').issueApplicationSession(ctx, ownerId, 'workos', {
            recentAuthenticationAt: Date.now()
        })
        assert.ok(issued)
        cookie = 'cuttlely-local-session=' + issued.token
    }
    const writeProof = (candidate = workos) =>
        proof.writeAuthKitProof(dir, {
            fingerprint: proof.authKitFingerprint(candidate, key),
            passedAt: new Date().toISOString(),
            by: 'synthetic accepted provider test',
            environment: 'staging'
        })
    const freshUpgrade = async (mixed = true, tested = true) => {
        await data.dropDatabase()
        await data.runMigrations()
        fs.rmSync(dir, { recursive: true, force: true })
        for (const name of [
            'CUTTLELY_LOCAL_ADMIN',
            'CUTTLELY_LOCAL_USERS',
            'CUTTLELY_SETTINGS_HOST_KEYS',
            'CUTTLELY_SETTINGS_APPLIED',
            'CUTTLELY_SETTINGS_SCRIPT_DEFAULTS'
        ])
            delete process.env[name]
        Object.assign(process.env, workos, { APP_URL: 'https://app.example.invalid', RENDER_EXTERNAL_URL: '' })
        const values = { CUTTLELY_LOCAL_ADMIN: 'true', CUTTLELY_LOCAL_USERS: String(mixed) }
        writeSettingsFile(dir, values, { key, by: 'pre-upgrade saved settings' })
        adminState = applyAdminSettings(process.env)
        assert.ok(adminState.hostKeys.includes('WORKOS_CLIENT_ID'))
        assert.ok(!adminState.hostKeys.includes('CUTTLELY_LOCAL_USERS'))
        const { User, Organization, Workspace, Role, OrganizationUser, WorkspaceUser } = entities
        const hash = await password.hashPassword('F1xture-Password!')
        await data.getRepository(Role).save({ id: '00000000-0000-4000-8000-000000000001', name: 'owner', permissions: '[]' })
        for (const id of [ownerId, 'other-owner']) {
            await data.getRepository(User).save({
                id,
                name: 'Fixture',
                email: id + '@example.invalid',
                credential: hash,
                externalId: id === ownerId ? 'legacy-workos-owner' : null,
                status: 'active',
                createdBy: id,
                updatedBy: id
            })
            await data.getRepository(Organization).save({ id: 'org-' + id, name: 'Fixture', createdBy: id, updatedBy: id })
            await data
                .getRepository(Workspace)
                .save({ id: 'team-' + id, organizationId: 'org-' + id, name: 'Fixture', createdBy: id, updatedBy: id })
            await data.getRepository(OrganizationUser).save({
                organizationId: 'org-' + id,
                userId: id,
                roleId: '00000000-0000-4000-8000-000000000001',
                status: 'active',
                createdBy: id,
                updatedBy: id
            })
            await data.getRepository(WorkspaceUser).save({
                workspaceId: 'team-' + id,
                userId: id,
                roleId: '00000000-0000-4000-8000-000000000001',
                status: 'active',
                createdBy: id,
                updatedBy: id
            })
        }
        assert.equal(await auth.readAuthenticationState(data), null)
        const initialized = await auth.initializeAuthenticationState(data, process.env)
        assert.equal(initialized.activeMethod, 'workos')
        assert.equal(initialized.warningKind, mixed ? 'configuration-ambiguous' : null)
        assert.deepEqual(await auth.readAuthenticationState(data), initialized)
        assert.equal(initialized.configurationFingerprint, auth.workosConfigurationFingerprint(process.env))
        assert.equal(
            initialized.providerKey,
            auth.stableWorkosProviderKey(initialized.installationId, initialized.configurationFingerprint)
        )
        await oidc.migrateLegacyProviderLinks(data, initialized)
        const links = await data.query('SELECT * FROM identity_provider_link WHERE userId = ?', [ownerId])
        assert.equal(links.length, 1)
        assert.equal(links[0].providerKey, initialized.providerKey)
        assert.equal(links[0].assuranceBasis, 'workos_legacy')
        process.env.CUTTLELY_INSTANCE_OPERATOR = JSON.stringify({
            userId: ownerId,
            database: serverRequire('./src/identity/instanceOperator.ts').operatorDatabaseFingerprint(data.options)
        })
        if (tested) writeProof()
        await renew()
        return initialized
    }
    try {
        await data.initialize()
        serverRequire('./src/DataSource.ts').getDataSource = () => data
        await freshUpgrade()
        setServerSettingsDeps(() => ({ env: process.env, state: adminState, key: async () => key }))
        const { App } = serverRequire('./src/index.ts')
        app = new App()
        app.AppDataSource = data
        app.identityManager = { getPlatformType: () => 'open_source' }
        app.sseStreamer = new (serverRequire('./src/utils/SSEStreamer.ts').SSEStreamer)()
        serverRequire('./src/utils/getRunningExpressApp.ts').getRunningExpressApp = () => app
        await app.config()
        for (const mixed of [true, false])
            for (const relevant of [true, false])
                for (const tested of [true, false]) {
                    await t.test(
                        `${mixed ? 'mixed upgrade' : 'plain WorkOS'} / ${relevant ? 'disable compatibility' : 'unrelated'} / ${
                            tested ? 'exact proof' : 'absent proof'
                        }`,
                        async () => {
                            const initialized = await freshUpgrade(mixed, tested)
                            const before = snapshot()
                            const readiness = await auth.readOrdinarySignInReadiness(data, process.env)
                            assert.equal(readiness.activeMethod, 'workos')
                            assert.equal(await auth.automaticWorkosLinkingAllowed(data), true)
                            const original = auth.readOrdinarySignInReadiness
                            let calls = 0
                            auth.readOrdinarySignInReadiness = async (...args) => {
                                calls++
                                return original(...args)
                            }
                            let res
                            try {
                                res = await put(relevant ? { CUTTLELY_LOCAL_ADMIN: 'false' } : { CUTTLELY_CHECK_MAX_TOKENS: '5000' })
                            } finally {
                                auth.readOrdinarySignInReadiness = original
                            }
                            t.diagnostic(
                                JSON.stringify({
                                    mixed,
                                    relevant,
                                    tested,
                                    identityMatches: readiness.workosIdentityMatches,
                                    status: res.status,
                                    code: res.body.code,
                                    wrote: snapshot().file !== before.file
                                })
                            )
                            if (res.status === 409) assert.deepEqual(snapshot(), before)
                            assert.equal(calls, relevant ? 1 : 0)
                            const expected = relevant && !tested ? 409 : 200
                            assert.equal(res.status, expected, res.body.code || 'unexpected HTTP status')
                            if (expected === 409) assert.equal(res.body.code, 'AUTHKIT_NOT_TESTED')
                            else {
                                assert.equal(
                                    readSettingsFile(dir, key).values[relevant ? 'CUTTLELY_LOCAL_ADMIN' : 'CUTTLELY_CHECK_MAX_TOKENS'],
                                    relevant ? 'false' : '5000'
                                )
                                assert.equal(readHistory(dir).length, before.history.length + 1)
                            }
                            assert.equal(readiness.workosIdentityMatches, true)
                            assert.deepEqual(
                                await auth.readAuthenticationState(data),
                                initialized,
                                'save must retain upgrade warning and identity'
                            )
                        }
                    )
                }
        await t.test('mixed upgrade can clear obsolete LOCAL_USERS without applying a method', async () => {
            const initialized = await freshUpgrade()
            const before = snapshot()
            const res = await put({ CUTTLELY_LOCAL_USERS: 'false' })
            t.diagnostic(`LOCAL_USERS cleanup: status=${res.status}, code=${res.body.code}, wrote=${snapshot().file !== before.file}`)
            if (res.status === 409) assert.deepEqual(snapshot(), before)
            assert.equal(res.status, 200, res.body.code || 'unexpected HTTP status')
            assert.equal(readSettingsFile(dir, key).values.CUTTLELY_LOCAL_USERS, 'false')
            assert.equal(readHistory(dir).length, before.history.length + 1)
            assert.deepEqual(await auth.readAuthenticationState(data), initialized)
        })
        for (const damage of [
            'absent proof',
            'stale proof',
            'client mismatch',
            'fingerprint mismatch',
            'provider mismatch',
            'absent link',
            'inactive link account',
            'method-missing',
            'unknown warning'
        ]) {
            await t.test(`refuse ${damage} without settings/history writes`, async () => {
                await freshUpgrade()
                if (damage === 'absent proof') fs.rmSync(path.join(dir, proof.AUTHKIT_PROOF_FILE))
                if (damage === 'stale proof') writeProof({ ...workos, WORKOS_CLIENT_ID: 'client_old' })
                if (damage === 'client mismatch') {
                    process.env.WORKOS_CLIENT_ID = 'client_changed'
                    await auth.initializeAuthenticationState(data, process.env)
                    assert.equal((await auth.readAuthenticationState(data)).warningKind, 'workos-client-mismatch')
                    writeProof(process.env)
                }
                if (damage === 'fingerprint mismatch')
                    await data.query("UPDATE identity_authentication_state SET configurationFingerprint = 'invalid-fingerprint'")
                if (damage === 'provider mismatch') {
                    await data.query("UPDATE identity_authentication_state SET providerKey = 'wrong-provider'")
                    await data.query("UPDATE identity_provider_link SET providerKey = 'wrong-provider'")
                }
                if (damage === 'absent link') await data.query('DELETE FROM identity_provider_link')
                if (damage === 'method-missing' || damage === 'unknown warning') {
                    let warning = 'fixture unexpected warning'
                    if (damage === 'method-missing') {
                        await data.query('DELETE FROM identity_authentication_state')
                        const missing = await auth.initializeAuthenticationState(data, {})
                        assert.equal(missing.warningKind, 'method-missing')
                        warning = missing.warning
                        await data.query('DELETE FROM identity_authentication_state')
                        await auth.initializeAuthenticationState(data, process.env)
                    }
                    // Deliberately damaged persisted warning, never a mocked readiness/classification object.
                    await data.query('UPDATE identity_authentication_state SET warning = ?', [warning])
                }
                // Keep caller authority separate from ordinary-login account evidence for this negative.
                if (damage === 'inactive link account') {
                    await data.query('UPDATE identity_provider_link SET userId = ?', ['other-owner'])
                    await data.query("UPDATE organization_user SET status = 'disable' WHERE userId = 'other-owner'")
                }
                await renew()
                const before = snapshot(),
                    stateBefore = await auth.readAuthenticationState(data)
                const res = await put({ CUTTLELY_LOCAL_ADMIN: 'false', CUTTLELY_CHECK_MAX_TOKENS: '6000' })
                t.diagnostic(`${damage}: status=${res.status}, code=${res.body.code}`)
                assert.equal(res.status, 409, res.body.code || 'unexpected HTTP status')
                assert.equal(res.body.code, ['absent proof', 'stale proof'].includes(damage) ? 'AUTHKIT_NOT_TESTED' : 'NO_WAY_IN')
                assert.deepEqual(snapshot(), before)
                assert.deepEqual(await auth.readAuthenticationState(data), stateBefore)
            })
        }
        await t.test('separate supported method apply clears the informational warning', async () => {
            const before = await freshUpgrade()
            const staged = await send('post', 'authentication-settings/stage', { method: 'local', version: before.version })
            assert.equal(staged.status, 200, JSON.stringify(staged.body))
            const applied = await send('post', 'authentication-settings/apply', {
                method: 'local',
                stage: staged.body.stage,
                stageVersion: staged.body.stageVersion,
                stateVersion: before.version,
                confirm: 'END SESSIONS'
            })
            assert.equal(applied.status, 200, JSON.stringify(applied.body))
            const after = await auth.readAuthenticationState(data)
            assert.equal(after.activeMethod, 'local')
            assert.equal(after.warningKind, null)
            assert.equal(after.warning, null)
            assert.equal(after.authenticationEpoch, before.authenticationEpoch + 1)
        })
    } finally {
        if (app)
            for (const handle of ['compactorTimer', 'itWorkedCleanupTimer', 'auditCleanupTimer'])
                if (app[handle]) clearInterval(app[handle])
        if (data.isInitialized) await data.destroy()
        fs.rmSync(root, { recursive: true, force: true })
    }
})
