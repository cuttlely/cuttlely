import { EtlError, errorMessage } from './errors.mjs'
import { executeRun } from './execute.mjs'
import { isCrash } from './faults.mjs'
import { ACTIVE_STATUSES, activeRunFor, addEvent, getRun, insertRun, normalizeSettings, runsWithStatus, updateRun } from './runs.mjs'
import { getPipeline, latestVersion } from './versions.mjs'

// In-process job runner. This is the queue seam: a later version replaces enqueue() with a job push
// and workers call executeRun(runId); runs, checkpoints and records already live in a database.
const active = new Map()
let contextFor = () => ({})
let maxActive = Math.max(1, Number(process.env.CUTTLELY_ETL_CONCURRENCY) || 1)
let onError = () => {}
let onSettled = () => {}

// The context a run of this pipeline gets (its credentials and node pool), for work outside a run such as a delete.
export async function pipelineContext(pipeline) {
    return (await contextFor(pipeline)) || {}
}

export function configureRunner(options = {}) {
    if (typeof options.contextFor === 'function') contextFor = options.contextFor
    if (Number(options.maxActive) > 0) maxActive = Number(options.maxActive)
    if (typeof options.onError === 'function') onError = options.onError
    if (typeof options.onSettled === 'function') onSettled = options.onSettled
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

export function startRun(pipelineId, { mode = 'incremental', settings = {} } = {}) {
    const pipeline = getPipeline(pipelineId)
    if (!pipeline) throw new EtlError('not_found', 'Save the pipeline before running it.', 404)
    refuseWhileDeleting(pipelineId)
    const version = latestVersion(pipelineId)
    if (!version) throw new EtlError('not_found', 'Save the pipeline before running it.', 404)
    const problems = version.problems?.problems || []
    if (problems.length) throw new EtlError('bad_pipeline', problems.join(' '))
    const running = activeRunFor(pipelineId)
    if (running)
        throw new EtlError('run_active', `Run ${running.id.slice(0, 8)} is still ${running.status}. Pause or cancel it first.`, 409)
    const run = insertRun({
        pipelineId,
        version: version.version,
        mode: mode === 'full' ? 'full' : 'incremental',
        settings: normalizeSettings(settings)
    })
    addEvent(run.id, 'info', null, `Queued ${run.mode} run of version ${run.version}.`)
    pump()
    return getRun(run.id)
}

export function pauseRun(runId) {
    const run = requireRun(runId)
    const job = active.get(runId)
    if (job) {
        job.control.stopRequested = 'pause'
        updateRun(runId, { status: 'pausing' })
        addEvent(runId, 'info', null, 'Pausing after the batches in flight commit.')
    } else if (run.status === 'queued') {
        updateRun(runId, { status: 'paused' })
    } else {
        throw new EtlError('bad_state', `A ${run.status} run cannot be paused.`, 409)
    }
    return getRun(runId)
}

export function cancelRun(runId) {
    const run = requireRun(runId)
    const job = active.get(runId)
    if (job) {
        job.control.stopRequested = 'cancel'
        job.control.abort.abort()
        updateRun(runId, { status: 'cancelling' })
        addEvent(runId, 'info', null, 'Cancelling after the batches in flight finish.')
    } else if (['queued', 'paused', 'failed', 'pausing', 'cancelling'].includes(run.status)) {
        updateRun(runId, { status: 'cancelled', finishedAt: new Date().toISOString() })
        addEvent(runId, 'info', null, 'Cancelled. Nothing was deleted.')
    } else {
        throw new EtlError('bad_state', `A ${run.status} run cannot be cancelled.`, 409)
    }
    return getRun(runId)
}

// Resume continues a paused run, or retries a failed one, from its last checkpoint with the same run id.
export function resumeRun(runId) {
    const run = requireRun(runId)
    if (!['paused', 'failed'].includes(run.status)) throw new EtlError('bad_state', `A ${run.status} run cannot be resumed.`, 409)
    refuseWhileDeleting(run.pipelineId)
    const other = activeRunFor(run.pipelineId)
    if (other && other.id !== runId) throw new EtlError('run_active', `Run ${other.id.slice(0, 8)} is ${other.status}.`, 409)
    updateRun(runId, { status: 'queued', error: null, attempt: run.status === 'failed' ? run.attempt + 1 : run.attempt })
    addEvent(runId, 'info', null, run.status === 'failed' ? 'Retrying from the last checkpoint.' : 'Resuming from the last checkpoint.')
    pump()
    return getRun(runId)
}

// After a restart nothing is in memory, so runs the database still marks active were interrupted.
export function resumeInterruptedRuns() {
    const resumed = []
    for (const run of runsWithStatus(ACTIVE_STATUSES)) {
        if (active.has(run.id)) continue
        if (run.status === 'pausing') updateRun(run.id, { status: 'paused' })
        else if (run.status === 'cancelling') updateRun(run.id, { status: 'cancelled', finishedAt: new Date().toISOString() })
        else {
            if (run.status === 'running') {
                updateRun(run.id, { status: 'queued' })
                addEvent(run.id, 'info', null, 'The server restarted during this run; resuming from the last checkpoint.')
            }
            resumed.push(run.id)
        }
    }
    pump()
    return resumed
}

export function waitForRun(runId) {
    return active.get(runId)?.promise || Promise.resolve(getRun(runId))
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

function requireRun(runId) {
    const run = getRun(runId)
    if (!run) throw new EtlError('not_found', `Run ${runId} was not found.`, 404)
    return run
}

function pump() {
    if (active.size >= maxActive) return
    for (const run of runsWithStatus(['queued'])) {
        if (active.size >= maxActive) break
        if (active.has(run.id) || deleting.has(run.pipelineId)) continue
        launch(run)
    }
}

function launch(run) {
    const control = { stopRequested: null, abort: new AbortController() }
    const job = { control, promise: null }
    active.set(run.id, job)
    job.promise = Promise.resolve()
        .then(async () => executeRun(run.id, { ctx: (await contextFor(getPipeline(run.pipelineId))) || {}, control }))
        .catch((error) => {
            if (isCrash(error)) return getRun(run.id)
            updateRun(run.id, { status: 'failed', error: errorMessage(error), finishedAt: new Date().toISOString() })
            addEvent(run.id, 'error', null, errorMessage(error))
            onError(error, run)
            return getRun(run.id)
        })
        .finally(() => {
            active.delete(run.id)
            try {
                onSettled(run.id)
            } catch (error) {
                onError(error, run)
            }
            setImmediate(pump)
        })
}
