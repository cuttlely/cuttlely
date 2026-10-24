import { randomUUID } from 'node:crypto'
import { assertHarnessCaller, serializableCaller } from './caller.mjs'
import { HarnessError } from './errors.mjs'
import { database, immediate, lockTtlMs, turnBusyError } from './lock.mjs'
import { promptImages } from './images.mjs'
import { sessionKey } from './session.mjs'
import { getHarness } from './store.mjs'

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

function jobPayload(args) {
    const flow = args.flowOptions || {}
    return {
        name: args.name,
        chatId: args.chatId,
        input: String(args.input ?? ''),
        budgetMs: args.budgetMs ?? null,
        timeoutMs: args.timeoutMs ?? null,
        offlineModel: args.offlineModel === true,
        callerChatflowId: flow.callerChatflowId || flow.chatflowid || null,
        // The worker must not read the team off the harness file. A missing caller stays null and the job is refused.
        workspaceId: typeof flow.workspaceId === 'string' && flow.workspaceId ? flow.workspaceId : null,
        source: args.source || 'prediction',
        // An id the caller already returned, so the run history row is the one it polls.
        runId: typeof args.runId === 'string' && /^run_[A-Za-z0-9-]{8,80}$/.test(args.runId) ? args.runId : null,
        apiKeyId: typeof args.apiKeyId === 'string' && args.apiKeyId ? args.apiKeyId.slice(0, 128) : null,
        // A worker in another process checks the same caller. A job without one is refused there.
        caller: serializableCaller(flow.harnessCaller),
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
    db.prepare(
        `UPDATE jobs
         SET status = 'failed', error_code = 'worker_lost', error_message = ?, updated_at = ?
         WHERE session_key = ? AND status = 'running' AND updated_at < ?`
    ).run('The harness worker stopped before the turn finished.', now, key, cutoff)
    forgetPayloadImages(db, `session_key = ? AND status = 'failed' AND error_code = 'worker_lost'`, key)
}

// Attached images only ride to the worker. A finished row drops them, so the queue database does not keep people's
// pictures or grow with every image turn.
function forgetPayloadImages(db, where, ...params) {
    db.prepare(
        `UPDATE jobs SET payload = json_remove(payload, '$.images')
         WHERE ${where} AND json_array_length(payload, '$.images') > 0`
    ).run(...params)
}

export function enqueueHarnessJob(args) {
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

export function markCancel(id) {
    database().prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(Date.now(), id)
}

export function cancelRequested(id) {
    const row = database().prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(id)
    return row?.cancel_requested === 1
}

export function touchJob(id) {
    database().prepare(`UPDATE jobs SET updated_at = ? WHERE id = ? AND status = 'running'`).run(Date.now(), id)
}

export function appendEvent(id, event) {
    const body = JSON.stringify(event)
    immediate((db) => {
        const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM job_events WHERE job_id = ?').get(id)
        db.prepare('INSERT INTO job_events (job_id, seq, event) VALUES (?, ?, ?)').run(id, Number(row?.seq || 0) + 1, body)
        db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    })
}

export function readEvents(id, afterSeq) {
    return database()
        .prepare('SELECT seq, event FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq')
        .all(id, afterSeq)
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
         SET status = ?, result = ?, error_code = ?, error_message = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`
    ).run(status, body, errorCode || null, errorMessage || null, Date.now(), id)
    forgetPayloadImages(db, `id = ? AND status NOT IN ('queued', 'running')`, id)
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
function callerFlowOptions(payload, flowOptions) {
    const next = { ...(flowOptions || {}) }
    if (payload?.callerChatflowId && next.callerChatflowId == null) next.callerChatflowId = payload.callerChatflowId
    next.workspaceId = payload?.workspaceId || undefined
    next.harnessCaller = payload?.caller || undefined
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
            runtime = record ? await workerContextFor(record) : null
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

// A running external job is the caller's team for the gateway, which otherwise only sees the harness file.
export function callerWorkspaceForJob(name) {
    let rows = []
    try {
        rows = database().prepare(`SELECT payload FROM jobs WHERE status = 'running'`).all()
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
        if (payload?.name !== name) continue
        const next = typeof payload.workspaceId === 'string' ? payload.workspaceId : ''
        if (caller === undefined) caller = next
        else if (caller !== next) return null
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
    if (cancelRequested(job.id) || job.cancelRequested) {
        finishJob(job.id, { status: 'cancelled', errorCode: 'aborted', errorMessage: 'Client disconnected' })
        return
    }
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
    try {
        // No localRuns entry means another process claimed the job. Refuse before runHarness so no history row is written.
        if (!local) {
            const caller = typeof job.payload.workspaceId === 'string' ? job.payload.workspaceId : ''
            const record = getHarness(job.payload.name)
            if (!caller || (record && caller !== (record.workspaceId || ''))) {
                throw new HarnessError('wrong_workspace', `Harness "${job.payload.name}" belongs to another workspace.`)
            }
        }
        const { runHarness } = await import('./run.mjs')
        const runtime = await jobRuntime(job, local)
        // The waiter is another process when the queue is external, so its onRecorded never runs.
        // The saved history id rides on the job result. The waiter reads it and then drops the field.
        const result = await runHarness({
            name: job.payload.name,
            chatId: job.payload.chatId,
            input: job.payload.input,
            images: job.payload.images,
            source: local?.source || job.payload.source,
            runId: local?.runId || job.payload.runId || undefined,
            apiKeyId: local?.apiKeyId || job.payload.apiKeyId || undefined,
            traceId: local?.traceId || job.payload.traceId,
            onRecorded: (row) => {
                const id = savedRunId(row)
                if (id) savedId = id
                local?.onRecorded?.(row)
            },
            budgetMs: local?.budgetMs ?? job.payload.budgetMs ?? undefined,
            timeoutMs: local?.timeoutMs ?? job.payload.timeoutMs ?? undefined,
            baseUrl: local?.baseUrl,
            fetchImpl: local?.fetchImpl,
            componentNodes: runtime.componentNodes,
            loadNode: runtime.loadNode,
            forceSpecialistFailure: local?.forceSpecialistFailure,
            metadata: jobMetadata(job, local),
            modelBaseUrl: local?.modelBaseUrl,
            flowOptions: runtime.flowOptions,
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
                const saved = savedRunId({ id: job.result?.runId })
                if (saved) error.runId = saved
                throw error
            }
            const stale = staleAfter()
            if (stale && job.status === 'running' && Date.now() - job.updatedAt > stale) {
                finishJob(id, {
                    status: 'failed',
                    errorCode: 'worker_lost',
                    errorMessage: 'The harness worker stopped before the turn finished.'
                })
                const { HarnessError } = await import('./errors.mjs')
                throw new HarnessError('worker_lost', 'The harness worker stopped before the turn finished.')
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

export async function runQueuedHarness(args) {
    // Refused before a job row, the same as a run that does not queue.
    assertHarnessCaller(args?.name, args?.flowOptions?.harnessCaller)
    let job
    try {
        job = enqueueHarnessJob(args)
    } catch (error) {
        // A crashed process can leave a queued row. Claiming it here lets that chat accept a later turn.
        if (error?.code === 'busy') kickInline()
        throw error
    }
    localRuns.set(job.id, args)
    kickInline()
    return waitForJob(job.id, { onEvent: args.onEvent, signal: args.signal, timeoutMs: args.timeoutMs })
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
