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

import { randomUUID } from 'crypto'
import type { DataSource, QueryRunner } from 'typeorm'
import { INVITE_NEEDS_AUTHKIT, LinkDeps, acceptLocalPassword, inviteAccount, resetLocalLink } from './actionLink'
import { DirectoryActor, Sql, deleteOrganizationUser, deleteWorkspaceUser, setUserDisabled, sqlFromDataSource } from './directory'
import { INVITE_PENDING, linkFailureMessage, linkWorkosUser } from './link'
import { LoginRateLimit } from './rateLimit'
import { addIdentityActionLinks } from './schemaMigration'
import { SqlIdentityStore } from './sqlStore'
import { LinkResult, WorkosIdentity } from './types'

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
        INSERT INTO organization (id, name) VALUES ('${ORG}', 'Harbor Bakery');
        INSERT INTO "user" (id, name, email, status, credential) VALUES ('${OWNER}', 'Rosa Diaz', 'rosa@example.com', 'active', NULL);
        INSERT INTO role (id, "organizationId", name, permissions) VALUES ('${MEMBER_ROLE}', NULL, 'member', '[]');
        INSERT INTO role (id, "organizationId", name, permissions) VALUES ('${OWNER_ROLE_ID}', '${ORG}', 'owner', '[]');
        INSERT INTO workspace (id, name, "organizationId") VALUES ('${TEAM}', 'Front Counter', '${ORG}');
        INSERT INTO workspace (id, name, "organizationId") VALUES ('${TEAM_2}', 'Kitchen', '${ORG}');
        INSERT INTO organization_user ("organizationId", "userId", "roleId", status) VALUES ('${ORG}', '${OWNER}', '${OWNER_ROLE_ID}', 'active');
        INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM}', '${OWNER}', '${MEMBER_ROLE}', 'active');
        INSERT INTO workspace_user ("workspaceId", "userId", "roleId", status) VALUES ('${TEAM_2}', '${OWNER}', '${MEMBER_ROLE}', 'active');
    `
}

function fakeDataSource(type: 'sqlite' | 'postgres', makeRunner: () => QueryRunner): DataSource {
    return { options: { type }, createQueryRunner: makeRunner } as unknown as DataSource
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
    const runner = () =>
        ({
            connection: { options: { type: 'sqlite' } },
            connect: async () => undefined,
            release: async () => undefined,
            query: run
        } as unknown as QueryRunner)
    await addIdentityActionLinks(runner())
    const dataSource = fakeDataSource('sqlite', runner)
    return {
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
    await setup.release()
    const dataSource = fakeDataSource('postgres', runner)
    const sql = sqlFromDataSource(dataSource)
    return {
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

function deps(now = NOW, env: NodeJS.ProcessEnv = { ...AUTHKIT_ENV }): LinkDeps {
    return {
        now: () => now,
        env,
        origin: () => 'https://bakery.example',
        mailReady: () => false,
        send: async () => undefined,
        rateLimit: new LoginRateLimit()
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
        if (enabled) db = await open()
    })
    afterEach(async () => {
        if (enabled) await db.close()
    })

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
        const links = await db.rows(`SELECT "usedAt" AS "usedAt" FROM identity_action_link WHERE "userId" = ?`, [ada.id])
        expect(links).toEqual([{ usedAt: null }])
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
        await deleteWorkspaceUser(db.sql, owner, TEAM, ada.id)
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
        expect(await rejections()).toEqual(['authkit-only'])
        expect(await signIn('ada@example.com', ada.token)).toMatchObject({ ok: true, user: { id: ada.id, externalId: 'wos-ada' } })
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
})
