// Run on the original volume during maintenance. The caller switches the application only after this returns.
import fs from 'node:fs'
import { loadStoreModule } from '../utils/appStoreSource'
import { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { DataSource, MigrationExecutor, QueryRunner } from 'typeorm'
import { postgresMigrations } from '../database/migrations/postgres'
import { sqliteMigrations } from '../database/migrations/sqlite'
import { applicationStorageDependencies, StoredCanvas } from './storageDependencies'
import { applicationPostgresOptions } from './applicationPostgres'

const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"'
const systemTables = new Set(['sqlite_sequence', 'migrations'])
type Column = { name: string; type: string }
const publicTable = (name: string) => 'public.' + identifier(name)

function sourceTables(source: DatabaseSync): string[] {
    const installed = new Set(
        source
            .prepare('SELECT name FROM migrations')
            .all()
            .map((row) => row.name)
    )
    if (sqliteMigrations.some((migration) => !installed.has(migration.name)))
        throw new Error(
            'Start the current Cuttlely version on the original SQLite installation and finish its application migrations first.'
        )
    if (source.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('trigger','view') LIMIT 1").get()) {
        throw new Error('Source tables differ from the application schema. Review custom SQLite triggers and views before migrating.')
    }
    const integrity = source.prepare('PRAGMA quick_check').get()
    if (integrity?.quick_check !== 'ok') throw new Error('The source SQLite integrity check failed.')
    return source
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
        .all()
        .map((row) => String(row.name))
        .filter((name) => !systemTables.has(name))
}

async function destinationColumns(runner: QueryRunner, table: string): Promise<Column[]> {
    return runner.query(
        "SELECT column_name AS name,udt_name AS type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
        [table]
    )
}

function parameter(value: SQLInputValue, type: string) {
    if (value === null) return null
    if (
        ['timestamp', 'timestamptz', 'date'].includes(type) &&
        (typeof value === 'bigint' || typeof value === 'number' || (typeof value === 'string' && /^-?\d{12,}$/.test(value)))
    ) {
        // SQLite identity records store JavaScript epoch milliseconds. PostgreSQL expects a calendar timestamp.
        return new Date(Number(value)).toISOString()
    }
    if (type === 'bool') {
        if (['0', 'false'].includes(String(value))) return false
        if (['1', 'true'].includes(String(value))) return true
        throw new Error('Invalid source boolean.')
    }
    if (value instanceof Uint8Array) return Buffer.from(value)
    return typeof value === 'bigint' ? value.toString() : value
}

async function copyTable(source: DatabaseSync, runner: QueryRunner, name: string): Promise<number> {
    const table = publicTable(name)
    const columns = await destinationColumns(runner, name)
    const local = source
        .prepare('PRAGMA table_info(' + identifier(name) + ')')
        .all()
        .map((row) => String(row.name))
    if (!columns.length || columns.length !== local.length || columns.some((col) => !local.includes(col.name)))
        throw new Error('The SQLite and PostgreSQL application columns differ.')
    const fields = columns.map((col) => identifier(col.name)).join(',')
    const read = source.prepare('SELECT ' + fields + ' FROM ' + identifier(name))
    read.setReadBigInts(true)
    await runner.query('CREATE TEMP TABLE cuttlely_expected ON COMMIT DROP AS SELECT ' + fields + ' FROM ' + table + ' WITH NO DATA')
    let count = 0
    let values: unknown[] = []
    let tuples: string[] = []
    let bytes = 0
    async function insertBatch() {
        if (!tuples.length) return
        await runner.query('INSERT INTO pg_temp.cuttlely_expected(' + fields + ') VALUES ' + tuples.join(','), values)
        values = []
        tuples = []
        bytes = 0
    }
    for (const row of read.iterate()) {
        const tuple = columns.map((col) => {
            const value = parameter(row[col.name], col.type)
            values.push(value)
            bytes += typeof value === 'string' ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : 8
            return '$' + values.length
        })
        tuples.push('(' + tuple.join(',') + ')')
        count++
        if (bytes >= 1024 * 1024 || tuples.length >= 128) await insertBatch()
    }
    await insertBatch()
    await runner.query('INSERT INTO ' + table + '(' + fields + ') SELECT ' + fields + ' FROM pg_temp.cuttlely_expected')
    const [check] = await runner.query(`SELECT (SELECT count(*) FROM ${table}) AS count,
        EXISTS(SELECT to_jsonb(e) FROM pg_temp.cuttlely_expected e EXCEPT ALL SELECT to_jsonb(t) FROM ${table} t) AS differs`)
    if (Number(check.count) !== count || check.differs) throw new Error('PostgreSQL row verification failed.')
    await runner.query('DROP TABLE pg_temp.cuttlely_expected')
    return count
}

export async function copySqliteApplication(file: string, env: Record<string, string | undefined>): Promise<Record<string, number>> {
    if (!fs.lstatSync(file).isFile()) throw new Error('Select the original regular SQLite application database file.')
    if (!env.DATABASE_HOST || !env.DATABASE_NAME || !env.DATABASE_USER)
        throw new Error('Supply the PostgreSQL destination host, database and user.')
    const { user: username, ...connection } = applicationPostgresOptions(env)
    const destination = new DataSource({
        type: 'postgres',
        ...connection,
        username,
        migrations: postgresMigrations,
        installExtensions: false,
        logging: false
    })
    const source = new DatabaseSync(file)
    let runner: QueryRunner | undefined
    let stage = 'opening the source and target'
    try {
        source.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE')
        const tables = sourceTables(source)
        const { etlDependencyContext } = await loadStoreModule('etl', 'upgrade-inventory.mjs')
        const { dependencies: blockers } = await applicationStorageDependencies(
            async (sql) => source.prepare(sql).all() as unknown as StoredCanvas[],
            await etlDependencyContext(null, { phase: 'sqlite' })
        )
        if (blockers.length)
            throw new Error(
                'Resolve storage dependencies before migrating:\n' +
                    blockers.map((b) => [b.workspace, b.flow, b.revision, b.node, b.input, b.location, b.resolution].join(' · ')).join('\n')
            )
        await destination.initialize()
        runner = destination.createQueryRunner()
        await runner.startTransaction('SERIALIZABLE')
        await runner.query("SELECT pg_advisory_xact_lock(hashtextextended('cuttlely-application-migration', 516))")
        const [occupied] = await runner.query(`SELECT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','f','v','m','S')) AS present`)
        if (occupied.present) throw new Error('Select an empty PostgreSQL database dedicated to this installation.')
        stage = 'creating the PostgreSQL application schema'
        await runner.query('SET LOCAL search_path TO public, pg_catalog')
        await runner.query("SET LOCAL TIME ZONE 'UTC'")
        await runner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public')
        const migrations = new MigrationExecutor(destination, runner)
        migrations.transaction = 'none'
        await migrations.executePendingMigrations()
        if (tables.includes('cuttlely_installation_key'))
            await runner.query('CREATE TABLE public.cuttlely_installation_key (id INTEGER PRIMARY KEY, marker VARCHAR(160) NOT NULL)')
        // Older SQLite API keys have an additional creation date. Preserve that historical value on PostgreSQL.
        if (
            source
                .prepare('PRAGMA table_info("apikey")')
                .all()
                .some((col) => col.name === 'createdDate')
        )
            await runner.query('ALTER TABLE public.apikey ADD COLUMN IF NOT EXISTS "createdDate" timestamp')
        // PostgreSQL creates its replica admission counters empty. A same-named operator table on SQLite is still unknown.
        const expected: Array<{ name: string }> = await runner.query(
            "SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT IN ('migrations', 'harness_request_window')"
        )
        if (tables.length !== expected.length || tables.some((name) => !expected.some((row) => row.name === name)))
            throw new Error('Source tables differ from the application schema. Account for extension and workflow tables before migrating.')
        // All objects here were created in this uncommitted transaction. Defer cyclic user/workspace references while restoring IDs.
        const constraints: Array<{ table_name: string; name: string }> =
            await runner.query(`SELECT t.relname AS table_name,c.conname AS name
            FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
            WHERE n.nspname='public' AND c.contype='f' AND NOT c.condeferrable`)
        for (const c of constraints)
            await runner.query('ALTER TABLE ' + publicTable(c.table_name) + ' ALTER CONSTRAINT ' + identifier(c.name) + ' DEFERRABLE')
        await runner.query('SET CONSTRAINTS ALL DEFERRED')
        await runner.query('TRUNCATE ' + tables.map(publicTable).join(','))
        const report: Record<string, number> = {}
        for (const name of tables) {
            stage = 'copying and verifying ' + name
            report[name] = await copyTable(source, runner, name)
        }
        stage = 'verifying foreign keys and sequences'
        await runner.query('SET CONSTRAINTS ALL IMMEDIATE')
        for (const c of constraints)
            await runner.query('ALTER TABLE ' + publicTable(c.table_name) + ' ALTER CONSTRAINT ' + identifier(c.name) + ' NOT DEFERRABLE')
        const sequences: Array<{ table_name: string; column_name: string; sequence: string }> =
            await runner.query(`SELECT table_name,column_name,
            pg_get_serial_sequence(format('%I.%I',table_schema,table_name),column_name) AS sequence FROM information_schema.columns
            WHERE table_schema='public' AND table_name <> 'migrations' AND (column_default LIKE 'nextval(%' OR is_identity='YES')`)
        for (const { table_name, column_name, sequence } of sequences) {
            const highWater = source.prepare('SELECT seq FROM sqlite_sequence WHERE name=?')
            highWater.setReadBigInts(true)
            await runner.query(
                'SELECT setval($1::regclass,GREATEST(coalesce(max(' +
                    identifier(column_name) +
                    '),0),$2::bigint,1),GREATEST(coalesce(max(' +
                    identifier(column_name) +
                    '),0),$2::bigint)>0) FROM ' +
                    publicTable(table_name),
                [sequence, String(highWater.get(table_name)?.seq || 0)]
            )
        }
        await runner.commitTransaction()
        return report
    } catch (error) {
        // Database driver errors can contain row contents and bound credential values.
        if (runner?.isTransactionActive) await runner.rollbackTransaction()
        if (
            error instanceof Error &&
            (error.message.startsWith('Resolve storage dependencies') ||
                error.message.startsWith('Select an empty') ||
                error.message.startsWith('Source tables differ') ||
                error.message.startsWith('Start the current'))
        )
            throw error
        const code = (error as { code?: string }).code
        const sqlState = typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? ' (SQLSTATE ' + code + ')' : ''
        throw new Error('The application copy failed while ' + stage + sqlState + '. The SQLite source remains authoritative.')
    } finally {
        source.close()
        await runner?.release()
        if (destination.isInitialized) await destination.destroy()
    }
}
