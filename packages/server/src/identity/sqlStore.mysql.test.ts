/**
 * Setup-code store against MySQL and MariaDB.
 * The suites that open a database run only when CUTTLELY_TEST_MYSQL_URL or
 * CUTTLELY_TEST_MARIADB_URL is set. Jest maps the typeorm package name to a stub,
 * so this file loads the real driver from its package path.
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import type { DataSource } from 'typeorm'
import { mysqlMigrations } from '../database/migrations/mysql'
import { mariadbMigrations } from '../database/migrations/mariadb'
import { SqlIdentityStore, SqlSetupCodeStore } from './sqlStore'
import { SetupCodeRow } from './setupCode'
import { SetupCodeRejected } from './types'

const SCRATCH = 'cuttlely_setup_code_live'
const HOUR = 60 * 60 * 1000

/** Jest maps the package name `typeorm` to a stub. Load the real package by its directory. */
function loadDataSource(): typeof DataSource {
    const candidates = [
        path.join(__dirname, '../../node_modules/typeorm/package.json'),
        path.join(__dirname, '../../../../node_modules/typeorm/package.json')
    ]
    const pkgPath = candidates.find((candidate) => fs.existsSync(candidate))
    if (!pkgPath) throw new Error('typeorm package was not found')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { main?: string }
    const entry = path.join(path.dirname(pkgPath), pkg.main || 'index.js')
    const loaded = createRequire(pkgPath)(entry) as { DataSource: typeof DataSource }
    return loaded.DataSource
}

function hmac(char: string): string {
    return char.repeat(64)
}

function row(char: string, issuedAt: number, expiresAt: number): SetupCodeRow {
    return { codeHmac: hmac(char), issuedAt, expiresAt, consumedAt: null }
}

interface MysqlTarget {
    host: string
    port: number
    username: string
    password: string
}

function targetFrom(url: string): MysqlTarget {
    const parsed = new URL(url)
    return {
        host: parsed.hostname,
        port: Number(parsed.port || 3306),
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password)
    }
}

describe('setup code sql', () => {
    it('writes MySQL and MariaDB setup rows in a transaction', () => {
        const source = fs.readFileSync(path.join(__dirname, 'sqlStore.ts'), 'utf8')
        expect(source.includes('@setup_keep')).toBe(false)
        expect(source.includes('INSERT IGNORE')).toBe(true)
        expect(source.includes('FOR UPDATE')).toBe(true)
    })
})

async function exercise(kind: 'mysql' | 'mariadb', url: string): Promise<void> {
    const DataSourceCtor = loadDataSource()
    const target = targetFrom(url)
    const migrations = kind === 'mysql' ? mysqlMigrations : mariadbMigrations
    const common = {
        type: kind,
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
        charset: 'utf8mb4' as const,
        synchronize: false,
        migrationsRun: false,
        entities: [] as [],
        extra: { connectTimeout: 5000 }
    }
    const admin = new DataSourceCtor({ ...common, database: 'mysql' })
    await admin.initialize()
    let version = ''
    try {
        const versions: { version?: string; VERSION?: string }[] = await admin.query('SELECT VERSION() AS version')
        version = String(versions[0]?.version ?? versions[0]?.VERSION ?? '')
        console.info(`${kind} VERSION ${version}`)
        await admin.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``)
        await admin.query(`CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4`)
    } finally {
        await admin.destroy()
    }

    const ds = new DataSourceCtor({ ...common, database: SCRATCH, migrations })
    const second = new DataSourceCtor({ ...common, database: SCRATCH })
    await ds.initialize()
    try {
        const applied = await ds.runMigrations()
        console.info(`${kind} migrations applied ${applied.length} of ${migrations.length}`)
        const tables: { name?: string }[] = await ds.query(
            `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'identity_setup_code'`,
            [SCRATCH]
        )
        expect(tables.length).toBe(1)

        const store = new SqlSetupCodeStore(ds)
        const issuedAt = Date.parse('2026-10-20T12:00:00.000Z')
        const inserted = row('a', issuedAt, issuedAt + HOUR)
        expect(await store.save(inserted, null)).toBe('inserted')
        const blocked = row('b', issuedAt + 1, issuedAt + HOUR)
        expect(await store.save(blocked, hmac('c'))).toBe('kept')
        expect((await store.read())?.codeHmac).toBe(inserted.codeHmac)
        const replacedOwn = { ...inserted, expiresAt: issuedAt + 2 * HOUR }
        expect(await store.save(replacedOwn, inserted.codeHmac)).toBe('replaced')

        const staleIssued = replacedOwn.expiresAt
        const stale = row('d', staleIssued, staleIssued + 1000)
        expect(await store.save(stale, null)).toBe('replaced')

        await second.initialize()
        const copyA = new SqlSetupCodeStore(ds)
        const copyB = new SqlSetupCodeStore(second)
        await ds.query('DELETE FROM `identity_setup_code`')
        const emptyA = row('e', issuedAt, issuedAt + HOUR)
        const emptyB = row('f', issuedAt, issuedAt + HOUR)
        const emptyRace = (await Promise.all([copyA.save(emptyA, ''), copyB.save(emptyB, '')])).slice().sort()
        expect(emptyRace).toEqual(['inserted', 'kept'])
        const afterEmpty = await store.read()
        expect([emptyA.codeHmac, emptyB.codeHmac]).toContain(afterEmpty?.codeHmac)

        const expiredAt = Date.parse('2026-10-20T11:00:00.000Z')
        const held = await store.read()
        const expired = row('d', held!.expiresAt, expiredAt)
        expect(await store.save(expired, held!.codeHmac)).toBe('replaced')
        const left = row('1', expired.expiresAt, expired.expiresAt + HOUR)
        const right = row('2', expired.expiresAt, expired.expiresAt + HOUR)
        const expiryRace = (await Promise.all([copyA.save(left, ''), copyB.save(right, '')])).slice().sort()
        expect(expiryRace).toEqual(['kept', 'replaced'])
        const winner = await store.read()
        expect([left.codeHmac, right.codeHmac]).toContain(winner?.codeHmac)
        expect(winner?.consumedAt).toBeNull()

        const identity = new SqlIdentityStore(ds)
        const owner = await identity.createOwner(
            { email: 'owner@example.com', name: 'Owner', credential: 'fixture-credential', externalId: null },
            { consumeSetupHmac: winner!.codeHmac, now: winner!.issuedAt + 1 }
        )
        expect(owner.email).toBe('owner@example.com')
        expect((await store.read())?.consumedAt).toBe(winner!.issuedAt + 1)

        await ds.query('SET FOREIGN_KEY_CHECKS = 0')
        try {
            for (const table of [
                'workspace_user',
                'organization_user',
                'workspace',
                'role',
                'organization',
                'user',
                'identity_bootstrap'
            ]) {
                await ds.query(`DELETE FROM \`${table}\``)
            }
        } finally {
            await ds.query('SET FOREIGN_KEY_CHECKS = 1')
        }
        await expect(
            identity.createOwner(
                { email: 'owner@example.com', name: 'Owner', credential: 'fixture-credential', externalId: null },
                { consumeSetupHmac: winner!.codeHmac, now: winner!.issuedAt + 2 }
            )
        ).rejects.toBeInstanceOf(SetupCodeRejected)

        console.info(
            `${kind} RESULT version=${version} inserted kept replaced empty=${emptyRace.join(',')} expiry=${expiryRace.join(
                ','
            )} consumed=yes`
        )
    } finally {
        if (second.isInitialized) await second.destroy()
        if (ds.isInitialized) await ds.destroy()
        const cleanup = new DataSourceCtor({ ...common, database: 'mysql' })
        await cleanup.initialize()
        try {
            await cleanup.query(`DROP DATABASE IF EXISTS \`${SCRATCH}\``)
        } finally {
            await cleanup.destroy()
        }
    }
}

const mysqlUrl = process.env.CUTTLELY_TEST_MYSQL_URL
const mariadbUrl = process.env.CUTTLELY_TEST_MARIADB_URL

;(mysqlUrl ? describe : describe.skip)('mysql setup code store', () => {
    it('runs migrations and the setup-code paths', async () => {
        await exercise('mysql', mysqlUrl as string)
    }, 180_000)
})
;(mariadbUrl ? describe : describe.skip)('mariadb setup code store', () => {
    it('runs migrations and the setup-code paths', async () => {
        await exercise('mariadb', mariadbUrl as string)
    }, 180_000)
})
