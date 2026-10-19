import { randomUUID } from 'crypto'

export const A2A_TASK_TTL_MS = 60 * 60 * 1000
export const A2A_TASK_CAP_PER_FLOW = 1000
export const A2A_HISTORY_TASK_LIMIT = 20

export const A2A_FINAL_STATES = new Set(['completed', 'failed', 'canceled'])

export class TaskStoreFullError extends Error {
    constructor() {
        super('Too many open tasks for this flow')
        this.name = 'TaskStoreFullError'
    }
}

export type A2aTaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled'

export type A2aTextPart = { kind: 'text'; text: string }

export type A2aMessage = {
    kind: 'message'
    messageId: string
    role: 'agent'
    parts: A2aTextPart[]
    taskId: string
    contextId: string
}

export type A2aArtifact = {
    artifactId: string
    name: string
    parts: A2aTextPart[]
}

export type A2aTaskStatus = {
    state: A2aTaskState
    timestamp: string
    message?: A2aMessage
}

export type A2aTask = {
    kind: 'task'
    id: string
    contextId: string
    status: A2aTaskStatus
    artifacts?: A2aArtifact[]
}

export type A2aStoredTask = {
    flowId: string
    caller: string
    chatId: string
    contextId: string
    question: string
    answer?: string
    artifactId: string
    task: A2aTask
    cancelRequested: boolean
    createdAt: number
    updatedAt: number
}

const store = new Map<string, A2aStoredTask>()

const keyOf = (flowId: string, caller: string, taskId: string) => `${flowId}|${caller}|${taskId}`

export function a2aCallerKey(flow: { id: string; apikeyid?: string | null }): string {
    return typeof flow.apikeyid === 'string' && flow.apikeyid ? `key:${flow.apikeyid}` : `public:${flow.id}`
}

export function isoNow(at = Date.now()): string {
    return new Date(at).toISOString()
}

const isExpired = (row: A2aStoredTask, now: number) => now - row.updatedAt > A2A_TASK_TTL_MS

const sweepExpired = (now = Date.now()) => {
    for (const [key, row] of store) {
        if (isExpired(row, now)) store.delete(key)
    }
}

const tasksForFlow = (flowId: string): A2aStoredTask[] => {
    const rows: A2aStoredTask[] = []
    for (const row of store.values()) {
        if (row.flowId === flowId) rows.push(row)
    }
    return rows
}

const evictOldestFinal = (flowId: string): boolean => {
    let oldest: A2aStoredTask | undefined
    for (const row of tasksForFlow(flowId)) {
        if (!A2A_FINAL_STATES.has(row.task.status.state)) continue
        if (!oldest || row.createdAt < oldest.createdAt || (row.createdAt === oldest.createdAt && row.updatedAt < oldest.updatedAt)) {
            oldest = row
        }
    }
    if (!oldest) return false
    store.delete(keyOf(oldest.flowId, oldest.caller, oldest.task.id))
    return true
}

export function createA2aTask(input: {
    flowId: string
    caller: string
    chatId: string
    contextId: string
    question: string
    now?: number
}): A2aStoredTask {
    const now = input.now ?? Date.now()
    sweepExpired(now)
    let rows = tasksForFlow(input.flowId)
    if (rows.length >= A2A_TASK_CAP_PER_FLOW) {
        evictOldestFinal(input.flowId)
        rows = tasksForFlow(input.flowId)
    }
    if (rows.length >= A2A_TASK_CAP_PER_FLOW) {
        throw new TaskStoreFullError()
    }
    const id = randomUUID()
    const artifactId = randomUUID()
    const row: A2aStoredTask = {
        flowId: input.flowId,
        caller: input.caller,
        chatId: input.chatId,
        contextId: input.contextId,
        question: input.question,
        artifactId,
        cancelRequested: false,
        createdAt: now,
        updatedAt: now,
        task: {
            kind: 'task',
            id,
            contextId: input.contextId,
            status: { state: 'submitted', timestamp: isoNow(now) }
        }
    }
    store.set(keyOf(input.flowId, input.caller, id), row)
    return row
}

export function removeA2aTask(flowId: string, caller: string, taskId: string): void {
    store.delete(keyOf(flowId, caller, taskId))
}

export function getA2aTask(flowId: string, caller: string, taskId: string, now = Date.now()): A2aStoredTask | undefined {
    sweepExpired(now)
    const row = store.get(keyOf(flowId, caller, taskId))
    if (!row || isExpired(row, now)) {
        if (row) store.delete(keyOf(flowId, caller, taskId))
        return undefined
    }
    return row
}

export function findA2aTask(flowId: string, caller: string, taskId: string, now = Date.now()): A2aStoredTask | undefined {
    return getA2aTask(flowId, caller, taskId, now)
}

const writeStatus = (
    row: A2aStoredTask,
    status: A2aTaskStatus,
    extra?: { answer?: string; artifacts?: A2aArtifact[] },
    now = Date.now()
): boolean => {
    if (A2A_FINAL_STATES.has(row.task.status.state)) return false
    row.task.status = status
    if (status.state === 'completed' && extra?.artifacts) row.task.artifacts = extra.artifacts
    else if (status.state !== 'working' && status.state !== 'submitted') delete row.task.artifacts
    if (extra?.answer !== undefined) row.answer = extra.answer
    row.updatedAt = now
    store.set(keyOf(row.flowId, row.caller, row.task.id), row)
    return true
}

export function markA2aWorking(row: A2aStoredTask, now = Date.now()): boolean {
    return writeStatus(row, { state: 'working', timestamp: isoNow(now) }, undefined, now)
}

export function finalizeA2aTask(
    row: A2aStoredTask,
    status: A2aTaskStatus,
    extra?: { answer?: string; artifacts?: A2aArtifact[] },
    now = Date.now()
): A2aStoredTask {
    writeStatus(row, status, extra, now)
    return row
}

export function requestA2aCancel(
    flowId: string,
    caller: string,
    taskId: string,
    now = Date.now()
): { ok: true; row: A2aStoredTask } | { ok: false; reason: 'not_found' | 'not_cancelable' } {
    const row = getA2aTask(flowId, caller, taskId, now)
    if (!row) return { ok: false, reason: 'not_found' }
    if (A2A_FINAL_STATES.has(row.task.status.state)) return { ok: false, reason: 'not_cancelable' }
    row.cancelRequested = true
    writeStatus(row, { state: 'canceled', timestamp: isoNow(now) }, undefined, now)
    return { ok: true, row }
}

export function listCompletedHistory(
    flowId: string,
    caller: string,
    contextId: string,
    now = Date.now()
): Array<{ question: string; answer: string }> {
    sweepExpired(now)
    const rows = [...store.values()]
        .filter(
            (row) =>
                row.flowId === flowId &&
                row.caller === caller &&
                row.contextId === contextId &&
                row.task.status.state === 'completed' &&
                typeof row.answer === 'string'
        )
        .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt)
    const last = rows.slice(-A2A_HISTORY_TASK_LIMIT)
    return last.map((row) => ({ question: row.question, answer: row.answer as string }))
}

export function resetA2aTaskStore(): void {
    store.clear()
}

/** Test helper: insert a stored task without the 1-hour TTL clock moving. */
export function insertA2aTaskForTests(row: A2aStoredTask): void {
    store.set(keyOf(row.flowId, row.caller, row.task.id), row)
}

/** Test helper: snapshot of every stored task. */
export function listA2aTasksForTests(): A2aStoredTask[] {
    return [...store.values()]
}

export const a2aTaskStore = {
    create: createA2aTask,
    get: getA2aTask,
    find: findA2aTask,
    markWorking: markA2aWorking,
    finalize: finalizeA2aTask,
    requestCancel: requestA2aCancel,
    listCompletedHistory,
    remove: removeA2aTask,
    reset: resetA2aTaskStore,
    callerKey: a2aCallerKey
}
