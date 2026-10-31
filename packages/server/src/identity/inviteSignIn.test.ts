/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * AuthKit sign-in for a pending invite, against SQLite and, when PGPASSWORD or CUTTLELY_TEST_PG_PASSWORD is set,
 * a live Postgres (CUTTLELY_TEST_PG_HOST and CUTTLELY_TEST_PG_PORT, or PGHOST and PGPORT, pick the server).
 * CUTTLELY_TEST_PG_REQUIRED=1 fails instead of skipping.
 */

let mockDataSource: unknown
jest.mock('../DataSource', () => ({ getDataSource: () => mockDataSource }))
// The real logger loads the storage providers from @cuttlely/components, which the Postgres CI job does not build.
jest.mock('../utils/logger', () => {
    const quiet = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), verbose: jest.fn() }
    return { __esModule: true, default: quiet }
})

import { randomUUID } from 'crypto'
import express from 'express'
import request from 'supertest'
import type { DataSource, QueryRunner } from 'typeorm'
import { INVITE_NEEDS_AUTHKIT, LinkDeps, acceptLocalPassword, inviteAccount, resetLocalLink } from './actionLink'
import {
    DirectoryActor,
    Sql,
    deleteOrganizationUser,
    deleteWorkspaceUser,
    setUserDisabled,
    sqlFromDataSource,
    updateOrganizationUser
} from './directory'
import { identityAuthRouter } from './http'
import { INVITE_PENDING, linkFailureMessage, linkWorkosUser } from './link'
import { LoginRateLimit } from './rateLimit'
import { requirePermission, setTeamPermissionLookup } from './rbac'
import { utcEpoch } from './dbTime'
import { addAuthenticationState, addIdentityActionLinks, addOidcProvider } from './schemaMigration'
import { automaticWorkosLinkingAllowed, initializeAuthenticationState } from './authenticationState'
import type { AuthenticationMethod } from './authenticationState'
import { SqlIdentityStore } from './sqlStore'
import { LinkResult, WorkosIdentity } from './types'
import { resolveOidcUser } from './oidcStore'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        exec(sql: string): void
        close(): void
        prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
    }
}

const ORG = '0b6f3c1e-4d2a-4f7b-9a10-2c3d4e5f6a70'
const OWNER = '1c7a4d2f-5e3b-4a8c-8b21-3d4e5f6a7b81'
const TEAM = '2d8b5e3a-6f4c-4b9d-9c32-4e5f6a7b8c92'
const TEAM_2 = '3e9c6f4b-7a5d-4cae-8d43-5f6a7b8c9da3'
const MEMBER_ROLE = '4fad7a5c-8b6e-4dbf-9e54-6a7b8c9daeb4'
const OWNER_ROLE_ID = '5abe8b6d-9c7f-4ec0-8f65-7b8c9daebfc5'
const NOW = Date.parse('2026-10-15T09:00:00.000Z')
const HOUR = 60 * 60 * 1000
const GOOD = 'Sup3r-Secret!'
const AUTHKIT_ENV = { WORKOS_API_KEY: 'sk_test_example', WORKOS_CLIENT_ID: 'client_example' }

const owner: DirectoryActor = { id: OWNER, organizationId: ORG, workspaceId: TEAM, owner: true, permissions: [] }

interface Backend {
    dataSource: DataSource
    sql: Sql
    store: SqlIdentityStore
    rows(statement: string, params?: unknown[]): Promise<Record<string, unknown>[]>
    close(): Promise<void>
}

function seed(dialect: 'sqlite' | 'postgres'): string {
    const uuid = dialect === 'postgres' ? 'uuid' : 'text'
    const time = dialect === 'postgres' ? 'timestamp' : 'text'
    const now = dialect === 'postgres' ? 'DEFAULT CURRENT_TIMESTAMP' : ''
    return `
        CREATE TABLE organization (id ${uuid} PRIMARY KEY, name varchar(100));
        CREATE TABLE "user" (
            id ${uuid} PRIMARY KEY, name varchar(100), email varchar(255) UNIQUE, credential text, status varchar(20),
            "externalId" varchar(255), "ssoProvider" varchar(100), "ssoSubjectId" varchar(255),
            "permissionVersion" integer NOT NULL DEFAULT 0,
            "createdBy" ${uuid}, "updatedBy" ${uuid}, "createdDate" ${time} ${now}, "updatedDate" ${time} ${now}
        );
        CREATE TABLE role (
            id ${uuid} PRIMARY KEY, "organizationId" ${uuid}, name varchar(100), description text, permissions text
        );
        CREATE TABLE workspace (
            id ${uuid} PRIMARY KEY, name varchar(100), description text, "organizationId" ${uuid},
            "createdBy" ${uuid}, "updatedBy" ${uuid}, "updatedDate" ${time} ${now}
        );
        CREATE TABLE organization_user (
            "organizationId" ${uuid}, "userId" ${uuid}, "roleId" ${uuid}, status varchar(20),
            "createdBy" ${uuid}, "updatedBy" ${uuid}, "updatedDate" ${time} ${now},
            PRIMARY KEY ("organizationId", "userId")
        );
        CREATE TABLE workspace_user (
            "workspaceId" ${uuid}, "userId" ${uuid}, "roleId" ${uuid}, status varchar(20), "lastLogin" ${time},
            "createdBy" ${uuid}, "updatedBy" ${uuid}, "updatedDate" ${time} ${now},
            PRIMARY KEY ("workspaceId", "userId")
        );
        CREATE TABLE identity_local_session (
            id varchar(255) PRIMARY KEY, "userId" varchar(255), token varchar(255), "expiresAt" ${time},
            "absoluteExpiresAt" ${time}, "createdDate" ${time}, "lastSeenAt" ${time}, "permissionVersion" integer NOT NULL DEFAULT 0
        );
        CREATE TABLE identity_authkit_switch (
            id integer PRIMARY KEY, configured integer NOT NULL, "sessionsEnded" integer NOT NULL, "switchedAt" ${time}
        );
        INSERT INTO organization (id, name) VALUES ('${ORG}', 'Harbor Bakery');
        INSERT INTO "user" (id, name, email, status, credential) VALUES ('${OWNER}', 'Rosa Diaz', 'rosa@example.com', 'active', NULL);
        INSERT INTO role (id, "organizationId", name, permissions) VALUES ('${MEMBER_ROLE}', NULL, 'member', '["chatflows:view"]');
        INSERT INTO role (id, "organizationId", name, permissions) VALUES ('${OWNER_ROLE_ID}', '${ORG}', 'owner', '[]');
        INSERT INTO workspace (id, name, "organizationId") VALUES ('${TEAM}', 'Front Counter', '${ORG}');
        INSERT INTO workspace (id, name, "organizationId") VALUES ('${TEAM_2}', 'Kitchen', '${ORG}');
        INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', '${OWNER}', '${OWNER_ROLE_ID}', 'active');
        INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', '${OWNER}', '${MEMBER_ROLE}', 'active');
        INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM_2}', '${OWNER}', '${MEMBER_ROLE}', 'active');
    `
}

function fakeDataSource(
    type: 'sqlite' | 'postgres',
    makeRunner: () => QueryRunner,
    pool: (statement: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
): DataSource {
    return { options: { type }, createQueryRunner: makeRunner, query: pool } as unknown as DataSource
}

async function sqliteBackend(): Promise<Backend> {
    const db = new DatabaseSync(':memory:')
    db.exec(seed('sqlite'))
    const run = async (statement: string, params: unknown[] = []) => {
        const prepared = db.prepare(statement)
        if (/^\s*(select|with)\b/i.test(statement)) return prepared.all(...params)
        prepared.run(...params)
        return []
    }
    const runner = () => {
        let inTransaction = false
        return {
            connection: { options: { type: 'sqlite' } },
            connect: async () => undefined,
            release: async () => undefined,
            query: run,
            startTransaction: async () => {
                db.exec('BEGIN')
                inTransaction = true
            },
            commitTransaction: async () => {
                db.exec('COMMIT')
                inTransaction = false
            },
            rollbackTransaction: async () => {
                db.exec('ROLLBACK')
                inTransaction = false
            },
            get isTransactionActive() {
                return inTransaction
            }
        } as unknown as QueryRunner
    }
    const setup = runner()
    await addIdentityActionLinks(setup)
    await addAuthenticationState(setup)
    await addOidcProvider(setup)
    const dataSource = fakeDataSource('sqlite', runner, run)
    return {
        dataSource,
        sql: sqlFromDataSource(dataSource),
        store: new SqlIdentityStore(dataSource),
        rows: run,
        close: async () => db.close()
    }
}

type PgClient = { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; release(): void }
type PgPool = {
    connect(): Promise<PgClient>
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
    end(): Promise<void>
}

const pgPassword = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD

async function postgresBackend(): Promise<Backend> {
    const pg = require('pg') as {
        Client: new (config: Record<string, unknown>) => {
            connect(): Promise<void>
            query(text: string): Promise<unknown>
            end(): Promise<void>
        }
        Pool: new (config: Record<string, unknown>) => PgPool
    }
    const base = {
        host: process.env.CUTTLELY_TEST_PG_HOST || process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.CUTTLELY_TEST_PG_PORT || process.env.PGPORT || 5432),
        user: process.env.CUTTLELY_TEST_PG_USER || process.env.PGUSER || 'postgres',
        password: pgPassword
    }
    const name = `cuttlely_invite_${process.pid}_${randomUUID().slice(0, 8)}`
    const admin = new pg.Client({ ...base, database: 'postgres' })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
    const pool = new pg.Pool({ ...base, database: name, max: 4 })
    await pool.query(seed('postgres'))
    const runner = (): QueryRunner => {
        let client: PgClient | undefined
        const query = async (text: string, params: unknown[] = []) => {
            if (!client) throw new Error('runner is not connected')
            return (await client.query(text, params)).rows
        }
        return {
            connection: { options: { type: 'postgres' } },
            connect: async () => {
                client = await pool.connect()
            },
            release: async () => {
                client?.release()
                client = undefined
            },
            query,
            startTransaction: async () => void (await query('BEGIN')),
            commitTransaction: async () => void (await query('COMMIT')),
            rollbackTransaction: async () => void (await query('ROLLBACK'))
        } as unknown as QueryRunner
    }
    const setup = runner()
    await setup.connect()
    await addIdentityActionLinks(setup)
    await addAuthenticationState(setup)
    await addOidcProvider(setup)
    await setup.release()
    const dataSource = fakeDataSource('postgres', runner, async (statement, params = []) => (await pool.query(statement, params)).rows)
    const sql = sqlFromDataSource(dataSource)
    return {
        dataSource,
        sql,
        store: new SqlIdentityStore(dataSource),
        rows: (statement, params = []) => sql.query(statement, params),
        close: async () => {
            await pool.end()
            const drop = new pg.Client({ ...base, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    }
}

function deps(
    now = NOW,
    env: NodeJS.ProcessEnv = { ...AUTHKIT_ENV },
    activeMethod: AuthenticationMethod | null | undefined = undefined
): LinkDeps {
    return {
        now: () => now,
        env,
        origin: () => 'https://bakery.example',
        mailReady: () => false,
        send: async () => undefined,
        rateLimit: new LoginRateLimit(),
        activeMethod: () => activeMethod
    }
}

function tokenOf(link: string | undefined): string {
    const url = new URL(link || '')
    expect(url.pathname).toBe('/local-accept')
    return decodeURIComponent(url.hash.slice('#token='.length))
}

function identity(email: string, id = `wos-${email.split('@')[0]}`): WorkosIdentity {
    return { id, email, emailVerified: true, name: null }
}

const backends: [string, () => Promise<Backend>, boolean][] = [
    ['sqlite', sqliteBackend, true],
    ['postgres', postgresBackend, Boolean(pgPassword)]
]

if (process.env.CUTTLELY_TEST_PG_REQUIRED === '1' && !pgPassword) {
    test('postgres is required for this run', () => {
        throw new Error('CUTTLELY_TEST_PG_REQUIRED=1 needs PGPASSWORD or CUTTLELY_TEST_PG_PASSWORD')
    })
}

describe.each(backends)('AuthKit sign-in for a pending invite on %s', (_name, open, enabled) => {
    const maybe = enabled ? it : it.skip
    let db: Backend

    beforeEach(async () => {
        if (!enabled) return
        db = await open()
        mockDataSource = db.dataSource
        setTeamPermissionLookup(null)
    })
    afterEach(async () => {
        if (enabled) await db.close()
    })

    async function gateStatus(userId: string): Promise<number> {
        let status = 200
        let done: () => void = () => undefined
        const res = {
            status(code: number) {
                status = code
                return this
            },
            json() {
                done()
                return this
            },
            send() {
                done()
                return this
            },
            end() {
                done()
                return this
            },
            headersSent: false
        }
        await new Promise<void>((resolve) => {
            done = resolve
            const req = { user: { id: userId, activeWorkspaceId: TEAM, activeOrganizationId: ORG } }
            requirePermission('chatflows:view')(req as never, res as never, () => resolve())
        })
        return status
    }

    async function withEnv<T>(extra: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
        const saved = { ...process.env }
        for (const key of ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'CUTTLELY_LOCAL_USERS', 'INVITE_DELIVERY']) delete process.env[key]
        Object.assign(process.env, extra)
        try {
            return await run()
        } finally {
            process.env = saved
        }
    }

    function authApp() {
        const app = express()
        app.use(express.json())
        app.use('/api/v1/auth', identityAuthRouter)
        return request(app)
    }

    async function invite(email: string, name = 'Ada Lovelace', workspaceId = TEAM): Promise<{ id: string; token: string }> {
        const created = await inviteAccount(
            db.sql,
            { ...owner, workspaceId },
            { user: { name, email }, workspace: { id: workspaceId }, role: { id: MEMBER_ROLE } },
            deps()
        )
        return { id: created.id, token: tokenOf(created.link) }
    }

    async function user(id: string): Promise<{ status: string; externalId: string | null }> {
        const rows = await db.rows(`SELECT status, "externalId" AS "externalId" FROM "user" WHERE id = ?`, [id])
        return { status: String(rows[0]?.status), externalId: (rows[0]?.externalId as string | null) ?? null }
    }

    async function rejections(): Promise<string[]> {
        const rows = await db.rows(`SELECT reason FROM identity_action_audit WHERE action = ? AND result = ?`, ['token_rejected', 'failed'])
        return rows.map((row) => String(row.reason))
    }

    async function signIn(email: string, token?: string, now = NOW, id?: string): Promise<LinkResult> {
        return linkWorkosUser(db.store, identity(email, id), { inviteToken: token, now })
    }

    maybe('email-match sign-in without a token leaves the user pending and grants no workspace access', async () => {
        const ada = await invite('ada@example.com')
        expect(await user(ada.id)).toEqual({ status: 'invited', externalId: null })

        const result = await signIn('Ada@Example.com')
        expect(result).toEqual({ ok: false, reason: 'invite-required' })
        if (!result.ok) expect(linkFailureMessage(result.reason)).toBe(INVITE_PENDING)
        expect(await signIn('ada@example.com')).toEqual({ ok: false, reason: 'invite-required' })
        expect(await linkWorkosUser(db.store, { ...identity('ada@example.com'), emailVerified: false }, { now: NOW })).toEqual({
            ok: false,
            reason: 'unverified'
        })

        expect(await user(ada.id)).toEqual({ status: 'invited', externalId: null })
        expect(await db.store.localAccountOpen(ada.id)).toBe(false)
        expect(await db.store.findUserByExternalId('wos-ada')).toBeNull()
        expect(await gateStatus(ada.id)).toBe(403)
        expect(await signIn('ada@example.com', ada.token)).toMatchObject({ ok: true })
        expect(await gateStatus(ada.id)).toBe(200)
        const links = await db.rows(
            `SELECT "usedAt" AS "usedAt", "consumeId" AS "consumeId" FROM identity_action_link WHERE "userId" = ?`,
            [ada.id]
        )
        expect(links).toHaveLength(1)
        expect(links[0].usedAt).not.toBeNull()
        expect(links[0].consumeId).toEqual(expect.any(String))
        expect(
            await db.store.acceptInvite({ token: ada.token, userId: ada.id, email: 'ada@example.com', externalId: 'wos-ada', now: NOW })
        ).toBe('invalid')
    })

    maybe('valid token plus matching sign-in activates the user and binds that sign-in once', async () => {
        const ada = await invite('ada@example.com')
        const result = await signIn('ada@example.com', ada.token, NOW + HOUR)
        expect(result).toMatchObject({ ok: true, bootstrapped: false, user: { id: ada.id, status: 'active', externalId: 'wos-ada' } })
        expect(await user(ada.id)).toEqual({ status: 'active', externalId: 'wos-ada' })
        expect(await db.store.localAccountOpen(ada.id)).toBe(true)
        const used = await db.rows(`SELECT "consumeId" AS "consumeId" FROM identity_action_link WHERE "userId" = ?`, [ada.id])
        expect(used).toHaveLength(1)
        expect(used[0].consumeId).toEqual(expect.any(String))
        const consumed = await db.rows(`SELECT reason FROM identity_action_audit WHERE action = ?`, ['token_consumed'])
        expect(consumed).toEqual([{ reason: 'authkit' }])

        expect(await signIn('ada@example.com', undefined, NOW + 2 * HOUR)).toMatchObject({ ok: true, user: { id: ada.id } })
        expect(await signIn('ada@example.com', undefined, NOW, 'wos-someone-else')).toEqual({ ok: false, reason: 'rebind' })
    })

    maybe('an OIDC invitation consumes its token and creates its provider link in one transaction', async () => {
        const ada = await invite('ada@example.com')
        await expect(
            db.store.acceptInvite({
                token: ada.token,
                userId: ada.id,
                email: 'ADA@example.com',
                externalId: 'subject-1',
                providerKey: 'provider-1',
                subject: 'subject-1',
                assuranceBasis: 'invitation',
                now: NOW
            })
        ).resolves.toBe('accepted')
        expect(await user(ada.id)).toEqual({ status: 'active', externalId: null })
        expect(
            await db.rows(
                `SELECT "providerKey" AS "providerKey", subject, "userId" AS "userId", "emailAtLink" AS "emailAtLink", "assuranceBasis" AS "assuranceBasis" FROM identity_provider_link`
            )
        ).toEqual([
            {
                providerKey: 'provider-1',
                subject: 'subject-1',
                userId: ada.id,
                emailAtLink: 'ada@example.com',
                assuranceBasis: 'invitation'
            }
        ])
        await expect(
            db.store.acceptInvite({
                token: ada.token,
                userId: ada.id,
                email: 'ada@example.com',
                externalId: 'subject-1',
                providerKey: 'provider-1',
                subject: 'subject-1',
                assuranceBasis: 'invitation',
                now: NOW
            })
        ).resolves.toBe('invalid')
    })

    maybe('an OIDC subject can accept a new invitation after its former user is removed', async () => {
        const first = await inviteAccount(
            db.sql,
            owner,
            { user: { name: 'Ada Lovelace', email: 'ada@example.com' }, workspace: { id: TEAM }, role: { id: MEMBER_ROLE } },
            deps(NOW, {}, 'oidc')
        )
        const firstToken = tokenOf(first.link)
        const oidcIdentity = {
            providerKey: 'provider-1',
            subject: 'subject-1',
            issuer: 'https://issuer.example',
            email: 'ada@example.com',
            emailVerified: true,
            emailVerificationPresent: true
        }
        await expect(
            resolveOidcUser(db.dataSource, db.store, oidcIdentity, {
                trustMissing: false,
                invitationToken: firstToken,
                now: NOW
            })
        ).resolves.toMatchObject({ ok: true, user: { id: first.id } })
        await expect(
            resolveOidcUser(db.dataSource, db.store, { ...oidcIdentity, email: undefined }, { trustMissing: false })
        ).resolves.toMatchObject({ ok: true, user: { id: first.id } })

        await deleteOrganizationUser(db.sql, owner, ORG, first.id)
        expect(await db.rows(`SELECT * FROM identity_provider_link WHERE "userId" = ?`, [first.id])).toEqual([])
        expect(await user(first.id)).toEqual({ status: 'deleted', externalId: null })

        const second = await inviteAccount(
            db.sql,
            owner,
            { user: { name: 'Ada Lovelace', email: 'ada@example.com' }, workspace: { id: TEAM }, role: { id: MEMBER_ROLE } },
            deps(NOW + HOUR, {}, 'oidc')
        )
        expect(second.id).not.toBe(first.id)
        const secondToken = tokenOf(second.link)
        await expect(
            resolveOidcUser(db.dataSource, db.store, oidcIdentity, {
                trustMissing: false,
                invitationToken: secondToken,
                now: NOW + HOUR
            })
        ).resolves.toMatchObject({ ok: true, user: { id: second.id, status: 'active' } })
        await expect(
            resolveOidcUser(db.dataSource, db.store, { ...oidcIdentity, email: undefined }, { trustMissing: false })
        ).resolves.toMatchObject({ ok: true, user: { id: second.id } })
    })

    maybe('a mixed local-user and WorkOS upgrade keeps invitation sign-in working', async () => {
        const env = { ...AUTHKIT_ENV, CUTTLELY_LOCAL_USERS: 'true' }
        const ada = await invite('ada@example.com')
        await initializeAuthenticationState(db.dataSource, env)
        const result = await withEnv(env, async () =>
            linkWorkosUser(db.store, identity('ada@example.com'), {
                inviteToken: ada.token,
                now: NOW,
                automaticEmailLinking: await automaticWorkosLinkingAllowed(db.dataSource)
            })
        )
        expect(result).toMatchObject({ ok: true, user: { id: ada.id, status: 'active', externalId: 'wos-ada' } })
    })

    maybe('refuses an expired token', async () => {
        const ada = await invite('ada@example.com')
        expect(await signIn('ada@example.com', ada.token, NOW + 73 * HOUR)).toEqual({ ok: false, reason: 'invite-invalid' })
        expect(await user(ada.id)).toEqual({ status: 'invited', externalId: null })
        expect(await rejections()).toEqual(['expired'])
    })

    maybe('refuses a reused token', async () => {
        const ada = await invite('ada@example.com')
        expect(await signIn('ada@example.com', ada.token)).toMatchObject({ ok: true })
        await db.rows(`UPDATE "user" SET status = ?, "externalId" = NULL WHERE id = ?`, ['invited', ada.id])
        expect(await signIn('ada@example.com', ada.token)).toEqual({ ok: false, reason: 'invite-invalid' })
        expect(await user(ada.id)).toEqual({ status: 'invited', externalId: null })
        expect(await rejections()).toEqual(['reused'])
    })

    maybe('lets only one of two sign-ins racing with the same token through', async () => {
        const ada = await invite('ada@example.com')
        const results = await Promise.all([
            db.store.acceptInvite({ token: ada.token, userId: ada.id, email: 'ada@example.com', externalId: 'wos-ada', now: NOW }),
            db.store.acceptInvite({ token: ada.token, userId: ada.id, email: 'ada@example.com', externalId: 'wos-other', now: NOW })
        ])
        expect(results.filter((item) => item === 'accepted')).toHaveLength(1)
        expect((await user(ada.id)).status).toBe('active')
    })

    maybe('refuses a token replaced by a newer invite link', async () => {
        const ada = await invite('ada@example.com')
        const fresh = tokenOf((await resetLocalLink(db.sql, owner, ada.id, {}, deps())).link)
        expect(fresh).not.toBe(ada.token)
        expect(await signIn('ada@example.com', ada.token)).toEqual({ ok: false, reason: 'invite-invalid' })
        expect(await signIn('ada@example.com', fresh)).toMatchObject({ ok: true })
    })

    maybe('refuses a token once the team removes the user, even after they are added back', async () => {
        const ada = await invite('ada@example.com')
        const before = Date.now()
        await deleteWorkspaceUser(db.sql, owner, TEAM, ada.id)
        const after = Date.now()
        const revoked = await db.rows(
            `SELECT "usedAt" AS "usedAt", "consumeId" AS "consumeId" FROM identity_action_link WHERE "userId" = ?`,
            [ada.id]
        )
        expect(revoked).toHaveLength(1)
        expect(revoked[0].consumeId).toBe('revoked')
        const revokedAt = utcEpoch(revoked[0].usedAt)
        expect(revokedAt).toBeGreaterThanOrEqual(before - 1000)
        expect(revokedAt).toBeLessThanOrEqual(after + 1000)
        expect(await signIn('ada@example.com', ada.token)).toEqual({ ok: false, reason: 'invite-invalid' })
        await db.rows(`INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES (?, ?, ?, ?)`, [
            TEAM,
            ada.id,
            MEMBER_ROLE,
            'active'
        ])
        expect(await signIn('ada@example.com', ada.token)).toEqual({ ok: false, reason: 'invite-invalid' })
        expect(await user(ada.id)).toEqual({ status: 'invited', externalId: null })
    })

    maybe('refuses a token once the invite is revoked by disabling or removing the user', async () => {
        const ada = await invite('ada@example.com')
        await setUserDisabled(db.sql, owner, ada.id, true)
        expect(await signIn('ada@example.com', ada.token)).toEqual({ ok: false, reason: 'invite-invalid' })
        await setUserDisabled(db.sql, owner, ada.id, false)
        expect(await user(ada.id)).toEqual({ status: 'invited', externalId: null })
        expect(await signIn('ada@example.com', ada.token)).toEqual({ ok: false, reason: 'invite-invalid' })
        expect(await signIn('ada@example.com')).toEqual({ ok: false, reason: 'invite-required' })

        const grace = await invite('grace@example.com', 'Grace Hopper')
        await deleteOrganizationUser(db.sql, owner, ORG, grace.id)
        expect(await signIn('grace@example.com', grace.token)).toEqual({ ok: false, reason: 'unknown' })
        expect(
            await db.store.acceptInvite({ token: grace.token, userId: grace.id, email: 'grace@example.com', externalId: 'g', now: NOW })
        ).toBe('invalid')
    })

    maybe("refuses another person's token, and leaves it usable for the person it was for", async () => {
        const ada = await invite('ada@example.com')
        const bob = await invite('bob@example.com', 'Bob Ito')
        expect(await signIn('bob@example.com', ada.token)).toEqual({ ok: false, reason: 'invite-invalid' })
        expect(await user(bob.id)).toEqual({ status: 'invited', externalId: null })
        expect(await signIn('mallory@example.com', ada.token)).toEqual({ ok: false, reason: 'unknown' })
        expect(
            await db.store.acceptInvite({ token: ada.token, userId: ada.id, email: 'mallory@example.com', externalId: 'm', now: NOW })
        ).toBe('invalid')
        expect(await rejections()).toEqual(['other-user', 'other-email'])
        expect(await signIn('ada@example.com', ada.token)).toMatchObject({ ok: true })
    })

    maybe('signs an already active user in normally, by AuthKit id or by a verified mailbox', async () => {
        await db.rows(`UPDATE "user" SET "externalId" = ? WHERE id = ?`, ['wos-rosa', OWNER])
        expect(await signIn('rosa@example.com', undefined, NOW, 'wos-rosa')).toMatchObject({ ok: true, user: { id: OWNER } })
        expect(await signIn('rosa@example.com', 'not-a-token', NOW, 'wos-rosa')).toMatchObject({ ok: true, user: { id: OWNER } })

        const local = randomUUID()
        await db.rows(`INSERT INTO "user" (id, name, email, status, credential) VALUES (?, ?, ?, ?, ?)`, [
            local,
            'Lin Park',
            'lin@example.com',
            'active',
            'scrypt$stored'
        ])
        expect(await signIn('lin@example.com')).toMatchObject({ ok: true, user: { id: local, externalId: 'wos-lin' } })
        expect(await user(local)).toEqual({ status: 'active', externalId: 'wos-lin' })
    })

    maybe('with AuthKit on, a password cannot accept an invite, and the link still works through AuthKit', async () => {
        const ada = await invite('ada@example.com')
        const result = await acceptLocalPassword(
            db.sql,
            { body: { token: ada.token, password: GOOD }, query: {}, ip: '203.0.113.9', now: NOW },
            deps()
        )
        expect(result).toEqual({ type: 'json', status: 400, body: { message: INVITE_NEEDS_AUTHKIT } })
        const rows = await db.rows(`SELECT status, credential, "externalId" AS "externalId" FROM "user" WHERE id = ?`, [ada.id])
        expect(rows).toEqual([{ status: 'invited', credential: null, externalId: null }])
        const links = await db.rows(`SELECT "usedAt" AS "usedAt" FROM identity_action_link WHERE "userId" = ?`, [ada.id])
        expect(links).toEqual([{ usedAt: null }])
        expect(await rejections()).toEqual(['remote-only'])
        expect(await signIn('ada@example.com', ada.token)).toMatchObject({ ok: true, user: { id: ada.id, externalId: 'wos-ada' } })
    })

    maybe('with AuthKit on, a used, expired, or revoked invite gets the generic answer on the password route', async () => {
        const accept = (token: string, now: number) =>
            acceptLocalPassword(db.sql, { body: { token, password: GOOD }, query: {}, ip: '203.0.113.9', now }, deps(now))
        const invalid = { type: 'json', status: 400, body: { message: 'This link is not valid.' } }

        const used = await invite('used@example.com', 'Uma Sato')
        expect(await signIn('used@example.com', used.token)).toMatchObject({ ok: true })
        expect(await accept(used.token, NOW)).toEqual(invalid)

        const late = await invite('late@example.com', 'Leo Brandt')
        expect(await accept(late.token, NOW + 73 * HOUR)).toEqual(invalid)

        const gone = await invite('gone@example.com', 'Gia Okoro')
        await deleteWorkspaceUser(db.sql, owner, TEAM, gone.id)
        expect(await accept(gone.token, NOW)).toEqual(invalid)

        expect(await accept('not-a-real-token', NOW)).toEqual(invalid)
        const live = await invite('live@example.com', 'Lia Moreau')
        expect(await accept(live.token, NOW)).toEqual({ type: 'json', status: 400, body: { message: INVITE_NEEDS_AUTHKIT } })
        expect((await rejections()).sort()).toEqual(['expired', 'remote-only', 'reused', 'reused', 'unknown'])
    })

    maybe('without AuthKit, a password accepts an invite once and makes the pending user active', async () => {
        const local = deps(NOW, {})
        const created = await inviteAccount(
            db.sql,
            owner,
            { user: { name: 'Lin Park', email: 'lin@example.com' }, workspace: { id: TEAM }, role: { id: MEMBER_ROLE }, link: true },
            local
        )
        const token = tokenOf(created.link)
        expect(await user(created.id)).toEqual({ status: 'invited', externalId: null })
        const accept = () => acceptLocalPassword(db.sql, { body: { token, password: GOOD }, query: {}, ip: '203.0.113.9', now: NOW }, local)
        expect(await accept()).toMatchObject({ type: 'json', status: 200 })
        expect((await user(created.id)).status).toBe('active')
        expect(await db.store.localAccountOpen(created.id)).toBe(true)
        expect(await accept()).toMatchObject({ type: 'json', status: 400, body: { message: 'This link is not valid.' } })
    })
    maybe('the real accept route with AuthKit on answers 400, not 404, and does not use the invite', async () => {
        const created = await inviteAccount(
            db.sql,
            owner,
            { user: { name: 'Ada Lovelace', email: 'ada@example.com' }, workspace: { id: TEAM }, role: { id: MEMBER_ROLE } },
            deps(Date.now())
        )
        const ada = { id: created.id, token: tokenOf(created.link) }
        const response = await withEnv(AUTHKIT_ENV, () =>
            authApp().post('/api/v1/auth/local/accept').send({ token: ada.token, password: GOOD })
        )
        expect(response.status).toBe(400)
        expect(response.body).toEqual({ message: INVITE_NEEDS_AUTHKIT })
        expect(await user(ada.id)).toEqual({ status: 'invited', externalId: null })
        const links = await db.rows(`SELECT "usedAt" AS "usedAt" FROM identity_action_link WHERE "userId" = ?`, [ada.id])
        expect(links).toEqual([{ usedAt: null }])
        expect(await gateStatus(ada.id)).toBe(403)

        const started = await withEnv(AUTHKIT_ENV, () =>
            authApp().post('/api/v1/auth/invite/start').set('x-request-from', 'internal').send({ token: ada.token })
        )
        expect(started.status).toBe(200)
        const cookie = String(started.headers['set-cookie'])
        expect(cookie).toContain('cuttlely-invite=')
        expect(cookie).toContain('Path=/api/v1/auth/callback')
        expect(cookie).toContain('HttpOnly')
    })

    maybe('the real accept route without AuthKit sets the password and activates the invite', async () => {
        await initializeAuthenticationState(db.dataSource, { CUTTLELY_LOCAL_USERS: 'true' })
        const created = await inviteAccount(
            db.sql,
            owner,
            { user: { name: 'Lin Park', email: 'lin@example.com' }, workspace: { id: TEAM }, role: { id: MEMBER_ROLE }, link: true },
            deps(Date.now(), {})
        )
        const response = await withEnv({}, () =>
            authApp()
                .post('/api/v1/auth/local/accept')
                .send({ token: tokenOf(created.link), password: GOOD })
        )
        expect(response.status).toBe(200)
        expect(response.body).toEqual({ message: 'Password saved.' })
        expect((await user(created.id)).status).toBe('active')
        expect(await gateStatus(created.id)).toBe(200)
    })

    maybe(
        'saving a pending user as invited keeps them pending, re-opens a disabled invite without activating it, and is refused for anyone else',
        async () => {
            const ada = await invite('ada@example.com')
            expect(await updateOrganizationUser(db.sql, owner, { userId: ada.id, organizationId: ORG, status: 'invited' })).toEqual({
                id: ada.id
            })
            expect(await user(ada.id)).toEqual({ status: 'invited', externalId: null })
            await setUserDisabled(db.sql, owner, ada.id, true)
            expect(await updateOrganizationUser(db.sql, owner, { userId: ada.id, organizationId: ORG, status: 'invited' })).toEqual({
                id: ada.id
            })
            expect(await db.rows(`SELECT status FROM organization_user WHERE "userId" = ?`, [ada.id])).toEqual([{ status: 'active' }])
            expect(await user(ada.id)).toEqual({ status: 'invited', externalId: null })
            expect(await signIn('ada@example.com', ada.token)).toEqual({ ok: false, reason: 'invite-invalid' })
            const fresh = tokenOf((await resetLocalLink(db.sql, owner, ada.id, {}, deps())).link)
            await expect(
                updateOrganizationUser(db.sql, owner, { userId: OWNER, organizationId: ORG, status: 'invited' })
            ).rejects.toMatchObject({
                status: 400
            })
            expect(await signIn('ada@example.com', fresh)).toMatchObject({ ok: true })
            await expect(
                updateOrganizationUser(db.sql, owner, { userId: ada.id, organizationId: ORG, status: 'invited' })
            ).rejects.toMatchObject({
                status: 400
            })
            expect((await user(ada.id)).status).toBe('active')
        }
    )

    maybe('a live owner invite on the password route: WorkOS message with AuthKit on, unchanged refusal without it', async () => {
        const ownerInvite = async (email: string, env: NodeJS.ProcessEnv) => {
            const created = await inviteAccount(
                db.sql,
                owner,
                { user: { name: 'Pat Moreno', email }, workspace: { id: TEAM }, role: { id: OWNER_ROLE_ID }, link: true },
                deps(NOW, env)
            )
            return { id: created.id, token: tokenOf(created.link) }
        }
        const state = async (id: string) => ({
            user: await db.rows(`SELECT status, credential, "externalId" AS "externalId" FROM "user" WHERE id = ?`, [id]),
            link: await db.rows(`SELECT "usedAt" AS "usedAt" FROM identity_action_link WHERE "userId" = ?`, [id])
        })
        const unchanged = { user: [{ status: 'invited', credential: null, externalId: null }], link: [{ usedAt: null }] }

        const withAuthKit = await ownerInvite('pat@example.com', { ...AUTHKIT_ENV })
        const refused = await acceptLocalPassword(
            db.sql,
            { body: { token: withAuthKit.token, password: GOOD }, query: {}, ip: '203.0.113.9', now: NOW },
            deps()
        )
        expect(refused).toEqual({ type: 'json', status: 400, body: { message: INVITE_NEEDS_AUTHKIT } })
        expect(await state(withAuthKit.id)).toEqual(unchanged)
        expect(await rejections()).toEqual(['remote-only'])
        expect(await signIn('pat@example.com', withAuthKit.token)).toMatchObject({
            ok: true,
            user: { id: withAuthKit.id, status: 'active' }
        })

        const local = await ownerInvite('quinn@example.com', {})
        const localResult = await acceptLocalPassword(
            db.sql,
            { body: { token: local.token, password: GOOD }, query: {}, ip: '203.0.113.9', now: NOW },
            deps(NOW, {})
        )
        expect(localResult).toEqual({ type: 'json', status: 400, body: { message: 'This link is not valid.' } })
        expect(await state(local.id)).toEqual(unchanged)
        expect((await rejections()).sort()).toEqual(['owner', 'remote-only'])
    })

    maybe('an owner can send a new link for a pending owner invite; anyone else cannot', async () => {
        const created = await inviteAccount(
            db.sql,
            owner,
            { user: { name: 'Pat Moreno', email: 'pat@example.com' }, workspace: { id: TEAM }, role: { id: OWNER_ROLE_ID } },
            deps()
        )
        const manager: DirectoryActor = {
            id: randomUUID(),
            organizationId: ORG,
            workspaceId: TEAM,
            owner: false,
            permissions: ['users:manage']
        }
        await expect(resetLocalLink(db.sql, manager, created.id, {}, deps())).rejects.toMatchObject({ status: 403 })
        const fresh = tokenOf((await resetLocalLink(db.sql, owner, created.id, {}, deps())).link)
        expect(await signIn('pat@example.com', fresh)).toMatchObject({ ok: true, user: { id: created.id, status: 'active' } })
    })
})
