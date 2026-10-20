export const A2A_RPC_CODES = {
    parse: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
    taskNotFound: -32001,
    taskNotCancelable: -32002,
    pushNotSupported: -32003,
    unsupported: -32004,
    contentType: -32005,
    extendedCard: -32007
} as const

export class A2aRpcError extends Error {
    code: number
    constructor(code: number, message: string) {
        super(message)
        this.name = 'A2aRpcError'
        this.code = code
    }
}

export type JsonRpcId = string | number

export type JsonRpcErrorBody = {
    jsonrpc: '2.0'
    id: JsonRpcId | null
    error: { code: number; message: string }
}

export type JsonRpcResultBody = {
    jsonrpc: '2.0'
    id: JsonRpcId
    result: unknown
}

export const jsonRpcError = (id: JsonRpcId | null, code: number, message: string): JsonRpcErrorBody => ({
    jsonrpc: '2.0',
    id,
    error: { code, message }
})

export const jsonRpcResult = (id: JsonRpcId, result: unknown): JsonRpcResultBody => ({
    jsonrpc: '2.0',
    id,
    result
})

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const isRpcId = (value: unknown): value is JsonRpcId => typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))

export type ParsedEnvelope =
    | { ok: false; id: JsonRpcId | null; method: string | undefined; error: A2aRpcError }
    | { ok: true; id: JsonRpcId; method: string; params: Record<string, unknown> }

export function parseEnvelope(raw: unknown): ParsedEnvelope {
    if (!isPlainObject(raw)) {
        return { ok: false, id: null, method: undefined, error: new A2aRpcError(A2A_RPC_CODES.invalidRequest, 'Invalid Request') }
    }
    const methodName = typeof raw.method === 'string' ? raw.method : undefined
    if (raw.jsonrpc !== '2.0' || typeof raw.method !== 'string' || !isRpcId(raw.id)) {
        return { ok: false, id: null, method: methodName, error: new A2aRpcError(A2A_RPC_CODES.invalidRequest, 'Invalid Request') }
    }
    if (!('params' in raw) || raw.params === undefined || raw.params === null) {
        return { ok: false, id: null, method: methodName, error: new A2aRpcError(A2A_RPC_CODES.invalidRequest, 'Invalid Request') }
    }
    if (!isPlainObject(raw.params)) {
        return {
            ok: false,
            id: raw.id,
            method: methodName,
            error: new A2aRpcError(A2A_RPC_CODES.invalidParams, 'Invalid params')
        }
    }
    return { ok: true, id: raw.id, method: methodName as string, params: raw.params }
}

export function errorResponseId(code: number, parsedId: JsonRpcId | null): JsonRpcId | null {
    if (code === A2A_RPC_CODES.parse || code === A2A_RPC_CODES.invalidRequest) return null
    return parsedId
}

export type ContextSource = 'context' | 'task' | 'ref' | 'new'

export type ParsedMessageParams = {
    question: string
    contextId?: string
    taskId?: string
    referenceTaskIds?: string[]
}

const CONTEXT_MAX = 200

export function parseMessageParams(params: Record<string, unknown>): ParsedMessageParams {
    if (isPlainObject(params.configuration) && 'pushNotificationConfig' in params.configuration) {
        throw new A2aRpcError(A2A_RPC_CODES.pushNotSupported, 'Push notifications are not supported')
    }
    const message = params.message
    if (!isPlainObject(message)) {
        throw new A2aRpcError(A2A_RPC_CODES.invalidParams, 'Invalid params')
    }
    if (message.kind !== 'message' || typeof message.messageId !== 'string' || message.role !== 'user' || !Array.isArray(message.parts)) {
        throw new A2aRpcError(A2A_RPC_CODES.invalidParams, 'Invalid params')
    }
    if ('contextId' in message) {
        if (typeof message.contextId !== 'string' || message.contextId.length < 1 || message.contextId.length > CONTEXT_MAX) {
            throw new A2aRpcError(A2A_RPC_CODES.invalidParams, 'Invalid params')
        }
    }
    const texts: string[] = []
    for (const part of message.parts) {
        if (!isPlainObject(part)) {
            throw new A2aRpcError(A2A_RPC_CODES.invalidParams, 'Invalid params')
        }
        if (part.kind !== 'text') {
            throw new A2aRpcError(A2A_RPC_CODES.contentType, 'Only text parts are supported')
        }
        if (typeof part.text !== 'string') {
            throw new A2aRpcError(A2A_RPC_CODES.invalidParams, 'Invalid params')
        }
        texts.push(part.text)
    }
    if (!texts.length) {
        throw new A2aRpcError(A2A_RPC_CODES.invalidParams, 'Invalid params')
    }
    const question = texts.join('\n')
    if (!question.trim()) {
        throw new A2aRpcError(A2A_RPC_CODES.invalidParams, 'Invalid params')
    }
    const referenceTaskIds = Array.isArray(message.referenceTaskIds)
        ? message.referenceTaskIds.filter((id): id is string => typeof id === 'string')
        : undefined
    return {
        question,
        contextId: typeof message.contextId === 'string' ? message.contextId : undefined,
        taskId: typeof message.taskId === 'string' ? message.taskId : undefined,
        referenceTaskIds
    }
}

export function parseTaskIdParams(params: Record<string, unknown>): string {
    if (typeof params.id !== 'string' || !params.id) {
        throw new A2aRpcError(A2A_RPC_CODES.invalidParams, 'Invalid params')
    }
    return params.id
}

const A2A_LOG_METHODS = new Set([
    'message/send',
    'message/stream',
    'tasks/get',
    'tasks/cancel',
    'tasks/resubscribe',
    'agent/getAuthenticatedExtendedCard'
])

export function a2aLogMethod(method?: string): string {
    if (!method) return '-'
    if (A2A_LOG_METHODS.has(method)) return method
    if (method.startsWith('tasks/pushNotificationConfig')) return 'tasks/pushNotificationConfig'
    return 'unknown'
}

export function methodError(method: string): A2aRpcError | undefined {
    if (method.startsWith('tasks/pushNotificationConfig')) {
        return new A2aRpcError(A2A_RPC_CODES.pushNotSupported, 'Push notifications are not supported')
    }
    if (method === 'tasks/resubscribe') {
        return new A2aRpcError(A2A_RPC_CODES.unsupported, 'Unsupported operation')
    }
    if (method === 'agent/getAuthenticatedExtendedCard') {
        return new A2aRpcError(A2A_RPC_CODES.extendedCard, 'Authenticated extended card is not configured')
    }
    if (method !== 'message/send' && method !== 'message/stream' && method !== 'tasks/get' && method !== 'tasks/cancel') {
        return new A2aRpcError(A2A_RPC_CODES.methodNotFound, 'Method not found')
    }
    return undefined
}

export function failedStatusText(code: string): string {
    return `The flow could not finish (code ${code}).`
}

export function humanInputStatusText(): string {
    return 'This flow needs human input, which this endpoint does not support (code human_input_unsupported).'
}
