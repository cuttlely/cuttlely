import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { createTestSource, skipReason } from '../../etl/check/pg-source.mjs'
import { configureHarnessPostgres } from '../side-store-postgres.mjs'
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
