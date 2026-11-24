// Pause and cancel against a job that is finishing. A job writes its run's last status before it leaves the runner's
// active set. A pause or cancel landing between the two must not write 'pausing' or 'cancelling' over that status: the
// run would stay active with no job, and every later run of the pipeline would be refused until a restart.
import fs from 'node:fs'
import path from 'node:path'
import { api, check, flowFor, root, WS } from './lib.mjs'

const etlStore = await import('../store.mjs')
const { ACTIVE_STATUSES, activeRunFor, getRun, insertRun, listEvents, runsWithStatus, updateRun } = await import('../runs.mjs')
const { executeRun } = await import('../execute.mjs')
const { blockRuns, isActive, unblockRuns } = await import('../runner.mjs')
const { pipelineStats } = await import('../versions.mjs')

const SETTINGS = { batchSize: 10, concurrency: 1, maxRetries: 1, maxErrors: 5 }
const outcome = (promise) =>
    promise.then(
        (run) => ({ status: 200, run: run?.status }),
        (error) => ({ status: error.status, message: error.message })
    )
const startOutcome = (pipelineId) => outcome(api.startRun(pipelineId, { settings: SETTINGS }))

async function savePipeline(id) {
    const file = path.join(root, `${id}.csv`)
    fs.writeFileSync(file, ['sku,name,notes', ...Array.from({ length: 30 }, (_, i) => `S${i},Loaf ${i},batch ${i}`)].join('\n'))
    await api.recordVersion({ workspaceId: WS, id, name: `Run control ${id}`, flowData: flowFor(file, '') })
}

// A pipeline whose first run holds its first embed call, so the job stays active until the gate opens.
async function heldRun(id) {
    let reached
    const gateReached = new Promise((resolve) => (reached = resolve))
    let release
    const gateReleased = new Promise((resolve) => (release = resolve))
    const embedGate = async (call) => {
        if (call !== 1) return
        reached(true)
        await gateReleased
    }
    api.configureRunner({ contextFor: () => ({ workspaceId: WS, embedGate }) })
    await savePipeline(id)
    const started = await api.startRun(id, { settings: SETTINGS })
    const held = await Promise.race([gateReached, new Promise((resolve) => setTimeout(() => resolve(false), 10000))])
    return { run: started, held, release }
}

async function settle(job) {
    api.configureRunner({ contextFor: () => ({ workspaceId: WS }) })
    job.release()
    await api.waitForIdle()
}

// The last status is written in a transaction while the job is still active; the pause and cancel arrive while that
// transaction holds the store.
{
    const job = await heldRun('run-control-settled')
    const runId = job.run.id
    let pause
    let cancel
    let activeDuringWrite = false
    await etlStore.tx(async (t) => {
        await updateRun(runId, { status: 'succeeded', finishedAt: new Date().toISOString() }, t)
        activeDuringWrite = isActive(runId)
        pause = outcome(api.pauseRun(runId))
        cancel = outcome(api.cancelRun(runId))
    })
    const paused = await pause
    const cancelled = await cancel
    const after = (await getRun(runId)).status
    const next = await startOutcome('run-control-settled')
    await settle(job)
    const detail = { held: job.held, activeDuringWrite, paused, cancelled, after, next }
    check(
        'run control 1: a pause landing after a job wrote its last status is refused with that status',
        job.held && activeDuringWrite && paused.status === 409 && paused.message === 'This run already succeeded.',
        JSON.stringify(detail)
    )
    check(
        'run control 2: a cancel landing after a job wrote its last status is refused with that status',
        job.held && activeDuringWrite && cancelled.status === 409 && cancelled.message === 'This run already succeeded.',
        JSON.stringify(detail)
    )
    check(
        'run control 3: the run keeps its last status and the next run of the pipeline is accepted',
        after === 'succeeded' && next.status === 200 && next.run === 'queued',
        JSON.stringify(detail)
    )
}

// The pause is issued first and the job's last status write arrives in the same turn. The pause reads the run and
// writes 'pausing' in one transaction, so the last status lands after it instead of between the read and the write.
{
    const job = await heldRun('run-control-ordered')
    const runId = job.run.id
    const pause = outcome(api.pauseRun(runId))
    const write = etlStore.tx((t) => updateRun(runId, { status: 'succeeded', finishedAt: new Date().toISOString() }, t))
    const paused = await pause
    await write
    const after = (await getRun(runId)).status
    const next = await startOutcome('run-control-ordered')
    await settle(job)
    const detail = { held: job.held, paused, after, next }
    check(
        'run control 4: a pause issued before a job writes its last status is applied before that write, not between',
        job.held && paused.status === 200 && after === 'succeeded',
        JSON.stringify(detail)
    )
    check(
        'run control 5: after that write the next run of the pipeline is accepted',
        next.status === 200 && next.run === 'queued',
        JSON.stringify(detail)
    )
}

// With no job behind the run, pause and cancel take their usual paths: a paused or a failed run is cancelled, and a
// queued run is paused. Blocking the pipeline keeps the runner from launching the seeded runs.
{
    const id = 'run-control-idle'
    await savePipeline(id)
    blockRuns(id)
    try {
        const seed = async (status) => {
            const run = await insertRun({ pipelineId: id, version: 1, mode: 'incremental', settings: SETTINGS })
            if (status !== 'queued') await updateRun(run.id, { status })
            return run.id
        }
        const runs = { paused: await seed('paused'), failed: await seed('failed'), queued: await seed('queued') }
        const results = {
            paused: await outcome(api.cancelRun(runs.paused)),
            failed: await outcome(api.cancelRun(runs.failed)),
            queued: await outcome(api.pauseRun(runs.queued))
        }
        const stored = {
            paused: (await getRun(runs.paused)).status,
            failed: (await getRun(runs.failed)).status,
            queued: (await getRun(runs.queued)).status
        }
        const anyJob = Object.values(runs).some(isActive)
        const detail = { anyJob, results, stored }
        check(
            'run control 6: with no job, cancelling a paused run or a failed run cancels it',
            !anyJob &&
                results.paused.status === 200 &&
                results.failed.status === 200 &&
                stored.paused === 'cancelled' &&
                stored.failed === 'cancelled',
            JSON.stringify(detail)
        )
        check(
            'run control 7: with no job, pausing a queued run pauses it',
            !anyJob && results.queued.status === 200 && stored.queued === 'paused',
            JSON.stringify(detail)
        )
    } finally {
        unblockRuns(id)
    }
}

// Resume against a cancel that does not take the pipeline lock. A resume that read the run as paused and then wrote
// 'queued' unconditionally would write over a cancel committed between the two, and the runner would launch the
// cancelled run. activeRunFor builds its query with ACTIVE_STATUSES.map, the one call between resume's read of the run
// and its status write, so a one-shot map on that array issues the cancel exactly there.
async function pausedRun(id) {
    await savePipeline(id)
    blockRuns(id)
    try {
        const run = await insertRun({ pipelineId: id, version: 1, mode: 'full', settings: SETTINGS })
        await updateRun(run.id, { status: 'paused' })
        return run.id
    } finally {
        unblockRuns(id)
    }
}

{
    const id = 'run-control-resume-cancel'
    await api.waitForIdle()
    const runId = await pausedRun(id)
    let cancel = null
    let fired = 0
    Object.defineProperty(ACTIVE_STATUSES, 'map', {
        configurable: true,
        value(...args) {
            if (!cancel) {
                fired += 1
                cancel = outcome(api.cancelRun(runId))
            }
            return Array.prototype.map.apply(this, args)
        }
    })
    let resume
    try {
        resume = await outcome(api.resumeRun(runId))
    } finally {
        delete ACTIVE_STATUSES.map
    }
    const cancelled = await cancel
    await api.waitForIdle()
    const stored = (await getRun(runId)).status
    const chunks = (await pipelineStats(id)).chunks
    const detail = JSON.stringify({ fired, resume, cancelled, stored, active: isActive(runId), chunks })
    check(
        'run control 8: a cancel between a resume reading the run and writing queued leaves the run cancelled and not launched',
        fired === 1 &&
            cancelled?.status === 200 &&
            stored === 'cancelled' &&
            !isActive(runId) &&
            chunks === 0 &&
            (resume.status === 200 || (resume.status === 409 && /cannot be resumed/.test(resume.message))),
        detail
    )
}

// A cancel committed before the resume reads the run: the resume sees 'cancelled' and is refused.
{
    const id = 'run-control-cancel-resume'
    await api.waitForIdle()
    const runId = await pausedRun(id)
    const [cancelled, resume] = await Promise.all([outcome(api.cancelRun(runId)), outcome(api.resumeRun(runId))])
    await api.waitForIdle()
    const stored = (await getRun(runId)).status
    const detail = JSON.stringify({ cancelled, resume, stored, active: isActive(runId) })
    check(
        'run control 9: a resume after a cancel in the same turn is refused with 409 and the run stays cancelled',
        cancelled.status === 200 &&
            resume.status === 409 &&
            resume.message === 'A cancelled run cannot be resumed.' &&
            stored === 'cancelled' &&
            !isActive(runId),
        detail
    )
}

// A pause or cancel between the runner reading a queued run and executeRun writing 'running'. launch() puts the job in
// the active set and then asks contextFor for the run's context, so a pause or cancel issued from contextFor takes the
// active-job path ('pausing' or 'cancelling') before executeRun reads the run. The run must stop without starting.
async function stopBeforeRunning(id, action) {
    await api.waitForIdle()
    await savePipeline(id)
    let fired = 0
    let stop = null
    api.configureRunner({
        contextFor: async (pipeline) => {
            if (pipeline?.id === id && !stop) {
                fired += 1
                const run = await activeRunFor(id)
                stop = outcome(action === 'pause' ? api.pauseRun(run.id) : api.cancelRun(run.id))
            }
            return { workspaceId: WS }
        }
    })
    let started
    try {
        started = await api.startRun(id, { settings: SETTINGS })
        await api.waitForIdle()
    } finally {
        api.configureRunner({ contextFor: () => ({ workspaceId: WS }) })
    }
    const stopped = await stop
    const run = await getRun(started.id)
    const events = (await listEvents(run.id)).map((event) => event.message)
    const chunks = (await pipelineStats(id)).chunks
    return {
        fired,
        stopped,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        active: isActive(run.id),
        chunks,
        events
    }
}

{
    const result = await stopBeforeRunning('run-control-cancel-launch', 'cancel')
    check(
        'run control 10: a cancel after the runner reads a queued run and before it is running cancels it without starting it',
        result.fired === 1 &&
            result.stopped?.status === 200 &&
            result.status === 'cancelled' &&
            Boolean(result.finishedAt) &&
            !result.startedAt &&
            !result.active &&
            result.chunks === 0 &&
            !result.events.some((message) => /^Started /.test(message)) &&
            result.events.includes('Cancelled. Nothing was deleted.'),
        JSON.stringify(result)
    )
}

{
    const result = await stopBeforeRunning('run-control-pause-launch', 'pause')
    check(
        'run control 11: a pause after the runner reads a queued run and before it is running pauses it without starting it',
        result.fired === 1 &&
            result.stopped?.status === 200 &&
            result.status === 'paused' &&
            !result.startedAt &&
            !result.active &&
            result.chunks === 0 &&
            !result.events.some((message) => /^Started /.test(message)) &&
            result.events.includes('Paused at the last committed batch.'),
        JSON.stringify(result)
    )
}

// The same window before launch() puts the job in the active set: the runner has read the run as queued, a cancel or
// pause with no job behind the run commits 'cancelled' or 'paused', and then executeRun is called for it the way
// launch() calls it. Nothing marks that point between the runner's read and launch(), so the check runs the three steps
// in that order itself, as the restart and duplicate-resume checks call executeRun directly.
async function stopThenExecute(id, action) {
    await api.waitForIdle()
    const runId = await pausedRun(id).then(async (seeded) => {
        await updateRun(seeded, { status: 'queued' })
        return seeded
    })
    const read = (await runsWithStatus(['queued'])).some((run) => run.id === runId)
    const stopped = await outcome(action === 'pause' ? api.pauseRun(runId) : api.cancelRun(runId))
    const control = { stopRequested: null, abort: new AbortController() }
    const executed = await outcome(executeRun(runId, { control, ctx: { workspaceId: WS } }))
    const run = await getRun(runId)
    const events = (await listEvents(runId)).map((event) => event.message)
    const chunks = (await pipelineStats(id)).chunks
    return { read, stopped, executed, status: run.status, startedAt: run.startedAt, active: isActive(runId), chunks, events }
}

{
    const result = await stopThenExecute('run-control-cancel-read', 'cancel')
    check(
        'run control 12: a run cancelled after the runner read it as queued is not started by executeRun',
        result.read &&
            result.stopped.status === 200 &&
            result.stopped.run === 'cancelled' &&
            result.executed.status === 200 &&
            result.status === 'cancelled' &&
            !result.startedAt &&
            !result.active &&
            result.chunks === 0 &&
            !result.events.some((message) => /^Started /.test(message)),
        JSON.stringify(result)
    )
}

{
    const result = await stopThenExecute('run-control-pause-read', 'pause')
    check(
        'run control 13: a run paused after the runner read it as queued is not started by executeRun',
        result.read &&
            result.stopped.status === 200 &&
            result.stopped.run === 'paused' &&
            result.executed.status === 200 &&
            result.status === 'paused' &&
            !result.startedAt &&
            !result.active &&
            result.chunks === 0 &&
            !result.events.some((message) => /^Started /.test(message)),
        JSON.stringify(result)
    )
}

// Recovery races: a pause or cancel that lands while resumeInterruptedRuns runs after a server start is not overwritten.
// RC-R1: seed job-less pausing, then cancel and recovery in the same tick. Expect cancelled.
{
    const id = 'run-control-recovery-1'
    await api.waitForIdle()
    await savePipeline(id)
    blockRuns(id)
    try {
        const run = await insertRun({ pipelineId: id, version: 1, mode: 'incremental', settings: SETTINGS })
        await updateRun(run.id, { status: 'pausing' })
        const resumed = api.resumeInterruptedRuns()
        const cancelled = outcome(api.cancelRun(run.id))
        const [resumedList, cancelResult] = await Promise.all([resumed, cancelled])
        const stored = await getRun(run.id)
        const detail = { resumedList, cancelResult, status: stored.status, finishedAt: Boolean(stored.finishedAt) }
        check(
            'run control RC-R1: a cancel that lands while recovery processes a pausing run is not overwritten',
            cancelResult.status === 200 && stored.status === 'cancelled' && stored.finishedAt && !resumedList.includes(run.id),
            JSON.stringify(detail)
        )
    } finally {
        unblockRuns(id)
    }
}

// RC-R2: seed cancelling, then recovery and a tx writing paused in the same tick. Expect paused stays.
{
    const id = 'run-control-recovery-2'
    await api.waitForIdle()
    await savePipeline(id)
    blockRuns(id)
    try {
        const run = await insertRun({ pipelineId: id, version: 1, mode: 'incremental', settings: SETTINGS })
        await updateRun(run.id, { status: 'cancelling' })
        const resumed = api.resumeInterruptedRuns()
        const write = etlStore.tx((t) => updateRun(run.id, { status: 'paused' }, t))
        await Promise.all([resumed, write])
        const stored = await getRun(run.id)
        check(
            'run control RC-R2: a paused status written while recovery processes a cancelling run stays paused',
            stored.status === 'paused',
            JSON.stringify({ status: stored.status })
        )
    } finally {
        unblockRuns(id)
    }
}

// RC-R3: seed running, then recovery and a tx writing cancelled in the same tick. Expect cancelled, not launched.
{
    const id = 'run-control-recovery-3'
    await api.waitForIdle()
    await savePipeline(id)
    blockRuns(id)
    try {
        const run = await insertRun({ pipelineId: id, version: 1, mode: 'incremental', settings: SETTINGS })
        await updateRun(run.id, { status: 'running' })
        const resumed = api.resumeInterruptedRuns()
        const write = etlStore.tx((t) => updateRun(run.id, { status: 'cancelled', finishedAt: new Date().toISOString() }, t))
        const [resumedList] = await Promise.all([resumed, write])
        await api.waitForIdle()
        const stored = await getRun(run.id)
        const events = (await listEvents(run.id)).map((event) => event.message)
        const chunks = (await pipelineStats(id)).chunks
        const detail = {
            resumedList,
            status: stored.status,
            active: isActive(run.id),
            chunks,
            hasStartedEvent: events.some((m) => /^Started /.test(m))
        }
        check(
            'run control RC-R3: a cancelled status written while recovery processes a running run stays cancelled and is not launched',
            stored.status === 'cancelled' &&
                !resumedList.includes(run.id) &&
                !isActive(run.id) &&
                chunks === 0 &&
                !events.some((message) => /^Started /.test(message)),
            JSON.stringify(detail)
        )
    } finally {
        unblockRuns(id)
    }
}

// RC-R4: lock-in with no concurrent writer. Seeds pausing, cancelling, running, queued; recovery ends them paused,
// cancelled, resumed, resumed, and returns exactly the running and queued ids.
{
    const id = 'run-control-recovery-4'
    await api.waitForIdle()
    await savePipeline(id)
    blockRuns(id)
    try {
        const runs = {
            pausing: await insertRun({ pipelineId: id, version: 1, mode: 'incremental', settings: SETTINGS }).then(async (r) => {
                await updateRun(r.id, { status: 'pausing' })
                return r.id
            }),
            cancelling: await insertRun({ pipelineId: id, version: 1, mode: 'incremental', settings: SETTINGS }).then(async (r) => {
                await updateRun(r.id, { status: 'cancelling' })
                return r.id
            }),
            running: await insertRun({ pipelineId: id, version: 1, mode: 'incremental', settings: SETTINGS }).then(async (r) => {
                await updateRun(r.id, { status: 'running' })
                return r.id
            }),
            queued: (await insertRun({ pipelineId: id, version: 1, mode: 'incremental', settings: SETTINGS })).id
        }
        const resumedList = await api.resumeInterruptedRuns()
        const stored = {
            pausing: (await getRun(runs.pausing)).status,
            cancelling: (await getRun(runs.cancelling)).status,
            running: (await getRun(runs.running)).status,
            queued: (await getRun(runs.queued)).status
        }
        const detail = { resumedList, stored }
        check(
            'run control RC-R4: recovery with no concurrent writer ends pausing→paused, cancelling→cancelled, running→queued, queued→queued',
            stored.pausing === 'paused' &&
                stored.cancelling === 'cancelled' &&
                stored.running === 'queued' &&
                stored.queued === 'queued' &&
                resumedList.includes(runs.running) &&
                resumedList.includes(runs.queued) &&
                resumedList.length === 2,
            JSON.stringify(detail)
        )
        // Clean up the queued runs left by recovery so they don't interfere with subsequent tests
        await api.cancelRun(runs.running)
        await api.cancelRun(runs.queued)
    } finally {
        unblockRuns(id)
    }
}

// Launch error races: a run that fails to start after a pause or cancel ends paused or cancelled instead of failed.
// RC-L1: contextFor calls cancelRun (job present → cancelling), awaits it, then throws. Expect cancelled, not failed.
{
    const id = 'run-control-launch-1'
    await api.waitForIdle()
    await savePipeline(id)
    let called = false
    let pipelineIdSeen = null
    const errorText = 'RC-L1 error after cancel'
    api.configureRunner({
        contextFor: async (pipeline) => {
            pipelineIdSeen = pipeline?.id
            if (pipeline?.id === id && !called) {
                called = true
                const run = await activeRunFor(id)
                await api.cancelRun(run.id)
                throw new Error(errorText)
            }
            return { workspaceId: WS }
        }
    })
    try {
        const started = await api.startRun(id, { settings: SETTINGS })
        await api.waitForIdle()
        // Extra yield to ensure .finally cleanup completes
        await new Promise((resolve) => setImmediate(resolve))
        const stored = await getRun(started.id)
        const events = (await listEvents(started.id)).map((event) => event.message)
        const chunks = (await pipelineStats(id)).chunks
        const nextStart = await startOutcome(id)
        const detail = {
            called,
            status: stored.status,
            finishedAt: Boolean(stored.finishedAt),
            active: isActive(started.id),
            chunks,
            hasErrorEvent: events.some((m) => m.includes(errorText)),
            nextStart
        }
        check(
            'run control RC-L1: a run that throws after a cancel during contextFor ends cancelled with one stop event and no error event',
            called &&
                stored.status === 'cancelled' &&
                stored.finishedAt &&
                !events.some((m) => m.includes(errorText)) &&
                events.filter((m) => m === 'Cancelled. Nothing was deleted.').length === 1 &&
                chunks === 0 &&
                nextStart.status === 200,
            JSON.stringify(detail)
        )
    } finally {
        api.configureRunner({ contextFor: () => ({ workspaceId: WS }) })
    }
}

// RC-L2: contextFor calls pauseRun, awaits it, then throws. Expect paused, not failed, and resumeRun accepted.
{
    const id = 'run-control-launch-2'
    await api.waitForIdle()
    await savePipeline(id)
    let called = false
    const errorText = 'RC-L2 error after pause'
    api.configureRunner({
        contextFor: async (pipeline) => {
            if (pipeline?.id === id && !called) {
                called = true
                const run = await activeRunFor(id)
                await api.pauseRun(run.id)
                throw new Error(errorText)
            }
            return { workspaceId: WS }
        }
    })
    try {
        const started = await api.startRun(id, { settings: SETTINGS })
        await api.waitForIdle()
        // Extra yield to ensure .finally cleanup completes
        await new Promise((resolve) => setImmediate(resolve))
        const stored = await getRun(started.id)
        const events = (await listEvents(started.id)).map((event) => event.message)
        const chunks = (await pipelineStats(id)).chunks
        const nextResume = await outcome(api.resumeRun(started.id))
        const detail = {
            called,
            status: stored.status,
            active: isActive(started.id),
            chunks,
            hasErrorEvent: events.some((m) => m.includes(errorText)),
            nextResume
        }
        check(
            'run control RC-L2: a run that throws after a pause during contextFor ends paused with one stop event, no error event and can be resumed',
            called &&
                stored.status === 'paused' &&
                !events.some((m) => m.includes(errorText)) &&
                events.filter((m) => m === 'Paused at the last committed batch.').length === 1 &&
                chunks === 0 &&
                nextResume.status === 200,
            JSON.stringify(detail)
        )
    } finally {
        api.configureRunner({ contextFor: () => ({ workspaceId: WS }) })
    }
}

// RC-L3: contextFor writes cancelled via a tx, then throws. Expect cancelled kept with no error event.
{
    const id = 'run-control-launch-3'
    await api.waitForIdle()
    await savePipeline(id)
    let called = false
    const errorText = 'RC-L3 error after tx cancel'
    api.configureRunner({
        contextFor: async (pipeline) => {
            if (pipeline?.id === id && !called) {
                called = true
                const run = await activeRunFor(id)
                await etlStore.tx((t) => updateRun(run.id, { status: 'cancelled', finishedAt: new Date().toISOString() }, t))
                throw new Error(errorText)
            }
            return { workspaceId: WS }
        }
    })
    try {
        const started = await api.startRun(id, { settings: SETTINGS })
        await api.waitForIdle()
        // Extra yield to ensure .finally cleanup completes
        await new Promise((resolve) => setImmediate(resolve))
        const stored = await getRun(started.id)
        const events = (await listEvents(started.id)).map((event) => event.message)
        const chunks = (await pipelineStats(id)).chunks
        const detail = {
            called,
            status: stored.status,
            finishedAt: Boolean(stored.finishedAt),
            active: isActive(started.id),
            chunks,
            hasErrorEvent: events.some((m) => m.includes(errorText))
        }
        check(
            'run control RC-L3: a run that throws after a tx writes cancelled during contextFor keeps cancelled with no error event',
            called &&
                stored.status === 'cancelled' &&
                stored.finishedAt &&
                !events.some((m) => m.includes(errorText)) &&
                !events.includes('Cancelled. Nothing was deleted.') &&
                chunks === 0,
            JSON.stringify(detail)
        )
    } finally {
        api.configureRunner({ contextFor: () => ({ workspaceId: WS }) })
    }
}

// RC-L4: lock-in with no stop. contextFor throws with no pause/cancel → failed with the error, as today.
{
    const id = 'run-control-launch-4'
    await api.waitForIdle()
    await savePipeline(id)
    let called = false
    const errorText = 'RC-L4 error with no stop'
    api.configureRunner({
        contextFor: async (pipeline) => {
            if (pipeline?.id === id && !called) {
                called = true
                throw new Error(errorText)
            }
            return { workspaceId: WS }
        }
    })
    try {
        const started = await api.startRun(id, { settings: SETTINGS })
        await api.waitForIdle()
        // Extra yield to ensure .finally cleanup completes
        await new Promise((resolve) => setImmediate(resolve))
        const stored = await getRun(started.id)
        const events = (await listEvents(started.id)).map((event) => event.message)
        const detail = {
            called,
            status: stored.status,
            error: stored.error,
            finishedAt: Boolean(stored.finishedAt),
            active: isActive(started.id),
            hasErrorEvent: events.some((m) => m.includes(errorText))
        }
        check(
            'run control RC-L4: a run that throws during contextFor with no pause or cancel ends failed with the error',
            called &&
                stored.status === 'failed' &&
                stored.error?.includes(errorText) &&
                stored.finishedAt &&
                events.some((m) => m.includes(errorText)),
            JSON.stringify(detail)
        )
    } finally {
        api.configureRunner({ contextFor: () => ({ workspaceId: WS }) })
    }
}

// The same conditional-write cases, including the claim races, also run against a real READ COMMITTED Postgres fixture.
const { checkRunControlRaces } = await import('./run-control-races.mjs')
await checkRunControlRaces({ check, writeDuringRead: (t, write) => write(t), savePipeline })
