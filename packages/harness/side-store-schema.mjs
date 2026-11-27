export const insertTurnLease = 'INSERT INTO turns (session_key, owner, expires_at) VALUES (?, ?, ?)'
export const turnLeaseStatements = Object.freeze({
    acquire: insertTurnLease + ' ON CONFLICT(session_key) DO NOTHING',
    renew: 'UPDATE turns SET expires_at = ? WHERE session_key = ? AND owner = ? AND expires_at != ?',
    release: 'DELETE FROM turns WHERE session_key = ? AND owner = ?'
})

export const QUEUE_SCHEMA = `CREATE TABLE IF NOT EXISTS turns (
            session_key TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS guarded_query_turns (
            profile TEXT NOT NULL,
            source_turn TEXT NOT NULL,
            session_key TEXT REFERENCES turns(session_key) ON DELETE SET NULL,
            attempt_limit INTEGER NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (profile, source_turn)
        );
        CREATE INDEX IF NOT EXISTS guarded_query_session ON guarded_query_turns(session_key);
        CREATE TABLE IF NOT EXISTS try_profile_turns (
            scope TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            pid INTEGER NOT NULL,
            started_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            session_key TEXT NOT NULL,
            status TEXT NOT NULL,
            payload TEXT NOT NULL,
            result TEXT,
            error_code TEXT,
            error_message TEXT,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_claim ON jobs (status, created_at);
        CREATE INDEX IF NOT EXISTS jobs_session_status ON jobs (session_key, status, created_at);
        CREATE TABLE IF NOT EXISTS job_events (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            event TEXT NOT NULL,
            PRIMARY KEY (job_id, seq)
        );`

export const SESSION_SCHEMA = `CREATE TABLE IF NOT EXISTS sessions (
            session_key TEXT PRIMARY KEY,
            harness_name TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_key TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_session ON messages (session_key, id);
        CREATE TABLE IF NOT EXISTS recall_turns (
            runtime_id TEXT PRIMARY KEY,
            owner_scope TEXT NOT NULL,
            session_key TEXT NOT NULL,
            question_id INTEGER NOT NULL,
            answer_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            started_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS recall_owner_started ON recall_turns (owner_scope, started_at, runtime_id);
        CREATE TABLE IF NOT EXISTS memory (
            session_key TEXT PRIMARY KEY,
            summary TEXT NOT NULL,
            pins TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS answer_context (
            session_key TEXT PRIMARY KEY,
            selections TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS managed_file_workspaces (
            scope_key TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            manifest TEXT NOT NULL
        );`

export const HISTORY_SCHEMA = `CREATE TABLE IF NOT EXISTS run_history (
            id TEXT PRIMARY KEY,
            harness_name TEXT NOT NULL,
            chat_id TEXT,
            status TEXT NOT NULL,
            source TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            latency_ms INTEGER,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            error_code TEXT,
            error_message TEXT,
            input_preview TEXT,
            text_preview TEXT,
            agents_json TEXT,
            timings_json TEXT,
            trace_id TEXT,
            trace_json TEXT,
            diagnostics_json TEXT
        );
        CREATE INDEX IF NOT EXISTS run_history_harness ON run_history (harness_name, started_at DESC);
        CREATE TABLE IF NOT EXISTS run_results (
            run_id TEXT PRIMARY KEY,
            harness_name TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS run_results_team ON run_results (harness_name, run_id);`

export const SCHEDULE_SCHEMA = `CREATE TABLE IF NOT EXISTS harness_schedules (
            harness_name TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            cron TEXT NOT NULL,
            timezone TEXT NOT NULL,
            input TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            status TEXT NOT NULL,
            next_run_at INTEGER,
            last_run_id TEXT,
            last_run_at INTEGER,
            last_result TEXT,
            last_reason TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS harness_schedules_due ON harness_schedules (status, next_run_at);`

export const AGENT_SCHEMA = `CREATE TABLE IF NOT EXISTS agent_turns (
        session_id TEXT PRIMARY KEY,
        profile_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        steps_json TEXT NOT NULL
    )`

export function isQueue(scope) {
    return scope === 'queue'
}

// The durable queue job and run must agree on the original admission, including its principal.
export const acceptedUsageJob = `j.status = 'succeeded' AND j.result IS NOT NULL AND j.payload::jsonb->>'runId' = h.id
    AND j.session_key = h.harness_name || ':' || h.chat_id AND j.payload::jsonb->>'name' = h.harness_name
    AND j.payload::jsonb->>'chatId' = h.chat_id AND j.payload::jsonb->>'workspaceId' = h.usage_workspace_id
    AND (j.payload::jsonb->>'apiKeyId') IS NOT DISTINCT FROM h.api_key_id`
export const openUsageRun =
    "usage_workspace_id IS NOT NULL AND usage_recorded = false AND (status IN ('queued','running','succeeded','completed_with_errors') OR (status='failed' AND error_code='interrupted'))"

export function postgresHarnessDdl(scope) {
    const ddl = isQueue(scope)
        ? [
              QUEUE_SCHEMA,
              AGENT_SCHEMA,
              SCHEDULE_SCHEMA,
              HISTORY_SCHEMA,
              'CREATE TABLE IF NOT EXISTS harness_records (entry TEXT PRIMARY KEY, content TEXT NOT NULL)',
              'ALTER TABLE run_history ADD COLUMN IF NOT EXISTS mode TEXT, ADD COLUMN IF NOT EXISTS api_key_id TEXT, ADD COLUMN IF NOT EXISTS usage_workspace_id TEXT, ADD COLUMN IF NOT EXISTS usage_recorded BOOLEAN NOT NULL DEFAULT false',
              `CREATE INDEX IF NOT EXISTS run_history_pending_usage ON run_history (id) WHERE ${openUsageRun}`,
              "CREATE INDEX IF NOT EXISTS jobs_accepted_usage ON jobs ((payload::jsonb->>'runId')) WHERE status = 'succeeded' AND result IS NOT NULL",
              'ALTER TABLE guarded_query_turns ADD COLUMN IF NOT EXISTS position BIGINT GENERATED ALWAYS AS IDENTITY'
          ]
        : [SESSION_SCHEMA]
    return ddl
        .join(';\n')
        .replaceAll('INTEGER PRIMARY KEY AUTOINCREMENT', 'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY')
        .replace(/\bINTEGER\b/g, 'BIGINT')
        .replace(/\bTEXT\b/g, 'TEXT COLLATE "C"')
}
