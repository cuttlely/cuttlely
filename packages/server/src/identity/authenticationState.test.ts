/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { workosConfigurationFingerprint, stableWorkosProviderKey } from './authenticationState'
import { workosProvider } from './provider'
import { DUMMY_PASSWORD_HASH } from './password'
import { WorkosPort } from './types'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import type { DataSource } from 'typeorm'
import {
    activateFreshOwnerLocalAuthentication,
    automaticWorkosLinkingAllowed,
    acknowledgeAuthenticationWarning,
    initializeAuthenticationState,
    readAuthenticationState,
    refreshAuthenticationState,
    selectedAuthenticationEpoch,
    stageAuthenticationMethodSwitch,
    switchAuthenticationMethod,
    usableLocalOwnerReady
} from './authenticationState'
import { addAuthenticationState, addAuthenticationSwitchStage, addOidcProvider } from './schemaMigration'
import { workosEpochCookie, workosEpochCookieValid } from './cookies'
import { applyAuthKitSwitchOnBoot } from './production'
import { oidcConfigurationFingerprint, readOidcConfiguration } from './oidcStore'
import { beginOidcAuthorization } from './oidcProvider'
import * as production from './production'
import { activateSessionConvergence, resetSessionConvergenceForTests, sessionConvergenceActive } from './sessionConvergence'
import { currentAuthOptionsBody } from './http'
import { signInOptionsBody } from './signInOptions'
import { runUserCommand } from './cli'

const GOOD_PASSWORD = 'Sup3r-Secret!'

async function database(type: 'sqlite' | 'postgres' = 'sqlite', name = '', ownerSchema = false): Promise<DataSource> {
    const candidates = [
        path.join(__dirname, '../../node_modules/typeorm/package.json'),
        path.join(__dirname, '../../../../node_modules/typeorm/package.json')
    ]
    const pkgPath = candidates.find((candidate) => fs.existsSync(candidate))
    if (!pkgPath) throw new Error('database package was not found')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { main?: string }
    const RealDataSource = (
        createRequire(pkgPath)(path.join(path.dirname(pkgPath), pkg.main || 'index.js')) as { DataSource: typeof DataSource }
    ).DataSource
    const db =
        type === 'postgres'
            ? new RealDataSource({
                  type: 'postgres',
                  host: process.env.CUTTLELY_TEST_PG_HOST || process.env.PGHOST || '127.0.0.1',
                  port: Number(process.env.CUTTLELY_TEST_PG_PORT || process.env.PGPORT || 5432),
                  username: 'postgres',
                  password: process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD,
                  database: name,
                  entities: []
              })
            : new RealDataSource({ type: 'sqlite', database: ':memory:', entities: [] })
    await db.initialize()
    const runner = db.createQueryRunner()
    await addAuthenticationState(runner)
    await addAuthenticationSwitchStage(runner)
    await addOidcProvider(runner)
    await runner.query(
        `CREATE TABLE "identity_authkit_switch" ("id" integer PRIMARY KEY, "configured" integer NOT NULL, "sessionsEnded" integer NOT NULL, "switchedAt" ${
            type === 'postgres' ? 'timestamp' : 'datetime'
        } NULL)`
    )
    await runner.query(
        `CREATE TABLE "identity_session_convergence" ("id" integer PRIMARY KEY, "cutoffAt" ${
            type === 'postgres' ? 'timestamp' : 'datetime'
        } NOT NULL)`
    )
    await runner.query(
        `CREATE TABLE "identity_local_session" ("id" varchar(36) PRIMARY KEY, "userId" varchar(36) NOT NULL, "token" varchar(64) NOT NULL,
         "expiresAt" ${type === 'postgres' ? 'timestamp' : 'datetime'} NULL,
         "absoluteExpiresAt" ${type === 'postgres' ? 'timestamp' : 'datetime'} NULL,
         "createdDate" ${type === 'postgres' ? 'timestamp' : 'datetime'} NULL,
         "authenticationMethod" varchar(32) NULL)`
    )
    if (ownerSchema) {
        await runner.query('CREATE TABLE "identity_bootstrap" ("id" integer PRIMARY KEY)')
        await runner.query(
            'CREATE TABLE "user" ("id" varchar(36) PRIMARY KEY, "name" varchar(100), "email" varchar(255), "credential" text, "status" varchar(20), "externalId" varchar(255), "createdBy" varchar(36), "updatedBy" varchar(36))'
        )
        await runner.query(
            'CREATE TABLE "organization" ("id" varchar(36) PRIMARY KEY, "name" varchar(100), "createdBy" varchar(36), "updatedBy" varchar(36))'
        )
        await runner.query(
            'CREATE TABLE "role" ("id" varchar(36) PRIMARY KEY, "organizationId" varchar(36), "name" varchar(100), "permissions" text, "createdBy" varchar(36), "updatedBy" varchar(36))'
        )
        await runner.query(
            'CREATE TABLE "workspace" ("id" varchar(36) PRIMARY KEY, "name" varchar(100), "organizationId" varchar(36), "createdBy" varchar(36), "updatedBy" varchar(36))'
        )
        await runner.query(
            'CREATE TABLE "organization_user" ("organizationId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20), "createdBy" varchar(36), "updatedBy" varchar(36))'
        )
        await runner.query(
            'CREATE TABLE "workspace_user" ("workspaceId" varchar(36), "userId" varchar(36), "roleId" varchar(36), "status" varchar(20), "createdBy" varchar(36), "updatedBy" varchar(36))'
        )
    } else {
        await runner.query('CREATE TABLE "user" ("id" varchar(36) PRIMARY KEY, "credential" text, "status" varchar(20))')
        await runner.query('CREATE TABLE "role" ("id" varchar(36) PRIMARY KEY, "name" varchar(100))')
        await runner.query('CREATE TABLE "organization_user" ("userId" varchar(36), "roleId" varchar(36), "status" varchar(20))')
    }
    await runner.query('CREATE TABLE "api_key" ("id" varchar(36) PRIMARY KEY)')
    await runner.query(
        'CREATE TABLE "audit_event" ("id" varchar(36) PRIMARY KEY, "type" varchar(80), "organizationId" varchar(36), "workspaceId" varchar(36), "userId" varchar(36), "actorId" varchar(36), "summary" varchar(255), "detail" text, "createdAt" bigint)'
    )
    await runner.release()
    return db
}

async function withEnvironment<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    Object.entries(values).forEach(([key, value]) => (value === undefined ? delete process.env[key] : (process.env[key] = value)))
    try {
        return await run()
    } finally {
        Object.entries(saved).forEach(([key, value]) => (value === undefined ? delete process.env[key] : (process.env[key] = value)))
    }
}

async function authenticationOptions(dataSource: DataSource) {
    const source = jest.spyOn(production, 'applicationDataSource').mockReturnValue(dataSource)
    try {
        return await currentAuthOptionsBody()
    } finally {
        source.mockRestore()
    }
}

describe('authentication provider foundation', () => {
    afterEach(() => {
        jest.restoreAllMocks()
        resetSessionConvergenceForTests()
    })

    it('records the convergence cutoff once across repeated starts', async () => {
        const db = await database()
        const first = await activateSessionConvergence(db, Date.parse('2026-10-30T12:00:00.000Z'))
        const second = await activateSessionConvergence(db, Date.parse('2026-10-31T12:00:00.000Z'))
        expect(first).toEqual({ created: true, cutoffAt: '2026-10-30T12:00:00.000Z' })
        expect(second).toEqual({ created: false, cutoffAt: first.cutoffAt })
        expect(sessionConvergenceActive()).toBe(true)
        expect(await db.query('SELECT * FROM "identity_session_convergence"')).toHaveLength(1)
        await db.destroy()
    })

    it('fingerprints issuer and client id without including the API key', () => {
        const first = workosConfigurationFingerprint({ WORKOS_CLIENT_ID: 'client-a', WORKOS_API_KEY: 'secret-a' })
        const second = workosConfigurationFingerprint({ WORKOS_CLIENT_ID: 'client-a', WORKOS_API_KEY: 'secret-b' })
        expect(first).toBe(second)
        expect(first).toMatch(/^[a-f0-9]{64}$/)
        expect(workosConfigurationFingerprint({ WORKOS_API_KEY: 'secret-a' })).toBeNull()
    })

    it('scopes the stable provider key to the database installation', () => {
        const fingerprint = workosConfigurationFingerprint({ WORKOS_CLIENT_ID: 'client-a' }) as string
        expect(stableWorkosProviderKey('installation-a', fingerprint)).not.toBe(stableWorkosProviderKey('installation-b', fingerprint))
    })

    it('keeps the existing WorkosPort object as the compatibility adapter', () => {
        const port = {} as WorkosPort
        const provider = workosProvider(port, () => true)
        expect(provider.kind).toBe('workos')
        expect(provider.configurationStatus()).toEqual({ configured: true })
        expect(provider.compatibility).toBe(port)
    })

    it.each([
        ['WorkOS', { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: undefined }, 'workos', null],
        ['local user', { WORKOS_API_KEY: undefined, WORKOS_CLIENT_ID: undefined, CUTTLELY_LOCAL_USERS: 'true' }, 'local', null],
        [
            'owner only',
            { WORKOS_API_KEY: undefined, WORKOS_CLIENT_ID: undefined, CUTTLELY_LOCAL_USERS: undefined, CUTTLELY_LOCAL_ADMIN: 'true' },
            null,
            null
        ],
        ['ambiguous', { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, 'workos', 'Both ordinary']
    ])('infers the %s upgrade once and idempotently', async (_name, env, method, warning) => {
        const db = await database()
        const first = await initializeAuthenticationState(db, env)
        const second = await initializeAuthenticationState(db, env)
        expect(first.activeMethod).toBe(method)
        expect(first.inferredAt).toBe(second.inferredAt)
        expect(first.version).toBe(second.version)
        expect(first.warning).toEqual(warning ? expect.stringContaining(warning) : null)
        expect(first.warningKind).toBe(warning ? 'configuration-ambiguous' : null)
        await db.destroy()
    })

    it('keeps mailbox linking enabled for a mixed local-user and WorkOS upgrade', async () => {
        const env = { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }
        const db = await database()
        const state = await initializeAuthenticationState(db, env)
        expect(state.warningKind).toBe('configuration-ambiguous')
        await withEnvironment(env, async () => {
            expect(await automaticWorkosLinkingAllowed(db)).toBe(true)
        })
        await db.destroy()
    })

    it('switches method, epoch, recovery sessions, and audit atomically while retaining API keys', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
            const db = await database()
            const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
            await db.query('INSERT INTO "identity_local_session" ("id", "userId", "token") VALUES (?, ?, ?)', [
                'recovery-session',
                'user',
                'token'
            ])
            await db.query('INSERT INTO "api_key" VALUES (?)', ['key'])
            const after = await switchAuthenticationMethod(db, 'workos', before.version, {
                organizationId: 'org',
                actorId: 'user'
            })
            expect(after.authenticationEpoch).toBe(before.authenticationEpoch + 1)
            expect(after.authenticationBaselineEpoch).toBe(before.authenticationEpoch)
            expect(await db.query('SELECT * FROM "identity_local_session"')).toHaveLength(0)
            expect(await db.query('SELECT * FROM "api_key"')).toHaveLength(1)
            const audit = await db.query('SELECT "detail" FROM "audit_event"')
            expect(JSON.parse(audit[0].detail)).toMatchObject({ outcome: 'applied', configurationFingerprint: expect.any(String) })
            await db.destroy()
        })
    })

    it('activates a tested private-host allowlist change while OIDC remains selected', async () => {
        const db = await database()
        const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
        const configuration = (privateIssuerHosts: string[]) => {
            const safe = {
                issuer: 'https://id.example',
                clientId: 'client',
                clientSecretEnvVar: 'OIDC_CLIENT_SECRET',
                trustMissingEmailVerification: false,
                privateIssuerHosts
            }
            return { ...safe, fingerprint: oidcConfigurationFingerprint(safe) }
        }
        const first = configuration([])
        await db.query(
            `INSERT INTO "identity_oidc_configuration" ("slot", "issuer", "clientId", "clientSecretEnvVar", "trustMissingEmailVerification", "privateIssuerHosts", "fingerprint", "discovery", "health", "healthError", "checkedAt", "testedFingerprint", "testedAt", "testResult", "version") VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, ?, ?)`,
            [
                'draft',
                first.issuer,
                first.clientId,
                first.clientSecretEnvVar,
                0,
                JSON.stringify(first.privateIssuerHosts),
                first.fingerprint,
                'ready',
                first.fingerprint,
                JSON.stringify({ identityAccepted: true }),
                1
            ]
        )
        await db.query(
            `INSERT INTO "identity_provider_link_migration" ("id", "providerKey", "migratedCount", "inertCount", "completedAt", "error") VALUES (?, NULL, 0, 0, ?, NULL)`,
            [1, Date.now()]
        )
        const active = await switchAuthenticationMethod(db, 'oidc', before.version)
        const changed = configuration(['127.0.0.1'])
        await db.query(
            `UPDATE "identity_oidc_configuration" SET "privateIssuerHosts" = ?, "fingerprint" = ?, "testedFingerprint" = ?, "version" = "version" + 1 WHERE "slot" = 'draft'`,
            [JSON.stringify(changed.privateIssuerHosts), changed.fingerprint, changed.fingerprint]
        )
        const after = await switchAuthenticationMethod(db, 'oidc', active.version)
        const [stored] = await db.query(
            `SELECT "privateIssuerHosts", "fingerprint" FROM "identity_oidc_configuration" WHERE "slot" = 'active'`
        )
        expect(JSON.parse(stored.privateIssuerHosts)).toEqual(['127.0.0.1'])
        expect(stored.fingerprint).toBe(changed.fingerprint)
        expect(after.version).toBeGreaterThan(active.version)
        await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['owner', DUMMY_PASSWORD_HASH, 'active'])
        await db.query('INSERT INTO "role" VALUES (?, ?)', ['owner-role', 'owner'])
        await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['owner', 'owner-role', 'active'])
        await db.query('INSERT INTO "identity_local_session" ("id", "userId", "token") VALUES (?, ?, ?)', [
            'keep-session',
            'owner',
            'keep-token'
        ])
        await withEnvironment({ CUTTLELY_LOCAL_ADMIN: 'true' }, async () => {
            const staged = await stageAuthenticationMethodSwitch(db, 'owner', 'oidc', after.version, changed.fingerprint)
            const unchanged = await switchAuthenticationMethod(db, 'oidc', after.version, undefined, {
                id: staged.id,
                actorId: 'owner',
                version: staged.version
            })
            expect(unchanged).toMatchObject({
                version: after.version,
                authenticationEpoch: after.authenticationEpoch,
                sessionsEnded: after.sessionsEnded
            })
        })
        expect(await db.query('SELECT * FROM "identity_local_session"')).toHaveLength(1)
        expect(await db.query(`SELECT * FROM "identity_oidc_configuration" WHERE "slot" = 'active'`)).toHaveLength(1)
        await db.destroy()
    })

    it('applies refreshed tested OIDC metadata without ending sessions or changing the epoch', async () => {
        const db = await database()
        const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
        const base = {
            issuer: 'https://id.example',
            clientId: 'client',
            clientSecretEnvVar: 'OIDC_CLIENT_SECRET',
            trustMissingEmailVerification: false,
            privateIssuerHosts: [] as string[]
        }
        const fingerprint = oidcConfigurationFingerprint(base)
        const discovery = (authorization_endpoint: string) => ({
            issuer: base.issuer,
            authorization_endpoint,
            token_endpoint: 'https://id.example/token',
            jwks_uri: 'https://id.example/jwks',
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['RS256']
        })
        await db.query(
            `INSERT INTO "identity_oidc_configuration" ("slot", "issuer", "clientId", "clientSecretEnvVar", "trustMissingEmailVerification", "privateIssuerHosts", "fingerprint", "discovery", "health", "healthError", "checkedAt", "testedFingerprint", "testedAt", "testResult", "version") VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'ready', NULL, NULL, ?, NULL, ?, 1)`,
            [
                'draft',
                base.issuer,
                base.clientId,
                base.clientSecretEnvVar,
                '[]',
                fingerprint,
                JSON.stringify(discovery('https://id.example/old')),
                fingerprint,
                JSON.stringify({ identityAccepted: true })
            ]
        )
        await db.query(
            `INSERT INTO "identity_provider_link_migration" ("id", "providerKey", "migratedCount", "inertCount", "completedAt", "error") VALUES (?, NULL, 0, 0, ?, NULL)`,
            [1, Date.now()]
        )
        const active = await switchAuthenticationMethod(db, 'oidc', before.version)
        await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['owner', DUMMY_PASSWORD_HASH, 'active'])
        await db.query('INSERT INTO "role" VALUES (?, ?)', ['owner-role', 'owner'])
        await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['owner', 'owner-role', 'active'])
        await db.query('INSERT INTO "identity_local_session" ("id", "userId", "token") VALUES (?, ?, ?)', [
            'keep-session',
            'owner',
            'keep-token'
        ])

        await db.query(`UPDATE "identity_oidc_configuration" SET "discovery" = ?, "version" = "version" + 1 WHERE "slot" = 'draft'`, [
            JSON.stringify(discovery('https://id.example/new'))
        ])
        await withEnvironment({ CUTTLELY_LOCAL_ADMIN: 'true' }, async () => {
            const stale = await stageAuthenticationMethodSwitch(db, 'owner', 'oidc', active.version, fingerprint)
            await db.query(`UPDATE "identity_oidc_configuration" SET "discovery" = ?, "version" = "version" + 1 WHERE "slot" = 'draft'`, [
                JSON.stringify(discovery('https://id.example/refreshed'))
            ])
            await expect(
                switchAuthenticationMethod(
                    db,
                    'oidc',
                    active.version,
                    { organizationId: 'org', actorId: 'owner' },
                    { id: stale.id, actorId: 'owner', version: stale.version }
                )
            ).rejects.toThrow('AUTH_STAGE_STALE')

            const staged = await stageAuthenticationMethodSwitch(db, 'owner', 'oidc', active.version, fingerprint)
            const refreshed = await switchAuthenticationMethod(
                db,
                'oidc',
                active.version,
                { organizationId: 'org', actorId: 'owner' },
                { id: staged.id, actorId: 'owner', version: staged.version }
            )
            expect(refreshed).toMatchObject({
                change: 'oidc_refresh',
                version: active.version,
                authenticationEpoch: active.authenticationEpoch,
                sessionsEnded: active.sessionsEnded
            })
            expect(await db.query('SELECT * FROM "identity_local_session"')).toHaveLength(1)
            expect((await readOidcConfiguration(db, 'active'))?.discovery).toMatchObject({
                authorization_endpoint: 'https://id.example/refreshed'
            })
            const audit = await db.query('SELECT "type", "summary", "detail" FROM "audit_event"')
            expect(audit).toHaveLength(1)
            expect(audit[0]).toMatchObject({ type: 'auth_config_change', summary: 'OIDC provider settings applied' })
            expect(JSON.parse(audit[0].detail)).toMatchObject({ outcome: 'applied_to_active', configurationFingerprint: fingerprint })

            const again = await stageAuthenticationMethodSwitch(db, 'owner', 'oidc', active.version, fingerprint)
            await expect(
                switchAuthenticationMethod(
                    db,
                    'oidc',
                    active.version,
                    { organizationId: 'org', actorId: 'owner' },
                    {
                        id: again.id,
                        actorId: 'owner',
                        version: again.version
                    }
                )
            ).resolves.toMatchObject({ change: 'none', version: active.version, authenticationEpoch: active.authenticationEpoch })
            expect(await db.query('SELECT * FROM "audit_event"')).toHaveLength(1)
        })

        await withEnvironment({ TOKEN_HASH_SECRET: 'test-transaction-secret' }, async () => {
            const begun = await beginOidcAuthorization({
                dataSource: db,
                slot: 'active',
                installationId: active.installationId,
                authenticationEpoch: active.authenticationEpoch,
                callbackUrl: 'http://127.0.0.1:3000/api/v1/auth/oidc/callback',
                redirectTarget: '/',
                purpose: 'signin'
            })
            expect(begun.url).toContain('https://id.example/refreshed?')
        })

        await db.query(`UPDATE "identity_oidc_configuration" SET "testResult" = NULL WHERE "slot" = 'draft'`)
        await expect(switchAuthenticationMethod(db, 'oidc', active.version)).rejects.toThrow('OIDC_TEST_REQUIRED')
        await db.query(
            `UPDATE "identity_oidc_configuration" SET "testedFingerprint" = NULL, "testResult" = ?, "version" = "version" + 1 WHERE "slot" = 'draft'`,
            [JSON.stringify({ identityAccepted: true })]
        )
        await expect(switchAuthenticationMethod(db, 'oidc', active.version)).rejects.toThrow('OIDC_TEST_REQUIRED')
        expect(await db.query('SELECT * FROM "identity_local_session"')).toHaveLength(1)
        await db.destroy()
    })

    it('counts usable current sessions and live legacy sessions without an authentication method when switching', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
            const db = await database()
            const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
            const cutoff = Date.parse('2026-10-30T12:00:00.000Z')
            const switchAt = Date.parse('2026-10-30T13:00:00.000Z')
            await activateSessionConvergence(db, cutoff)
            const insert = async (
                id: string,
                expiresAt: number,
                absoluteExpiresAt: number,
                createdDate: number,
                authenticationMethod: string | null
            ) =>
                db.query(
                    'INSERT INTO "identity_local_session" ("id", "userId", "token", "expiresAt", "absoluteExpiresAt", "createdDate", "authenticationMethod") VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [id, 'user', id, expiresAt, absoluteExpiresAt, createdDate, authenticationMethod]
                )
            await insert('usable-local', switchAt + 1, switchAt + 2, switchAt - 1, 'local')
            await insert('idle-ended', switchAt - 1, switchAt + 2, switchAt - 2, 'local')
            await insert('absolute-ended', switchAt + 1, switchAt - 1, switchAt - 2, 'local')
            await insert('cutoff-workos', switchAt + 1, switchAt + 2, cutoff, 'workos')
            await insert('new-workos', switchAt + 1, switchAt + 2, switchAt, 'workos')
            await insert('legacy-null', switchAt + 1, switchAt + 2, cutoff, null)

            const clock = jest.spyOn(Date, 'now').mockReturnValue(switchAt)
            let after
            try {
                after = await switchAuthenticationMethod(db, 'workos', before.version)
            } finally {
                clock.mockRestore()
            }

            expect(after.sessionsEnded).toBe(3)
            expect(await db.query('SELECT * FROM "identity_local_session"')).toHaveLength(0)
            await db.destroy()
        })
    })

    it('reports panel switches through /auth/options from durable state in both directions', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
            const db = await database()
            const local = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
            await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['owner', DUMMY_PASSWORD_HASH, 'active'])
            await db.query('INSERT INTO "role" VALUES (?, ?)', ['owner-role', 'owner'])
            await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['owner', 'owner-role', 'active'])
            const expiresAt = Date.now() + 60_000
            await db.query(
                'INSERT INTO "identity_local_session" ("id", "userId", "token", "expiresAt", "absoluteExpiresAt", "createdDate", "authenticationMethod") VALUES (?, ?, ?, ?, ?, ?, ?)',
                ['local-session', 'owner', 'local-token', expiresAt, expiresAt, Date.now(), 'local']
            )

            const workos = await switchAuthenticationMethod(db, 'workos', local.version)
            const workosOptions = await authenticationOptions(db)
            expect(workosOptions.status).toMatchObject({
                authKit: true,
                localPasswordSignIn: false,
                localSessions: 'ended',
                sessionsEnded: 1
            })

            await db.query(
                'INSERT INTO "identity_local_session" ("id", "userId", "token", "expiresAt", "absoluteExpiresAt", "createdDate", "authenticationMethod") VALUES (?, ?, ?, ?, ?, ?, ?)',
                ['workos-session', 'owner', 'workos-token', expiresAt, expiresAt, Date.now(), 'workos']
            )
            await db.query(
                'INSERT INTO "identity_local_session" ("id", "userId", "token", "expiresAt", "absoluteExpiresAt", "createdDate", "authenticationMethod") VALUES (?, ?, ?, ?, ?, ?, ?)',
                ['workos-session-2', 'owner', 'workos-token-2', expiresAt, expiresAt, Date.now(), 'workos']
            )
            await switchAuthenticationMethod(db, 'local', workos.version)
            const localOptions = await authenticationOptions(db)
            expect(localOptions.status).toMatchObject({
                authKit: false,
                localPasswordSignIn: true,
                localSessions: 'open',
                sessionsEnded: 2
            })
            await db.destroy()
        })
    })

    it('requires local users when changing from WorkOS to Local', async () => {
        await withEnvironment(
            {
                WORKOS_API_KEY: 'set',
                WORKOS_CLIENT_ID: 'client',
                CUTTLELY_LOCAL_ADMIN: 'true',
                CUTTLELY_LOCAL_USERS: undefined
            },
            async () => {
                const db = await database()
                const before = await initializeAuthenticationState(db)
                await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['owner', DUMMY_PASSWORD_HASH, 'active'])
                await db.query('INSERT INTO "role" VALUES (?, ?)', ['owner-role', 'owner'])
                await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['owner', 'owner-role', 'active'])
                const staged = await stageAuthenticationMethodSwitch(db, 'owner', 'local', before.version)
                await expect(
                    switchAuthenticationMethod(db, 'local', before.version, undefined, {
                        id: staged.id,
                        actorId: 'owner',
                        version: staged.version
                    })
                ).rejects.toThrow('METHOD_NOT_READY')
                await db.destroy()
            }
        )
    })

    it('changes from WorkOS to Local when local users are enabled', async () => {
        await withEnvironment(
            {
                WORKOS_API_KEY: 'set',
                WORKOS_CLIENT_ID: 'client',
                CUTTLELY_LOCAL_ADMIN: 'true',
                CUTTLELY_LOCAL_USERS: 'true'
            },
            async () => {
                const db = await database()
                const before = await initializeAuthenticationState(db)
                await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['owner', DUMMY_PASSWORD_HASH, 'active'])
                await db.query('INSERT INTO "role" VALUES (?, ?)', ['owner-role', 'owner'])
                await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['owner', 'owner-role', 'active'])
                const staged = await stageAuthenticationMethodSwitch(db, 'owner', 'local', before.version)
                const after = await switchAuthenticationMethod(db, 'local', before.version, undefined, {
                    id: staged.id,
                    actorId: 'owner',
                    version: staged.version
                })
                expect(after.activeMethod).toBe('local')
                await db.destroy()
            }
        )
    })

    it('records first-boot WorkOS inference in the durable compatibility view', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client' }, async () => {
            const db = await database()
            await db.query('INSERT INTO "identity_local_session" ("id", "userId", "token") VALUES (?, ?, ?)', [
                'local-session',
                'owner',
                'token'
            ])
            expect(await applyAuthKitSwitchOnBoot(db)).toEqual({ ended: 1 })
            const options = await authenticationOptions(db)
            expect(options.status).toMatchObject({ localSessions: 'ended', sessionsEnded: 1 })
            await db.destroy()
        })
    })

    it('refuses a staged WorkOS activation when recovery stopped being ready after staging', async () => {
        await withEnvironment(
            { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true', CUTTLELY_LOCAL_ADMIN: 'true' },
            async () => {
                const db = await database()
                const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
                await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['owner', DUMMY_PASSWORD_HASH, 'active'])
                await db.query('INSERT INTO "role" VALUES (?, ?)', ['owner-role', 'owner'])
                await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['owner', 'owner-role', 'active'])
                const staged = await stageAuthenticationMethodSwitch(db, 'owner', 'workos', before.version)
                await db.query('UPDATE "user" SET "credential" = NULL')
                await expect(
                    switchAuthenticationMethod(db, 'workos', before.version, undefined, {
                        id: staged.id,
                        actorId: 'owner',
                        version: staged.version
                    })
                ).rejects.toThrow('RECOVERY_REQUIRED')
                const [row] = await db.query('SELECT "activeMethod", "authenticationEpoch" FROM "identity_authentication_state"')
                expect(row).toMatchObject({ activeMethod: 'local', authenticationEpoch: before.authenticationEpoch })
                await db.destroy()
            }
        )
    })

    it('applies a durable stage from another process and refuses its stale version and reuse', async () => {
        await withEnvironment(
            { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true', CUTTLELY_LOCAL_ADMIN: 'true' },
            async () => {
                const db = await database()
                const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
                await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['owner', DUMMY_PASSWORD_HASH, 'active'])
                await db.query('INSERT INTO "role" VALUES (?, ?)', ['owner-role', 'owner'])
                await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['owner', 'owner-role', 'active'])
                const staged = await stageAuthenticationMethodSwitch(db, 'owner', 'workos', before.version)
                await expect(
                    switchAuthenticationMethod(db, 'workos', before.version, undefined, {
                        id: staged.id,
                        actorId: 'owner',
                        version: staged.version + 1
                    })
                ).rejects.toThrow('AUTH_STAGE_STALE')
                const after = await switchAuthenticationMethod(db, 'workos', before.version, undefined, {
                    id: staged.id,
                    actorId: 'owner',
                    version: staged.version
                })
                expect(after.activeMethod).toBe('workos')
                await expect(
                    switchAuthenticationMethod(db, 'local', after.version, undefined, {
                        id: staged.id,
                        actorId: 'owner',
                        version: staged.version
                    })
                ).rejects.toThrow('AUTH_STAGE_STALE')
                await db.destroy()
            }
        )
    })

    it('finds any active owner with a local password, not only the oldest owner', async () => {
        const db = await database()
        await db.query('INSERT INTO "role" VALUES (?, ?)', ['owner-role', 'owner'])
        await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['first-owner', null, 'active'])
        await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['first-owner', 'owner-role', 'active'])
        expect(await usableLocalOwnerReady(db)).toBe(false)
        await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['placeholder-owner', 'not-a-password-hash', 'active'])
        await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['placeholder-owner', 'owner-role', 'active'])
        expect(await usableLocalOwnerReady(db)).toBe(false)
        await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['second-owner', DUMMY_PASSWORD_HASH, 'active'])
        await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['second-owner', 'owner-role', 'active'])
        expect(await usableLocalOwnerReady(db)).toBe(true)
        await db.destroy()
    })

    it('rejects an old sealed WorkOS cookie after a WorkOS to Local to WorkOS round trip', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
            const db = await database()
            const first = await initializeAuthenticationState(db, { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client' })
            await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['owner', DUMMY_PASSWORD_HASH, 'active'])
            await db.query('INSERT INTO "role" VALUES (?, ?)', ['owner-role', 'owner'])
            await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['owner', 'owner-role', 'active'])
            const password = 'p'.repeat(44)
            const sealed = 'sealed-before-switches'
            const claim = workosEpochCookie(sealed, first.authenticationEpoch, password, false).value
            const local = await switchAuthenticationMethod(db, 'local', first.version)
            const workos = await switchAuthenticationMethod(db, 'workos', local.version)
            expect(workos.authenticationEpoch).toBe(first.authenticationEpoch + 2)
            expect(workosEpochCookieValid(claim, sealed, workos.authenticationEpoch, password)).toBe(false)
            await db.destroy()
        })
    })

    it('keeps the epoch and local sessions when the owner password disappears after staging', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
            const db = await database()
            const before = await initializeAuthenticationState(db, { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client' })
            await db.query('INSERT INTO "user" VALUES (?, ?, ?)', ['owner', DUMMY_PASSWORD_HASH, 'active'])
            await db.query('INSERT INTO "role" VALUES (?, ?)', ['owner-role', 'owner'])
            await db.query('INSERT INTO "organization_user" VALUES (?, ?, ?)', ['owner', 'owner-role', 'active'])
            await db.query('INSERT INTO "identity_local_session" ("id", "userId", "token") VALUES (?, ?, ?)', ['session', 'owner', 'token'])
            const staged = await stageAuthenticationMethodSwitch(db, 'owner', 'local', before.version)
            await db.query('UPDATE "user" SET "credential" = NULL WHERE "id" = ?', ['owner'])
            await expect(
                switchAuthenticationMethod(db, 'local', before.version, undefined, {
                    id: staged.id,
                    actorId: 'owner',
                    version: staged.version
                })
            ).rejects.toThrow('LOCAL_OWNER_REQUIRED')
            const unchanged = await initializeAuthenticationState(db)
            expect(unchanged.authenticationEpoch).toBe(before.authenticationEpoch)
            expect(await db.query('SELECT * FROM "identity_local_session"')).toHaveLength(1)
            await db.destroy()
        })
    })

    it('blocks new mailbox linking after a fingerprint mismatch until acknowledgment restores it', async () => {
        const db = await database()
        const before = await initializeAuthenticationState(db, { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'first' })
        const mismatch = await initializeAuthenticationState(db, { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'second' })
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'second' }, async () => {
            const cutoff = Date.parse('2026-10-30T12:00:00.000Z')
            const acknowledgedAt = Date.parse('2026-10-30T13:00:00.000Z')
            await activateSessionConvergence(db, cutoff)
            const insert = (id: string, expiresAt: number, authenticationMethod: string | null, createdDate = cutoff) =>
                db.query(
                    'INSERT INTO "identity_local_session" ("id", "userId", "token", "expiresAt", "absoluteExpiresAt", "createdDate", "authenticationMethod") VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [id, 'owner', id, expiresAt, acknowledgedAt + 2, createdDate, authenticationMethod]
                )
            await insert('current-session', acknowledgedAt + 1, 'workos', acknowledgedAt)
            await insert('legacy-session', acknowledgedAt + 1, null)
            await insert('expired-session', acknowledgedAt - 1, 'local')
            expect(await automaticWorkosLinkingAllowed(db)).toBe(false)
            const clock = jest.spyOn(Date, 'now').mockReturnValue(acknowledgedAt)
            let acknowledged
            try {
                acknowledged = await acknowledgeAuthenticationWarning(db, mismatch.version, {
                    organizationId: 'org',
                    actorId: 'owner'
                })
            } finally {
                clock.mockRestore()
            }
            expect(acknowledged.warning).toBeNull()
            expect(acknowledged.warningKind).toBeNull()
            expect(acknowledged.authenticationEpoch).toBe(before.authenticationEpoch + 1)
            expect(acknowledged.sessionsEnded).toBe(2)
            expect(acknowledged.changedAt).toBe(new Date(acknowledgedAt).toISOString())
            expect(await db.query('SELECT * FROM "identity_local_session"')).toHaveLength(0)
            const [audit] = await db.query('SELECT "detail" FROM "audit_event"')
            expect(JSON.parse(audit.detail)).toMatchObject({
                authenticationEpoch: before.authenticationEpoch + 1,
                sessionsEnded: 2,
                outcome: 'acknowledged'
            })
            expect(await automaticWorkosLinkingAllowed(db)).toBe(true)
        })
        expect(mismatch.warningKind).toBe('workos-client-mismatch')
        await db.destroy()
    })

    it('adopts the row created by another process that started at the same time', async () => {
        const db = await database()
        const winner = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
        const createQueryRunner = db.createQueryRunner.bind(db)
        let hidden = false
        jest.spyOn(db, 'createQueryRunner').mockImplementation((...args) => {
            const runner = createQueryRunner(...args)
            const original = runner.query.bind(runner)
            runner.query = (async (sql: string, parameters?: unknown[]) => {
                if (!hidden && /^SELECT \* FROM "identity_authentication_state"/.test(sql)) {
                    hidden = true
                    return []
                }
                return original(sql, parameters)
            }) as typeof runner.query
            return runner
        })
        const loser = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
        expect(hidden).toBe(true)
        expect(loser.installationId).toBe(winner.installationId)
        expect(loser.version).toBe(winner.version)
        jest.restoreAllMocks()
        await db.destroy()
    })

    it('refreshes a changed epoch from the shared database for another process view', async () => {
        const db = await database()
        const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
        await db.query('UPDATE "identity_authentication_state" SET "authenticationEpoch" = "authenticationEpoch" + 1')
        await refreshAuthenticationState(db, true)
        expect(selectedAuthenticationEpoch()).toBe(before.authenticationEpoch + 1)
        await db.destroy()
    })

    it('keeps /auth/options durable after a panel switch and restart without repeating the session cutoff', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
            const db = await database()
            const local = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
            await switchAuthenticationMethod(db, 'workos', local.version)
            await db.query('INSERT INTO "identity_local_session" ("id", "userId", "token") VALUES (?, ?, ?)', [
                'recovery-session',
                'owner',
                'token'
            ])
            expect(await applyAuthKitSwitchOnBoot(db)).toBeNull()
            expect(await db.query('SELECT * FROM "identity_local_session"')).toHaveLength(1)
            const options = await authenticationOptions(db)
            expect(options.status).toMatchObject({ localSessions: 'ended', sessionsEnded: 0 })
            await db.destroy()
        })
    })

    it('selects Local and writes the method-change audit in the first-owner transaction', async () => {
        const db = await database()
        const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_ADMIN: 'true' })
        expect(before.activeMethod).toBeNull()
        const runner = db.createQueryRunner()
        await runner.connect()
        await runner.startTransaction()
        await activateFreshOwnerLocalAuthentication(
            runner,
            { organizationId: 'organization-1', actorId: 'owner-1' },
            Date.parse('2026-10-30T12:00:00.000Z')
        )
        expect((await runner.query('SELECT "activeMethod" FROM "identity_authentication_state"'))[0].activeMethod).toBe('local')
        await runner.commitTransaction()
        await runner.release()
        const after = await refreshAuthenticationState(db, true)
        if (!after) throw new Error('authentication state was not refreshed')
        expect(after).toMatchObject({ activeMethod: 'local', authenticationEpoch: before.authenticationEpoch + 1, sessionsEnded: 0 })
        expect(signInOptionsBody({ CUTTLELY_LOCAL_ADMIN: 'true' }, after.activeMethod).localAdmin).toBe(true)
        const [audit] = await db.query('SELECT "type", "summary", "detail" FROM "audit_event"')
        expect(audit).toMatchObject({ type: 'auth_method_change', summary: 'Sign-in method changed' })
        expect(JSON.parse(audit.detail)).toMatchObject({
            oldMethod: 'none',
            newMethod: 'local',
            sessionsEnded: 0,
            outcome: 'applied',
            reason: 'first_owner_setup'
        })
        await db.destroy()
    })

    it('initializes durable Local login before the operator command creates the first owner', async () => {
        await withEnvironment(
            {
                CUTTLELY_LOCAL_ADMIN: 'true',
                CUTTLELY_LOCAL_USERS: undefined,
                WORKOS_API_KEY: undefined,
                WORKOS_CLIENT_ID: undefined
            },
            async () => {
                const db = await database('sqlite', '', true)
                expect(await readAuthenticationState(db)).toBeNull()
                const result = await runUserCommand(db, {
                    email: 'owner@example.com',
                    password: GOOD_PASSWORD,
                    localAdmin: true
                })
                expect(result.ok).toBe(true)
                const afterCommand = await readAuthenticationState(db)
                expect(afterCommand).toMatchObject({ activeMethod: 'local', authenticationEpoch: 1, sessionsEnded: 0 })
                await db.query('INSERT INTO "identity_local_session" ("id", "userId", "token") VALUES (?, ?, ?)', [
                    'later-session',
                    'owner',
                    'token'
                ])
                expect(await applyAuthKitSwitchOnBoot(db)).toBeNull()
                expect(await readAuthenticationState(db)).toEqual(afterCommand)
                expect(await db.query('SELECT "id" FROM "identity_local_session"')).toEqual([{ id: 'later-session' }])
                expect(await db.query('SELECT "id" FROM "audit_event"')).toHaveLength(1)
                await db.destroy()
            }
        )
    }, 20000)

    it('keeps a durable WorkOS selection when the operator command creates the first owner', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client-existing' }, async () => {
            const db = await database('sqlite', '', true)
            await initializeAuthenticationState(db)
            const before = await readAuthenticationState(db)
            const result = await runUserCommand(db, {
                email: 'owner@example.com',
                password: GOOD_PASSWORD,
                localAdmin: true
            })
            expect(result.ok).toBe(true)
            expect(await readAuthenticationState(db)).toEqual(before)
            expect(await db.query('SELECT "id" FROM "audit_event"')).toEqual([])
            await db.destroy()
        })
    }, 20000)
})

const livePg = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD ? it : it.skip

livePg('applies a durable stage on postgres and refuses its reuse', async () => {
    const pg = require('pg') as {
        Client: new (config: Record<string, unknown>) => {
            connect(): Promise<void>
            query(text: string): Promise<unknown>
            end(): Promise<void>
        }
    }
    const admin = new pg.Client({
        host: process.env.CUTTLELY_TEST_PG_HOST || process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.CUTTLELY_TEST_PG_PORT || process.env.PGPORT || 5432),
        user: 'postgres',
        password: process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD,
        database: 'postgres'
    })
    const name = `cuttlely_auth_stage_${process.pid}`
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
    await withEnvironment(
        { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true', CUTTLELY_LOCAL_ADMIN: 'true' },
        async () => {
            const db = await database('postgres', name)
            try {
                const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
                await db.query('INSERT INTO "user" VALUES ($1, $2, $3)', ['owner', DUMMY_PASSWORD_HASH, 'active'])
                await db.query('INSERT INTO "role" VALUES ($1, $2)', ['owner-role', 'owner'])
                await db.query('INSERT INTO "organization_user" VALUES ($1, $2, $3)', ['owner', 'owner-role', 'active'])
                const staged = await stageAuthenticationMethodSwitch(db, 'owner', 'workos', before.version)
                const after = await switchAuthenticationMethod(db, 'workos', before.version, undefined, {
                    id: staged.id,
                    actorId: 'owner',
                    version: staged.version
                })
                expect(after.activeMethod).toBe('workos')
                await expect(
                    switchAuthenticationMethod(db, 'local', after.version, undefined, {
                        id: staged.id,
                        actorId: 'owner',
                        version: staged.version
                    })
                ).rejects.toThrow('AUTH_STAGE_STALE')
            } finally {
                await db.destroy()
            }
        }
    )
})
