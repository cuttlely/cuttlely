import { assertJobsAllowed, jobsStopped, trackStorageJob } from './side-store-maintenance.mjs'
import { randomUUID } from 'node:crypto'
import { assertHarnessCaller, serializableCaller, serializableNestedFlowCaller } from './caller.mjs'
import { HarnessError } from './errors.mjs'
import { database, immediate, lockTtlMs, turnBusyError } from './lock.mjs'
import { promptImages } from './images.mjs'
import { sessionKey } from './session.mjs'
import { getHarness } from './store.mjs'
import availability from './availability.cjs'
import { nativeToolJournal } from './runtime/native-journal.mjs'
import { admittedAgentEngine, selectAgentEngine } from './runtime/native-prime.mjs'

const localRuns = new Map()
let inlineActive = 0
let workerContextFor = null

// The external worker sets this after it boots the Flowise node pool.
// Inline runs keep the caller's componentNodes and flowOptions in localRuns.
export function setWorkerContext(contextFor) {
    workerContextFor = typeof contextFor === 'function' ? contextFor : null
}

export function queueMode() {
    const raw = String(process.env.CUTTLELY_HARNESS_QUEUE || 'inline')
        .trim()
        .toLowerCase()
    if (raw === 'off' || raw === 'external' || raw === 'inline') return raw
    return 'inline'
}

export function workerConcurrency() {
    const n = Number(process.env.CUTTLELY_HARNESS_WORKER_CONCURRENCY || 4)
    if (!Number.isFinite(n) || n < 1) return 1
    return Math.floor(n)
}

export function jobPayload(args) {
    if (args.mode !== undefined && !['router', 'agent'].includes(args.mode)) {
        throw new HarnessError('bad_mode', 'mode must be "router" or "agent".')
    }
    const flow = args.flowOptions || {}
    if (flow.harnessCaller?.harnessIds !== undefined)
        assertHarnessCaller(args.name, flow.harnessCaller, { requirePin: true, expectedChatflowId: flow.expectedHarnessChatflowId })
    return {
        name: args.name,
        ...(args.mode === 'agent' ? { mode: 'agent' } : {}),
        engine: selectAgentEngine(args.name),
        chatId: args.chatId,
        input: String(args.input ?? ''),
        ...(args.managedUploadReceipts?.length ? { managedUploadReceipts: args.managedUploadReceipts } : {}),
        ...(args.trustedOutputPreview === true ? { trustedOutputPreview: true } : {}),
        budgetMs: args.budgetMs ?? null,
        timeoutMs: args.timeoutMs ?? null,
        offlineModel: args.offlineModel === true,
        callerChatflowId: flow.callerChatflowId || flow.chatflowid || null,
        // Keep the admission pin distinct from the flow that called the harness.
        expectedHarnessChatflowId: flow.expectedHarnessChatflowId ?? null,
        // The worker must not read the team off the harness file. A missing caller stays null and the job is refused.
        workspaceId: typeof flow.workspaceId === 'string' && flow.workspaceId ? flow.workspaceId : null,
        source: args.source || 'prediction',
        // An id the caller already returned, so the run history row is the one it polls.
        runId: typeof args.runId === 'string' && /^run_[A-Za-z0-9-]{8,80}$/.test(args.runId) ? args.runId : null,
        apiKeyId: typeof args.apiKeyId === 'string' && args.apiKeyId ? args.apiKeyId.slice(0, 128) : null,
        // A worker in another process checks the same caller. A job without one is refused there.
        caller: serializableCaller(flow.harnessCaller),
        // The worker rebuilds the in-process flow runner from these plain fields.
        nestedFlowCaller: serializableNestedFlowCaller(flow.nestedFlowCaller || flow.harnessCaller),
        nestedFlowDepth: Number.isInteger(flow.nestedFlowDepth) && flow.nestedFlowDepth >= 0 ? flow.nestedFlowDepth : 0,
        traceId: args.traceId || flow.executionId || null,
        // A worker in another process needs the images too. They are already within the count and size limits.
        images: promptImages(args.images),
        // Run metadata (for a tool run: the agent task and the routed input source) rides with the job too.
        metadata: serializableMetadata(args.metadata)
    }
}

// Router reply deltas are not saved with the job: the router's own text is never stored. Every other event is.
// A waiter in the same process still gets them live; a worker in another process drops them.
export function keepJobEvent(event) {
    return !(event && event.type === 'partial' && event.phase === 'route')
}

const JOB_METADATA_CHARS = 65536

// A plain JSON object within a size cap, or null. A worker in another process reads it back from the payload.
function serializableMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
    try {
        const text = JSON.stringify(metadata)
        return text && text.length <= JOB_METADATA_CHARS ? JSON.parse(text) : null
    } catch {
        return null
    }
}

// The metadata a job runs with: the caller's own object in this process, else the copy saved on the job.
export function jobMetadata(job, local) {
    if (local?.metadata) return local.metadata
    const saved = job?.payload?.metadata
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : undefined
}

// A dead worker stops touching the row. The turn lock expires; this row used to stay `running` and pin the chat.
function reapStaleRunning(db, key, now) {
    const ttl = lockTtlMs()
    if (!ttl) return
    const cutoff = now - (ttl + 15000)
    const stale = db.prepare("SELECT id FROM jobs WHERE session_key = ? AND status = 'running' AND updated_at < ?").all(key, cutoff)
    for (const row of stale) failExpiredWorker(db, row.id, cutoff, now)
}

// Both expiry paths hold the queue transaction while checking the lease and
// reconciling committed call receipts. A refreshed or finished job wins the race.
function failExpiredWorker(db, id, cutoff, now) {
    const expired = db.prepare("SELECT 1 AS ok FROM jobs WHERE id = ? AND status = 'running' AND updated_at < ?").get(id, cutoff)
    if (!expired) return
    const entries = db.prepare('SELECT event FROM job_events WHERE job_id = ? AND event LIKE ? ORDER BY seq').all(id, journalPrefix)
    const calls = new Map()
    for (const row of entries) {
        const entry = JSON.parse(row.event)
        calls.set(entry.callId, entry)
    }
    const pending = [...calls.values()].filter((entry) => entry.phase === 'dispatched')
    for (const entry of pending) appendJobEvent(db, id, { ...entry, phase: 'uncertain' })
    const message =
        'The harness worker stopped before the turn finished.' +
        (pending.length
            ? ' The outcome of ' +
              pending.length +
              ' dispatched tool ' +
              (pending.length === 1 ? 'call' : 'calls') +
              ' could not be confirmed. Check the destination before retrying.'
            : '')
    db.prepare(
        `UPDATE jobs SET status = 'failed', error_code = 'worker_lost', error_message = ?, updated_at = ?,
         payload = ${finishedPayload(db)} WHERE id = ?`
    ).run(message, now, id)
}

// Images and private admission receipts only travel to the consumer. Drop both in
// the same write that marks a job terminal, including a failed worker lease.
function finishedPayload(db) {
    return db.dialect === 'postgres'
        ? "(payload::jsonb - 'images' - 'managedUploadReceipts')::text"
        : "json_remove(payload, '$.images', '$.managedUploadReceipts')"
}

export function enqueueHarnessJob(args) {
    assertJobsAllowed()
    const key = sessionKey(args.name, args.chatId)
    const id = `job_${randomUUID()}`
    const now = Date.now()
    const payload = JSON.stringify(jobPayload(args))
    immediate((db) => {
        db.prepare('DELETE FROM turns WHERE session_key = ? AND expires_at <= ?').run(key, now)
        reapStaleRunning(db, key, now)
        const held = db.prepare('SELECT 1 AS ok FROM turns WHERE session_key = ?').get(key)
        const active = db.prepare(`SELECT 1 AS ok FROM jobs WHERE session_key = ? AND status IN ('queued', 'running')`).get(key)
        if (held || active) throw turnBusyError()
        db.prepare(
            `INSERT INTO jobs (
                id, session_key, status, payload, cancel_requested, created_at, updated_at
             ) VALUES (?, ?, 'queued', ?, 0, ?, ?)`
        ).run(id, key, payload, now, now)
    })
    return { id, sessionKey: key }
}

export function claimJob() {
    if (jobsStopped()) return null
    const now = Date.now()
    const row = immediate((db) => {
        const found = db.prepare(`SELECT id, payload, cancel_requested FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`).get()
        if (!found) return null
        const info = db.prepare(`UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'`).run(now, found.id)
        if (!info.changes) return null
        return found
    })
    if (!row) return null
    return { id: row.id, payload: JSON.parse(row.payload), cancelRequested: row.cancel_requested === 1 }
}

// The coordinator owns the exclusive instance lock and has stopped queue admission.
export function stopQueueJobs(drained) {
    immediate((db) => {
        db.prepare("UPDATE jobs SET cancel_requested=1 WHERE status='running' AND cancel_requested=0").run()
        const statuses = drained ? "('queued','running')" : "('queued')"
        const where = 'status IN ' + statuses
        forgetPayloadImages(db, where)
        db.prepare(
            "UPDATE jobs SET status='cancelled',cancel_requested=1,error_code='aborted',error_message=?,updated_at=? WHERE " + where
        ).run('Stopped for a storage upgrade.', Date.now())
        if (drained) {
            for (const table of ['turns', 'try_profile_turns', 'agent_turns']) {
                if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) db.exec('DELETE FROM ' + table)
            }
        }
    })
}

export function markCancel(id) {
    database()
        .prepare(
            "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND cancel_requested = 0 AND status IN ('queued','running')"
        )
        .run(Date.now(), id)
}

export function cancelRequested(id) {
    const row = database().prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(id)
    return row?.cancel_requested === 1
}

export function touchJob(id) {
    database().prepare(`UPDATE jobs SET updated_at = ? WHERE id = ? AND status = 'running'`).run(Date.now(), id)
}

const journalType = 'nativeToolReceipt'
const journalPrefix = '{"type":"nativeToolReceipt",%'

function appendJobEvent(db, id, event) {
    const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM job_events WHERE job_id = ?').get(id)
    db.prepare('INSERT INTO job_events (job_id, seq, event) VALUES (?, ?, ?)').run(id, Number(row?.seq || 0) + 1, JSON.stringify(event))
}

export function appendEvent(id, event) {
    immediate((db) => {
        appendJobEvent(db, id, event)
        db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    })
}

function recordToolPhase(id, { callId, specialist, name, phase }) {
    immediate((db) => {
        const job = db.prepare('SELECT status, cancel_requested FROM jobs WHERE id = ?').get(id)
        if (job?.status !== 'running') throw new HarnessError('worker_lost', 'The harness job no longer owns this turn.')
        if (phase !== 'confirmed' && job.cancel_requested) throw new HarnessError('aborted', 'Client disconnected')
        appendJobEvent(db, id, { type: journalType, callId, specialist, name, phase })
        db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    })
}

export function readEvents(id, afterSeq) {
    return database()
        .prepare('SELECT seq, event FROM job_events WHERE job_id = ? AND seq > ? AND event NOT LIKE ? ORDER BY seq')
        .all(id, afterSeq, journalPrefix)
        .map((row) => ({ seq: row.seq, event: JSON.parse(row.event) }))
}

export function readJob(id) {
    const row = database()
        .prepare('SELECT id, status, result, error_code, error_message, updated_at, cancel_requested FROM jobs WHERE id = ?')
        .get(id)
    if (!row) return null
    let result = null
    if (row.result) {
        try {
            result = JSON.parse(row.result)
        } catch {
            result = null
        }
    }
    return {
        id: row.id,
        status: row.status,
        result,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        updatedAt: row.updated_at,
        cancelRequested: row.cancel_requested === 1
    }
}

export function finishJob(id, { status, result, errorCode, errorMessage }) {
    let body = null
    if (result != null) {
        try {
            body = JSON.stringify(result)
        } catch {
            body = null
        }
    }
    const db = database()
    db.prepare(
        `UPDATE jobs
         SET status = ?, result = ?, error_code = ?, error_message = ?, updated_at = ?, payload = ${finishedPayload(db)}
         WHERE id = ? AND status IN ('queued', 'running')`
    ).run(status, body, errorCode || null, errorMessage || null, Date.now(), id)
}

function offlineLoadNode(payload) {
    if (payload?.offlineModel !== true || process.env.CUTTLELY_HARNESS_OFFLINE_MODEL !== 'scripted') return undefined
    return async function loadNode() {
        return class OfflineChat {
            async init() {
                return {
                    async invoke(messages) {
                        const first = messages?.[0]
                        const content = typeof first?.content === 'string' ? first.content : ''
                        if (content.includes('You are Harness Prime for')) return { content: 'answer:0|writer' }
                        if (content.includes('You route work')) return { content: '{"steps":[]}' }
                        return { content: 'specialist:ok' }
                    }
                }
            }
        }
    }
}

// The node pool copies workspaceId off the harness file. The job payload is the caller's team.
export function callerFlowOptions(payload, flowOptions) {
    const next = { ...(flowOptions || {}) }
    if (payload?.callerChatflowId && next.callerChatflowId == null) next.callerChatflowId = payload.callerChatflowId
    next.workspaceId = payload?.workspaceId || undefined
    next.harnessCaller = payload?.caller || undefined
    next.expectedHarnessChatflowId = payload?.expectedHarnessChatflowId ?? undefined
    next.nestedFlowCaller = payload?.nestedFlowCaller || undefined
    next.nestedFlowDepth = Number.isInteger(payload?.nestedFlowDepth) && payload.nestedFlowDepth >= 0 ? payload.nestedFlowDepth : 0
    return next
}

async function jobRuntime(job, local) {
    const offline = offlineLoadNode(job.payload)
    if (local?.componentNodes || local?.flowOptions || local?.loadNode) {
        return {
            componentNodes: local.componentNodes,
            loadNode: local.loadNode || offline,
            flowOptions: local.flowOptions
        }
    }
    if (!workerContextFor) {
        const { bootHarnessNodePool } = await import('./node-pool.mjs')
        const booted = await bootHarnessNodePool()
        if (booted?.ready) setWorkerContext(booted.contextFor)
    }
    if (typeof workerContextFor === 'function') {
        const record = getHarness(job.payload.name)
        let runtime = null
        try {
            runtime = record
                ? await workerContextFor(record, {
                      nestedFlowCaller: job.payload.nestedFlowCaller,
                      nestedFlowDepth: job.payload.nestedFlowDepth
                  })
                : null
        } catch (error) {
            console.info(`[harness] worker ${process.pid} node pool context failed (${error?.name || 'Error'})`)
        }
        if (runtime?.componentNodes || runtime?.flowOptions) {
            return {
                componentNodes: runtime.componentNodes,
                loadNode: runtime.loadNode || offline,
                flowOptions: callerFlowOptions(job.payload, runtime.flowOptions)
            }
        }
    }
    return { loadNode: offline, flowOptions: callerFlowOptions(job.payload) }
}

// External workers expose only the job for this exact chat, never another chat on the same team.
export function callerWorkspaceForJob(name, chatId) {
    const flowOptions = callerFlowOptionsForJob(name, chatId)
    return flowOptions === null ? null : flowOptions?.workspaceId
}

export function callerFlowOptionsForJob(name, chatId) {
    if (!name || !chatId) return undefined
    let rows = []
    try {
        rows = database().prepare(`SELECT payload FROM jobs WHERE status = 'running' AND session_key = ?`).all(sessionKey(name, chatId))
    } catch {
        return undefined
    }
    let caller
    for (const row of rows) {
        let payload
        try {
            payload = JSON.parse(row.payload)
        } catch {
            continue
        }
        if (payload?.name !== name || payload?.chatId !== chatId) continue
        // Admission serializes a chat. Conflicting rows cannot choose a principal for a tool call.
        if (caller !== undefined) return null
        caller = callerFlowOptions(payload)
    }
    return caller
}

function savedRunId(row) {
    const id = row && typeof row.id === 'string' ? row.id : ''
    return /^run_[A-Za-z0-9-]{8,80}$/.test(id) ? id : ''
}

function resultWithRunId(result, runId) {
    if (!runId || !result || typeof result !== 'object' || Array.isArray(result)) return result
    return { ...result, runId }
}

export async function executeJob(job) {
    return trackStorageJob(() => executeClaimedJob(job))
}

async function executeClaimedJob(job) {
    const local = localRuns.get(job.id)
    const controller = new AbortController()
    const onLocalAbort = () => {
        markCancel(job.id)
        controller.abort()
    }
    local?.signal?.addEventListener('abort', onLocalAbort)
    const timer = setInterval(() => {
        touchJob(job.id)
        if (cancelRequested(job.id) || local?.signal?.aborted) controller.abort()
    }, 25)
    if (typeof timer.unref === 'function') timer.unref()
    let savedId = ''
    const onRecorded = (row) => {
        const id = savedRunId(row)
        if (id) savedId = id
        local?.onRecorded?.(row)
    }
    const runArgs = {
        name: job.payload.name,
        mode: job.payload.mode,
        // Jobs admitted before engine selection was recorded use the released runtime.
        [admittedAgentEngine]: job.payload.engine ?? 'hermes',
        chatId: job.payload.chatId,
        input: job.payload.input,
        source: local?.source || job.payload.source,
        runId: local?.runId || job.payload.runId || undefined,
        apiKeyId: local?.apiKeyId || job.payload.apiKeyId || undefined,
        traceId: local?.traceId || job.payload.traceId,
        metadata: jobMetadata(job, local),
        onRecorded
    }
    try {
        // No localRuns entry means another process claimed the job. Refuse before runHarness so no history row is written.
        if (!local) {
            const caller = typeof job.payload.workspaceId === 'string' ? job.payload.workspaceId : ''
            const record = getHarness(job.payload.name)
            if (!caller || (record && caller !== (record.workspaceId || ''))) {
                throw new HarnessError('wrong_workspace', `Harness "${job.payload.name}" belongs to another workspace.`)
            }
        }
        const { runHarness, assertHarnessWorkspace, recordCancelledHarnessRun } = await import('./run.mjs')
        assertHarnessWorkspace(job.payload.name, callerFlowOptions(job.payload))
        const cancelBeforeStart = () => {
            if (!job.cancelRequested && !cancelRequested(job.id) && !local?.signal?.aborted) return
            controller.abort()
            recordCancelledHarnessRun(runArgs)
            throw new HarnessError('aborted', 'Client disconnected')
        }
        cancelBeforeStart()
        availability.assertRuntimeAvailable(undefined, runArgs[admittedAgentEngine])
        const runtime = await jobRuntime(job, local)
        cancelBeforeStart()
        // The waiter is another process when the queue is external, so its onRecorded never runs.
        // The saved history id rides on the job result. The waiter reads it and then drops the field.
        const result = await runHarness({
            ...runArgs,
            images: job.payload.images,
            managedUploadReceipts: job.payload.managedUploadReceipts,
            budgetMs: local?.budgetMs ?? job.payload.budgetMs ?? undefined,
            timeoutMs: local?.timeoutMs ?? job.payload.timeoutMs ?? undefined,
            baseUrl: local?.baseUrl,
            fetchImpl: local?.fetchImpl,
            componentNodes: runtime.componentNodes,
            loadNode: runtime.loadNode,
            forceSpecialistFailure: local?.forceSpecialistFailure,
            ...(job.payload.trustedOutputPreview === true ? { trustedOutputPreview: true } : {}),
            modelBaseUrl: local?.modelBaseUrl,
            flowOptions: { ...runtime.flowOptions, [nativeToolJournal]: (entry) => recordToolPhase(job.id, entry) },
            signal: controller.signal,
            // Tracer callbacks exist only in the process that queued the job. A worker elsewhere runs untraced.
            callbacks: local?.callbacks,
            onEvent: (event) => {
                if (keepJobEvent(event)) appendEvent(job.id, event)
                // In this process the waiter's own callback still gets them live, without a saved copy.
                else local?.onEvent?.(event)
            }
        })
        const stored = resultWithRunId(result, savedId)
        finishJob(job.id, { status: 'succeeded', result: stored })
        console.info(`[harness] worker ${process.pid} job ${job.id} ${job.payload.name} succeeded`)
        return stored
    } catch (error) {
        const code = controller.signal.aborted ? 'aborted' : error?.code || 'harness_failed'
        const message = code === 'aborted' ? 'Client disconnected' : error?.message || 'The harness job failed.'
        finishJob(job.id, {
            status: code === 'aborted' ? 'cancelled' : 'failed',
            errorCode: code,
            errorMessage: message,
            result: savedId ? { runId: savedId } : undefined
        })
        console.info(`[harness] worker ${process.pid} job ${job.id} ${job.payload.name} ${code}`)
        throw error
    } finally {
        clearInterval(timer)
        local?.signal?.removeEventListener('abort', onLocalAbort)
        localRuns.delete(job.id)
    }
}

function staleAfter() {
    const ttl = lockTtlMs()
    if (!ttl) return 0
    return ttl + 15000
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// Image bytes only ride to the waiter. Once it has them, the stored row keeps the image names, not the bytes, so
// completed rows do not grow the queue database.
export function forgetJobImageBytes(id, result) {
    const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : []
    if (!artifacts.some((item) => item && typeof item.base64 === 'string')) return
    const lean = {
        ...result,
        artifacts: artifacts.map((item) => (item && typeof item === 'object' ? { ...item, base64: undefined } : item))
    }
    database().prepare('UPDATE jobs SET result = ? WHERE id = ?').run(JSON.stringify(lean), id)
}

export async function waitForJob(id, { onEvent, signal, timeoutMs } = {}) {
    const onAbort = () => markCancel(id)
    signal?.addEventListener('abort', onAbort)
    let seq = 0
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0
    try {
        for (;;) {
            assertJobsAllowed()
            if (signal?.aborted) markCancel(id)
            for (const row of readEvents(id, seq)) {
                seq = row.seq
                onEvent?.(row.event)
            }
            const job = readJob(id)
            if (!job) {
                const { HarnessError } = await import('./errors.mjs')
                throw new HarnessError('not_found', `Harness job ${id} was not found.`)
            }
            if (job.status === 'succeeded') {
                // The worker can write its last events and finish the job between the read above and this one, so
                // read the events once more: the final event carries the run header's token totals.
                for (const row of readEvents(id, seq)) {
                    seq = row.seq
                    onEvent?.(row.event)
                }
                forgetJobImageBytes(id, job.result)
                return job.result
            }
            if (job.status === 'failed' || job.status === 'cancelled') {
                const { HarnessError } = await import('./errors.mjs')
                const error = new HarnessError(job.errorCode || 'harness_failed', job.errorMessage || 'The harness job failed.')
                if (error.code === 'RUNTIME_UNAVAILABLE') Object.assign(error, { statusCode: 503, retryAfterSeconds: 5 })
                const saved = savedRunId({ id: job.result?.runId })
                if (saved) error.runId = saved
                throw error
            }
            const stale = staleAfter()
            if (stale && job.status === 'running' && Date.now() - job.updatedAt > stale) {
                const now = Date.now()
                immediate((db) => failExpiredWorker(db, id, now - stale, now))
                continue
            }
            if (deadline && Date.now() > deadline) {
                markCancel(id)
                const { HarnessError } = await import('./errors.mjs')
                throw new HarnessError('worker_timeout', 'The harness job did not finish before its wait elapsed.')
            }
            await delay(15)
        }
    } finally {
        signal?.removeEventListener('abort', onAbort)
    }
}

function kickInline() {
    if (queueMode() !== 'inline') return
    const limit = workerConcurrency()
    while (inlineActive < limit) {
        const job = claimJob()
        if (!job) return
        inlineActive += 1
        executeJob(job)
            .catch(() => {
                // waitForJob throws the error stored on the job.
            })
            .finally(() => {
                inlineActive -= 1
                kickInline()
            })
    }
}

// Test seam: pause a persisted job before any worker claims it.
export const queueHooks = {
    afterEnqueue: null,
    get localRunCount() {
        return localRuns.size
    }
}

export async function runQueuedHarness(args) {
    // Refused before a job row, the same as a run that does not queue.
    assertHarnessCaller(args?.name, args?.flowOptions?.harnessCaller)
    // Resource ownership precedes availability, including calls that bypass the server.
    const { assertHarnessWorkspace } = await import('./run.mjs')
    assertHarnessWorkspace(args.name, args.flowOptions, args.record)
    availability.assertRuntimeAvailable(undefined, selectAgentEngine(args.name))
    let job
    try {
        job = enqueueHarnessJob(args)
    } catch (error) {
        // A crashed process can leave a queued row. Claiming it here lets that chat accept a later turn.
        if (error?.code === 'busy') kickInline()
        throw error
    }
    if (queueHooks.afterEnqueue) await queueHooks.afterEnqueue(job)
    localRuns.set(job.id, args)
    try {
        kickInline()
        return await waitForJob(job.id, { onEvent: args.onEvent, signal: args.signal, timeoutMs: args.timeoutMs })
    } finally {
        // An external worker cannot remove the waiting process's request context.
        localRuns.delete(job.id)
    }
}

export function startWorkerLoop() {
    let stopped = false
    const finished = (async () => {
        console.info(`[harness] worker ${process.pid} started`)
        while (!stopped) {
            const job = claimJob()
            if (!job) {
                await delay(50)
                continue
            }
            try {
                await executeJob(job)
            } catch {
                // The job row holds the code. The waiter throws it.
            }
        }
        console.info(`[harness] worker ${process.pid} stopped`)
    })()
    return {
        stop() {
            stopped = true
        },
        finished
    }
}
