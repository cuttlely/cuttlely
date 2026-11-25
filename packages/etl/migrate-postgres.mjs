// Offline copy primitives used while all writers are paused. They never select a backend or remove a source file.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { migrate, SCHEMA_VERSION } from './db.mjs'
import { harnessSchema, registerSideSchema } from '../harness/side-store-identity.mjs'
import {
    QUEUE_SCHEMA,
    HISTORY_SCHEMA,
    SCHEDULE_SCHEMA,
    AGENT_SCHEMA,
    SESSION_SCHEMA,
    postgresHarnessDdl
} from '../harness/side-store-schema.mjs'
import { VECTOR_SCHEMA } from './vector-schema.mjs'
import { ensureVectorSchema, vectorSchema } from './vectors-postgres.mjs'
import { ETL_SCHEMA, ensureSchema, withEtlSession } from './store-postgres.mjs'

const tables = (db) =>
    db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND substr(name,1,7) <> 'sqlite_' ORDER BY name")
        .all()
        .map((row) => row.name)
const quote = (name) => '"' + name.replaceAll('"', '""') + '"'
const columns = (db, table) => db.prepare('SELECT name,type,pk FROM pragma_table_info(?) ORDER BY cid').all(table)

export async function snapshotSqlite(file, parent) {
    const source = new DatabaseSync(file, { readOnly: true })
    let directory
    try {
        directory = fs.mkdtempSync(path.join(parent, 'storage-backup-'))
        const snapshot = path.join(directory, 'store.sqlite')
        await backup(source, snapshot)
        fs.chmodSync(snapshot, 0o400)
        const copy = new DatabaseSync(snapshot, { readOnly: true })
        try {
            if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
                throw new Error('SQLite backup failed its integrity check.')
        } finally {
            copy.close()
        }
        return snapshot
    } catch (error) {
        if (directory) fs.rmSync(directory, { recursive: true, force: true })
        throw error
    } finally {
        source.close()
    }
}

function verifyLayout(db, model) {
    if (JSON.stringify(tables(db)) !== JSON.stringify(tables(model))) throw new Error('Unrecognized tables in the SQLite snapshot.')
    for (const table of tables(model)) {
        const actual = columns(db, table)
        const byName = (a, b) => a.name.localeCompare(b.name)
        if (JSON.stringify(actual.sort(byName)) !== JSON.stringify(columns(model, table).sort(byName)))
            throw new Error('Unrecognized SQLite layout for ' + table)
    }
}

function digestRows(layout) {
    const hash = createHash('sha256')
    let count = 0
    return {
        add(row) {
            const values = layout.map(({ name, type }) => {
                const value = row[name]
                if (value === null) return null
                if (type === 'INTEGER') return BigInt(value).toString()
                if (type === 'BLOB') return Buffer.from(value).toString('base64')
                return value
            })
            hash.update(JSON.stringify(values) + '\n')
            count++
        },
        finish: () => ({ count, sha256: hash.digest('hex') })
    }
}

// Inputs are a validated SQLite layout and a qualified destination owned by the store.
// Cursor reads and bounded inserts keep memory independent of table size.
export async function copyTable(db, session, table, target, layout, resume, insertionOrder = false) {
    const names = layout.map(({ name }) => quote(name)).join(',')
    const keys = layout
        .filter(({ pk }) => pk)
        .sort((a, b) => a.pk - b.pk)
        .map(({ name }) => quote(name))
        .join(',')
    if (!keys) throw new Error('Missing primary key in ' + table)
    const query = (sql, args = []) => session.execute(sql, args)
    await query('LOCK TABLE ' + target + ' IN ACCESS EXCLUSIVE MODE')
    if (!resume && (await query('SELECT 1 FROM ' + target + ' LIMIT 1')).rows.length)
        throw new Error('ETL migration destination is occupied: ' + table)
    const stmt = db.prepare('SELECT ' + names + ' FROM ' + quote(table) + ' ORDER BY ' + (insertionOrder ? 'rowid' : keys))
    stmt.setReadBigInts(true)
    const input = digestRows(layout)
    let batch = []
    async function flush() {
        const args = batch.flat()
        const tuples = batch.map((_, i) => '(' + layout.map((_, j) => '$' + (1 + i * layout.length + j)).join(',') + ')')
        await query('INSERT INTO ' + target + ' (' + names + ') VALUES ' + tuples.join(','), args)
        batch = []
    }
    for (const row of stmt.iterate()) {
        input.add(row)
        if (resume) continue
        batch.push(layout.map(({ name }) => row[name]))
        if (batch.length === 64) await flush()
    }
    if (batch.length) await flush()
    const output = digestRows(layout)
    await query(
        'DECLARE copy_check NO SCROLL CURSOR FOR SELECT ' + names + ' FROM ' + target + ' ORDER BY ' + (insertionOrder ? 'position' : keys)
    )
    for (;;) {
        const { rows } = await query('FETCH FORWARD 64 FROM copy_check')
        for (const row of rows) output.add(row)
        if (rows.length < 64) break
    }
    await query('CLOSE copy_check')
    const expected = input.finish()
    if (JSON.stringify(expected) !== JSON.stringify(output.finish())) throw new Error('ETL migration verification failed for ' + table)
    return expected
}

export async function copyEtlSnapshot(source, snapshot) {
    // Apply historical migrations to a private working copy. Keep the operator's original backup intact.
    const directory = fs.mkdtempSync(path.join(path.dirname(snapshot), 'working-'))
    const file = path.join(directory, 'etl.sqlite')
    let db
    let model
    try {
        fs.copyFileSync(snapshot, file)
        fs.chmodSync(file, 0o600)
        db = new DatabaseSync(file)
        const version = db.prepare('PRAGMA user_version').get().user_version
        if (version > SCHEMA_VERSION) throw new Error('Unsupported SQLite ETL schema version.')
        model = new DatabaseSync(':memory:')
        migrate(model)
        migrate(db)
        verifyLayout(db, model)
        return await withEtlSession(source, async (session) => {
            await ensureSchema(session)
            const query = (sql, params = []) => session.execute(sql, params)
            const saved = (await query("SELECT value FROM etl_store_meta WHERE key='verified_copy'")).rows[0]
            const report = {}
            // Legacy NULL-workspace pipelines predate the insert guard. DDL is transactional.
            if (!saved) await query('ALTER TABLE pipelines DISABLE TRIGGER pipelines_workspace_insert')
            for (const table of tables(model)) {
                const target = ETL_SCHEMA + '.' + quote(table)
                report[table] = await copyTable(db, session, table, target, columns(model, table), Boolean(saved))
            }
            const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='run_events'")
            sequence.setReadBigInts(true)
            const highWater = sequence.get()?.seq || 0n
            report.run_events.sequence = highWater.toString()
            if (saved) {
                if (saved.value !== JSON.stringify(report)) throw new Error('ETL snapshot differs from the verified migration.')
                return report
            }
            for (const table of ['run_events', 'rejects', 'lineage']) {
                const { rows } = await query('SELECT max(id) AS highest FROM ' + quote(table))
                let highest = BigInt(rows[0].highest || 0)
                if (table === 'run_events' && highWater > highest) highest = highWater
                // ALTER ... RESTART is transactional; setval() would survive a rollback.
                await query('ALTER TABLE ' + quote(table) + ' ALTER COLUMN id RESTART WITH ' + (highest < 0n ? 1n : highest + 1n))
            }
            await query('ALTER TABLE pipelines ENABLE TRIGGER pipelines_workspace_insert')
            await query("INSERT INTO etl_store_meta (key,value) VALUES ('verified_copy',$1)", [JSON.stringify(report)])
            return report
        })
    } finally {
        db?.close()
        model?.close()
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

export async function copyVectorSnapshot(source, snapshot, collection) {
    const db = new DatabaseSync(snapshot, { readOnly: true })
    const model = new DatabaseSync(':memory:')
    try {
        model.exec(VECTOR_SCHEMA)
        if (db.prepare('PRAGMA user_version').get().user_version !== 0) throw new Error('Unsupported SQLite vector schema version.')
        verifyLayout(db, model)
        return await withEtlSession(source, async (session) => {
            const schema = vectorSchema(collection)
            await ensureVectorSchema(session, collection)
            const saved = (await session.execute('SELECT collection,report FROM ' + schema + '.migration', [])).rows[0]
            if (saved && saved.collection !== collection) throw new Error('Collection identifier conflict.')
            const report = {}
            for (const table of tables(model)) {
                report[table] = await copyTable(
                    db,
                    session,
                    table,
                    schema + '.' + table,
                    columns(model, table),
                    Boolean(saved),
                    table === 'vectors'
                )
            }
            if (saved && saved.report !== JSON.stringify(report)) throw new Error('Vector snapshot differs from the verified migration.')
            if (!saved) await session.execute('INSERT INTO ' + schema + '.migration VALUES ($1,$2)', [collection, JSON.stringify(report)])
            return report
        })
    } finally {
        model.close()
        db.close()
    }
}

function prepareHarnessSnapshot(db, scope) {
    if (scope !== 'queue') {
        db.exec(SESSION_SCHEMA)
        return
    }
    db.exec([QUEUE_SCHEMA, HISTORY_SCHEMA, SCHEDULE_SCHEMA, AGENT_SCHEMA].join(';'))
    const fields = new Set(columns(db, 'run_history').map(({ name }) => name))
    for (const name of ['trace_json', 'diagnostics_json', 'mode', 'api_key_id']) {
        if (!fields.has(name)) db.exec('ALTER TABLE run_history ADD COLUMN ' + name + ' TEXT')
    }
}

export async function copyHarnessSnapshot(source, snapshot, scope) {
    const directory = fs.mkdtempSync(path.join(path.dirname(snapshot), 'working-'))
    const file = path.join(directory, 'harness.sqlite')
    let db
    let model
    try {
        fs.copyFileSync(snapshot, file)
        fs.chmodSync(file, 0o600)
        db = new DatabaseSync(file)
        if (db.prepare('PRAGMA user_version').get().user_version !== 0) throw new Error('Unsupported SQLite harness schema version.')
        const required = scope === 'queue' ? 'turns' : 'sessions'
        if (!tables(db).includes(required)) throw new Error('Unrecognized harness SQLite database.')
        model = new DatabaseSync(':memory:')
        prepareHarnessSnapshot(model, scope)
        prepareHarnessSnapshot(db, scope)
        verifyLayout(db, model)
        const schema = harnessSchema(scope)
        return await withEtlSession(source, async (session) => {
            const query = (sql, params = []) => session.execute(sql, params)
            await query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema])
            await query('CREATE SCHEMA IF NOT EXISTS ' + schema)
            await query('SET LOCAL search_path TO ' + schema + ',pg_catalog')
            await query(postgresHarnessDdl(scope))
            await registerSideSchema(query, schema)
            await query('CREATE TABLE IF NOT EXISTS storage_migration (scope TEXT PRIMARY KEY, report TEXT NOT NULL)')
            const saved = (await query('SELECT * FROM storage_migration')).rows[0]
            if (saved && saved.scope !== scope) throw new Error('Harness store identifier conflict.')
            const report = {}
            const names = tables(model)
            if (scope === 'queue') names.unshift(...names.splice(names.indexOf('turns'), 1))
            for (const name of names) {
                report[name] = await copyTable(
                    db,
                    session,
                    name,
                    schema + '.' + quote(name),
                    columns(model, name),
                    Boolean(saved),
                    name === 'guarded_query_turns'
                )
            }
            if (scope !== 'queue') {
                const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='messages'")
                seq.setReadBigInts(true)
                const highest = BigInt((await query('SELECT max(id) AS highest FROM messages')).rows[0].highest || 0)
                const highWater = seq.get()?.seq || 0n
                report.messages.sequence = highWater.toString()
                if (!saved)
                    await query('ALTER TABLE messages ALTER COLUMN id RESTART WITH ' + ((highest > highWater ? highest : highWater) + 1n))
            }
            if (saved && saved.report !== JSON.stringify(report)) throw new Error('Harness snapshot differs from the verified migration.')
            if (!saved) await query('INSERT INTO storage_migration VALUES ($1,$2)', [scope, JSON.stringify(report)])
            return report
        })
    } finally {
        db?.close()
        model?.close()
        fs.rmSync(directory, { recursive: true, force: true })
    }
}

// Check live sources again on resume. SQLite backups include WAL data and their page headers can differ, so compare
// schema, row types, primary-key order and sequence contents without exposing any row values.
export function sqliteFingerprint(db) {
    const hash = createHash('sha256')
    const add = (part) => hash.update(JSON.stringify(part) + '\n')
    add(db.prepare('PRAGMA user_version').get().user_version)
    for (const schema of db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all()) {
        add([schema.type, schema.name, schema.sql])
        if (schema.type !== 'table') continue
        const layout = columns(db, schema.name)
        const keys = layout
            .filter((col) => col.pk)
            .sort((a, b) => a.pk - b.pk)
            .map((col) => quote(col.name))
        const order = keys.length ? keys.join(',') : 'rowid'
        const stmt = db.prepare('SELECT * FROM ' + quote(schema.name) + ' ORDER BY ' + order)
        stmt.setReadBigInts(true)
        for (const row of stmt.iterate())
            add(
                Object.values(row).map((value) => {
                    if (typeof value === 'bigint') return ['integer', String(value)]
                    if (value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')]
                    return value
                })
            )
    }
    return hash.digest('hex')
}
