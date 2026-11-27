import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { nativeToolJournal, queueNativeTool } from './native-journal.mjs'
import { runNativeToolLoop } from './native-prime.mjs'
import { closeQueueDb, database } from '../lock.mjs'
import {
    appendEvent,
    claimJob,
    enqueueHarnessJob,
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
