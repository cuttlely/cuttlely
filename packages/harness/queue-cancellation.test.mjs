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

for (const dialect of ['sqlite', 'postgres']) {
    test(
        `${dialect}: claimed jobs renew infrequently and promptly observe a different process cancelling or draining`,
        { timeout: 30000 },
        async (t) => {
            const { spawn } = await import('node:child_process')
            const { once } = await import('node:events')
            const { setTimeout: delay } = await import('node:timers/promises')
            const { createTestSource, skipReason } = await import('../etl/check/pg-source.mjs')
            const { configureHarnessPostgres } = await import('./side-store-postgres.mjs')
            const { database } = await import('./lock.mjs')
            if (dialect === 'postgres' && skipReason) return t.skip(skipReason)
            const previousKey = process.env.CUTTLELY_SECRETKEY_OVERWRITE
            process.env.CUTTLELY_SECRETKEY_OVERWRITE = (await import('node:crypto')).randomBytes(32).toString('hex')
            const priorQueue = process.env.CUTTLELY_HARNESS_QUEUE
            process.env.CUTTLELY_HARNESS_QUEUE = 'external'
            closeSessions()
            closeQueueDb()
            const pg = dialect === 'postgres' ? await createTestSource() : undefined
            let observer
            t.after(async () => {
                queueHooks.afterEnqueue = null
                closeSessions()
                closeQueueDb()
                configureHarnessPostgres(undefined)
                await pg?.cleanup()
                if (previousKey === undefined) delete process.env.CUTTLELY_SECRETKEY_OVERWRITE
                else process.env.CUTTLELY_SECRETKEY_OVERWRITE = previousKey
                if (priorQueue === undefined) delete process.env.CUTTLELY_HARNESS_QUEUE
                else process.env.CUTTLELY_HARNESS_QUEUE = priorQueue
            })
            if (pg) configureHarnessPostgres(pg.connection)
            const db = database()
            if (pg) {
                observer = pg.client
                const { initializeRuntimeSessions } = await import('../etl/runtime-sessions.mjs')
                await initializeRuntimeSessions(pg, [], pg.connection)
                await observer.query(`CREATE TABLE public.qa_worker_renewals(job text, flag int);
                CREATE FUNCTION public.qa_count_renewal() RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN INSERT INTO public.qa_worker_renewals VALUES(NEW.id,NEW.cancel_requested); RETURN NULL; END $$;
                CREATE TRIGGER qa_count_renewal AFTER UPDATE OF updated_at ON cuttlely_harness_queue.jobs
                FOR EACH ROW WHEN (OLD.status='running' AND NEW.status='running' AND OLD.cancel_requested=NEW.cancel_requested)
                EXECUTE FUNCTION public.qa_count_renewal()`)
            } else {
                db.exec(`CREATE TEMP TABLE qa_worker_renewals(job text, flag int);
                CREATE TEMP TRIGGER qa_count_renewal AFTER UPDATE OF updated_at ON main.jobs
                WHEN OLD.status='running' AND NEW.status='running' AND OLD.cancel_requested=NEW.cancel_requested
                BEGIN INSERT INTO qa_worker_renewals VALUES(NEW.id,NEW.cancel_requested); END`)
            }
            const count = async (job, flag = 0) =>
                pg
                    ? (
                          await observer.query('SELECT count(*)::int AS n FROM public.qa_worker_renewals WHERE job=$1 AND flag=$2', [
                              job,
                              flag
                          ])
                      ).rows[0].n
                    : db.prepare('SELECT count(*) AS n FROM qa_worker_renewals WHERE job=? AND flag=?').get(job, flag).n

            const name = 'heartbeat-provider-' + dialect
            saveHarness({
                name,
                workspaceId: 'fixture-workspace',
                chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
                specialists: [{ name: 'worker' }]
            })
            for (const action of ['cancel', 'drain']) {
                const peer = spawn(
                    process.execPath,
                    [
                        '--input-type=module',
                        '-e',
                        `
                import {once} from 'node:events'
                import {configureHarnessPostgres} from ${JSON.stringify(new URL('./side-store-postgres.mjs', import.meta.url).href)}
                import {database,closeQueueDb} from ${JSON.stringify(new URL('./lock.mjs', import.meta.url).href)}
                import {markCancel,stopQueueJobs} from ${JSON.stringify(new URL('./queue.mjs', import.meta.url).href)}
                const [connection]=await once(process,'message')
                if(connection)configureHarnessPostgres(connection)
                database()
                const command=once(process,'message'); process.send('ready')
                const [{job,action}]=await command
                if(action==='drain')stopQueueJobs(!connection);else markCancel(job)
                process.send(Date.now())
                closeQueueDb();configureHarnessPostgres(undefined);process.disconnect()
            `
                    ],
                    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
                )
                const peerExit = once(peer, 'exit')
                t.after(() => {
                    if (peer.exitCode === null) peer.kill()
                })
                const ready = once(peer, 'message')
                peer.send(pg?.connection || false)
                assert.equal((await ready)[0], 'ready')

                const entered = Promise.withResolvers()
                const aborted = Promise.withResolvers()
                const enqueued = Promise.withResolvers()
                queueHooks.afterEnqueue = (job) => enqueued.resolve(job)
                let calls = 0
                let stops = 0
                let jobId
                const waiting = runQueuedHarness({
                    name,
                    mode: 'agent',
                    chatId: action,
                    input: 'Wait for the fixture.',
                    flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } },
                    fetchImpl: async (url, options) => {
                        if (url.endsWith('/stop')) {
                            stops++
                            return Response.json({ status: 'cancelled' })
                        }
                        if (url.endsWith('/events')) {
                            entered.resolve()
                            return new Promise((_resolve, reject) =>
                                options.signal.addEventListener(
                                    'abort',
                                    async () => {
                                        const at = Date.now()
                                        aborted.resolve({ at, afterCancellation: await count(jobId, 1) })
                                        reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }))
                                    },
                                    { once: true }
                                )
                            )
                        }
                        calls++
                        return Response.json({ status: 'running', run_id: 'held-fixture' })
                    }
                })
                const waiterDone = assert.rejects(waiting, { code: 'aborted' })
                const admission = await enqueued.promise
                jobId = admission.id
                await setImmediate()
                const claimed = claimJob()
                assert.equal(claimed.id, jobId)
                const workerDone = assert.rejects(executeJob(claimed), { code: 'aborted' })
                await entered.promise
                const first = await count(jobId)
                const start = performance.now()
                await delay(action === 'cancel' ? 1040 : 100)
                // Observe a fresh renewal before the remote action, ensuring its next 25 ms tick is a read.
                const prior = await count(jobId)
                const fixedWaitMs = Math.round(performance.now() - start)
                let last = prior
                while (last === prior && performance.now() - start < 5000) {
                    await delay(8)
                    last = await count(jobId)
                }
                assert.ok(last > prior)
                const elapsed = performance.now() - start
                const committed = once(peer, 'message')
                peer.send({ job: jobId, action })
                const [{ at, afterCancellation }, [committedAt]] = await Promise.all([aborted.promise, committed])
                await Promise.all([waiterDone, workerDone])
                assert.deepEqual(await peerExit, [0, null])
                assert.equal(readJob(jobId).status, 'cancelled')
                assert.equal(calls, 1)
                assert.equal(stops, 1)
                t.diagnostic(
                    JSON.stringify({
                        dialect,
                        action,
                        fixedWaitMs,
                        fixedWaitWrites: prior - first,
                        waitMs: Math.round(elapsed),
                        heartbeatWrites: last - first,
                        committedToAbortMs: at - committedAt,
                        afterCancellation
                    })
                )
                assert.ok(last - first <= Math.ceil(elapsed / 500) + 1, 'worker renewed more frequently than its durable heartbeat')
                assert.equal(afterCancellation, 0, 'remote cancellation should be observed by the next read')
            }
        }
    )
}

for (const dialect of ['sqlite', 'postgres']) {
    test(
        `${dialect}: a disconnected waiter persists cancellation once across polls and inline ownership`,
        { timeout: 20000 },
        async (t) => {
            const { createTestSource, skipReason } = await import('../etl/check/pg-source.mjs')
            if (dialect === 'postgres' && skipReason) return t.skip(skipReason)
            const { configureHarnessPostgres } = await import('./side-store-postgres.mjs')
            const { database } = await import('./lock.mjs')
            const { finishJob, waitForJob, queueMode } = await import('./queue.mjs')
            const { setTimeout: delay } = await import('node:timers/promises')
            const pg = dialect === 'postgres' ? await createTestSource() : undefined
            const original = { queue: process.env.CUTTLELY_HARNESS_QUEUE, key: process.env.CUTTLELY_SECRETKEY_OVERWRITE }
            delete process.env.CUTTLELY_HARNESS_QUEUE
            process.env.CUTTLELY_SECRETKEY_OVERWRITE = (await import('node:crypto')).randomBytes(32).toString('hex')
            closeSessions()
            closeQueueDb()
            if (pg) configureHarnessPostgres(pg.connection)
            t.after(async () => {
                closeSessions()
                closeQueueDb()
                configureHarnessPostgres(undefined)
                await pg?.cleanup()
                queueHooks.afterEnqueue = null
                for (const [key, v] of [
                    ['CUTTLELY_HARNESS_QUEUE', original.queue],
                    ['CUTTLELY_SECRETKEY_OVERWRITE', original.key]
                ]) {
                    if (v === undefined) delete process.env[key]
                    else process.env[key] = v
                }
            })
            assert.equal(queueMode(), 'inline')
            const db = database()
            let remaining = 0
            if (pg) {
                const { initializeRuntimeSessions } = await import('../etl/runtime-sessions.mjs')
                await initializeRuntimeSessions(pg, [], pg.connection)
                await pg.query(`CREATE SEQUENCE public.qa_cancel_counter MINVALUE 0 START 0;
                CREATE SEQUENCE public.qa_cancel_fault MINVALUE 0 START 0;
                CREATE FUNCTION public.qa_cancel_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN PERFORM nextval('public.qa_cancel_counter'); RETURN NULL; END $$;
                CREATE TRIGGER qa_cancel_attempt BEFORE UPDATE OF cancel_requested ON cuttlely_harness_queue.jobs
                FOR EACH STATEMENT EXECUTE FUNCTION public.qa_cancel_attempt();
                CREATE FUNCTION public.qa_cancel_fail() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF nextval('public.qa_cancel_fault') < 2 THEN RAISE EXCEPTION 'transient disconnect fixture';END IF; RETURN NEW; END $$;
                CREATE TRIGGER qa_cancel_fail BEFORE UPDATE OF cancel_requested ON cuttlely_harness_queue.jobs
                FOR EACH ROW EXECUTE FUNCTION public.qa_cancel_fail(); SELECT setval('public.qa_cancel_fault',2,false)`)
            } else {
                db.function('qa_cancel_fail', () => (remaining > 0 ? (remaining--, 1) : 0))
                db.exec(`CREATE TEMP TRIGGER qa_cancel_fault BEFORE UPDATE OF cancel_requested ON main.jobs
                WHEN qa_cancel_fail()=1 BEGIN SELECT RAISE(ABORT,'transient disconnect fixture');END`)
            }
            const prepare = db.prepare.bind(db)
            let writes = 0,
                loseAcknowledgement = false
            t.mock.method(db, 'prepare', (sql) => {
                const statement = prepare(sql)
                if (!sql.startsWith('UPDATE jobs SET cancel_requested = 1, updated_at = ?')) return statement
                return {
                    run: (...params) => {
                        writes++
                        const value = statement.run(...params)
                        if (loseAcknowledgement) {
                            loseAcknowledgement = false
                            throw new Error('Simulated lost acknowledgement after a real commit.')
                        }
                        return value
                    }
                }
            })
            const count = async () =>
                pg
                    ? Number(
                          (
                              await pg.query('SELECT CASE WHEN is_called THEN last_value + 1 ELSE 0 END AS n FROM public.qa_cancel_counter')
                          )[0].n
                      )
                    : writes
            const faults = async (n) => {
                if (pg) await pg.query("SELECT setval('public.qa_cancel_fault',$1,false)", [2 - n])
                else remaining = n
            }
            const name = 'disconnect-once-' + dialect
            saveHarness({
                name,
                workspaceId: 'fixture-workspace',
                chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'fixture' } } },
                specialists: [{ name: 'reader' }]
            })
            const args = {
                name,
                mode: 'agent',
                input: 'Wait for the simulated response.',
                flowOptions: { workspaceId: 'fixture-workspace', harnessCaller: { via: 'session' } }
            }
            for (const inlineFailures of [0, 1]) {
                await faults(inlineFailures)
                const entered = Promise.withResolvers(),
                    enqueued = Promise.withResolvers(),
                    inline = new AbortController()
                queueHooks.afterEnqueue = (job) => enqueued.resolve(job)
                const start = await count()
                const waiting = runQueuedHarness({
                    ...args,
                    chatId: 'inline-' + inlineFailures,
                    signal: inline.signal,
                    fetchImpl: async (url, opts) => {
                        if (url.endsWith('/stop')) return Response.json({ status: 'cancelled' })
                        if (url.endsWith('/events')) {
                            entered.resolve()
                            await new Promise((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }))
                            await delay(140)
                            throw Object.assign(new Error('Synthetic provider stopped.'), { name: 'AbortError' })
                        }
                        return Response.json({ status: 'running', run_id: 'held-fixture' })
                    }
                })
                const cancelled = assert.rejects(waiting, { code: 'aborted' })
                const job = await enqueued.promise
                await entered.promise
                inline.abort()
                assert.equal(readJob(job.id).cancelRequested, true)
                await cancelled
                const after = await count()
                t.diagnostic(
                    JSON.stringify({
                        dialect,
                        defaultInlineDisconnectWrites: after - start,
                        inlineFailures,
                        submittedWrites: writes,
                        pgStatementTrigger: Boolean(pg)
                    })
                )
                assert.equal(after - start, 1 + inlineFailures)
            }
            for (const [action, failCount] of [
                ['pre-abort', 0],
                ['pre-abort-transient', 1],
                ['lost-acknowledgement', 0],
                ['event-transient', 1],
                ['persistent-failure', 2],
                ['deadline', 0],
                ['already-settled', 0]
            ]) {
                const { id } = enqueueHarnessJob({ ...args, chatId: action })
                const ctrl = new AbortController()
                await faults(failCount)
                if (action === 'already-settled') finishJob(id, { status: 'succeeded', result: { text: 'already recorded' } })
                loseAcknowledgement = action === 'lost-acknowledgement'
                const before = await count()
                const oldTime = readJob(id).updatedAt
                if (action !== 'event-transient') ctrl.abort()
                const wait = waitForJob(id, { signal: ctrl.signal, timeoutMs: action === 'deadline' ? 100 : 1500 })
                if (action === 'already-settled') {
                    assert.deepEqual(await wait, { text: 'already recorded' })
                    assert.equal(readJob(id).updatedAt, oldTime)
                } else if (action === 'persistent-failure') {
                    await assert.rejects(wait)
                    assert.equal(readJob(id).cancelRequested, false)
                } else if (action === 'deadline') {
                    await assert.rejects(wait, { code: 'worker_timeout' })
                    assert.equal(readJob(id).cancelRequested, true)
                } else {
                    const terminal = assert.rejects(wait, { code: 'aborted' })
                    if (action === 'event-transient') ctrl.abort()
                    const limit = performance.now() + 1500
                    while (!readJob(id).cancelRequested && performance.now() < limit) await delay(5)
                    assert.equal(readJob(id).cancelRequested, true)
                    await delay(100)
                    finishJob(id, { status: 'cancelled', errorCode: 'aborted' })
                    await terminal
                }
                const observed = (await count()) - before
                t.diagnostic(JSON.stringify({ dialect, action, observed, failCount }))
                assert.equal(observed, action === 'persistent-failure' ? 2 : 1 + failCount)
            }
        }
    )
}
