/**
 * Pre-3.1.4 Flowise databases are refused before TypeORM migrations, against SQLite and,
 * when PGPASSWORD or CUTTLELY_TEST_PG_PASSWORD is set, a live Postgres.
 * CUTTLELY_TEST_PG_REQUIRED=1 fails instead of skipping.
 */
import type { DataSource, QueryRunner } from 'typeorm'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import {
    UNSUPPORTED_FLOWISE_UPGRADE,
    WORKSPACE_SCOPED_TABLES,
    assertSupportedFlowiseUpgrade,
    ensureFlowiseUpgradeSupported,
    logUnsupportedFlowiseUpgrade,
    runSupportedMigrations,
    unsupportedFlowiseUpgradeError,
    unsupportedFlowiseUpgradeMessage
} from './flowiseUpgradeGuard'

const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
        close(): void
        prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
    }
}

const pgPassword = process.env.PGPASSWORD || process.env.CUTTLELY_TEST_PG_PASSWORD

type PgClient = {
    connect(): Promise<void>
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>
    end(): Promise<void>
}

type Store = {
    dialect: 'sqlite' | 'postgres'
    exec(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>
    snapshot(): Promise<string>
    close(): Promise<void>
}

function sqliteStore(): Store {
    const db = new DatabaseSync(':memory:')
    const exec = async (sql: string, params: unknown[] = []) => {
        const trimmed = sql.trim()
        const stmt = db.prepare(trimmed)
        if (/^(SELECT|PRAGMA)\b/i.test(trimmed)) return stmt.all(...params) as Record<string, unknown>[]
        stmt.run(...params)
        return []
    }
    return {
        dialect: 'sqlite',
        exec,
        snapshot: async () => {
            const tables = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{
                name: string
                sql: string | null
            }>
            const pieces = tables.map((table) => {
                const rows = db.prepare(`SELECT * FROM "${table.name.replace(/"/g, '""')}"`).all()
                return `${table.name}\n${table.sql || ''}\n${JSON.stringify(rows)}`
            })
            return pieces.join('\n---\n')
        },
        close: async () => db.close()
    }
}

async function postgresStore(): Promise<Store> {
    const pg = require('pg') as { Client: new (config: Record<string, unknown>) => PgClient }
    const base = {
        host: process.env.CUTTLELY_TEST_PG_HOST || process.env.PGHOST || '127.0.0.1',
        port: Number(process.env.CUTTLELY_TEST_PG_PORT || process.env.PGPORT || 5432),
        user: process.env.CUTTLELY_TEST_PG_USER || process.env.PGUSER || 'postgres',
        password: pgPassword
    }
    const name = `cuttlely_guard_${process.pid}_${randomUUID().slice(0, 8).replace(/-/g, '')}`
    const admin = new pg.Client({ ...base, database: 'postgres' })
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
    await admin.query(`CREATE DATABASE ${name}`)
    await admin.end()
    const db = new pg.Client({ ...base, database: name })
    await db.connect()
    return {
        dialect: 'postgres',
        exec: async (sql: string, params: unknown[] = []) => {
            let index = 0
            const text = sql.replace(/\?/g, () => `$${++index}`)
            return (await db.query(text, params)).rows
        },
        snapshot: async () => {
            const tables = (
                await db.query(
                    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`
                )
            ).rows as Array<{ name: string }>
            const pieces = []
            for (const table of tables) {
                const columns = (
                    await db.query(
                        `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
                        [table.name]
                    )
                ).rows
                const rows = (await db.query(`SELECT * FROM "${table.name.replace(/"/g, '""')}"`)).rows
                pieces.push(`${table.name}\n${JSON.stringify(columns)}\n${JSON.stringify(rows)}`)
            }
            return pieces.join('\n---\n')
        },
        close: async () => {
            await db.end()
            const drop = new pg.Client({ ...base, database: 'postgres' })
            await drop.connect()
            await drop.query(`DROP DATABASE IF EXISTS ${name}`)
            await drop.end()
        }
    }
}

function runnerFor(store: Store): QueryRunner {
    return {
        connection: { options: { type: store.dialect } },
        query: (text: string, params?: unknown[]) => store.exec(text, params)
    } as unknown as QueryRunner
}

function dataSourceFor(store: Store, onMigrate: () => Promise<void>, queries: string[] = []): DataSource {
    const runner = runnerFor(store)
    return {
        options: { type: store.dialect },
        createQueryRunner: () => ({
            ...runner,
            release: async () => undefined
        }),
        query: async (sql: string) => {
            queries.push(sql)
            return []
        },
        runMigrations: async () => {
            await onMigrate()
            return []
        }
    } as unknown as DataSource
}

async function seedPre314(store: Store): Promise<void> {
    const time = store.dialect === 'postgres' ? 'TIMESTAMP' : 'datetime'
    await store.exec(
        `CREATE TABLE chat_flow (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL, "flowData" text NOT NULL, "createdDate" ${time})`
    )
    await store.exec(
        `CREATE TABLE credential (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL, "credentialName" varchar NOT NULL, "encryptedData" text NOT NULL)`
    )
    await store.exec(`CREATE TABLE migrations (id integer PRIMARY KEY NOT NULL, timestamp bigint NOT NULL, name varchar NOT NULL)`)
    await store.exec(`INSERT INTO migrations (id, timestamp, name) VALUES (?, ?, ?)`, [1, 1693835579790, 'Init1693835579790'])
    await store.exec(`INSERT INTO chat_flow (id, name, "flowData", "createdDate") VALUES (?, ?, ?, ?)`, [
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01',
        'Harbor Bakery helper',
        '{"nodes":[],"edges":[]}',
        '2024-06-11 08:15:00'
    ])
    await store.exec(`INSERT INTO credential (id, name, "credentialName", "encryptedData") VALUES (?, ?, ?, ?)`, [
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02',
        'Harbor counter key',
        'openAIApi',
        'enc-not-a-real-secret'
    ])
}

async function seed314(store: Store): Promise<void> {
    await seedPre314(store)
    await store.exec(`CREATE TABLE workspace (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL)`)
    await store.exec(`CREATE TABLE workspace_user ("workspaceId" varchar NOT NULL, "userId" varchar NOT NULL)`)
    await store.exec(`ALTER TABLE chat_flow ADD COLUMN "workspaceId" varchar`)
    await store.exec(`ALTER TABLE credential ADD COLUMN "workspaceId" varchar`)
    await store.exec(`INSERT INTO workspace (id, name) VALUES (?, ?)`, ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee03', 'Harbor counter'])
    await store.exec(`UPDATE chat_flow SET "workspaceId" = ?`, ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee03'])
    await store.exec(`UPDATE credential SET "workspaceId" = ?`, ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee03'])
    await store.exec(`INSERT INTO migrations (id, timestamp, name) VALUES (?, ?, ?)`, [
        2,
        1737076223692,
        'RefactorEnterpriseDatabase1737076223692'
    ])
    await store.exec(`INSERT INTO workspace_user ("workspaceId", "userId") VALUES (?, ?)`, [
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee03',
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee04'
    ])
}

const backends: [string, () => Promise<Store>, boolean][] = [
    ['sqlite', async () => sqliteStore(), true],
    ['postgres', postgresStore, Boolean(pgPassword)]
]

if (process.env.CUTTLELY_TEST_PG_REQUIRED === '1' && !pgPassword) {
    test('postgres is required for this run', () => {
        throw new Error('CUTTLELY_TEST_PG_REQUIRED=1 needs PGPASSWORD or CUTTLELY_TEST_PG_PASSWORD')
    })
}

describe.each(backends)('Flowise pre-3.1.4 upgrade guard on %s', (_name, open, enabled) => {
    const maybe = enabled ? it : it.skip
    let store: Store

    beforeEach(async () => {
        if (!enabled) return
        store = await open()
    })

    afterEach(async () => {
        if (!enabled) return
        await store.close()
    })

    maybe('refuses a 2.2.8-style database, leaves every table and row unchanged, and does not run migrations', async () => {
        await seedPre314(store)
        const before = await store.snapshot()
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
            await store.exec(`CREATE TABLE guard_must_not_run (id integer)`)
        })
        await expect(runSupportedMigrations(ds)).rejects.toThrow(UNSUPPORTED_FLOWISE_UPGRADE)
        await expect(runSupportedMigrations(ds)).rejects.toThrow('docs/bring-your-flows.md#move-a-whole-install')
        expect(migrated).toBe(false)
        expect(await store.snapshot()).toBe(before)
    })

    maybe('allows an empty database so a first start can still migrate', async () => {
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
        })
        await expect(runSupportedMigrations(ds)).resolves.toBeUndefined()
        expect(migrated).toBe(true)
    })

    maybe('allows a 3.1.4-style database that already has workspace rows', async () => {
        await seed314(store)
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
        })
        await expect(ensureFlowiseUpgradeSupported(ds)).resolves.toBeUndefined()
        await expect(runSupportedMigrations(ds)).resolves.toBeUndefined()
        expect(migrated).toBe(true)
        const flows = await store.exec(`SELECT name, "workspaceId" AS workspace FROM chat_flow`)
        expect(flows).toEqual([{ name: 'Harbor Bakery helper', workspace: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee03' }])
    })

    maybe('refuses when the workspace table exists but chat_flow has no workspaceId', async () => {
        await seedPre314(store)
        await store.exec(`CREATE TABLE workspace (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL)`)
        const before = await store.snapshot()
        await expect(assertSupportedFlowiseUpgrade(runnerFor(store))).rejects.toThrow(UNSUPPORTED_FLOWISE_UPGRADE)
        expect(await store.snapshot()).toBe(before)
    })

    maybe('refuses a database that still has the old enterprise identity columns', async () => {
        await seedPre314(store)
        await store.exec(`CREATE TABLE workspace (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL)`)
        await store.exec(`ALTER TABLE chat_flow ADD COLUMN "workspaceId" varchar`)
        await store.exec(`ALTER TABLE credential ADD COLUMN "workspaceId" varchar`)
        await store.exec(`CREATE TABLE workspace_user ("workspaceId" varchar NOT NULL, "userId" varchar NOT NULL)`)
        await store.exec(`CREATE TABLE roles (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL)`)
        const before = await store.snapshot()
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
        })
        await expect(runSupportedMigrations(ds)).rejects.toThrow(UNSUPPORTED_FLOWISE_UPGRADE)
        expect(migrated).toBe(false)
        expect(await store.snapshot()).toBe(before)
    })

    maybe('allows a 3.1.4 database identified only by its recorded migration names', async () => {
        await seedPre314(store)
        await store.exec(`INSERT INTO migrations (id, timestamp, name) VALUES (?, ?, ?)`, [2, 1720230151484, 'AddWorkspace1720230151484'])
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
        })
        await expect(runSupportedMigrations(ds)).resolves.toBeUndefined()
        expect(migrated).toBe(true)
    })

    maybe('allows a MariaDB 3.1.4 AddWorkspace name', async () => {
        await seedPre314(store)
        await store.exec(`INSERT INTO migrations (id, timestamp, name) VALUES (?, ?, ?)`, [2, 1725437498242, 'AddWorkspace1725437498242'])
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
        })
        await expect(runSupportedMigrations(ds)).resolves.toBeUndefined()
        expect(migrated).toBe(true)
    })

    maybe('resumes a Cuttlely first start that recorded Init then stopped before AddWorkspace', async () => {
        const time = store.dialect === 'postgres' ? 'TIMESTAMP' : 'datetime'
        await store.exec(
            `CREATE TABLE chat_flow (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL, "flowData" text NOT NULL, "createdDate" ${time})`
        )
        await store.exec(
            `CREATE TABLE credential (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL, "credentialName" varchar NOT NULL, "encryptedData" text NOT NULL)`
        )
        await store.exec(`CREATE TABLE migrations (id integer PRIMARY KEY NOT NULL, timestamp bigint NOT NULL, name varchar NOT NULL)`)
        await store.exec(`INSERT INTO migrations (id, timestamp, name) VALUES (?, ?, ?)`, [1, 1693835579790, 'Init1693835579790'])
        let migrated = false
        const queries: string[] = []
        const ds = dataSourceFor(
            store,
            async () => {
                migrated = true
            },
            queries
        )
        await expect(runSupportedMigrations(ds)).resolves.toBeUndefined()
        expect(migrated).toBe(true)
        if (store.dialect === 'sqlite') {
            expect(queries).toEqual(['PRAGMA journal_mode = WAL', 'PRAGMA synchronous = NORMAL'])
        } else {
            expect(queries).toEqual([])
        }
    })

    maybe('does not switch SQLite to WAL when a 2.2.8-style database is refused', async () => {
        await seedPre314(store)
        const queries: string[] = []
        const ds = dataSourceFor(store, async () => undefined, queries)
        await expect(runSupportedMigrations(ds)).rejects.toThrow(UNSUPPORTED_FLOWISE_UPGRADE)
        expect(queries).toEqual([])
    })

    maybe('refuses a pre-3.1.4 database whose only app data is a document_store row', async () => {
        await store.exec(`CREATE TABLE migrations (id integer PRIMARY KEY NOT NULL, timestamp bigint NOT NULL, name varchar NOT NULL)`)
        await store.exec(`INSERT INTO migrations (id, timestamp, name) VALUES (?, ?, ?)`, [1, 1693835579790, 'Init1693835579790'])
        await store.exec(
            `CREATE TABLE document_store (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL, status varchar NOT NULL, loaders text)`
        )
        await store.exec(`INSERT INTO document_store (id, name, status, loaders) VALUES (?, ?, ?, ?)`, [
            'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee11',
            'Harbor bakery recipes',
            'EMPTY',
            '[]'
        ])
        const before = await store.snapshot()
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
        })
        await expect(runSupportedMigrations(ds)).rejects.toThrow(UNSUPPORTED_FLOWISE_UPGRADE)
        expect(migrated).toBe(false)
        expect(await store.snapshot()).toBe(before)
    })

    maybe('refuses an older enterprise identity schema even when application tables are empty', async () => {
        await store.exec(`CREATE TABLE roles (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL)`)
        await store.exec(`INSERT INTO roles (id, name) VALUES (?, ?)`, ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee21', 'Harbor owner'])
        const before = await store.snapshot()
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
        })
        await expect(runSupportedMigrations(ds)).rejects.toThrow(UNSUPPORTED_FLOWISE_UPGRADE)
        expect(migrated).toBe(false)
        expect(await store.snapshot()).toBe(before)
    })

    maybe('refuses legacy user identity columns even when application tables are empty', async () => {
        await store.exec(
            `CREATE TABLE "user" (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL, "activeWorkspaceId" varchar, user_type varchar)`
        )
        await store.exec(`INSERT INTO "user" (id, name, "activeWorkspaceId", user_type) VALUES (?, ?, ?, ?)`, [
            'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee22',
            'Harbor owner',
            'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee23',
            'PLATFORM'
        ])
        const before = await store.snapshot()
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
        })
        await expect(runSupportedMigrations(ds)).rejects.toThrow(UNSUPPORTED_FLOWISE_UPGRADE)
        expect(migrated).toBe(false)
        expect(await store.snapshot()).toBe(before)
    })

    maybe('allows a current Cuttlely identity schema with empty application tables', async () => {
        await store.exec(`CREATE TABLE "user" (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL, email varchar NOT NULL)`)
        await store.exec(`CREATE TABLE organization (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL)`)
        await store.exec(`CREATE TABLE role (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL)`)
        await store.exec(`CREATE TABLE workspace (id varchar PRIMARY KEY NOT NULL, name varchar NOT NULL)`)
        await store.exec(`CREATE TABLE workspace_user ("workspaceId" varchar NOT NULL, "userId" varchar NOT NULL)`)
        await store.exec(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
            'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee31',
            'Harbor baker',
            'baker@harbor.example'
        ])
        await store.exec(`INSERT INTO organization (id, name) VALUES (?, ?)`, ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee32', 'Harbor Bakery'])
        await store.exec(`INSERT INTO role (id, name) VALUES (?, ?)`, ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee33', 'Owner'])
        await store.exec(`INSERT INTO workspace (id, name) VALUES (?, ?)`, ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee34', 'Harbor counter'])
        await store.exec(`INSERT INTO workspace_user ("workspaceId", "userId") VALUES (?, ?)`, [
            'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee34',
            'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee31'
        ])
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
        })
        await expect(runSupportedMigrations(ds)).resolves.toBeUndefined()
        expect(migrated).toBe(true)
    })

    maybe('refuses a pre-3.1.4 database whose only app data is a variable row', async () => {
        await store.exec(`CREATE TABLE migrations (id integer PRIMARY KEY NOT NULL, timestamp bigint NOT NULL, name varchar NOT NULL)`)
        await store.exec(`INSERT INTO migrations (id, timestamp, name) VALUES (?, ?, ?)`, [1, 1693835579790, 'Init1693835579790'])
        await store.exec(`CREATE TABLE variable (id varchar PRIMARY KEY NOT NULL, name text NOT NULL, value text NOT NULL)`)
        await store.exec(`INSERT INTO variable (id, name, value) VALUES (?, ?, ?)`, [
            'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee12',
            'harbor_bakery_hours',
            'Tue-Sun 07:00-16:00'
        ])
        const before = await store.snapshot()
        let migrated = false
        const ds = dataSourceFor(store, async () => {
            migrated = true
        })
        await expect(runSupportedMigrations(ds)).rejects.toThrow(UNSUPPORTED_FLOWISE_UPGRADE)
        expect(migrated).toBe(false)
        expect(await store.snapshot()).toBe(before)
    })
})

describe('unsupported Flowise upgrade log', () => {
    it('prints the documented stop line and the docs link for start, worker, and user', () => {
        const lines: string[] = []
        const log = { error: (line: string) => lines.push(line) }
        expect(logUnsupportedFlowiseUpgrade(unsupportedFlowiseUpgradeError(), log)).toBe(true)
        expect(lines).toEqual([unsupportedFlowiseUpgradeMessage()])
        expect(lines[0]).toContain(UNSUPPORTED_FLOWISE_UPGRADE)
        expect(lines[0]).toContain('docs/bring-your-flows.md#move-a-whole-install')
        expect(logUnsupportedFlowiseUpgrade(new Error('other'), log)).toBe(false)
        expect(lines).toHaveLength(1)
    })

    it('is wired from start, worker, and user so each prints that line', () => {
        const here = path.join(__dirname, '..')
        for (const file of ['index.ts', 'commands/start.ts', 'commands/worker.ts', 'commands/user.ts']) {
            expect(fs.readFileSync(path.join(here, file), 'utf8')).toContain('logUnsupportedFlowiseUpgrade')
        }
    })

    it('shares the workspace-scoped table list with AddWorkspace / workspaceUp', () => {
        expect([...WORKSPACE_SCOPED_TABLES]).toEqual([
            'assistant',
            'chat_flow',
            'credential',
            'dataset',
            'document_store',
            'evaluation',
            'evaluator',
            'tool',
            'variable',
            'custom_template',
            'apikey'
        ])
        const schema = fs.readFileSync(path.join(__dirname, '../database/identitySchema.ts'), 'utf8')
        expect(schema).toContain('WORKSPACE_SCOPED_TABLES')
        expect(schema).not.toMatch(/const WORKSPACE_ID_TABLES/)
        expect(schema).toMatch(/for \(const table of WORKSPACE_SCOPED_TABLES\)/)
    })
})
