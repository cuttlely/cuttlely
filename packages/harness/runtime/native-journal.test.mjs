import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { createTestSource, skipReason } from '../../etl/check/pg-source.mjs'
import { configureHarnessPostgres, listenForQueueWork } from '../side-store-postgres.mjs'
import { recordToolPhase } from '../queue-events.mjs'
import { nativeToolJournal, queueNativeTool } from './native-journal.mjs'
import { runNativeToolLoop } from './native-prime.mjs'
import { closeQueueDb, database } from '../lock.mjs'
import {
    appendEvent,
    claimJob,
    enqueueHarnessJob,
    finishJob,
    markCancel,
    readEvents,
    readJob,
    reconcilePublicQueueRun,
    stopQueueJobs,
    touchJob,
    waitForJob
} from '../queue.mjs'

import { beginHarnessRun, finishHarnessRun, getRun, getRunResult, interruptOpenRuns, queueHarnessRun, saveRunResult } from '../history.mjs'

test('all validated calls are durably queued before dispatch and failure to fence the job prevents invocation', async () => {
    const records = []
    let calls = 0
    const context = {
        nativeSpecialists: true,
        assertNativeAuthority() {},
        moduleOptions: {
            flowOptions: {
                [nativeToolJournal](record) {
                    if (record.phase === 'dispatched' && record.name === 'second') throw new Error('lost owner')
                    records.push(record)
                }
            }
        }
    }
    const names = ['first', 'second']
    await assert.rejects(
        runNativeToolLoop({
            messages: [],
            tools: names.map((name) => ({ function: { name } })),
            maxCalls: 2,
            complete: async () => ({ content: '', toolCalls: names.map((name) => ({ id: name, function: { name, arguments: '{}' } })) }),
            queueCall: (name) => queueNativeTool(context, { name: 'author' }, name),
            execute: (_name, _args, receipt) =>
                receipt.invoke(() => {
                    calls++
                    return 'done'
                })
        }),
        /lost owner/
    )
    assert.equal(calls, 1)
    assert.deepEqual(
        records.map((r) => [r.name, r.phase]),
        [
            ['first', 'queued'],
            ['second', 'queued'],
            ['first', 'dispatched'],
            ['first', 'confirmed']
        ]
    )
    assert.equal(records[0].callId, records[3].callId)
    assert.notEqual(records[0].callId, records[1].callId)
})

test('SQLite expiry preserves confirmation and unstarted calls and only marks outstanding dispatches as uncertain', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-job-receipts-'))
    const before = process.env.CUTTLELY_DATA_DIR
    process.env.CUTTLELY_DATA_DIR = dir
    closeQueueDb()
    t.after(() => {
        closeQueueDb()
        fs.rmSync(dir, { force: true, recursive: true })
        if (before === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = before
    })
    const args = {
        name: 'QA',
        chatId: 'chat',
        input: 'fixed fixture',
        flowOptions: { workspaceId: 'qa', harnessCaller: { via: 'session' } }
    }
    for (const byAdmission of [false, true]) {
        const job = enqueueHarnessJob({ ...args, chatId: String(byAdmission) })
        assert.equal(claimJob().id, job.id)
        appendEvent(job.id, { type: 'route', status: 'done' })
        for (const [callId, phase] of [
            ['a', 'queued'],
            ['b', 'dispatched'],
            ['c', 'dispatched'],
            ['b', 'confirmed']
        ]) {
            appendEvent(job.id, { type: 'nativeToolReceipt', callId, specialist: 'QA', name: 'qa_tool', phase })
        }
        database().prepare('UPDATE jobs SET updated_at = 0 WHERE id = ?').run(job.id)
        if (byAdmission) enqueueHarnessJob({ ...args, chatId: String(byAdmission) })
        await assert.rejects(waitForJob(job.id), { code: 'worker_lost', message: /outcome of 1 dispatched tool/ })
        assert.equal(readJob(job.id).status, 'failed')
        assert.deepEqual(
            readEvents(job.id, 0).map((r) => r.event),
            [{ type: 'route', status: 'done' }]
        )
        const uncertain = database()
            .prepare("SELECT event FROM job_events WHERE job_id = ? AND json_extract(event,'$.phase') = 'uncertain'")
            .all(job.id)
        assert.deepEqual(
            uncertain.map((row) => JSON.parse(row.event).callId),
            ['c']
        )
    }
})

test('public background runs reconcile their own durable job and keep completed answers across API replacement', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-public-job-'))
    const before = process.env.CUTTLELY_DATA_DIR
    process.env.CUTTLELY_DATA_DIR = dir
    closeQueueDb()
    t.after(() => {
        closeQueueDb()
        fs.rmSync(dir, { recursive: true, force: true })
        if (before === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = before
    })
    const args = {
        name: 'Paper',
        chatId: 'same',
        input: 'Count',
        apiKeyId: 'paper-key',
        flowOptions: { workspaceId: 'paper-space', harnessCaller: { via: 'session' } }
    }
    for (const outcome of ['expired', 'stopped', 'returned']) {
        const admitted = queueHarnessRun(args)
        const job = enqueueHarnessJob({ ...args, runId: admitted.id })
        assert.equal(claimJob().id, job.id)
        const open = beginHarnessRun({ ...args, id: admitted.id })
        assert.equal(open.status, 'running')
        const unrelated = beginHarnessRun(args)
        interruptOpenRuns({ before: Date.now() + 5 })
        assert.equal(getRun(args.name, open.id).status, 'running')
        assert.equal(getRun(args.name, unrelated.id).error.code, 'interrupted')
        assert.equal(reconcilePublicQueueRun(unrelated), false)
        assert.equal(reconcilePublicQueueRun(open), false)
        if (outcome === 'returned') {
            finishHarnessRun(open, { result: { text: 'Accepted 51.', agents: [] }, saveResult: true })
            assert.equal(getRunResult(args.name, open.id).text, 'Accepted 51.')
            continue
        }
        for (const phase of ['queued', 'dispatched'])
            appendEvent(job.id, { type: 'nativeToolReceipt', callId: 'count', phase, name: 'calculator', specialist: 'math' })
        if (outcome === 'expired') database().prepare('UPDATE jobs SET updated_at = 0 WHERE id = ?').run(job.id)
        else stopQueueJobs(true)
        assert.equal(reconcilePublicQueueRun(open), true)
        const expected = outcome === 'expired' ? 'worker_lost' : 'aborted'
        assert.equal(readJob(job.id).errorCode, expected)
        assert.equal(getRun(args.name, open.id).error.code, expected)
        assert.match(getRun(args.name, open.id).error.message, /could not be confirmed/)
        assert.equal(getRun(args.name, open.id, { apiKeyId: 'another-key' }), null)
        finishHarnessRun(open, { result: { text: 'Late return.' }, saveResult: true })
        assert.equal(getRun(args.name, open.id).error.code, expected)
        assert.equal(saveRunResult(args.name, open.id, { text: 'Late API waiter.' }), false)
        assert.equal(getRunResult(args.name, open.id), null)
    }
})

test(
    'PostgreSQL commits each admitted phase, fences cancellation and loss, and rolls back a failed event append',
    { skip: skipReason },
    async (t) => {
        const pg = await createTestSource()
        configureHarnessPostgres(pg.connection)
        closeQueueDb()
        t.after(async () => {
            closeQueueDb()
            configureHarnessPostgres(null)
            await pg.cleanup()
        })
        const args = { name: 'Math', input: '2+3', flowOptions: { workspaceId: 'qa', harnessCaller: { via: 'session' } } }
        const persisted = async (id) =>
            (await pg.query('SELECT seq, event FROM cuttlely_harness_queue.job_events WHERE job_id=$1 ORDER BY seq', [id])).map((r) => ({
                seq: Number(r.seq),
                ...JSON.parse(r.event)
            }))
        for (const stop of ['before-dispatch', 'during-operation', 'lease-lost']) {
            const job = enqueueHarnessJob({ ...args, chatId: stop })
            assert.equal(claimJob().id, job.id)
            let runs = 0
            const context = {
                nativeSpecialists: true,
                assertNativeAuthority() {},
                moduleOptions: { flowOptions: { [nativeToolJournal]: (entry) => recordToolPhase(job.id, entry) } }
            }
            const tool = queueNativeTool(context, { name: 'math' }, 'calculator')
            assert.deepEqual(
                (await persisted(job.id)).map((e) => e.phase),
                ['queued']
            )
            appendEvent(job.id, { type: 'route', status: 'done' })
            if (stop === 'before-dispatch') {
                markCancel(job.id)
                await assert.rejects(
                    tool.invoke(() => runs++),
                    { code: 'aborted' }
                )
            } else if (stop === 'lease-lost') {
                finishJob(job.id, { status: 'failed', errorCode: 'worker_lost' })
                await assert.rejects(
                    tool.invoke(() => runs++),
                    { code: 'worker_lost' }
                )
            } else {
                const answer = await tool.invoke(async () => {
                    runs++
                    assert.deepEqual(
                        (await persisted(job.id)).map((e) => e.phase || e.type),
                        ['queued', 'route', 'dispatched']
                    )
                    markCancel(job.id)
                    return 2 + 3
                })
                assert.equal(answer, 5)
            }
            const rows = await persisted(job.id)
            const privatePhases = rows.filter((e) => e.callId === tool.id).map((e) => e.phase)
            assert.deepEqual(privatePhases, stop === 'during-operation' ? ['queued', 'dispatched', 'confirmed'] : ['queued'])
            assert.deepEqual(
                rows.map((e) => e.seq),
                rows.map((_, i) => i + 1)
            )
            assert.equal(runs, stop === 'during-operation' ? 1 : 0)
            assert.deepEqual(
                readEvents(job.id, 0).map((e) => e.event),
                [{ type: 'route', status: 'done' }]
            )
        }
        const job = enqueueHarnessJob({ ...args, chatId: 'rolled-back' })
        assert.equal(claimJob().id, job.id)
        // A different client holds the same writer lock. Its timed SQL COMMIT can
        // release the writer even while appendEvent blocks this thread.
        const { Client } = createRequire(new URL('../../server/package.json', import.meta.url))('pg')
        const holder = new Client(pg.connection)
        await holder.connect()
        try {
            await holder.query('BEGIN')
            await holder.query("SELECT pg_advisory_xact_lock(hashtext('cuttlely_harness_queue'))")
            const blockedAt = Date.now()
            const released = holder.query('SELECT pg_sleep(0.1); COMMIT')
            appendEvent(job.id, { type: 'route' })
            await released
            assert.ok(readJob(job.id).updatedAt >= blockedAt + 70, 'heartbeat starts after acquiring the writer lock')
        } finally {
            await holder.end()
        }
        await pg.query('UPDATE cuttlely_harness_queue.jobs SET updated_at=1 WHERE id=$1', [job.id])
        await pg.query(`ALTER TABLE cuttlely_harness_queue.job_events
        ADD CONSTRAINT reject_fixture_body CHECK (event NOT LIKE '%reject-fixture-body%')`)
        assert.throws(() => appendEvent(job.id, { type: 'reject-fixture-body' }), { code: '23514' })
        assert.deepEqual(await persisted(job.id), [{ seq: 1, type: 'route' }])
        assert.equal(readJob(job.id).updatedAt, 1)
    }
)

test(
    'a committed external admission wakes a dedicated PostgreSQL listener without exposing the job or changing its ownership',
    { skip: skipReason },
    async (t) => {
        const pg = await createTestSource()
        let close
        t.after(async () => {
            await close?.()
            closeQueueDb()
            configureHarnessPostgres(null)
            await pg.cleanup()
        })
        configureHarnessPostgres(pg.connection)
        const previous = process.env.CUTTLELY_HARNESS_QUEUE
        process.env.CUTTLELY_HARNESS_QUEUE = 'external'
        t.after(() => {
            if (previous === undefined) delete process.env.CUTTLELY_HARNESS_QUEUE
            else process.env.CUTTLELY_HARNESS_QUEUE = previous
        })
        const wait = async (check) => {
            const until = Date.now() + 4000
            do {
                if (await check()) return
                await new Promise((resolve) => setTimeout(resolve, 10))
            } while (Date.now() < until)
            assert.fail('Timed out waiting for the PostgreSQL queue listener.')
        }
        let wakes = 0
        close = listenForQueueWork(() => wakes++)
        const listeners = async () =>
            (
                await pg.query(
                    "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name='Cuttlely harness queue listener' AND state='idle' AND query='LISTEN cuttlely_harness_queue_ready'"
                )
            ).length
        await wait(async () => (await listeners()) === 1)
        // A nonempty notification cannot substitute caller data for an admitted job.
        await pg.query("SELECT pg_notify('cuttlely_harness_queue_ready', 'unrelated')")
        const args = { name: 'queue-wake-fixture', chatId: 'qa-chat', input: 'Count items.' }
        const accepted = enqueueHarnessJob(args)
        assert.throws(() => enqueueHarnessJob(args), { code: 'busy' })
        await wait(() => wakes > 0)
        assert.equal(wakes, 1)
        assert.equal(readJob(accepted.id).status, 'queued')
        assert.equal(claimJob().id, accepted.id)
        await close()
        await wait(async () => !(await listeners()))
        assert.equal(claimJob(), null)
    }
)

test('PostgreSQL workers reserve a chat once and observe cancellation on their next heartbeat', { skip: skipReason }, async (t) => {
    const pg = await createTestSource()
    const { Client } = createRequire(new URL('../../server/package.json', import.meta.url))('pg')
    const writer = new Client(pg.connection)
    configureHarnessPostgres({ ...pg.connection, options: '-c default_transaction_isolation=repeatable\\ read' })
    closeQueueDb()
    t.after(async () => {
        await writer.end()
        closeQueueDb()
        configureHarnessPostgres(null)
        await pg.cleanup()
    })
    const args = { name: 'Reservation', chatId: 'same-chat', input: 'Count items.' }
    assert.equal(database().prepare("SELECT current_setting('default_transaction_isolation') AS setting").get().setting, 'repeatable read')
    const first = enqueueHarnessJob(args)
    assert.equal(claimJob().id, first.id)
    assert.equal(claimJob(), null)
    assert.equal(touchJob(first.id), false)
    markCancel(first.id)
    assert.equal(touchJob(first.id), true)
    finishJob(first.id, { status: 'cancelled', errorCode: 'aborted', errorMessage: 'Stopped.' })

    // An independent writer reserves the same chat before its row is visible to normal readers.
    await writer.connect()
    await writer.query('BEGIN')
    await writer.query("SELECT pg_advisory_xact_lock(hashtext('cuttlely_harness_queue'))")
    await writer.query(
        `INSERT INTO cuttlely_harness_queue.jobs (id, session_key, status, payload, cancel_requested, created_at, updated_at)
         VALUES ($1, $2, 'queued', '{}', 0, $3, $3)`,
        ['other-worker-job', first.sessionKey, Date.now()]
    )
    const commit = writer.query('SELECT pg_sleep(0.15); COMMIT')
    try {
        assert.throws(() => enqueueHarnessJob(args), { code: 'busy' })
    } finally {
        await commit
    }
    assert.equal(claimJob().id, 'other-worker-job')
    assert.equal(claimJob(), null)
    finishJob('other-worker-job', { status: 'succeeded', result: { text: 'Done.' } })
    const next = enqueueHarnessJob(args)
    assert.equal(claimJob().id, next.id)
    // A truly expired worker, unlike the committed reservation, frees this chat for one new claim.
    recordToolPhase(next.id, { callId: 'stale-call', specialist: 'math', name: 'calculator', phase: 'dispatched' })
    database().prepare('UPDATE jobs SET updated_at = 0 WHERE id = ?').run(next.id)
    const replacement = enqueueHarnessJob(args)
    assert.equal(readJob(next.id).errorCode, 'worker_lost')
    assert.match(readJob(next.id).errorMessage, /outcome of 1 dispatched tool call could not be confirmed/)
    assert.equal(claimJob().id, replacement.id)
    assert.equal(claimJob(), null)
})

test(
    'PostgreSQL appends overlap across jobs and fence each job after waiting for its preceding commit',
    { skip: skipReason },
    async (t) => {
        const pg = await createTestSource()
        const { Client } = createRequire(new URL('../../server/package.json', import.meta.url))('pg')
        const holder = new Client(pg.connection)
        t.after(async () => {
            await holder.end()
            closeQueueDb()
            configureHarnessPostgres(null)
            await pg.cleanup()
        })
        // The appender must take a new snapshot after the preceding writer releases the job lock,
        // including on installations whose normal transaction isolation is repeatable read.
        configureHarnessPostgres({ ...pg.connection, options: '-c default_transaction_isolation=repeatable\\ read', lock_timeout: 1000 })
        const admit = (chatId) => {
            const job = enqueueHarnessJob({ name: 'math', chatId, input: '1 + 1' })
            assert.equal(claimJob().id, job.id)
            return job.id
        }
        assert.equal(
            database().prepare("SELECT current_setting('default_transaction_isolation') AS setting").get().setting,
            'repeatable read'
        )
        const first = admit('first')
        const second = admit('second')
        const phase = (value) => recordToolPhase(first, { callId: 'call', specialist: 'math', name: 'calculator', phase: value })
        const stored = async (id) =>
            (await pg.query('SELECT seq,event FROM cuttlely_harness_queue.job_events WHERE job_id=$1 ORDER BY seq', [id])).map((row) => [
                Number(row.seq),
                JSON.parse(row.event).phase || JSON.parse(row.event).type
            ])
        await holder.connect()
        await holder.query('BEGIN')
        try {
            await holder.query("SELECT pg_advisory_xact_lock_shared(hashtext('cuttlely_harness_queue'))")
            await holder.query("SELECT pg_advisory_xact_lock(hashtext('cuttlely_harness_queue.job_events'),hashtext($1))", [first])
            await holder.query('INSERT INTO cuttlely_harness_queue.job_events(job_id,seq,event) VALUES ($1,1,$2)', [
                first,
                '{"type":"first"}'
            ])
            appendEvent(second, { type: 'independent' })
            assert.deepEqual(await stored(second), [[1, 'independent']])
            assert.throws(() => phase('queued'), { code: '55P03' })
            assert.deepEqual(await stored(first), [])
            // PostgreSQL can release the first writer while this process waits synchronously.
            const release = holder.query('SELECT pg_sleep(0.15); COMMIT')
            try {
                phase('queued')
            } finally {
                await release
            }
        } finally {
            await holder.query('ROLLBACK')
        }
        phase('dispatched')
        markCancel(first)
        assert.throws(() => phase('dispatched'), { code: 'aborted' })
        phase('confirmed')
        finishJob(first, { status: 'failed', errorCode: 'aborted', errorMessage: 'Fixture cancelled.' })
        assert.throws(() => phase('confirmed'), { code: 'worker_lost' })
        assert.deepEqual(await stored(first), [
            [1, 'first'],
            [2, 'queued'],
            [3, 'dispatched'],
            [4, 'confirmed']
        ])
    }
)
