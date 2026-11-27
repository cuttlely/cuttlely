// Keeps the synchronous harness queue/session API while PostgreSQL I/O runs on its own thread.
import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { harnessSchema, registerSideSchema } from './side-store-identity.mjs'
import { postgresHarnessDdl } from './side-store-schema.mjs'

const requireServer = createRequire(new URL('../server/package.json', import.meta.url))
const { Pool, Client, escapeIdentifier, escapeLiteral } = requireServer('pg')
const pool = new Pool(workerData)
pool.on('error', () => {})
const transactions = new Map()
const leases = new Map()

async function begin(scope) {
    const client = await pool.connect()
    try {
        // Acquire the same schema lock in one round trip. The caller's next statement
        // starts after the lock is held and observes the preceding writer's commit.
        const schema = harnessSchema(scope)
        await client.query(`BEGIN; SET LOCAL search_path TO ${escapeIdentifier(schema)}, pg_catalog;
            SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${escapeLiteral(schema)}))`)
        return client
    } catch (error) {
        client.release(true)
        throw error
    }
}

async function finish(client, command) {
    try {
        await client.query(command)
    } catch (error) {
        client.release(true)
        throw error
    }
    client.release()
}

// One committed snapshot covers both the public events and terminal status. An accepted
// worker writes its final event before settling the job, so the final delta cannot be missed.
// The pooled connection retains the installation's search path. Resolve tables, aggregates and
// operators explicitly, just as the transactional queue path selects its own schema.
const queueSchema = harnessSchema('queue')
const pollSql = `SELECT w.poll_index,j.id,j.status,j.result,j.error_code,j.error_message,j.updated_at,j.cancel_requested,
           e.events,e.last_seq FROM ROWS FROM (
             pg_catalog.unnest($1::pg_catalog.text[]), pg_catalog.unnest($2::pg_catalog.int8[])
           ) WITH ORDINALITY AS w(job_id,after_seq,poll_index)
           JOIN ${queueSchema}.jobs j ON j.id OPERATOR(pg_catalog.=) w.job_id
           CROSS JOIN LATERAL (
             SELECT pg_catalog.array_agg(event ORDER BY seq) FILTER (WHERE event OPERATOR(pg_catalog.!~~) $3) AS events,
                    pg_catalog.max(seq) AS last_seq FROM ${queueSchema}.job_events
             WHERE job_id OPERATOR(pg_catalog.=) j.id AND seq OPERATOR(pg_catalog.>) w.after_seq) e`

// The PostgreSQL adapter wraps a standalone statement in the same schema-scoped
// writer transaction as immediate(). Keep one commit per visible event or private
// phase; the admitted state, sequence allocation and heartbeat share that lock.
const storeQueueEventSql = `WITH input (job_id, event, phase) AS (
        VALUES ($1::text, $2::text, $3::text)
    ), state AS (
        SELECT input.*, j.status, j.cancel_requested FROM input LEFT JOIN jobs j ON j.id = input.job_id
    ), permitted AS (
        SELECT job_id, event FROM state
        WHERE phase IS NULL OR (status = 'running' AND (cancel_requested = 0 OR phase = 'confirmed'))
    ), heartbeat AS (
        UPDATE jobs SET updated_at = $4 FROM permitted WHERE jobs.id = permitted.job_id
    ), appended AS (
        INSERT INTO job_events (job_id, seq, event)
        SELECT p.job_id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM job_events WHERE job_id = p.job_id), p.event
        FROM permitted p
    )
    SELECT status, cancel_requested FROM state`

function normalizeBigInts(response) {
    for (const { name, dataTypeID } of response.fields) {
        if (dataTypeID !== 20) continue
        for (const row of response.rows) {
            if (row[name] === null) continue
            const value = Number(row[name])
            if (!Number.isSafeInteger(value)) throw new RangeError('Harness integer exceeds safe JavaScript range.')
            row[name] = value
        }
    }
}

async function pollJobs(params, deadline) {
    const client = await pool.connect()
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
        client.release()
        throw new Error('The queue read expired while waiting for a database connection.')
    }
    // A stalled observer must give its connection back without terminating live writers.
    let discarded = false
    const timeout = setTimeout(() => {
        discarded = true
        client.release(true)
    }, remaining)
    try {
        const response = await client.query(pollSql, params)
        normalizeBigInts(response)
        return response.rows
    } finally {
        clearTimeout(timeout)
        if (!discarded) client.release()
    }
}

async function execute({ scope, op, sql, params, owner, key, payload, usage, deadline }) {
    if (op === 'pollJobs') {
        if (scope !== 'queue') throw new Error('Job polling requires the queue store.')
        // Asynchronous observers always see a committed snapshot, even if this worker
        // currently holds another connection for a synchronous write transaction.
        return pollJobs(params, deadline)
    }
    if (op === 'saveRuntimeSetting') {
        const client = await pool.connect()
        try {
            await client.query('BEGIN')
            await client.query('SET LOCAL synchronous_commit = on')
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,519))', ['setting/' + key])
            await client.query(
                'INSERT INTO cuttlely_runtime.runtime_settings(scope,payload) VALUES($1,$2) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload',
                [key, Buffer.from(payload)]
            )
            await client.query('COMMIT')
            client.release()
        } catch (error) {
            client.release(true)
            throw error
        }
        return
    }
    if (op === 'tryLease') {
        const client = new Client(workerData)
        client.on('error', () => {})
        try {
            await client.connect()
            const { rows } = await client.query('SELECT pg_try_advisory_lock(516,hashtext($1)) AS ok', ['try-profile:' + key])
            if (rows[0].ok) leases.set(owner, client)
            else await client.end()
            return rows[0].ok
        } catch (error) {
            await client.end().catch(() => {})
            throw error
        }
    }
    if (op === 'releaseLease') {
        await leases.get(owner)?.end()
        leases.delete(owner)
        return
    }
    if (op === 'begin') {
        if (transactions.has(scope)) throw new Error('Nested harness store transaction.')
        transactions.set(scope, await begin(scope))
        return
    }
    const active = transactions.get(scope)
    if (op === 'commit' || op === 'rollback') {
        if (!active) throw new Error('Missing harness store transaction.')
        transactions.delete(scope)
        return finish(active, op.toUpperCase())
    }
    if (op === 'creditUsage') {
        if (!active || scope !== 'queue') throw new Error('Usage requires the queue transaction.')
        // Resolve the application table with the install's normal PostgreSQL search path.
        // Failure is propagated so the claim and any model buckets roll back together.
        const { writeUsageLines } = requireServer('./dist/services/usage/store.js')
        // Do not let a locked workspace usage row hold the shared queue transaction. A durable
        // accepted job remains available for a bounded later settlement.
        await active.query(`SELECT set_config(name, LEAST(NULLIF(setting::int, 0),
            CASE name WHEN 'lock_timeout' THEN 250 ELSE 1000 END)::text, true)
            FROM pg_catalog.pg_settings WHERE name IN ('lock_timeout','statement_timeout')`)
        await active.query('SET LOCAL search_path TO DEFAULT')
        await writeUsageLines(
            { options: { type: 'postgres' }, query: (sql, args) => active.query(sql, args) },
            { ...usage, at: new Date(usage.at) }
        )
        await active.query(
            'SET LOCAL lock_timeout TO DEFAULT; SET LOCAL statement_timeout TO DEFAULT; SET LOCAL search_path TO ' +
                harnessSchema(scope) +
                ', pg_catalog'
        )
        return
    }
    const client = active || (await begin(scope))
    let result
    try {
        if (op === 'appendJobEvent') {
            if (scope !== 'queue') throw new Error('Job events require the queue store.')
            // A contended writer's heartbeat starts after taking the queue lock.
            const response = await client.query(storeQueueEventSql, [...params, Date.now()])
            normalizeBigInts(response)
            result = response.rows[0]
        } else if (op === 'open') {
            const schema = harnessSchema(scope)
            await client.query('CREATE SCHEMA IF NOT EXISTS ' + schema)
            await client.query(postgresHarnessDdl(scope))
            await registerSideSchema((sql, params = []) => client.query(sql, params), schema)
        } else if (op === 'dropDraft') {
            if (!/^draft:[a-f0-9]{64}$/.test(scope)) throw new Error('Invalid draft scope.')
            const schema = harnessSchema(scope)
            if ((await client.query('SELECT to_regclass($1) AS present', [schema + '.sessions'])).rows[0].present) {
                await client.query(
                    'TRUNCATE ' +
                        ['messages', 'memory', 'answer_context', 'managed_file_workspaces', 'sessions']
                            .map((name) => schema + '.' + name)
                            .join(',')
                )
            }
        } else {
            const response = await client.query(sql, params)
            normalizeBigInts(response)
            result = op === 'run' ? { changes: response.rowCount } : op === 'get' ? response.rows[0] : response.rows
        }
    } catch (error) {
        if (!active) await finish(client, 'ROLLBACK')
        throw error
    }
    if (!active) await finish(client, 'COMMIT')
    return result
}

parentPort.on('message', async ({ request, port, ready }) => {
    try {
        port.postMessage({ value: await execute(request) })
    } catch (error) {
        port.postMessage({ error: { message: 'Harness PostgreSQL operation failed.', code: error.code } })
    } finally {
        if (ready) {
            Atomics.store(ready, 0, 1)
            Atomics.notify(ready, 0)
        }
        port.close()
    }
})
