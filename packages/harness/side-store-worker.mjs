// Keeps the synchronous harness queue/session API while PostgreSQL I/O runs on its own thread.
import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { harnessSchema, queueWakeChannel, registerSideSchema } from './side-store-identity.mjs'
import { claimQueuedJobSql, postgresHarnessDdl, turnLeaseStatements } from './side-store-schema.mjs'

const requireServer = createRequire(new URL('../server/package.json', import.meta.url))
const { Pool, Client, escapeIdentifier, escapeLiteral } = requireServer('pg')
const pool = new Pool(workerData)
pool.on('error', () => {})
const transactions = new Map()
const leases = new Map()
let rosterUsesRowLock = false

// Both stores use the same fixed lease mutations. This entry point never accepts SQL from its caller.
const postgresLeaseStatements = new Map(
    Object.entries(turnLeaseStatements).map(([action, statement]) => {
        let position = 0
        return [action, statement.replaceAll('?', () => '$' + ++position)]
    })
)

// Keep each statement separate so a queue operation starts with a new snapshot after its lock is held.
function transactionStart(scope, eventJobId, leaseWrite = false) {
    const schema = harnessSchema(scope)
    const schemaKey = `pg_catalog.hashtext(${escapeLiteral(schema)})`
    const append = typeof eventJobId === 'string'
    // Standalone lease writes use the unique session key and owner predicates. Explicit transactions retain the exclusive fence.
    const schemaLock = append || leaseWrite ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'
    let lock = `SELECT pg_catalog.${schemaLock}(${schemaKey})`
    if (append) {
        lock += `; SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('cuttlely_harness_queue.job_events'), pg_catalog.hashtext(${escapeLiteral(
            eventJobId
        )}))`
    }
    const transaction = scope === 'queue' ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN'
    return `${transaction}; SET LOCAL search_path TO ${escapeIdentifier(schema)}, pg_catalog; ${lock}`
}

async function begin(scope, eventJobId, leaseWrite = false) {
    const client = await pool.connect()
    try {
        await client.query(transactionStart(scope, eventJobId, leaseWrite))
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
// A standalone claim sends the fixed UPDATE with the fence, then commits after checking its returned integers.
const claimAfterQueueFence = `${transactionStart('queue')}; ${claimQueuedJobSql}`
// A subsequent SELECT gets a fresh snapshot after Cuttlely writers release the queue lock.
const queueReadFence = `SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
                        SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtext(${escapeLiteral(queueSchema)}));`

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

async function execute({ scope, op, sql, params, owner, key, payload, usage, deadline, action }) {
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
    if (op === 'readJobCancellation') {
        if (scope !== 'queue') throw new Error('Job cancellation requires the queue store.')
        const select = `SELECT cancel_requested FROM ${queueSchema}.jobs WHERE id OPERATOR(pg_catalog.=) `
        const response = active
            ? await active.query(select + '$1::pg_catalog.text', [key])
            : (await pool.query(`${queueReadFence} ${select}${escapeLiteral(key)}::pg_catalog.text`)).at(-1)
        normalizeBigInts(response)
        return response.rows[0]?.cancel_requested === 1
    }
    if (op === 'readHarnessRecord') {
        if (scope !== 'queue') throw new Error('Harness records require the queue store.')
        const select = `SELECT content FROM ${queueSchema}.harness_records WHERE entry OPERATOR(pg_catalog.=) `
        if (active) return (await active.query(select + '$1::pg_catalog.text', [key])).rows[0]?.content ?? null

        // A simple query message is one implicit transaction. Acquire the writer's lock
        // and table locks first so the SELECT sees a committed publication, even from a direct SQL writer.
        // SHARE locks coexist among readers without writing or flushing WAL for a tuple lock.
        const row = select + escapeLiteral(key) + '::pg_catalog.text'
        if (!rosterUsesRowLock) {
            try {
                const results = await pool.query(`${queueReadFence} LOCK TABLE ${queueSchema}.harness_records IN SHARE MODE; ${row}`)
                return results.at(-1).rows[0]?.content ?? null
            } catch (error) {
                if (error.code !== '42501') throw error
            }
        }
        try {
            const results = await pool.query(`${queueReadFence} ${row} FOR SHARE`)
            rosterUsesRowLock = true
            const record = results.at(-1).rows[0]
            if (record) return record.content
            // Row-level security can permit SELECT but hide a row from a locking read.
        } catch (error) {
            if (error.code !== '42501') throw error
        }
        // An execution role can have only SELECT on a separately owned roster table.
        // The schema lock still orders reads after every Cuttlely publication, and the
        // SELECT checks the current grants and row policies on every lookup.
        const results = await pool.query(`${queueReadFence} ${row}`)
        return results.at(-1).rows[0]?.content ?? null
    }
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
    const eventJobId = scope === 'queue' && op === 'appendJobEvent' ? params[0] : undefined
    const leaseWrite = op === 'writeTurnLease'
    if (leaseWrite) {
        if (scope !== 'queue' || !postgresLeaseStatements.has(action)) throw new Error('Invalid turn lease operation.')
        sql = postgresLeaseStatements.get(action)
    }
    const claim = op === 'claimQueuedJob'
    if (claim && (scope !== 'queue' || params?.length !== 1 || !Number.isSafeInteger(params[0]))) throw new Error('Invalid queue claim.')
    if (claim && action === 'poll' && !active) {
        // An idle timer can check committed work without taking the queue writer lock.
        // A positive observation still goes through the ordinary locked claim. A new
        // arrival after an empty snapshot wakes workers or is found on the next poll.
        const pending = await pool.query(
            `SELECT 1 FROM ${queueSchema}.jobs WHERE status OPERATOR(pg_catalog.=) 'queued'::pg_catalog.text LIMIT 1`
        )
        if (pending.rowCount === 0) return
    }
    const client = active || (claim ? await pool.connect() : await begin(scope, eventJobId, leaseWrite))
    let result
    try {
        if (claim) {
            const response = active
                ? await client.query(claimQueuedJobSql.replace('?', '$1'), params)
                : (await client.query(claimAfterQueueFence.replace('?', String(params[0])))).at(-1)
            normalizeBigInts(response)
            result = response.rows[0]
        } else if (op === 'appendJobEvent') {
            if (scope !== 'queue') throw new Error('Job events require the queue store.')
            // A contended writer's heartbeat starts after taking the queue lock.
            const response = await client.query(storeQueueEventSql, [...params, Date.now()])
            normalizeBigInts(response)
            result = response.rows[0]
        } else if (op === 'open') {
            const schema = harnessSchema(scope)
            await client.query(`CREATE SCHEMA IF NOT EXISTS ${escapeIdentifier(schema)}; ${postgresHarnessDdl(scope)}`)
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
            result = op === 'run' || leaseWrite ? { changes: response.rowCount } : op === 'get' ? response.rows[0] : response.rows
        }
    } catch (error) {
        if (!active) await finish(client, 'ROLLBACK')
        throw error
    }
    if (!active) await finish(client, 'COMMIT')
    return result
}

let notifying = false
let retryNotifyAfter = 0
async function notifyQueue() {
    if (notifying || Date.now() < retryNotifyAfter) return
    notifying = true
    try {
        // Separate from the insert transaction so a denied or unsupported NOTIFY cannot fail admission.
        await pool.query('NOTIFY ' + queueWakeChannel)
    } catch {
        retryNotifyAfter = Date.now() + 30000
    } finally {
        notifying = false
    }
}

parentPort.on('message', async ({ request, port, ready, notifyQueue: hint }) => {
    if (hint) return notifyQueue()
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
