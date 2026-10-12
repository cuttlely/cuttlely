// etl:check, E1 schema migrations. A pre-E1 etl.sqlite is built at test time from the frozen old schema and rows in
// fixtures/ (the hard rule keeps SQLite files out of the repo), then upgraded with the same migrate() the server runs.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { check, root } from './lib.mjs'

const { migrate, SCHEMA_VERSION } = await import('../db.mjs')
const here = path.dirname(new URL(import.meta.url).pathname)
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8')

const file = path.join(root, 'pre-e1', 'etl.sqlite')
fs.mkdirSync(path.dirname(file), { recursive: true })
{
    const old = new DatabaseSync(file)
    old.exec(fixture('pre-e1-schema.sql'))
    old.exec(fixture('pre-e1-rows.sql'))
    old.close()
}

const handle = new DatabaseSync(file)
const count = (table) => Number(handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
const tables = ['pipelines', 'pipeline_versions', 'runs', 'run_events', 'sources', 'records', 'vector_ids', 'shadow_vectors', 'schedules']
const before = Object.fromEntries(tables.map((table) => [table, count(table)]))
const versionBefore = Number(handle.prepare('PRAGMA user_version').get().user_version)
const first = migrate(handle)
const after = Object.fromEntries(tables.map((table) => [table, count(table)]))
const columns = (table) =>
    handle
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)
const status = (id) => handle.prepare('SELECT status FROM runs WHERE id = ?').get(id)?.status
const newTables = handle
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('rejects', 'batches', 'run_nodes', 'lineage') ORDER BY name")
    .all()
    .map((row) => row.name)
check(
    'E1: upgrading a pre-E1 etl.sqlite keeps every pipeline, version, run, event, source, record, vector id and schedule',
    versionBefore === 0 &&
        first.from === 0 &&
        first.applied.includes(SCHEMA_VERSION) &&
        JSON.stringify(before) === JSON.stringify(after) &&
        after.records === 3,
    JSON.stringify({ versionBefore, first, before, after })
)
check(
    'E1: the upgrade adds workspace_id (backfilled), runs.summary, records.doc_key/record_hash and the rejects, batches, run_nodes and lineage tables',
    ['runs', 'run_events', 'records', 'sources', 'schedules', 'vector_ids', 'shadow_vectors'].every((table) =>
        columns(table).includes('workspace_id')
    ) &&
        columns('runs').includes('summary') &&
        columns('records').includes('doc_key') &&
        columns('records').includes('record_hash') &&
        JSON.stringify(newTables) === JSON.stringify(['batches', 'lineage', 'rejects', 'run_nodes']) &&
        handle.prepare("SELECT workspace_id FROM records WHERE chunk_id = 'c-1'").get().workspace_id === 'ws-a' &&
        handle.prepare("SELECT workspace_id FROM run_events WHERE run_id = 'r-done' LIMIT 1").get().workspace_id === 'ws-a',
    JSON.stringify({ runs: columns('runs'), records: columns('records'), newTables })
)
check(
    'E1: `completed` runs and schedule results become `succeeded`; other statuses are untouched',
    status('r-done') === 'succeeded' &&
        status('r-fail') === 'failed' &&
        handle.prepare("SELECT last_result FROM schedules WHERE id = 's-one'").get().last_result === 'succeeded',
    JSON.stringify({ done: status('r-done'), fail: status('r-fail') })
)
{
    const objects = handle
        .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('pipelines_workspace', 'pipelines_workspace_insert', 'pipelines_workspace_update') ORDER BY name"
        )
        .all()
        .map((row) => row.name)
    let refused = null
    try {
        handle.prepare("UPDATE pipelines SET workspace_id = NULL WHERE id = 'p-one'").run()
    } catch (error) {
        refused = String(error.message)
    }
    check(
        'Workspace scope: the upgrade indexes pipelines.workspace_id and adds the NULL-refusing triggers; a legacy NULL row waits for the boot backfill',
        objects.join() === 'pipelines_workspace,pipelines_workspace_insert,pipelines_workspace_update' &&
            /workspace_required/.test(refused || '') &&
            handle.prepare("SELECT workspace_id FROM pipelines WHERE id = 'p-two'").get().workspace_id === null,
        JSON.stringify({ objects, refused })
    )
}
const insert = handle.prepare(
    "INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, 'Catalog', 'catalog', ?, '2026-10-04', '2026-10-04')"
)
insert.run('p-b', 'ws-b')
let clash = null
try {
    insert.run('p-a2', 'ws-a')
} catch (error) {
    clash = String(error.message)
}
check(
    'E1: pipeline names are unique per workspace (the same name in another workspace is allowed)',
    /UNIQUE/.test(clash || '') && Number(handle.prepare("SELECT COUNT(*) AS n FROM pipelines WHERE name_key = 'catalog'").get().n) === 2,
    String(clash)
)
const second = migrate(handle)
check(
    'E1: the second boot is a no-op',
    second.applied.length === 0 &&
        second.from === SCHEMA_VERSION &&
        Number(handle.prepare('PRAGMA user_version').get().user_version) === SCHEMA_VERSION,
    JSON.stringify(second)
)
handle.close()

// A fresh database goes straight to the latest version.
{
    const fresh = new DatabaseSync(path.join(root, 'pre-e1', 'fresh.sqlite'))
    const result = migrate(fresh)
    check(
        'E1: a fresh database migrates from 0 to the latest version',
        result.from === 0 && Number(fresh.prepare('PRAGMA user_version').get().user_version) === SCHEMA_VERSION,
        JSON.stringify(result)
    )
    fresh.close()
}
