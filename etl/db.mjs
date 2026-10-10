import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataRoot } from '../harness/paths.mjs'

export const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pipelines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    workspace_id TEXT,
    served_version INTEGER,
    index_fingerprint TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipeline_versions (
    pipeline_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    graph_hash TEXT NOT NULL,
    flow_data TEXT NOT NULL,
    spec TEXT,
    problems TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (pipeline_id, version)
);
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    settings TEXT,
    checkpoint TEXT,
    counters TEXT,
    steps TEXT,
    error TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_pipeline ON runs (pipeline_id, created_at);
CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    step TEXT,
    message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events (run_id, id);
CREATE TABLE IF NOT EXISTS sources (
    pipeline_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    fingerprint TEXT,
    seen_run TEXT,
    chunks INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (pipeline_id, source_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS records (
    pipeline_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    seen_run TEXT,
    PRIMARY KEY (pipeline_id, chunk_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS records_source ON records (pipeline_id, source_id);
CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    every_n INTEGER,
    every_unit TEXT,
    cron TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    next_run_at TEXT,
    last_run_id TEXT,
    last_run_at TEXT,
    last_result TEXT,
    last_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_pipeline ON schedules (pipeline_id, status);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules (status, next_run_at);
CREATE TABLE IF NOT EXISTS vector_ids (
    pipeline_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    PRIMARY KEY (pipeline_id, chunk_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS shadow_vectors (
    pipeline_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    embedding TEXT NOT NULL,
    PRIMARY KEY (pipeline_id, chunk_id)
) WITHOUT ROWID;
`

// Schema migrations (E1). `PRAGMA user_version` records the last one applied; each runs once, in one transaction, so a
// second boot is a no-op. Version 1 is the base schema above (what every pre-E1 etl.sqlite already has).
const WORKSPACE_TABLES = ['runs', 'run_events', 'records', 'sources', 'schedules', 'vector_ids', 'shadow_vectors']

// API-14: refuse a pipeline row without a workspace (SQLite's stand-in for NOT NULL without a table rebuild).
export const WORKSPACE_TRIGGERS = `
    CREATE TRIGGER IF NOT EXISTS pipelines_workspace_insert BEFORE INSERT ON pipelines
        WHEN NEW.workspace_id IS NULL OR NEW.workspace_id = ''
        BEGIN SELECT RAISE(ABORT, 'workspace_required: an ETL pipeline needs a workspace'); END;
    CREATE TRIGGER IF NOT EXISTS pipelines_workspace_update BEFORE UPDATE OF workspace_id ON pipelines
        WHEN NEW.workspace_id IS NULL OR NEW.workspace_id = ''
        BEGIN SELECT RAISE(ABORT, 'workspace_required: an ETL pipeline needs a workspace'); END;
`

const MIGRATIONS = [
    {
        version: 2,
        name: 'workspace scope, dead letters, write journal, per-node counts, lineage, run summary, record keys, run statuses',
        up(handle) {
            const columns = (table) =>
                new Set(
                    handle
                        .prepare(`PRAGMA table_info(${table})`)
                        .all()
                        .map((row) => row.name)
                )
            const addColumn = (table, column, type) => {
                if (!columns(table).has(column)) handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
            }
            for (const table of WORKSPACE_TABLES) addColumn(table, 'workspace_id', 'TEXT')
            handle.exec(`
                UPDATE runs SET workspace_id = (SELECT workspace_id FROM pipelines p WHERE p.id = runs.pipeline_id) WHERE workspace_id IS NULL;
                UPDATE run_events SET workspace_id = (SELECT workspace_id FROM runs r WHERE r.id = run_events.run_id) WHERE workspace_id IS NULL;
                UPDATE records SET workspace_id = (SELECT workspace_id FROM pipelines p WHERE p.id = records.pipeline_id) WHERE workspace_id IS NULL;
                UPDATE sources SET workspace_id = (SELECT workspace_id FROM pipelines p WHERE p.id = sources.pipeline_id) WHERE workspace_id IS NULL;
                UPDATE schedules SET workspace_id = (SELECT workspace_id FROM pipelines p WHERE p.id = schedules.pipeline_id) WHERE workspace_id IS NULL;
                UPDATE vector_ids SET workspace_id = (SELECT workspace_id FROM pipelines p WHERE p.id = vector_ids.pipeline_id) WHERE workspace_id IS NULL;
                UPDATE shadow_vectors SET workspace_id = (SELECT workspace_id FROM pipelines p WHERE p.id = shadow_vectors.pipeline_id) WHERE workspace_id IS NULL;
                CREATE INDEX IF NOT EXISTS runs_workspace ON runs (workspace_id, pipeline_id);
                CREATE INDEX IF NOT EXISTS run_events_workspace ON run_events (workspace_id, run_id);
                CREATE INDEX IF NOT EXISTS records_workspace ON records (workspace_id, pipeline_id);
                CREATE INDEX IF NOT EXISTS sources_workspace ON sources (workspace_id, pipeline_id);
                CREATE INDEX IF NOT EXISTS schedules_workspace ON schedules (workspace_id, pipeline_id);
                CREATE INDEX IF NOT EXISTS vector_ids_workspace ON vector_ids (workspace_id, pipeline_id);
                CREATE INDEX IF NOT EXISTS shadow_vectors_workspace ON shadow_vectors (workspace_id, pipeline_id);
            `)
            addColumn('runs', 'summary', 'TEXT')
            addColumn('records', 'doc_key', 'TEXT')
            addColumn('records', 'record_hash', 'TEXT')
            handle.exec('CREATE INDEX IF NOT EXISTS records_key ON records (pipeline_id, source_id, doc_key)')
            // Names are unique per workspace, not per server. SQLite cannot change a constraint in place: rebuild.
            handle.exec(`
                CREATE TABLE pipelines_v2 (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    name_key TEXT NOT NULL,
                    workspace_id TEXT,
                    served_version INTEGER,
                    index_fingerprint TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE (workspace_id, name_key)
                );
                INSERT INTO pipelines_v2 (id, name, name_key, workspace_id, served_version, index_fingerprint, created_at, updated_at)
                    SELECT id, name, name_key, workspace_id, served_version, index_fingerprint, created_at, updated_at FROM pipelines;
                DROP TABLE pipelines;
                ALTER TABLE pipelines_v2 RENAME TO pipelines;
                CREATE INDEX IF NOT EXISTS pipelines_name ON pipelines (name_key);
            `)
            handle.exec(`
                CREATE TABLE IF NOT EXISTS rejects (
                    id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, pipeline_id TEXT NOT NULL, run_id TEXT NOT NULL,
                    node_id TEXT NOT NULL, source_id TEXT NOT NULL, unit_key TEXT, ordinal INTEGER, record_key TEXT,
                    reason TEXT NOT NULL, field TEXT, detail TEXT, raw TEXT, raw_sha256 TEXT NOT NULL, raw_bytes INTEGER,
                    created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS rejects_run ON rejects (workspace_id, run_id, id);
                CREATE INDEX IF NOT EXISTS rejects_expiry ON rejects (expires_at);
                CREATE TABLE IF NOT EXISTS batches (
                    run_id TEXT NOT NULL, seq INTEGER NOT NULL, workspace_id TEXT NOT NULL, pipeline_id TEXT NOT NULL,
                    state TEXT NOT NULL, chunk_ids TEXT, record_keys TEXT, attempt INTEGER NOT NULL DEFAULT 1, node_ids TEXT,
                    records INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0, inserted INTEGER NOT NULL DEFAULT 0,
                    unchanged INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, embed_ms INTEGER, store_ms INTEGER,
                    retries INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, seq));
                CREATE INDEX IF NOT EXISTS batches_workspace ON batches (workspace_id, run_id, seq);
                CREATE TABLE IF NOT EXISTS run_nodes (
                    run_id TEXT NOT NULL, node_id TEXT NOT NULL, workspace_id TEXT NOT NULL, pipeline_id TEXT NOT NULL,
                    node_kind TEXT, label TEXT, read INTEGER NOT NULL DEFAULT 0, written_inserted INTEGER NOT NULL DEFAULT 0,
                    written_unchanged INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, filtered INTEGER NOT NULL DEFAULT 0,
                    by_reason TEXT, coercions TEXT, retries TEXT, bytes INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL, PRIMARY KEY (run_id, node_id));
                CREATE INDEX IF NOT EXISTS run_nodes_workspace ON run_nodes (workspace_id, run_id);
                CREATE TABLE IF NOT EXISTS lineage (
                    id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, workspace_id TEXT NOT NULL, pipeline_id TEXT NOT NULL,
                    record_key TEXT, node_id TEXT NOT NULL, source_id TEXT, unit_key TEXT, ordinal INTEGER, outcome TEXT NOT NULL,
                    reason TEXT, chunk_ids TEXT, batch_seq INTEGER);
                CREATE INDEX IF NOT EXISTS lineage_run ON lineage (workspace_id, run_id, record_key);
            `)
            // `completed` is retired: a run that read everything with nothing rejected is `succeeded` (spec 5.3.3).
            handle.exec(`
                UPDATE runs SET status = 'succeeded' WHERE status = 'completed';
                UPDATE schedules SET last_result = 'succeeded' WHERE last_result = 'completed';
            `)
        }
    },
    {
        version: 3,
        name: 'pipelines need a workspace (API-14)',
        up(handle) {
            // SQLite can only add NOT NULL by rebuilding the table, and the backfill target (the instance's default
            // workspace) lives in the Flowise database, which this file cannot read. So existing NULL rows stay until
            // the server's boot backfill (etl/workspace.mjs) assigns them, and these triggers refuse any new NULL: an
            // INSERT without a workspace, or an UPDATE that sets it back to NULL. The app checks the same thing first.
            handle.exec('CREATE INDEX IF NOT EXISTS pipelines_workspace ON pipelines (workspace_id)')
            handle.exec(WORKSPACE_TRIGGERS)
        }
    }
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

export function migrate(handle) {
    const current = Number(handle.prepare('PRAGMA user_version').get().user_version) || 0
    const applied = []
    if (current === 0) {
        handle.exec(BASE_SCHEMA)
        handle.exec('PRAGMA user_version = 1')
    }
    for (const migration of MIGRATIONS) {
        if (migration.version <= Math.max(current, 1)) continue
        handle.exec('BEGIN IMMEDIATE')
        try {
            migration.up(handle)
            handle.exec(`PRAGMA user_version = ${migration.version}`)
            handle.exec('COMMIT')
        } catch (error) {
            handle.exec('ROLLBACK')
            throw error
        }
        applied.push(migration.version)
    }
    return { from: current, to: SCHEMA_VERSION, applied }
}

let cached = null
let lastMigration = null

export function lastMigrationResult() {
    return lastMigration
}

export function etlDir() {
    return process.env.CUTTLELY_ETL_DIR || path.join(dataRoot(), 'etl')
}

export function db() {
    const file = path.join(etlDir(), 'etl.sqlite')
    if (cached && cached.file === file) return cached.handle
    closeDb()
    fs.mkdirSync(etlDir(), { recursive: true })
    const handle = new DatabaseSync(file)
    handle.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    lastMigration = migrate(handle)
    cached = { file, handle, statements: new Map() }
    return handle
}

export function stmt(sql) {
    db()
    let prepared = cached.statements.get(sql)
    if (!prepared) {
        prepared = cached.handle.prepare(sql)
        cached.statements.set(sql, prepared)
    }
    return prepared
}

export function tx(fn) {
    const handle = db()
    handle.exec('BEGIN IMMEDIATE')
    try {
        const result = fn(handle)
        handle.exec('COMMIT')
        return result
    } catch (error) {
        handle.exec('ROLLBACK')
        throw error
    }
}

export function closeDb() {
    if (!cached) return
    try {
        cached.handle.close()
    } catch {
        // already closed
    }
    cached = null
}

export function now() {
    return new Date().toISOString()
}

export function parseJson(text, fallback) {
    if (text == null || text === '') return fallback
    try {
        return JSON.parse(text)
    } catch {
        return fallback
    }
}
