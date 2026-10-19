import { randomUUID } from 'crypto'
import { Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { MODE } from '../../Interface'
import { onAbort, watchClientDisconnect } from '../../utils/clientAbort'
import { ExternalAgentError } from '../../utils/externalAgentAuth'
import { threadChatId, threadLogHash } from '../../utils/externalThread'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { errorEventDetails } from '../../utils/predictionErrors'
import { bindRequestSession } from '../../utils/sessionOwnership'
import { SSEEncoder } from '../../utils/SSEStreamer'
import predictionsServices from '../../services/predictions'
import { waitingForApproval } from '../../services/usage'
import { answerText } from '../../services/orchestrate/completion'
import { flowHasMemory } from '../../services/orchestrate/mapRequest'
import { a2aSseData, makeA2aEncoder, silentA2aEncoder } from './a2aEncoder'
import {
    A2A_RPC_CODES,
    A2aRpcError,
    ContextSource,
    JsonRpcId,
    failedStatusText,
    humanInputStatusText,
    jsonRpcResult,
    parseMessageParams
} from './rpc'
import { A2aMessage, A2aStoredTask, A2aTask, a2aCallerKey, a2aTaskStore, isoNow } from './taskStore'

export type A2aLogState = {
    method: string
    stream: boolean
    ctxSrc: ContextSource | '-'
    context: string
    rpc: string
}

export const emptyA2aLog = (): A2aLogState => ({
    method: '-',
    stream: false,
    ctxSrc: '-',
    context: '-',
    rpc: '-'
})

const stripClientSession = (req: Request): void => {
    delete req.headers['x-cuttlely-session-token']
    delete req.headers['cookie']
    ;(req as Request & { cookies?: Record<string, unknown> }).cookies = {}
}

const noopSink = {
    write: () => true,
    flushHeaders: () => undefined,
    end: () => undefined,
    writableEnded: false,
    destroyed: false
} as unknown as Response

const writeIfOpen = (res: Response, chunk: string): void => {
    if (res.writableEnded || res.destroyed) return
    try {
        res.write(chunk)
    } catch {
        // Client already disconnected.
    }
}

export function agentStatusMessage(taskId: string, contextId: string, text: string): A2aMessage {
    return {
        kind: 'message',
        messageId: randomUUID(),
        role: 'agent',
        taskId,
        contextId,
        parts: [{ kind: 'text', text }]
    }
}

export function isHumanInputResult(result: unknown): boolean {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false
    return waitingForApproval((result as { action?: unknown }).action)
}

export function resolveContext(input: {
    flow: { id: string; apikeyid?: string | null }
    caller: string
    parsed: ReturnType<typeof parseMessageParams>
}): { contextId: string; ctxSrc: ContextSource } {
    if (input.parsed.contextId) return { contextId: input.parsed.contextId, ctxSrc: 'context' }
    if (input.parsed.taskId) {
        const named = a2aTaskStore.get(input.flow.id, input.caller, input.parsed.taskId)
        if (named) return { contextId: named.contextId, ctxSrc: 'task' }
    }
    if (input.parsed.referenceTaskIds) {
        for (const id of input.parsed.referenceTaskIds) {
            const named = a2aTaskStore.get(input.flow.id, input.caller, id)
            if (named) return { contextId: named.contextId, ctxSrc: 'ref' }
        }
    }
    return { contextId: randomUUID(), ctxSrc: 'new' }
}

const storedCanceled = (row: A2aStoredTask) => row.cancelRequested || row.task.status.state === 'canceled'

const clientGone = (signal: AbortSignal | undefined) => Boolean(signal?.aborted)

const historyFor = (flow: { id: string; apikeyid?: string | null; flowData?: string | null }, caller: string, contextId: string) => {
    if (flowHasMemory(flow)) return undefined
    const rows = a2aTaskStore.listCompletedHistory(flow.id, caller, contextId)
    if (!rows.length) return undefined
    const history: Array<{ role: 'userMessage' | 'apiMessage'; content: string }> = []
    for (const row of rows) {
        history.push({ role: 'userMessage', content: row.question })
        history.push({ role: 'apiMessage', content: row.answer })
    }
    return history
}

async function abortRunning(flowId: string, chatId: string): Promise<void> {
    const id = `${flowId}_${chatId}`
    const appServer = getRunningExpressApp()
    if (process.env.MODE === MODE.QUEUE) {
        await appServer.queueManager.getPredictionQueueEventsProducer().publishEvent({ eventName: 'abort', id })
        return
    }
    appServer.abortControllerPool.abort(id)
}

export async function cancelStoredTask(flowId: string, caller: string, taskId: string): Promise<A2aTask> {
    const result = a2aTaskStore.requestCancel(flowId, caller, taskId)
    if (!result.ok) {
        if (result.reason === 'not_found') throw new A2aRpcError(A2A_RPC_CODES.taskNotFound, 'Task not found')
        throw new A2aRpcError(A2A_RPC_CODES.taskNotCancelable, 'Task cannot be canceled')
    }
    await abortRunning(flowId, result.row.chatId)
    return result.row.task
}

const bindRun = (
    req: Request,
    res: Response,
    chatflow: { id: string; apikeyid?: string | null; flowData?: string | null },
    body: {
        question: string
        history?: Array<{ role: 'userMessage' | 'apiMessage'; content: string }>
        streaming: boolean
        chatId: string
        sessionToken: string
    }
) => {
    stripClientSession(req)
    req.body = { ...body }
    req.headers['x-cuttlely-session-token'] = body.sessionToken
    res.cookie = (() => res) as typeof res.cookie
    const owned = bindRequestSession(req, { chatflow, isInternal: false })
    ;(req.body as { sessionToken?: string }).sessionToken = body.sessionToken
    res.removeHeader('Set-Cookie')
    return owned
}

type RunOutcome = { kind: 'canceled' } | { kind: 'disconnected' } | { kind: 'failed'; text: string } | { kind: 'completed'; text: string }

export function classifyOutcome(opts: { row: A2aStoredTask; signal?: AbortSignal; error?: unknown; result?: unknown }): RunOutcome {
    if (storedCanceled(opts.row)) return { kind: 'canceled' }
    if (clientGone(opts.signal)) return { kind: 'disconnected' }
    if (opts.error) {
        return { kind: 'failed', text: failedStatusText(errorEventDetails(opts.error).code) }
    }
    if (isHumanInputResult(opts.result)) {
        return { kind: 'failed', text: humanInputStatusText() }
    }
    return { kind: 'completed', text: answerText(opts.result) }
}

export async function executeMessage(opts: {
    req: Request
    res: Response
    chatflow: { id: string; apikeyid?: string | null; flowData?: string | null }
    rpcId: JsonRpcId
    params: Record<string, unknown>
    stream: boolean
    log: A2aLogState
}): Promise<void> {
    const parsed = parseMessageParams(opts.params)
    const caller = a2aCallerKey(opts.chatflow)
    const { contextId, ctxSrc } = resolveContext({ flow: opts.chatflow, caller, parsed })
    opts.log.ctxSrc = ctxSrc
    opts.log.context = threadLogHash(contextId)
    const boundIds = threadChatId(opts.chatflow, contextId)
    const history = historyFor(opts.chatflow, caller, contextId)
    const row = a2aTaskStore.create({
        flowId: opts.chatflow.id,
        caller,
        chatId: boundIds.chatId,
        contextId,
        question: parsed.question
    })

    bindRun(opts.req, opts.res, opts.chatflow, {
        question: parsed.question,
        history,
        streaming: opts.stream,
        chatId: boundIds.chatId,
        sessionToken: boundIds.sessionToken
    })

    const sseStreamer = getRunningExpressApp().sseStreamer
    const sink = opts.stream ? opts.res : noopSink
    let sentToken = false
    const inner = opts.stream
        ? makeA2aEncoder({ rpcId: opts.rpcId, taskId: row.task.id, contextId, artifactId: row.artifactId })
        : silentA2aEncoder
    const encoder: SSEEncoder = (frame) => {
        const encoded = inner(frame)
        if (encoded && frame.kind === 'event' && frame.payload.event === 'token') sentToken = true
        return encoded
    }

    if (!sseStreamer.tryAddExternalClient(boundIds.chatId, sink, encoder)) {
        a2aTaskStore.remove(opts.chatflow.id, caller, row.task.id)
        throw new ExternalAgentError(StatusCodes.CONFLICT, 'thread_busy', 'conflict_error', 'A run on this thread is already in progress')
    }

    const signal = watchClientDisconnect(opts.res)
    try {
        opts.res.removeHeader('Set-Cookie')
    } catch {
        // Header may already have been sent.
    }

    if (opts.stream) {
        opts.res.setHeader('Content-Type', 'text/event-stream')
        opts.res.setHeader('Cache-Control', 'no-cache')
        opts.res.setHeader('Connection', 'keep-alive')
        opts.res.setHeader('X-Accel-Buffering', 'no')
        opts.res.flushHeaders()
        writeIfOpen(opts.res, a2aSseData(jsonRpcResult(opts.rpcId, row.task)))
        a2aTaskStore.markWorking(row)
        writeIfOpen(
            opts.res,
            a2aSseData(
                jsonRpcResult(opts.rpcId, {
                    kind: 'status-update',
                    taskId: row.task.id,
                    contextId,
                    status: { state: 'working', timestamp: isoNow() },
                    final: false
                })
            )
        )
    }

    const isQueueMode = process.env.MODE === MODE.QUEUE
    const stopWatchingClient = onAbort(signal, () => sseStreamer.removeClient(boundIds.chatId))
    try {
        if (isQueueMode) {
            await getRunningExpressApp().redisSubscriber.subscribe(boundIds.chatId)
        }
        let outcome: RunOutcome
        try {
            const apiResponse = await predictionsServices.buildChatflow(opts.req)
            outcome = classifyOutcome({ row, signal, result: apiResponse })
        } catch (error) {
            outcome = classifyOutcome({ row, signal, error })
        }
        applyOutcome({ row, outcome, sentToken, stream: opts.stream, res: opts.res, rpcId: opts.rpcId, signal })
        if (opts.log.rpc === '-') opts.log.rpc = 'ok'
    } finally {
        stopWatchingClient()
        if (isQueueMode) {
            await getRunningExpressApp().redisSubscriber.unsubscribe(boundIds.chatId)
        }
        sseStreamer.removeClient(boundIds.chatId)
    }
}

function applyOutcome(opts: {
    row: A2aStoredTask
    outcome: RunOutcome
    sentToken: boolean
    stream: boolean
    res: Response
    rpcId: JsonRpcId
    signal?: AbortSignal
}): void {
    const { row, outcome, stream, res: response, rpcId } = opts
    const gone = clientGone(opts.signal) || response.writableEnded || response.destroyed
    if (outcome.kind === 'disconnected') {
        a2aTaskStore.finalize(row, { state: 'canceled', timestamp: isoNow() })
        return
    }
    if (outcome.kind === 'canceled') {
        a2aTaskStore.finalize(row, { state: 'canceled', timestamp: isoNow() })
        if (stream && !gone) {
            writeIfOpen(
                response,
                a2aSseData(
                    jsonRpcResult(rpcId, {
                        kind: 'status-update',
                        taskId: row.task.id,
                        contextId: row.contextId,
                        status: { state: 'canceled', timestamp: isoNow() },
                        final: true
                    })
                )
            )
        } else if (!stream && !gone) {
            writeSendResult(response, rpcId, row.task)
        }
        return
    }
    if (outcome.kind === 'failed') {
        const message = agentStatusMessage(row.task.id, row.contextId, outcome.text)
        a2aTaskStore.finalize(row, { state: 'failed', timestamp: isoNow(), message })
        if (stream && !gone) {
            writeIfOpen(
                response,
                a2aSseData(
                    jsonRpcResult(rpcId, {
                        kind: 'status-update',
                        taskId: row.task.id,
                        contextId: row.contextId,
                        status: { state: 'failed', timestamp: isoNow(), message },
                        final: true
                    })
                )
            )
        } else if (!stream && !gone) {
            writeSendResult(response, rpcId, row.task)
        }
        return
    }
    const artifacts = [
        {
            artifactId: row.artifactId,
            name: 'answer',
            parts: [{ kind: 'text' as const, text: outcome.text }]
        }
    ]
    a2aTaskStore.finalize(row, { state: 'completed', timestamp: isoNow() }, { answer: outcome.text, artifacts })
    if (stream && !gone) {
        if (opts.sentToken) {
            writeIfOpen(
                response,
                a2aSseData(
                    jsonRpcResult(rpcId, {
                        kind: 'artifact-update',
                        taskId: row.task.id,
                        contextId: row.contextId,
                        artifact: { artifactId: row.artifactId, name: 'answer', parts: [{ kind: 'text', text: '' }] },
                        append: true,
                        lastChunk: true
                    })
                )
            )
        } else {
            writeIfOpen(
                response,
                a2aSseData(
                    jsonRpcResult(rpcId, {
                        kind: 'artifact-update',
                        taskId: row.task.id,
                        contextId: row.contextId,
                        artifact: { artifactId: row.artifactId, name: 'answer', parts: [{ kind: 'text', text: outcome.text }] },
                        append: false,
                        lastChunk: true
                    })
                )
            )
        }
        writeIfOpen(
            response,
            a2aSseData(
                jsonRpcResult(rpcId, {
                    kind: 'status-update',
                    taskId: row.task.id,
                    contextId: row.contextId,
                    status: { state: 'completed', timestamp: isoNow() },
                    final: true
                })
            )
        )
    } else if (!stream && !gone) {
        writeSendResult(response, rpcId, row.task)
    }
}

function writeSendResult(res: Response, rpcId: JsonRpcId, result: A2aTask): void {
    if (res.headersSent || res.writableEnded || res.destroyed) return
    try {
        res.removeHeader('Set-Cookie')
    } catch {
        // Header may already have been sent.
    }
    res.status(StatusCodes.OK).json(jsonRpcResult(rpcId, result))
}

export { resolveContext as resolveA2aContext }
