import { randomUUID } from 'crypto'

export const A2A_TASK_TTL_MS = 60 * 60 * 1000
export const A2A_TASK_CAP_PER_FLOW = 1000
export const A2A_HISTORY_TASK_LIMIT = 20
export const A2A_TASK_TEXT_MAX_BYTES_DEFAULT = 65536
export const A2A_TASK_BYTES_PER_FLOW_DEFAULT = 64 * 1024 * 1024
export const A2A_ANSWER_TRUNCATE_MARK = '\n[truncated]'
export const A2A_TASK_TEXT_MAX_BYTES_MIN = Buffer.byteLength(A2A_ANSWER_TRUNCATE_MARK, 'utf8')

export const A2A_FINAL_STATES = new Set(['completed', 'failed', 'canceled'])

export class TaskStoreFullError extends Error {
    constructor() {
        super('Too many open tasks for this flow')
        this.name = 'TaskStoreFullError'
    }
}

export class TaskQuestionTooLargeError extends Error {
    readonly limit: number
    constructor(limit: number) {
        super(`Question exceeds the ${limit}-byte store limit`)
        this.name = 'TaskQuestionTooLargeError'
        this.limit = limit
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
    storedBytes: number
}

const store = new Map<string, A2aStoredTask>()
const flowBytes = new Map<string, number>()

const keyOf = (flowId: string, caller: string, taskId: string) => `${flowId}|${caller}|${taskId}`

export function a2aCallerKey(flow: { id: string; apikeyid?: string | null }): string {
    return typeof flow.apikeyid === 'string' && flow.apikeyid ? `key:${flow.apikeyid}` : `public:${flow.id}`
}

export function isoNow(at = Date.now()): string {
    return new Date(at).toISOString()
}

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
    if (raw == null || String(raw).trim() === '') return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) return fallback
    return n
}

export function a2aTaskTextMaxBytes(): number {
    const n = parsePositiveInt(process.env.A2A_TASK_TEXT_MAX_BYTES, A2A_TASK_TEXT_MAX_BYTES_DEFAULT)
    if (n < A2A_TASK_TEXT_MAX_BYTES_MIN) return A2A_TASK_TEXT_MAX_BYTES_DEFAULT
    return n
}

export function a2aTaskBytesPerFlow(): number {
    return parsePositiveInt(process.env.A2A_TASK_BYTES_PER_FLOW, A2A_TASK_BYTES_PER_FLOW_DEFAULT)
}

export function a2aTaskCapPerFlow(): number {
    return parsePositiveInt(process.env.A2A_TASK_CAP_PER_FLOW, A2A_TASK_CAP_PER_FLOW)
}

export function utf8Bytes(text: string | undefined): number {
    return text ? Buffer.byteLength(text, 'utf8') : 0
}

const truncateUtf8 = (text: string, maxBytes: number): string => {
    if (maxBytes <= 0) return ''
    const buf = Buffer.from(text, 'utf8')
    if (buf.length <= maxBytes) return text
    let end = maxBytes
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
    return buf.toString('utf8', 0, end)
}

export function truncateA2aStoredAnswer(text: string, maxBytes = a2aTaskTextMaxBytes()): string {
    const size = utf8Bytes(text)
    if (size <= maxBytes) return text
    const mark = A2A_ANSWER_TRUNCATE_MARK
    const markBytes = utf8Bytes(mark)
    if (maxBytes < markBytes) return ''
    return `${truncateUtf8(text, maxBytes - markBytes)}${mark}`
}

const statusMessageText = (row: A2aStoredTask): string | undefined => {
    const parts = row.task.status.message?.parts
    const text = parts?.[0]?.text
    return typeof text === 'string' ? text : undefined
}

export function measureA2aStoredTask(row: A2aStoredTask): number {
    return utf8Bytes(row.question) + utf8Bytes(row.answer) + utf8Bytes(statusMessageText(row))
}

export function a2aFlowStoredBytes(flowId: string): number {
    return flowBytes.get(flowId) ?? 0
}

const addFlowBytes = (flowId: string, delta: number): void => {
    const next = (flowBytes.get(flowId) ?? 0) + delta
    if (next <= 0) flowBytes.delete(flowId)
    else flowBytes.set(flowId, next)
}

const rememberBytes = (row: A2aStoredTask): void => {
    const next = measureA2aStoredTask(row)
    addFlowBytes(row.flowId, next - row.storedBytes)
    row.storedBytes = next
}

const forget = (row: A2aStoredTask): void => {
    store.delete(keyOf(row.flowId, row.caller, row.task.id))
    addFlowBytes(row.flowId, -row.storedBytes)
    row.storedBytes = 0
}

const isExpired = (row: A2aStoredTask, now: number) => now - row.updatedAt > A2A_TASK_TTL_MS

const sweepExpired = (now = Date.now()) => {
    for (const row of [...store.values()]) {
        if (isExpired(row, now)) forget(row)
    }
}

const tasksForFlow = (flowId: string): A2aStoredTask[] => {
    const rows: A2aStoredTask[] = []
    for (const row of store.values()) {
        if (row.flowId === flowId) rows.push(row)
    }
    return rows
}

const isOlder = (a: A2aStoredTask, b: A2aStoredTask): boolean =>
    a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.updatedAt < b.updatedAt)

const evictOldestMatching = (flowId: string, match: (row: A2aStoredTask) => boolean): boolean => {
    let oldest: A2aStoredTask | undefined
    for (const row of tasksForFlow(flowId)) {
        if (!match(row)) continue
        if (!oldest || isOlder(row, oldest)) oldest = row
    }
    if (!oldest) return false
    forget(oldest)
    return true
}

const evictOldestFinal = (flowId: string): boolean => evictOldestMatching(flowId, (row) => A2A_FINAL_STATES.has(row.task.status.state))

const evictOldestCompleted = (flowId: string, keepId?: string): boolean =>
    evictOldestMatching(flowId, (row) => row.task.status.state === 'completed' && row.task.id !== keepId)

const makeRoomFor = (flowId: string, extraBytes: number, keepId?: string): void => {
    const budget = a2aTaskBytesPerFlow()
    while (a2aFlowStoredBytes(flowId) + extraBytes > budget) {
        if (!evictOldestCompleted(flowId, keepId)) break
    }
}

const remainingBytesForRow = (row: A2aStoredTask): number => {
    const others = a2aFlowStoredBytes(row.flowId) - row.storedBytes
    return Math.max(0, a2aTaskBytesPerFlow() - others)
}

const clampAnswerToRemainingBudget = (row: A2aStoredTask): void => {
    if (row.answer === undefined) return
    const overhead = utf8Bytes(row.question) + utf8Bytes(statusMessageText(row))
    const answerRoom = Math.max(0, remainingBytesForRow(row) - overhead)
    if (utf8Bytes(row.answer) <= answerRoom) return
    row.answer = truncateA2aStoredAnswer(row.answer, answerRoom)
}

export function a2aPublicTask(row: A2aStoredTask): A2aTask {
    const task: A2aTask = {
        kind: 'task',
        id: row.task.id,
        contextId: row.contextId,
        status: row.task.status
    }
    if (row.task.status.state === 'completed' && typeof row.answer === 'string') {
        task.artifacts = [
            {
                artifactId: row.artifactId,
                name: 'answer',
                parts: [{ kind: 'text', text: row.answer }]
            }
        ]
    }
    return task
}

export function createA2aTask(input: {
    flowId: string
    caller: string
    chatId: string
    contextId: string
    question: string
    now?: number
}): A2aStoredTask {
    const limit = a2aTaskTextMaxBytes()
    if (utf8Bytes(input.question) > limit) {
        throw new TaskQuestionTooLargeError(limit)
    }
    const now = input.now ?? Date.now()
    sweepExpired(now)
    const cap = a2aTaskCapPerFlow()
    let rows = tasksForFlow(input.flowId)
    if (rows.length >= cap) {
        evictOldestFinal(input.flowId)
        rows = tasksForFlow(input.flowId)
    }
    if (rows.length >= cap) {
        throw new TaskStoreFullError()
    }
    const extraBytes = utf8Bytes(input.question)
    makeRoomFor(input.flowId, extraBytes)
    if (a2aFlowStoredBytes(input.flowId) + extraBytes > a2aTaskBytesPerFlow()) {
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
        storedBytes: 0,
        task: {
            kind: 'task',
            id,
            contextId: input.contextId,
            status: { state: 'submitted', timestamp: isoNow(now) }
        }
    }
    store.set(keyOf(input.flowId, input.caller, id), row)
    rememberBytes(row)
    return row
}

export function removeA2aTask(flowId: string, caller: string, taskId: string): void {
    const row = store.get(keyOf(flowId, caller, taskId))
    if (row) forget(row)
}

export function getA2aTask(flowId: string, caller: string, taskId: string, now = Date.now()): A2aStoredTask | undefined {
    sweepExpired(now)
    const row = store.get(keyOf(flowId, caller, taskId))
    if (!row || isExpired(row, now)) {
        if (row) forget(row)
        return undefined
    }
    return row
}

export function findA2aTask(flowId: string, caller: string, taskId: string, now = Date.now()): A2aStoredTask | undefined {
    return getA2aTask(flowId, caller, taskId, now)
}

const writeStatus = (row: A2aStoredTask, status: A2aTaskStatus, extra?: { answer?: string }, now = Date.now()): boolean => {
    if (A2A_FINAL_STATES.has(row.task.status.state)) return false
    row.task.status = status
    delete row.task.artifacts
    if (extra?.answer !== undefined) row.answer = truncateA2aStoredAnswer(extra.answer)
    row.updatedAt = now
    makeRoomFor(row.flowId, Math.max(0, measureA2aStoredTask(row) - row.storedBytes), row.task.id)
    clampAnswerToRemainingBudget(row)
    rememberBytes(row)
    if (a2aFlowStoredBytes(row.flowId) > a2aTaskBytesPerFlow() && A2A_FINAL_STATES.has(row.task.status.state)) {
        forget(row)
        return true
    }
    store.set(keyOf(row.flowId, row.caller, row.task.id), row)
    return true
}

export function markA2aWorking(row: A2aStoredTask, now = Date.now()): boolean {
    return writeStatus(row, { state: 'working', timestamp: isoNow(now) }, undefined, now)
}

export function finalizeA2aTask(row: A2aStoredTask, status: A2aTaskStatus, extra?: { answer?: string }, now = Date.now()): A2aStoredTask {
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
    flowBytes.clear()
}

/** Test helper: insert a stored task without the 1-hour TTL clock moving. */
export function insertA2aTaskForTests(row: Omit<A2aStoredTask, 'storedBytes'> & { storedBytes?: number }): void {
    const stored: A2aStoredTask = { ...row, storedBytes: 0, task: { ...row.task } }
    delete stored.task.artifacts
    store.set(keyOf(stored.flowId, stored.caller, stored.task.id), stored)
    rememberBytes(stored)
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
    callerKey: a2aCallerKey,
    publicTask: a2aPublicTask
}
