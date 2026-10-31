import { DataSource } from 'typeorm'
import { SqlIdentityStore } from './sqlStore'

const livePg = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD ? it : it.skip

type PgClient = {
    connect(): Promise<void>
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
    end(): Promise<void>
}

livePg('finds a local session on postgres, where user.id is a uuid and the session userId is varchar', async () => {
    const pg = require('pg') as { Client: new (config: Record<string, unknown>) => PgClient }
    const password = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD
    const admin = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: 'postgres' })
    await admin.connect()
    const name = `cuttlely_session_${process.pid}`
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
    const db = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: name })
    await db.connect()
    try {
        await db.query(`CREATE TABLE "user" (id uuid PRIMARY KEY, "permissionVersion" integer NOT NULL DEFAULT 0)`)
        await db.query(`CREATE TABLE identity_local_session (
            id varchar(255) NOT NULL PRIMARY KEY,
            "userId" varchar(255) NOT NULL,
            token varchar(255) NOT NULL UNIQUE,
            "expiresAt" TIMESTAMP NOT NULL,
            "absoluteExpiresAt" TIMESTAMP NOT NULL,
            "createdDate" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "lastSeenAt" TIMESTAMP,
            "permissionVersion" integer NOT NULL DEFAULT 0,
            "recentAuthenticationAt" TIMESTAMP NULL,
            "authenticationMethod" varchar(32) NULL,
            "authenticationEpoch" integer NULL,
            "recoveryUse" integer NOT NULL DEFAULT 0,
            "workosSessionId" varchar(255) NULL
        )`)
        const userId = '6f1d3a52-2c4b-4c1e-9a57-0d3b8f6e2a10'
        await db.query(`INSERT INTO "user" (id, "permissionVersion") VALUES ($1, 3)`, [userId])
        const runner = {
            connection: { options: { type: 'postgres' } },
            connect: async () => undefined,
            release: async () => undefined,
            query: async (text: string, params?: unknown[]) => (await db.query(text, params)).rows
        }
        const store = new SqlIdentityStore({ createQueryRunner: () => runner } as unknown as DataSource)
        const now = Date.now()
        await store.insertLocalSession({
            id: 'session-1',
            userId,
            token: 'hashed-token',
            idleExpires: new Date(now + 60_000),
            absoluteExpires: new Date(now + 120_000),
            authenticationMethod: 'workos',
            workosSessionId: 'workos-session-1'
        })
        const found = await store.findLocalSession('hashed-token')
        expect(found).toEqual(
            expect.objectContaining({
                id: 'session-1',
                userId,
                permissionVersion: 3,
                currentPermissionVersion: 3,
                authenticationMethod: 'workos',
                workosSessionId: 'workos-session-1'
            })
        )
    } finally {
        await db.end()
        const drop = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: 'postgres' })
        await drop.connect()
        await drop.query(`DROP DATABASE IF EXISTS ${name}`)
        await drop.end()
    }
})

it('stores and finds a WorkOS session id on sqlite', async () => {
    const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (path: string) => {
            exec(sql: string): void
            close(): void
            prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
        }
    }
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE "user" (id text PRIMARY KEY, "permissionVersion" integer NOT NULL DEFAULT 0);
        CREATE TABLE identity_local_session (
            id text NOT NULL PRIMARY KEY,
            "userId" text NOT NULL,
            token text NOT NULL UNIQUE,
            "expiresAt" datetime NOT NULL,
            "absoluteExpiresAt" datetime NOT NULL,
            "createdDate" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "lastSeenAt" datetime,
            "permissionVersion" integer NOT NULL DEFAULT 0,
            "recentAuthenticationAt" datetime,
            "authenticationMethod" varchar(32),
            "authenticationEpoch" integer,
            "recoveryUse" integer NOT NULL DEFAULT 0,
            "workosSessionId" varchar(255)
        );
        INSERT INTO "user" (id, "permissionVersion") VALUES ('user-1', 4);
    `)
    const runner = {
        connection: { options: { type: 'sqlite' } },
        connect: async () => undefined,
        release: async () => undefined,
        query: async (statement: string, params: unknown[] = []) => {
            const prepared = db.prepare(statement)
            const values = params.map((value) => (value instanceof Date ? value.toISOString() : value))
            if (/^\s*(select|with|pragma)\b/i.test(statement)) return prepared.all(...values)
            prepared.run(...values)
            return []
        }
    }
    const store = new SqlIdentityStore({ createQueryRunner: () => runner } as unknown as DataSource)
    try {
        const now = Date.now()
        await store.insertLocalSession({
            id: 'session-1',
            userId: 'user-1',
            token: 'hashed-token',
            idleExpires: new Date(now + 60_000),
            absoluteExpires: new Date(now + 120_000),
            authenticationMethod: 'workos',
            workosSessionId: 'workos-session-1'
        })
        expect(await store.findLocalSession('hashed-token')).toEqual(
            expect.objectContaining({
                id: 'session-1',
                userId: 'user-1',
                permissionVersion: 4,
                currentPermissionVersion: 4,
                authenticationMethod: 'workos',
                workosSessionId: 'workos-session-1'
            })
        )
        const recentAuthenticationAt = new Date(now - 30_000)
        await store.insertLocalSession({
            id: 'session-2',
            userId: 'user-1',
            token: 'oidc-token',
            idleExpires: new Date(now + 60_000),
            absoluteExpires: new Date(now + 120_000),
            authenticationMethod: 'oidc',
            recentAuthenticationAt
        })
        expect(await store.findLocalSession('oidc-token')).toEqual(
            expect.objectContaining({ authenticationMethod: 'oidc', recentAuthenticationAt })
        )
    } finally {
        db.close()
    }
})

const OLD_BCRYPT = '$2a$10$izJQJlD9yogrwzhiB6CQA.X0TmTi5UTGyQsoXeQpetpnyAGhVJWJO'
const NEXT_SCRYPT = 'scrypt$salt$new-key'
const OTHER_SCRYPT = 'scrypt$salt$other-writer'
/** Matches `$2a$%` but fails isBcryptHash (cost 31). One page of these used to hide a later accepted hash. */
const REJECTED_BCRYPT = '$2a$31$' + 'A'.repeat(53)
const REJECTED_PAGE = 33

function sqliteRejectedIds(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `aa-${String(i).padStart(2, '0')}`)
}

function postgresRejectedIds(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`)
}

async function expectReplaceCredentialCas(store: SqlIdentityStore, userId: string, read: () => Promise<string | null>): Promise<void> {
    expect(await store.replaceCredential(userId, OLD_BCRYPT, NEXT_SCRYPT)).toBe(true)
    expect(await read()).toBe(NEXT_SCRYPT)
    expect(await store.replaceCredential(userId, OLD_BCRYPT, OTHER_SCRYPT)).toBe(false)
    expect(await read()).toBe(NEXT_SCRYPT)
}

it('replaces a credential only when the stored hash still matches, on sqlite', async () => {
    const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (path: string) => {
            exec(sql: string): void
            close(): void
            prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
        }
    }
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE "user" (
            id text PRIMARY KEY,
            credential text,
            "updatedDate" text
        );
        INSERT INTO "user" (id, credential) VALUES ('user-1', '${OLD_BCRYPT}');
    `)
    const run = async (statement: string, params: unknown[] = []) => {
        const prepared = db.prepare(statement)
        if (/^\s*(select|with)\b/i.test(statement)) return prepared.all(...params)
        prepared.run(...params)
        return []
    }
    const runner = {
        connection: { options: { type: 'sqlite' } },
        connect: async () => undefined,
        release: async () => undefined,
        query: run
    }
    const store = new SqlIdentityStore({ createQueryRunner: () => runner } as unknown as DataSource)
    try {
        expect(await store.hasBcryptCredential()).toBe(true)
        await expectReplaceCredentialCas(store, 'user-1', async () => {
            const rows = await run('SELECT credential FROM "user" WHERE id = ?', ['user-1'])
            return rows[0] ? String(rows[0].credential) : null
        })
        expect(await store.hasBcryptCredential()).toBe(false)
    } finally {
        db.close()
    }
})

it('finds an accepted bcrypt hash after more than one page of rejected $2x$ prefixes, on sqlite', async () => {
    const { DatabaseSync } = require('node:sqlite') as {
        DatabaseSync: new (path: string) => {
            exec(sql: string): void
            close(): void
            prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
        }
    }
    const db = new DatabaseSync(':memory:')
    const rejected = sqliteRejectedIds(REJECTED_PAGE)
    const values = rejected.map((id) => `('${id}', '${REJECTED_BCRYPT}')`).join(', ')
    db.exec(`
        CREATE TABLE "user" (
            id text PRIMARY KEY,
            credential text,
            "updatedDate" text
        );
        INSERT INTO "user" (id, credential) VALUES ${values};
    `)
    const statements: string[] = []
    const run = async (statement: string, params: unknown[] = []) => {
        statements.push(statement)
        const prepared = db.prepare(statement)
        if (/^\s*(select|with)\b/i.test(statement)) return prepared.all(...params)
        prepared.run(...params)
        return []
    }
    const runner = {
        connection: { options: { type: 'sqlite' } },
        connect: async () => undefined,
        release: async () => undefined,
        query: run
    }
    const store = new SqlIdentityStore({ createQueryRunner: () => runner } as unknown as DataSource)
    try {
        expect(rejected.length).toBeGreaterThan(32)
        expect(await store.hasBcryptCredential()).toBe(false)
        await run('INSERT INTO "user" (id, credential) VALUES (?, ?)', ['zz-valid', OLD_BCRYPT])
        expect(await store.hasBcryptCredential()).toBe(true)
        expect(statements.some((sql) => /\bOFFSET\b/i.test(sql))).toBe(false)
        expect(statements.some((sql) => /"id"\s*>\s*\?/.test(sql))).toBe(true)
    } finally {
        db.close()
    }
})

livePg('replaces a credential only when the stored hash still matches, on postgres', async () => {
    const pg = require('pg') as { Client: new (config: Record<string, unknown>) => PgClient }
    const password = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD
    const admin = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: 'postgres' })
    await admin.connect()
    const name = `cuttlely_cas_${process.pid}`
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
    const db = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: name })
    await db.connect()
    try {
        const userId = '6f1d3a52-2c4b-4c1e-9a57-0d3b8f6e2a10'
        await db.query(`CREATE TABLE "user" (id uuid PRIMARY KEY, credential text, "updatedDate" TIMESTAMP)`)
        await db.query(`INSERT INTO "user" (id, credential) VALUES ($1, $2)`, [userId, OLD_BCRYPT])
        const runner = {
            connection: { options: { type: 'postgres' } },
            connect: async () => undefined,
            release: async () => undefined,
            query: async (text: string, params?: unknown[]) => (await db.query(text, params)).rows
        }
        const store = new SqlIdentityStore({ createQueryRunner: () => runner } as unknown as DataSource)
        expect(await store.hasBcryptCredential()).toBe(true)
        await expectReplaceCredentialCas(store, userId, async () => {
            const result = await db.query('SELECT credential FROM "user" WHERE id = $1', [userId])
            return result.rows[0] ? String(result.rows[0].credential) : null
        })
        expect(await store.hasBcryptCredential()).toBe(false)
    } finally {
        await db.end()
        const drop = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: 'postgres' })
        await drop.connect()
        await drop.query(`DROP DATABASE IF EXISTS ${name}`)
        await drop.end()
    }
})

livePg('finds an accepted bcrypt hash after more than one page of rejected $2x$ prefixes, on postgres', async () => {
    const pg = require('pg') as { Client: new (config: Record<string, unknown>) => PgClient }
    const password = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD
    const admin = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: 'postgres' })
    await admin.connect()
    const name = `cuttlely_bcrypt_page_${process.pid}`
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
    const db = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: name })
    await db.connect()
    try {
        await db.query(`CREATE TABLE "user" (id uuid PRIMARY KEY, credential text, "updatedDate" TIMESTAMP)`)
        const rejected = postgresRejectedIds(REJECTED_PAGE)
        for (const id of rejected) {
            await db.query(`INSERT INTO "user" (id, credential) VALUES ($1, $2)`, [id, REJECTED_BCRYPT])
        }
        const statements: string[] = []
        const runner = {
            connection: { options: { type: 'postgres' } },
            connect: async () => undefined,
            release: async () => undefined,
            query: async (text: string, params?: unknown[]) => {
                statements.push(text)
                return (await db.query(text, params)).rows
            }
        }
        const store = new SqlIdentityStore({ createQueryRunner: () => runner } as unknown as DataSource)
        expect(rejected.length).toBeGreaterThan(32)
        expect(await store.hasBcryptCredential()).toBe(false)
        await db.query(`INSERT INTO "user" (id, credential) VALUES ($1, $2)`, ['ffffffff-ffff-4fff-bfff-ffffffffffff', OLD_BCRYPT])
        expect(await store.hasBcryptCredential()).toBe(true)
        expect(statements.some((sql) => /\bOFFSET\b/i.test(sql))).toBe(false)
        expect(statements.some((sql) => /"id"\s*>/.test(sql))).toBe(true)
    } finally {
        await db.end()
        const drop = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: 'postgres' })
        await drop.connect()
        await drop.query(`DROP DATABASE IF EXISTS ${name}`)
        await drop.end()
    }
})
