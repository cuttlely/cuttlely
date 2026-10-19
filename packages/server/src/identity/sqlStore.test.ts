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
            "permissionVersion" integer NOT NULL DEFAULT 0
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
            absoluteExpires: new Date(now + 120_000)
        })
        const found = await store.findLocalSession('hashed-token')
        expect(found).toEqual(expect.objectContaining({ id: 'session-1', userId, permissionVersion: 3, currentPermissionVersion: 3 }))
    } finally {
        await db.end()
        const drop = new pg.Client({ host: '127.0.0.1', user: 'postgres', password, database: 'postgres' })
        await drop.connect()
        await drop.query(`DROP DATABASE IF EXISTS ${name}`)
        await drop.end()
    }
})

const OLD_BCRYPT = '$2a$10$izJQJlD9yogrwzhiB6CQA.X0TmTi5UTGyQsoXeQpetpnyAGhVJWJO'
const NEXT_SCRYPT = 'scrypt$salt$new-key'
const OTHER_SCRYPT = 'scrypt$salt$other-writer'

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
