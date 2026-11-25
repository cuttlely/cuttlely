// A test-only Postgres store for the real runner. This does not select a production ETL backend or migrate its schema.
// Uses a disposable database when PGPASSWORD (or CUTTLELY_TEST_PG_PASSWORD) is set, or a temporary initdb cluster
// when initdb and pg_ctl are on PATH (or PG_BINDIR). Skips with a clear message when neither is available, unless
// CUTTLELY_TEST_PG_REQUIRED=1, which fails instead of skipping.
// Run with Node 24 --experimental-test-module-mocks --test --test-concurrency=1.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { mock, test } from 'node:test'
import { createTestDatabase, skipReason } from './pg-source.mjs'

const require = createRequire(new URL('../../server/package.json', import.meta.url))

function statements(client) {
    const query = (sql, params = []) => {
        let index = 0
        const text = sql.replace(/\?/g, () => `$${++index}`)
        assert.equal(index, params.length, 'The test adapter binds every placeholder.')
        return client.query(text, params)
    }
    return {
        all: async (sql, params) => (await query(sql, params)).rows,
        get: async (sql, params) => (await query(sql, params)).rows[0],
        // Return rowCount, not a fabricated changes value, to exercise the Postgres affected-row contract.
        run: query,
        exec: (sql) => client.query(sql)
    }
}

test('run control: real Postgres READ COMMITTED races', { timeout: 90000, skip: skipReason }, async (t) => {
    const { Pool, Client } = require('pg')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-pg-races-'))
    process.env.HOME = path.join(root, 'home')
    process.env.DATABASE_PATH = path.join(root, 'database')
    process.env.CUTTLELY_DATA_DIR = path.join(root, 'data')
    process.env.ETL_CHECK = '1'
    for (const dir of ['home', 'database', 'data']) fs.mkdirSync(path.join(root, dir))

    let pool
    let writer
    let mocked
    let database
    const sessions = new Set()
    t.after(async () => {
        try {
            mocked?.restore()
            await (await import('../store.mjs')).drained()
            for (const client of sessions) client.release()
            sessions.clear()
            await writer?.end()
            await pool?.end()
            await database?.cleanup()
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    database = await createTestDatabase()
    const { connection } = database
    pool = new Pool({ ...connection, max: 2 })
    // Parse BIGINT like the backend does, so a run the stop writer reads compares equal to the same run read through the store.
    const { types } = require('pg')
    writer = new Client({
        ...connection,
        types: { getTypeParser: (oid, format) => (oid === 20 ? Number : types.getTypeParser(oid, format)) }
    })
    await writer.connect()

    // Use the real Postgres backend through store-postgres.mjs
    const { openPostgresEtlStore, ETL_SCHEMA } = await import('../store-postgres.mjs')
    const { useBackend } = await import('../store.mjs')

    const source = {
        dialect: 'postgres',
        session: async () => {
            const client = await pool.connect()
            sessions.add(client)
            return {
                execute: async (sql, params) => {
                    const result = await client.query(sql, params)
                    return {
                        rows: result.rows,
                        fields: result.fields,
                        affected: result.rowCount ?? 0
                    }
                },
                release: () => {
                    sessions.delete(client)
                    client.release()
                }
            }
        }
    }

    const backend = await openPostgresEtlStore(source)
    useBackend(backend)
    // The stop writer reads and writes the same tables as the backend, so it resolves them in the ETL schema too.
    await writer.query(`SET search_path TO ${ETL_SCHEMA}, pg_catalog`)

    const inTransaction = async (client, fn) => {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        try {
            assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'read committed')
            const value = await fn(statements(client))
            await client.query('COMMIT')
            return value
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        }
    }

    let checks = 0
    let externalCommits = 0
    const { checkRunControlRaces } = await import('./run-control-races.mjs')

    // Helper to save a pipeline on the real backend
    const savePipeline = async (pipelineId) => {
        const etlStore = await import('../store.mjs')
        const existing = await etlStore.all('SELECT id FROM pipelines WHERE id = ?', [pipelineId])
        if (existing.length === 0) {
            const stamp = new Date().toISOString()
            await etlStore.run(
                'INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                [pipelineId, pipelineId, pipelineId, 'ws-check', stamp, stamp]
            )
            await etlStore.run(
                'INSERT INTO pipeline_versions (pipeline_id, version, graph_hash, flow_data, created_at) VALUES (?, ?, ?, ?, ?)',
                [pipelineId, 1, 'hash', '{"nodes":[],"edges":[]}', stamp]
            )
        }
    }

    await checkRunControlRaces({
        check: (name, ok, detail) => {
            assert.ok(ok, `${name}${detail ? `: ${detail}` : ''}`)
            checks += 1
        },
        writeDuringRead: async (reader, write) => {
            const readerPid = (await reader.get('SELECT pg_backend_pid() AS pid')).pid
            const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
            assert.notEqual(readerPid, writerPid, 'The stop commits on a separate connection while the runner transaction is open.')
            await inTransaction(writer, write)
            externalCommits += 1
        },
        savePipeline
    })
    assert.equal(
        externalCommits,
        18,
        'Six recovery stops, four launch stops, five run-control stops, two claim stops, and one lock-blocked stop commit between the runner read and write, with 50 concurrent addEvent calls and queue parity (order check only).'
    )
    t.diagnostic(`${checks} shared checks passed with ${externalCommits} independent stop commits.`)
})
