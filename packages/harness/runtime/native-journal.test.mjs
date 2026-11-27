import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { nativeToolJournal, queueNativeTool } from './native-journal.mjs'
import { runNativeToolLoop } from './native-prime.mjs'
import { closeQueueDb, database } from '../lock.mjs'
import { appendEvent, claimJob, enqueueHarnessJob, readEvents, readJob, waitForJob } from '../queue.mjs'

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
