-- This is the SCHEMA constant of etl/db.mjs as it was before migration E1, verbatim below these comments.
-- etl:check builds a pre-E1 database from it at test time; no SQLite file is checked in. Do not edit: it stands for
-- databases already in use.
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
