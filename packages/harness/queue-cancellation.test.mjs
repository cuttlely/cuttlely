import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { promisify } from 'node:util'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-queue-cancellation-'))
process.env.HOME = dir
process.env.DATABASE_PATH = dir
process.env.CUTTLELY_DATA_DIR = dir
process.env.CUTTLELY_HERMES_HOME = path.join(dir, 'runtime')
process.env.CUTTLELY_HARNESS_WORKER_CONCURRENCY = '1'
const { saveHarness } = await import('./store.mjs')
const { listRuns } = await import('./history.mjs')
const { closeQueueDb } = await import('./lock.mjs')
const { closeSessions } = await import('./session.mjs')
const { claimJob, enqueueHarnessJob, executeJob, markCancel, queueHooks, readJob, runQueuedHarness, setWorkerContext } = await import(
    './queue.mjs'
)

after(() => {
    closeSessions()
    closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(name) {
    saveHarness({
        name,
        workspaceId: 'fixture-workspace',
        chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
        specialists: [{ name: 'worker', codeExecution: true }]
    })
    return { name, flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } } }
}

for (const mode of ['agent', 'router']) {
    test(`${mode}: disconnect while queued records one cancelled run and releases local context`, { timeout: 10000 }, async (t) => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'inline'
        const args = fixture(`queued-cancel-${mode}`)
        const entered = Promise.withResolvers()
        const release = Promise.withResolvers()
        t.after(() => {
            release.resolve()
            queueHooks.afterEnqueue = null
        })
        const blocker = runQueuedHarness({
            ...args,
            mode: 'agent',
            chatId: 'blocker',
            input: 'Block this worker.',
            fetchImpl: async () => {
                entered.resolve()
                await release.promise
                return new Response(JSON.stringify({ status: 'completed', output: 'Released.' }))
            }
        })
        await entered.promise
        const enqueued = Promise.withResolvers()
        queueHooks.afterEnqueue = (job) => enqueued.resolve(job)
        const controller = new AbortController()
        const recorded = []
        let calls = 0
        const cancelled = runQueuedHarness({
            ...args,
            mode,
            chatId: 'cancelled',
            input: 'Never execute this request.',
            source: 'api',
            apiKeyId: 'fixture-key',
            traceId: 'fixture-trace',
            signal: controller.signal,
            onRecorded: (row) => recorded.push(row),
            fetchImpl: async () => {
                calls++
                throw new Error('Cancelled job started a chief or specialist call.')
            },
            loadNode: async () => {
                calls++
                throw new Error('Cancelled job started the router.')
            }
        })
        const job = await enqueued.promise
        await setImmediate()
        assert.equal(readJob(job.id).status, 'queued')
        assert.equal(queueHooks.localRunCount, 2)
        controller.abort()
        assert.equal(readJob(job.id).cancelRequested, true)
        let cancelledError
        const rejection = assert.rejects(cancelled, (error) => {
            cancelledError = error
            return error.code === 'aborted'
        })
        release.resolve()
        await Promise.all([blocker, rejection])
        assert.equal(readJob(job.id).status, 'cancelled')
        assert.equal(calls, 0, 'no harness execution or model call for the cancelled job')
        const rows = listRuns(args.name).filter((row) => row.chatId === 'cancelled')
        assert.equal(rows.length, 1, 'exactly one cancelled harness history row')
        assert.equal(recorded.length, 1)
        const [row] = rows
        assert.equal(row.id, recorded[0].id)
        assert.equal(row.id, cancelledError.runId)
        assert.equal(row.mode || 'router', mode)
        assert.equal(row.source, 'api')
        assert.equal(listRuns(args.name, { apiKeyId: 'fixture-key' }).length, 1)
        assert.equal(row.traceId, 'fixture-trace')
        assert.equal(row.status, 'cancelled')
        assert.equal(row.error.code, 'aborted')
        assert.equal(row.trace.status, 'cancelled')
        assert.equal(row.trace.mode, mode)
        assert.equal(row.trace.route.status, 'skipped')
        assert.equal(row.trace.handoff.status, 'skipped')
        assert.deepEqual(row.trace.specialists, [])
        if (mode === 'agent') assert.equal(row.trace.chief.status, 'cancelled')
        assert.equal(queueHooks.localRunCount, 0)
    })

    test(`${mode}: cancellation after claim records once without starting the run`, { timeout: 10000 }, async (t) => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'external'
        const args = fixture(`claimed-cancel-${mode}`)
        const enqueued = Promise.withResolvers()
        queueHooks.afterEnqueue = (job) => enqueued.resolve(job)
        t.after(() => (queueHooks.afterEnqueue = null))
        let calls = 0
        const cancelled = runQueuedHarness({
            ...args,
            mode,
            chatId: 'claimed',
            input: 'Never start this claimed job.',
            runId: `run_claimed-cancel-${mode}`,
            fetchImpl: async () => {
                calls++
                throw new Error('Cancelled job made a model call.')
            }
        })
        const job = await enqueued.promise
        await setImmediate()
        const claimed = claimJob()
        assert.equal(claimed.id, job.id)
        assert.equal(claimed.cancelRequested, false)
        markCancel(job.id)
        const rejection = assert.rejects(cancelled, (error) => error.code === 'aborted' && error.runId === `run_claimed-cancel-${mode}`)
        await executeJob(claimed).catch((error) => assert.equal(error.code, 'aborted'))
        await rejection
        const rows = listRuns(args.name)
        assert.equal(rows.length, 1)
        assert.equal(rows[0].status, 'cancelled')
        assert.equal(rows[0].mode || 'router', mode)
        assert.equal(rows[0].trace.status, 'cancelled')
        assert.equal(calls, 0)
        assert.equal(queueHooks.localRunCount, 0)
    })

    test(`${mode}: an external worker cancellation also releases the waiter's local context`, { timeout: 10000 }, async (t) => {
        process.env.CUTTLELY_HARNESS_QUEUE = 'external'
        const args = fixture(`external-cancel-${mode}`)
        const enqueued = Promise.withResolvers()
        queueHooks.afterEnqueue = (job) => enqueued.resolve(job)
        t.after(() => (queueHooks.afterEnqueue = null))
        const cancelled = runQueuedHarness({ ...args, mode, chatId: 'external', input: 'Cancel in another process.' })
        const job = await enqueued.promise
        await setImmediate()
        assert.equal(queueHooks.localRunCount, 1)
        markCancel(job.id)
        const rejection = assert.rejects(cancelled, (error) => error.code === 'aborted' && Boolean(error.runId))
        await promisify(execFile)(process.execPath, [
            '--input-type=module',
            '-e',
            `import { claimJob, executeJob } from ${JSON.stringify(new URL('./queue.mjs', import.meta.url).href)};
             try { await executeJob(claimJob()) } catch (error) { if (error.code !== 'aborted') throw error }`
        ])
        await rejection
        const rows = listRuns(args.name)
        assert.equal(rows.length, 1)
        assert.equal(rows[0].status, 'cancelled')
        assert.equal(rows[0].mode || 'router', mode)
        assert.equal(rows[0].trace.status, 'cancelled')
        assert.equal(queueHooks.localRunCount, 0)
    })
}

test('cancellation during worker context setup records once before runHarness starts', { timeout: 10000 }, async (t) => {
    const args = fixture('context-cancel-router')
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    let modelCalls = 0
    setWorkerContext(async () => {
        entered.resolve()
        await release.promise
        return {
            flowOptions: {},
            loadNode: async () => {
                modelCalls++
                throw new Error('Cancelled job started the router.')
            }
        }
    })
    t.after(() => {
        release.resolve()
        setWorkerContext(null)
    })
    const job = enqueueHarnessJob({
        ...args,
        chatId: 'context',
        input: 'Cancel while preparing context.',
        metadata: { executionId: 'context-trace' }
    })
    const running = executeJob(claimJob())
    await entered.promise
    markCancel(job.id)
    const rejection = assert.rejects(running, (error) => error.code === 'aborted')
    release.resolve()
    await rejection
    const rows = listRuns(args.name)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'cancelled')
    assert.equal(rows[0].trace.status, 'cancelled')
    assert.equal(rows[0].traceId, 'context-trace')
    assert.equal(rows[0].trace.route.status, 'skipped')
    assert.equal(modelCalls, 0)
    assert.equal(queueHooks.localRunCount, 0)
})

test('PostgreSQL cancellation checks wait for committed queue state and share unrelated event locks', async (t) => {
    const { createTestDatabase, skipReason } = await import('../etl/check/pg-source.mjs')
    if (skipReason) return t.skip(skipReason)
    const { configureHarnessPostgres } = await import('./side-store-postgres.mjs')
    const { database } = await import('./lock.mjs')
    const { cancelRequested } = await import('./queue.mjs')
    const { Worker, MessageChannel } = await import('node:worker_threads')
    const { once } = await import('node:events')
    const { setTimeout: delay } = await import('node:timers/promises')
    const { createRequire } = await import('node:module')
    const { Client } = createRequire(new URL('../server/package.json', import.meta.url))('pg')
    const fixture = await createTestDatabase()
    const writer = new Client(fixture.connection)
    const observer = new Client(fixture.connection)
    const schema = 'cuttlely_harness_queue'
    const jobs = schema + '.jobs'
    const id = 'job-cancellation-fixture'
    let reader
    async function read() {
        const { port1, port2 } = new MessageChannel()
        try {
            const pending = once(port1, 'message')
            reader.postMessage({ request: { scope: 'queue', op: 'readJobCancellation', key: id }, port: port2 }, [port2])
            const [reply] = await pending
            assert.equal(reply.error, undefined)
            return reply.value
        } finally {
            port1.close()
        }
    }
    async function waitForWriterFence() {
        for (let i = 0; i < 160; i++) {
            const { rows } = await observer.query(`SELECT 1 FROM pg_catalog.pg_stat_activity WHERE application_name='qa-cancel-reader'
                AND wait_event_type='Lock' AND wait_event='advisory'`)
            if (rows.length) return
            await delay(5)
        }
        assert.fail('Cancellation read did not wait for the publishing transaction.')
    }
    try {
        closeQueueDb()
        configureHarnessPostgres(fixture.connection)
        const db = database()
        await writer.connect()
        await observer.connect()
        reader = new Worker(new URL('./side-store-worker.mjs', import.meta.url), {
            workerData: {
                ...fixture.connection,
                application_name: 'qa-cancel-reader',
                options: '-c lock_timeout=4000 -c search_path=pg_catalog -c default_transaction_isolation=repeatable\\ read'
            }
        })
        assert.equal(cancelRequested(undefined), false)
        assert.equal(cancelRequested(null), false)
        assert.equal(cancelRequested(id), false)
        db.prepare("INSERT INTO jobs(id,session_key,status,payload,created_at,updated_at) VALUES (?,?,'running','{}',0,0)").run(id, 's')
        db.exec('BEGIN')
        try {
            db.prepare('UPDATE jobs SET cancel_requested=1 WHERE id=?').run(id)
            assert.equal(cancelRequested(id), true)
        } finally {
            db.exec('ROLLBACK')
        }
        assert.equal(cancelRequested(id), false)
        assert.equal(await read(), false)
        for (const scenario of ['rollback', 'cancel', 'remove']) {
            await writer.query('BEGIN')
            await writer.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))', [schema])
            const pending = read()
            await waitForWriterFence()
            await writer.query(
                scenario === 'remove' ? `DELETE FROM ${jobs} WHERE id=$1` : `UPDATE ${jobs} SET cancel_requested=1 WHERE id=$1`,
                [id]
            )
            await writer.query(scenario === 'rollback' ? 'ROLLBACK' : 'COMMIT')
            assert.equal(await pending, scenario === 'cancel')
        }
        // An event append for another job holds the schema lock in shared mode and
        // writes no cancellation flags. It can remain open for the complete lookup.
        await writer.query('BEGIN')
        await writer.query('SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtext($1))', [schema])
        assert.equal(await read(), false)
        await writer.query('ROLLBACK')
    } finally {
        await writer.end()
        await reader?.terminate()
        await observer.end()
        closeQueueDb()
        configureHarnessPostgres(undefined)
        await fixture.cleanup()
    }
})
