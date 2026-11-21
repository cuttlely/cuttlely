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
