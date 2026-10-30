/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { workosConfigurationFingerprint, stableWorkosProviderKey } from './authenticationState'
import { workosProvider } from './provider'
import { WorkosPort } from './types'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import type { DataSource } from 'typeorm'
import {
    automaticWorkosLinkingAllowed,
    acknowledgeAuthenticationWarning,
    initializeAuthenticationState,
    recordRecentAuthentication,
    hasRecentAuthentication,
    refreshAuthenticationState,
    selectedAuthenticationEpoch,
    stageAuthenticationMethodSwitch,
    switchAuthenticationMethod
} from './authenticationState'
import { addAuthenticationState, addAuthenticationSwitchStage } from './schemaMigration'
import { workosEpochCookie, workosEpochCookieValid } from './cookies'
import { applyAuthKitSwitchOnBoot } from './production'

async function database(type: 'sqlite' | 'postgres' = 'sqlite', name = ''): Promise<DataSource> {
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
    await runner.query(
        `CREATE TABLE "identity_authkit_switch" ("id" integer PRIMARY KEY, "configured" integer NOT NULL, "sessionsEnded" integer NOT NULL, "switchedAt" ${
            type === 'postgres' ? 'timestamp' : 'datetime'
        } NULL)`
    )
    await runner.query(
        'CREATE TABLE "identity_local_session" ("id" varchar(36) PRIMARY KEY, "userId" varchar(36) NOT NULL, "token" varchar(64) NOT NULL)'
    )
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

describe('authentication provider foundation', () => {
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

    it('switches method, epoch, sessions, and audit atomically while retaining API keys', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
            const db = await database()
            const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
            await db.query('INSERT INTO "identity_local_session" VALUES (?, ?, ?)', ['session', 'user', 'token'])
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

    it('applies a durable stage from another process and refuses its stale version and reuse', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
            const db = await database()
            const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
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
        })
    })

    it('rejects an old sealed WorkOS cookie after a WorkOS to Local to WorkOS round trip', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
            const db = await database()
            const first = await initializeAuthenticationState(db, { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client' })
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

    it('blocks new mailbox linking after a fingerprint mismatch until acknowledgment restores it', async () => {
        const db = await database()
        await initializeAuthenticationState(db, { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'first' })
        const mismatch = await initializeAuthenticationState(db, { WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'second' })
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'second' }, async () => {
            expect(await automaticWorkosLinkingAllowed(db)).toBe(false)
            const acknowledged = await acknowledgeAuthenticationWarning(db, mismatch.version, {
                organizationId: 'org',
                actorId: 'owner'
            })
            expect(acknowledged.warning).toBeNull()
            expect(acknowledged.warningKind).toBeNull()
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

    it('does not repeat the compatibility session cutoff after a panel switch and restart', async () => {
        await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
            const db = await database()
            const local = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
            await switchAuthenticationMethod(db, 'workos', local.version)
            await db.query('INSERT INTO "identity_local_session" VALUES (?, ?, ?)', ['recovery-session', 'owner', 'token'])
            expect(await applyAuthKitSwitchOnBoot(db)).toBeNull()
            expect(await db.query('SELECT * FROM "identity_local_session"')).toHaveLength(1)
            await db.destroy()
        })
    })

    it('accepts only a server-side fresh-sign-in record within ten minutes', async () => {
        const db = await database()
        const now = Date.parse('2026-10-30T12:00:00.000Z')
        const recent = await recordRecentAuthentication(db, 'owner', now)
        expect(await hasRecentAuthentication(db, 'owner', recent.token, now + 9 * 60 * 1000)).toBe(true)
        expect(await hasRecentAuthentication(db, 'other', recent.token, now + 60 * 1000)).toBe(false)
        expect(await hasRecentAuthentication(db, 'owner', recent.token, now + 10 * 60 * 1000)).toBe(false)
        await db.destroy()
    })
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
    await withEnvironment({ WORKOS_API_KEY: 'set', WORKOS_CLIENT_ID: 'client', CUTTLELY_LOCAL_USERS: 'true' }, async () => {
        const db = await database('postgres', name)
        try {
            const before = await initializeAuthenticationState(db, { CUTTLELY_LOCAL_USERS: 'true' })
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
    })
})
