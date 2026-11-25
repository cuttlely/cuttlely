// Tests for the Postgres ETL store backend.
// Run with Node 24 --experimental-test-module-mocks --test --test-concurrency=1.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { skipReason, createTestSource } from './pg-source.mjs'
import { openPostgresEtlStore, toPositional, ETL_SCHEMA, missingPrivilege } from '../store-postgres.mjs'
import { SCHEMA_VERSION } from '../db.mjs'

test('placeholder rewrite: ? to $n, skipping quoted literals', () => {
    assert.equal(toPositional('SELECT * FROM runs WHERE id = ?'), 'SELECT * FROM runs WHERE id = $1')
    assert.equal(toPositional('SELECT * FROM runs WHERE id = ? AND status = ?'), 'SELECT * FROM runs WHERE id = $1 AND status = $2')
    assert.equal(toPositional("SELECT * FROM runs WHERE id = ? AND name = '?'"), "SELECT * FROM runs WHERE id = $1 AND name = '?'")
    assert.equal(
        toPositional("INSERT INTO runs (id, status) VALUES (?, 'pending')"),
        "INSERT INTO runs (id, status) VALUES ($1, 'pending')"
    )
})

test('normalizer: run_nodes.retries stays a string', { skip: skipReason }, async () => {
    const source = await createTestSource()
    try {
        const backend = await openPostgresEtlStore(source)

        await backend.run(`DROP SCHEMA IF EXISTS ${ETL_SCHEMA} CASCADE`, [])
        await openPostgresEtlStore(source)

        const runId = 'test-run-normalizer'
        const pipelineId = 'test-pipeline'
        const nodeId = 'test-node'
        const workspaceId = 'test-workspace'
        const stamp = new Date().toISOString()

        await backend.run('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
            pipelineId,
            pipelineId,
            pipelineId,
            workspaceId,
            stamp,
            stamp
        ])

        await backend.run(
            'INSERT INTO runs (id, pipeline_id, version, mode, status, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [runId, pipelineId, 1, 'full', 'queued', workspaceId, stamp, stamp]
        )

        await backend.run(
            'INSERT INTO run_nodes (run_id, node_id, workspace_id, pipeline_id, retries, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            [runId, nodeId, workspaceId, pipelineId, '{"source-1": 2, "source-2": 1}', stamp]
        )

        const row = await backend.get('SELECT retries FROM run_nodes WHERE run_id = ? AND node_id = ?', [runId, nodeId])
        assert.equal(typeof row.retries, 'string', 'run_nodes.retries must stay a string')
        assert.equal(row.retries, '{"source-1": 2, "source-2": 1}')
    } finally {
        await source.cleanup()
    }
})

test('C-collation order: B < a, - < _', { skip: skipReason }, async () => {
    const source = await createTestSource()
    try {
        const backend = await openPostgresEtlStore(source)

        await backend.run(`DROP SCHEMA IF EXISTS ${ETL_SCHEMA} CASCADE`, [])
        await openPostgresEtlStore(source)

        const pipelineId = 'test-pipeline'
        const workspaceId = 'test-workspace'
        const stamp = new Date().toISOString()

        await backend.run('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
            pipelineId,
            pipelineId,
            pipelineId,
            workspaceId,
            stamp,
            stamp
        ])

        const ids = ['run-B', 'run-a', 'run--', 'run-_']
        for (const id of ids) {
            await backend.run(
                'INSERT INTO runs (id, pipeline_id, version, mode, status, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [id, pipelineId, 1, 'full', 'queued', workspaceId, stamp, stamp]
            )
        }

        const ordered = await backend.all('SELECT id FROM runs ORDER BY id', [])
        const orderCheck = ordered.map((r) => r.id)
        assert.deepEqual(orderCheck, ['run--', 'run-B', 'run-_', 'run-a'], 'C collation: - < B < _ < a')
    } finally {
        await source.cleanup()
    }
})

test('trigger parity: legacy NULL copies, new NULL refused, unrelated UPDATE allowed', { skip: skipReason }, async () => {
    const source = await createTestSource()
    try {
        const backend = await openPostgresEtlStore(source)

        await backend.run(`DROP SCHEMA IF EXISTS ${ETL_SCHEMA} CASCADE`, [])
        const freshBackend = await openPostgresEtlStore(source)

        const stamp = new Date().toISOString()

        // Legacy NULL workspace_id can be inserted when creating the schema before triggers
        await backend.run(`DROP SCHEMA IF EXISTS ${ETL_SCHEMA} CASCADE`, [])
        const session = await source.session()
        try {
            await session.execute(`CREATE SCHEMA IF NOT EXISTS ${ETL_SCHEMA}`, [])
            await session.execute(
                `CREATE TABLE IF NOT EXISTS ${ETL_SCHEMA}.pipelines (
                    id TEXT COLLATE "C" PRIMARY KEY,
                    name TEXT COLLATE "C" NOT NULL,
                    name_key TEXT COLLATE "C" NOT NULL,
                    workspace_id TEXT COLLATE "C",
                    served_version BIGINT,
                    index_fingerprint TEXT COLLATE "C",
                    created_at TEXT COLLATE "C" NOT NULL,
                    updated_at TEXT COLLATE "C" NOT NULL,
                    UNIQUE (workspace_id, name_key)
                )`,
                []
            )
            await session.execute(
                `INSERT INTO ${ETL_SCHEMA}.pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)`,
                ['legacy-null', 'Legacy', 'legacy', null, stamp, stamp]
            )
        } finally {
            session.release()
        }

        // Now create triggers through openPostgresEtlStore
        await openPostgresEtlStore(source)

        // Verify the NULL row exists
        const legacy = await freshBackend.get('SELECT * FROM pipelines WHERE id = ?', ['legacy-null'])
        assert.equal(legacy.workspace_id, null, 'Legacy NULL workspace_id was copied')

        // New NULL is refused
        await assert.rejects(
            async () => {
                await freshBackend.run(
                    'INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                    ['new-null', 'New', 'new', null, stamp, stamp]
                )
            },
            { message: /workspace_required/ },
            'New NULL workspace_id must be refused'
        )

        // Unrelated UPDATE of a NULL row is allowed
        const updated = new Date(Date.now() + 1000).toISOString()
        await freshBackend.run('UPDATE pipelines SET updated_at = ? WHERE id = ?', [updated, 'legacy-null'])
        const after = await freshBackend.get('SELECT * FROM pipelines WHERE id = ?', ['legacy-null'])
        assert.equal(after.updated_at, updated, 'Unrelated UPDATE of NULL row is allowed')
    } finally {
        await source.cleanup()
    }
})

test('identity DDL: explicit ids are accepted and kept', { skip: skipReason }, async () => {
    const source = await createTestSource()
    try {
        const backend = await openPostgresEtlStore(source)

        await backend.run(`DROP SCHEMA IF EXISTS ${ETL_SCHEMA} CASCADE`, [])
        await openPostgresEtlStore(source)

        const pipelineId = 'test-pipeline'
        const runId = 'test-run-identity'
        const workspaceId = 'test-workspace'
        const stamp = new Date().toISOString()

        await backend.run('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
            pipelineId,
            pipelineId,
            pipelineId,
            workspaceId,
            stamp,
            stamp
        ])

        await backend.run(
            'INSERT INTO runs (id, pipeline_id, version, mode, status, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [runId, pipelineId, 1, 'full', 'queued', workspaceId, stamp, stamp]
        )

        // S2 pins only the GENERATED BY DEFAULT identity DDL; continuity after a copy is asserted with the copy in S3.
        const inserts = {
            run_events: [
                'INSERT INTO run_events (id, run_id, ts, level, message, workspace_id) VALUES (?, ?, ?, ?, ?, ?)',
                (id) => [id, runId, stamp, 'info', `Event ${id}`, workspaceId]
            ],
            rejects: [
                'INSERT INTO rejects (id, workspace_id, pipeline_id, run_id, node_id, source_id, reason, raw_sha256, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (id) => [id, workspaceId, pipelineId, runId, 'node', 'source', 'reason', 'sha', stamp, stamp]
            ],
            lineage: [
                'INSERT INTO lineage (id, run_id, workspace_id, pipeline_id, node_id, outcome) VALUES (?, ?, ?, ?, ?, ?)',
                (id) => [id, runId, workspaceId, pipelineId, 'node', 'loaded']
            ]
        }
        for (const [table, [sql, values]] of Object.entries(inserts)) {
            for (const id of [100, 101]) assert.equal((await backend.run(sql, values(id))).changes, 1, `${table} accepts id ${id}`)
            const rows = await backend.all(`SELECT id FROM ${table} WHERE run_id = ? ORDER BY id`, [runId])
            assert.deepEqual(
                rows.map((row) => Number(row.id)),
                [100, 101],
                `${table} keeps the explicit ids`
            )
        }
    } finally {
        await source.cleanup()
    }
})

test('LIKE parity: patterns used in purge.mjs and store-adapter.mjs work correctly', { skip: skipReason }, async () => {
    const source = await createTestSource()
    try {
        const backend = await openPostgresEtlStore(source)

        await backend.run(`DROP SCHEMA IF EXISTS ${ETL_SCHEMA} CASCADE`, [])
        await openPostgresEtlStore(source)

        const pipelineId = 'test-pipeline'
        const workspaceId = 'test-workspace'
        const stamp = new Date().toISOString()

        await backend.run('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
            pipelineId,
            pipelineId,
            pipelineId,
            workspaceId,
            stamp,
            stamp
        ])

        // Insert records with chunk IDs
        await backend.run('INSERT INTO records (pipeline_id, chunk_id, source_id, workspace_id) VALUES (?, ?, ?, ?)', [
            pipelineId,
            'chunk-123',
            'source-1',
            workspaceId
        ])
        await backend.run('INSERT INTO records (pipeline_id, chunk_id, source_id, workspace_id) VALUES (?, ?, ?, ?)', [
            pipelineId,
            'chunk-456',
            'source-1',
            workspaceId
        ])
        await backend.run('INSERT INTO records (pipeline_id, chunk_id, source_id, workspace_id) VALUES (?, ?, ?, ?)', [
            pipelineId,
            'other-789',
            'source-1',
            workspaceId
        ])

        // Test LIKE pattern from purge.mjs
        const matched = await backend.all('SELECT chunk_id FROM records WHERE pipeline_id = ? AND chunk_id LIKE ?', [pipelineId, 'chunk-%'])
        assert.equal(matched.length, 2, 'LIKE pattern matches chunk-* records')
        assert.ok(matched.some((r) => r.chunk_id === 'chunk-123'))
        assert.ok(matched.some((r) => r.chunk_id === 'chunk-456'))
        assert.ok(!matched.some((r) => r.chunk_id === 'other-789'))
    } finally {
        await source.cleanup()
    }
})

test('exec refusal: Postgres backend throws on exec', { skip: skipReason }, async () => {
    const source = await createTestSource()
    try {
        const backend = await openPostgresEtlStore(source)

        await backend.run(`DROP SCHEMA IF EXISTS ${ETL_SCHEMA} CASCADE`, [])
        await openPostgresEtlStore(source)

        await assert.rejects(
            async () => {
                await backend.exec('SELECT 1')
            },
            { message: /exec is not supported/ },
            'exec must throw on Postgres backend'
        )
    } finally {
        await source.cleanup()
    }
})

test('schema-version parity: stored version equals SCHEMA_VERSION', { skip: skipReason }, async () => {
    const source = await createTestSource()
    try {
        const backend = await openPostgresEtlStore(source)

        await backend.run(`DROP SCHEMA IF EXISTS ${ETL_SCHEMA} CASCADE`, [])
        await openPostgresEtlStore(source)

        const row = await backend.get('SELECT value FROM etl_store_meta WHERE key = ?', ['schema_version'])
        assert.equal(row.value, String(SCHEMA_VERSION), 'Postgres schema version must equal SCHEMA_VERSION from db.mjs')
    } finally {
        await source.cleanup()
    }
})

test('DDL creation: schema and all tables are created', { skip: skipReason }, async () => {
    const source = await createTestSource()
    try {
        await source.client.query(`DROP SCHEMA IF EXISTS ${ETL_SCHEMA} CASCADE`)

        const backend = await openPostgresEtlStore(source)

        // Check schema exists
        const schemaResult = await source.client.query('SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present', [
            ETL_SCHEMA
        ])
        assert.equal(schemaResult.rows[0].present, true, 'Schema must be created')

        // Check all 14 tables exist
        const tables = [
            'pipelines',
            'pipeline_versions',
            'runs',
            'run_events',
            'sources',
            'records',
            'schedules',
            'vector_ids',
            'shadow_vectors',
            'rejects',
            'batches',
            'run_nodes',
            'lineage',
            'run_names',
            'etl_store_meta'
        ]

        for (const table of tables) {
            const result = await source.client.query(
                'SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2) AS present',
                [ETL_SCHEMA, table]
            )
            assert.equal(result.rows[0].present, true, `Table ${table} must be created`)
        }

        // Check triggers exist
        const triggers = await source.client.query(
            `SELECT tgname FROM pg_trigger t
             JOIN pg_class c ON t.tgrelid = c.oid
             JOIN pg_namespace n ON c.relnamespace = n.oid
             WHERE n.nspname = $1 AND c.relname = 'pipelines'`,
            [ETL_SCHEMA]
        )
        assert.ok(triggers.rows.length >= 2, 'Workspace triggers must be created')
    } finally {
        await source.cleanup()
    }
})

test('idempotent re-run: opening twice does not error', { skip: skipReason }, async () => {
    const source = await createTestSource()
    try {
        await source.client.query(`DROP SCHEMA IF EXISTS ${ETL_SCHEMA} CASCADE`)

        const backend1 = await openPostgresEtlStore(source)
        const backend2 = await openPostgresEtlStore(source)

        // Both should work
        const pipelineId = 'test-pipeline'
        const workspaceId = 'test-workspace'
        const stamp = new Date().toISOString()

        await backend1.run('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
            pipelineId,
            pipelineId,
            pipelineId,
            workspaceId,
            stamp,
            stamp
        ])

        const row = await backend2.get('SELECT * FROM pipelines WHERE id = ?', [pipelineId])
        assert.equal(row.id, pipelineId, 'Second backend can read data')
    } finally {
        await source.cleanup()
    }
})

test('source validation: rejects source without session', () => {
    const badSource = { dialect: 'postgres' }
    assert.rejects(
        async () => openPostgresEtlStore(badSource),
        { message: /source must have a session\(\) method/ },
        'Must reject source without session'
    )
})

test('source validation: rejects source with wrong dialect', () => {
    const badSource = {
        dialect: 'mysql',
        session: async () => ({})
    }
    assert.rejects(
        async () => openPostgresEtlStore(badSource),
        { message: /dialect must be 'postgres'/ },
        'Must reject source with wrong dialect'
    )
})
