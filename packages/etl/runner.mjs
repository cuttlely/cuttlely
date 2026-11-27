import { jobsStopped } from '../harness/side-store-maintenance.mjs'
import { EtlError, errorMessage } from './errors.mjs'
import { executeRun } from './execute.mjs'
import { fault, isCrash } from './faults.mjs'
import {
    ACTIVE_STATUSES,
    activeRunFor,
    addEvent,
    finishRunStop,
    getRun,
    insertRun,
    normalizeSettings,
    runsWithStatus,
    updateRun,
    updateRunIf
} from './runs.mjs'
import * as etlStore from './store.mjs'
import { getPipeline, latestVersion } from './versions.mjs'

// In-process job runner. This is the queue seam: a later version replaces enqueue() with a job push
// and workers call executeRun(runId); runs, checkpoints and records already live in a database.
const active = new Map()
export const hasActiveRuns = () => active.size > 0
let contextFor = () => ({})
let maxActive = Math.max(1, Number(process.env.CUTTLELY_ETL_CONCURRENCY) || 1)
let onError = () => {}
let onSettled = () => {}
let runnerFaults = null
let stopping = () => false
let track = (run) => run

export function runnerStopping() {
    return stopping() || jobsStopped()
}

// Register work before its first await, including admission and queue handoff.
function admitted(work) {
    if (etlStore.gate.closed())
        throw new EtlError('store_moving', 'ETL is moving to the application database. Try again in a minute.', 503, 30)
    if (runnerStopping()) throw new EtlError('restarting', 'Cuttlely is restarting to apply new settings. Try again in a minute.', 503)
    return track(Promise.resolve().then(work))
}

// The context a run of this pipeline gets (its credentials and node pool), for work outside a run such as a delete.
export async function pipelineContext(pipeline) {
    return (await contextFor(pipeline)) || {}
}

export function configureRunner(options = {}) {
    if (typeof options.contextFor === 'function') contextFor = options.contextFor
    if (Number(options.maxActive) > 0) maxActive = Number(options.maxActive)
    if (typeof options.onError === 'function') onError = options.onError
    if (typeof options.onSettled === 'function') onSettled = options.onSettled
    if (Object.hasOwn(options, 'faults')) runnerFaults = options.faults
    if (typeof options.stopping === 'function') stopping = options.stopping
    if (typeof options.track === 'function') track = options.track
}

// Pipelines being deleted. No run starts, resumes or leaves the queue for them, so nothing writes vectors back while the
// delete removes them.
const deleting = new Map()

export function blockRuns(pipelineId) {
    deleting.set(pipelineId, (deleting.get(pipelineId) || 0) + 1)
}

export function unblockRuns(pipelineId) {
    const count = (deleting.get(pipelineId) || 0) - 1
    if (count > 0) deleting.set(pipelineId, count)
    else deleting.delete(pipelineId)
}

function refuseWhileDeleting(pipelineId) {
    if (deleting.has(pipelineId)) throw new EtlError('deleting', 'This pipeline is being deleted.', 409)
}

export function isActive(runId) {
    return active.has(runId)
}

// Starting, resuming and deleting a pipeline each hold that pipeline's lock, so their checks and writes never interleave.
// Only startRun, resumeRun and purge's deletePipeline take it, each once and outside any store transaction. Nothing that
// holds it calls another of them, and pump() and executeRun() never take it. The deleting check runs before the wait,
// so a start during a delete is refused at once, and again inside the lock.
export async function startRun(pipelineId, options) {
    refuseWhileDeleting(pipelineId)
    return admitted(() => etlStore.withPipelineLock(pipelineId, () => startUnlocked(pipelineId, options)))
}

async function startUnlocked(pipelineId, { mode = 'incremental', settings = {} } = {}) {
    const pipeline = await getPipeline(pipelineId)
    if (!pipeline) throw new EtlError('not_found', 'Save the pipeline before running it.', 404)
    refuseWhileDeleting(pipelineId)
    const version = await latestVersion(pipelineId)
    if (!version) throw new EtlError('not_found', 'Save the pipeline before running it.', 404)
    const problems = version.problems?.problems || []
    if (problems.length) throw new EtlError('bad_pipeline', problems.join(' '))
    const running = await activeRunFor(pipelineId)
    if (running)
        throw new EtlError('run_active', `Run ${running.id.slice(0, 8)} is still ${running.status}. Pause or cancel it first.`, 409)
    const run = await insertRun({
        pipelineId,
        version: version.version,
        mode: mode === 'full' ? 'full' : 'incremental',
        settings: normalizeSettings(settings)
    })
    await addEvent(run.id, 'info', null, `Queued ${run.mode} run of version ${run.version}.`)
    await pump()
    return getRun(run.id)
}

// A job writes its run's last status before it leaves `active`. A job whose run is no longer active is finishing, and
// a pause or cancel written over that status would leave the run active with nothing behind it.
function refuseFinishing(run) {
    if (!ACTIVE_STATUSES.includes(run.status)) throw new EtlError('bad_state', `This run already ${run.status}.`, 409)
}

// A refused request returns its EtlError from the transaction instead of throwing it, so the transaction commits:
// the refusal comes before the request's own write, and a rollback would also undo a write another writer made inside
// the same SQLite transaction. Only EtlError is returned; database and hook errors still roll the transaction back.
async function decide(step) {
    try {
        return await step()
    } catch (error) {
        if (error instanceof EtlError) return error
        throw error
    }
}

async function refusableTx(body) {
    const refused = await etlStore.tx(body)
    if (refused instanceof EtlError) throw refused
}

// The run read, the job lookup and the status write share one transaction, so a job's last status write lands either
// before it (and is seen here) or after it. The write is conditional on the status read: at READ COMMITTED another
// writer can commit after the read, and then the request decides again from the status that writer left.
export async function pauseRun(runId) {
    await refusableTx(async (t) => {
        for (;;) {
            const decision = await decide(async () => {
                const run = await requireRun(runId, t)
                await fault({ faults: runnerFaults }, 'pauseAfterRead', run, t)
                const job = active.get(runId)
                if (job) refuseFinishing(run)
                else if (run.status !== 'queued' && !((includeInterrupted || etlStore.sharedExecution()) && run.status === 'running'))
                    throw new EtlError('bad_state', `A ${run.status} run cannot be paused.`, 409)
                return { run, job }
            })
            if (decision instanceof EtlError) return decision
            const { run, job } = decision
            if (job || (etlStore.sharedExecution() && run.status === 'running')) {
                if (!(await updateRunIf(runId, [run.status], { status: 'pausing' }, t))) continue
                if (job) job.control.stopRequested = 'pause'
                await addEvent(runId, 'info', null, 'Pausing after the batches in flight commit.', t)
            } else {
                if (!(await updateRunIf(runId, [run.status], { status: 'paused' }, t))) continue
            }
            return
        }
    })
    return getRun(runId)
}

export async function stopEtlJobs() {
    for (const run of await runsWithStatus(ACTIVE_STATUSES)) {
        if (run.status === 'cancelling' && active.get(run.id)?.control.stopRequested === 'cancel') continue
        try {
            await cancelRun(run.id, { includeInterrupted: true })
        } catch (error) {
            if (error.code !== 'bad_state') throw error
        }
    }
}

export async function cancelRun(runId, { includeInterrupted = false } = {}) {
    await refusableTx(async (t) => {
        for (;;) {
            const decision = await decide(async () => {
                const run = await requireRun(runId, t)
                await fault({ faults: runnerFaults }, 'cancelAfterRead', run, t)
                const job = active.get(runId)
                if (job) refuseFinishing(run)
                else if (
                    !['queued', 'paused', 'failed', 'pausing', 'cancelling'].includes(run.status) &&
                    !((includeInterrupted || etlStore.sharedExecution()) && run.status === 'running')
                ) {
                    throw new EtlError('bad_state', `A ${run.status} run cannot be cancelled.`, 409)
                }
                return { run, job }
            })
            if (decision instanceof EtlError) return decision
            const { run, job } = decision
            if (job || (etlStore.sharedExecution() && ['running', 'pausing', 'cancelling'].includes(run.status))) {
                if (!(await updateRunIf(runId, [run.status], { status: 'cancelling' }, t))) continue
                if (job) {
                    job.control.stopRequested = 'cancel'
                    job.control.abort.abort()
                }
                await addEvent(runId, 'info', null, 'Cancelling after the batches in flight finish.', t)
            } else {
                if (!(await updateRunIf(runId, [run.status], { status: 'cancelled', finishedAt: new Date().toISOString() }, t))) continue
                await addEvent(runId, 'info', null, 'Cancelled. Nothing was deleted.', t)
            }
            return
        }
    })
    return getRun(runId)
}

// Resume continues a paused run, or retries a failed one, from its last checkpoint with the same run id.
export async function resumeRun(runId) {
    return admitted(async () => {
        const { pipelineId } = await requireRun(runId)
        refuseWhileDeleting(pipelineId)
        return etlStore.withPipelineLock(pipelineId, () => resumeUnlocked(runId))
    })
}

// Pause and cancel do not take the pipeline lock, so the read, the checks and the 'queued' write share one transaction:
// a cancel lands wholly before it (and the resume is refused) or wholly after it (and cancels the queued run).
async function resumeUnlocked(runId) {
    await refusableTx(async (t) => {
        for (;;) {
            const run = await decide(async () => {
                const run = await requireRun(runId, t)
                await fault({ faults: runnerFaults }, 'resumeAfterRead', run, t)
                if (!['paused', 'failed'].includes(run.status))
                    throw new EtlError('bad_state', `A ${run.status} run cannot be resumed.`, 409)
                refuseWhileDeleting(run.pipelineId)
                const other = await activeRunFor(run.pipelineId, t)
                if (other && other.id !== runId) throw new EtlError('run_active', `Run ${other.id.slice(0, 8)} is ${other.status}.`, 409)
                return run
            })
            if (run instanceof EtlError) return run
            const fields = { status: 'queued', error: null, attempt: run.status === 'failed' ? run.attempt + 1 : run.attempt }
            if (!(await updateRunIf(runId, [run.status], fields, t))) continue
            await addEvent(
                runId,
                'info',
                null,
                run.status === 'failed' ? 'Retrying from the last checkpoint.' : 'Resuming from the last checkpoint.',
                t
            )
            return
        }
    })
    await pump()
    return getRun(runId)
}

// After a restart nothing is in memory, so runs the database still marks active were interrupted. Each status write
// is conditional on the status read, including when another connection commits a stop during a READ COMMITTED transaction.
export async function resumeInterruptedRuns() {
    const resumed = []
    for (const run of await runsWithStatus(ACTIVE_STATUSES)) {
        const release = etlStore.sharedExecution() ? await etlStore.tryLease('run:' + run.id) : undefined
        if (release === null) continue
        try {
            await etlStore.tx(async (t) => {
                const current = await getRun(run.id, t)
                if (!current || active.has(run.id)) return
                await fault({ faults: runnerFaults }, 'recoveryAfterRead', current, t)
                if (current.status === 'pausing') {
                    if (!(await updateRunIf(run.id, [current.status], { status: 'paused' }, t))) return
                } else if (current.status === 'cancelling') {
                    if (!(await updateRunIf(run.id, [current.status], { status: 'cancelled', finishedAt: new Date().toISOString() }, t)))
                        return
                } else if (current.status === 'running') {
                    if (!(await updateRunIf(run.id, [current.status], { status: 'queued' }, t))) return
                    await addEvent(run.id, 'info', null, 'The server restarted during this run; resuming from the last checkpoint.', t)
                    resumed.push(run.id)
                } else if (current.status === 'queued') {
                    resumed.push(run.id)
                }
            })
        } finally {
            await release?.()
        }
    }
    await pump()
    return resumed
}

export async function waitForRun(runId) {
    if (active.has(runId)) return active.get(runId).promise
    if (!etlStore.sharedExecution()) return getRun(runId)
    // A delete on another replica must wait for the writer to release its lease before removing vectors.
    for (;;) {
        const release = await etlStore.tryLease('run:' + runId)
        if (release) {
            try {
                return await getRun(runId)
            } finally {
                await release()
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
}

export async function waitForIdle() {
    // Guard against a race where the last finishing job schedules a follow-up
    // pump on setImmediate(): yield once when the map looks empty, then recheck.
    for (;;) {
        if (active.size === 0) {
            await new Promise((resolve) => setImmediate(resolve))
            if (active.size === 0) return
        }
        await Promise.all([...active.values()].map((job) => job.promise))
    }
}

async function requireRun(runId, q) {
    const run = await getRun(runId, q)
    if (!run) throw new EtlError('not_found', `Run ${runId} was not found.`, 404)
    return run
}

async function pump() {
    if (etlStore.gate.closed() || runnerStopping() || active.size >= maxActive) return
    for (const run of await runsWithStatus(['queued'])) {
        if (etlStore.gate.closed() || runnerStopping() || active.size >= maxActive) break
        if (active.has(run.id) || deleting.has(run.pipelineId)) continue
        const release = etlStore.sharedExecution() ? await etlStore.tryLease('run:' + run.id) : undefined
        if (release === null) continue
        if (release) {
            try {
                if (active.size >= maxActive || (await getRun(run.id))?.status !== 'queued') {
                    await release()
                    continue
                }
            } catch (error) {
                await release()
                throw error
            }
        }
        launch(run, release)
    }
}

function launch(run, release) {
    const control = { stopRequested: null, abort: new AbortController() }
    const job = { control, promise: null }
    active.set(run.id, job)
    let polling = false
    const poll =
        release &&
        setInterval(async () => {
            if (polling || control.stopRequested === 'cancel') return
            polling = true
            try {
                const current = await getRun(run.id)
                if (current?.status === 'pausing') control.stopRequested = 'pause'
                if (current?.status === 'cancelling') {
                    control.stopRequested = 'cancel'
                    control.abort.abort()
                }
            } catch (error) {
                onError(error, run)
            } finally {
                polling = false
            }
        }, 500)
    poll?.unref()
    job.promise = track(
        Promise.resolve()
            .then(async () => executeRun(run.id, { ctx: (await contextFor(await getPipeline(run.pipelineId))) || {}, control }))
            .catch(async (error) => {
                if (isCrash(error)) return getRun(run.id)
                // Re-read and condition the write so a stop committed even after this read is not overwritten.
                await etlStore.tx(async (t) => {
                    const current = await getRun(run.id, t)
                    await fault({ faults: runnerFaults }, 'launchErrorAfterRead', current, t)
                    if (current?.status === 'queued' || current?.status === 'running') {
                        const applied = await updateRunIf(
                            run.id,
                            [current.status],
                            { status: 'failed', error: errorMessage(error), finishedAt: new Date().toISOString() },
                            t
                        )
                        if (applied) await addEvent(run.id, 'error', null, errorMessage(error), t)
                    }
                    await finishRunStop(run.id, t)
                })
                onError(error, run)
                return getRun(run.id)
            })
            .finally(async () => {
                clearInterval(poll)
                await release?.()
                active.delete(run.id)
                try {
                    await onSettled(run.id)
                } catch (error) {
                    onError(error, run)
                }
                setImmediate(() => pump().catch((error) => onError(error, run)))
            })
    )
}
