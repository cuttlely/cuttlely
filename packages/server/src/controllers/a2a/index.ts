import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { ExternalAgentError } from '../../utils/externalAgentAuth'
import { threadLogHash } from '../../utils/externalThread'
import { buildAgentCard } from '../../services/a2a/agentCard'
import { A2aLogState, cancelStoredTask, emptyA2aLog, executeMessage } from '../../services/a2a/executor'
import {
    A2A_RPC_CODES,
    A2aRpcError,
    errorResponseId,
    jsonRpcError,
    jsonRpcResult,
    methodError,
    parseEnvelope,
    parseTaskIdParams
} from '../../services/a2a/rpc'
import { TaskStoreFullError, a2aCallerKey, a2aTaskStore } from '../../services/a2a/taskStore'

type A2aRequest = Request & { orchestrate?: unknown }

const logOf = (res: Response): A2aLogState => {
    if (!res.locals.a2aLog) res.locals.a2aLog = emptyA2aLog()
    return res.locals.a2aLog as A2aLogState
}

const sendRpcError = (res: Response, parsedId: string | number | null, err: A2aRpcError) => {
    const log = logOf(res)
    log.rpc = String(err.code)
    const id = errorResponseId(err.code, parsedId)
    res.status(StatusCodes.OK).json(jsonRpcError(id, err.code, err.message))
}

const getAgentCard = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const chatflow = res.locals.chatflow as { id: string; name?: string; updatedDate?: Date }
        if (!chatflow?.id) {
            throw new ExternalAgentError(StatusCodes.NOT_FOUND, 'flow_not_found', 'invalid_request_error', 'Flow not found')
        }
        const log = logOf(res)
        log.method = '-'
        log.rpc = '-'
        res.removeHeader('Set-Cookie')
        res.status(StatusCodes.OK).json(buildAgentCard(req, chatflow))
    } catch (error) {
        next(error)
    }
}

const handleRpc = async (req: A2aRequest, res: Response, next: NextFunction) => {
    const log = logOf(res)
    try {
        const chatflow = res.locals.chatflow as { id: string; apikeyid?: string | null; flowData?: string | null; name?: string }
        if (!chatflow?.id) {
            throw new ExternalAgentError(StatusCodes.NOT_FOUND, 'flow_not_found', 'invalid_request_error', 'Flow not found')
        }

        const parsed = parseEnvelope(req.orchestrate)
        res.locals.a2aRpcId = parsed.ok ? parsed.id : parsed.id
        log.method = parsed.method || '-'
        log.stream = parsed.method === 'message/stream'

        if (!parsed.ok) {
            sendRpcError(res, parsed.id, parsed.error)
            return
        }

        const unsupported = methodError(parsed.method)
        if (unsupported) {
            sendRpcError(res, parsed.id, unsupported)
            return
        }

        const caller = a2aCallerKey(chatflow)

        if (parsed.method === 'tasks/get') {
            const taskId = parseTaskIdParams(parsed.params)
            const row = a2aTaskStore.get(chatflow.id, caller, taskId)
            if (!row) throw new A2aRpcError(A2A_RPC_CODES.taskNotFound, 'Task not found')
            log.ctxSrc = '-'
            log.context = threadLogHash(row.contextId)
            log.rpc = 'ok'
            res.status(StatusCodes.OK).json(jsonRpcResult(parsed.id, row.task))
            return
        }

        if (parsed.method === 'tasks/cancel') {
            const taskId = parseTaskIdParams(parsed.params)
            const task = await cancelStoredTask(chatflow.id, caller, taskId)
            log.ctxSrc = '-'
            log.context = threadLogHash(task.contextId)
            log.rpc = 'ok'
            res.status(StatusCodes.OK).json(jsonRpcResult(parsed.id, task))
            return
        }

        await executeMessage({
            req,
            res,
            chatflow,
            rpcId: parsed.id,
            params: parsed.params,
            stream: parsed.method === 'message/stream',
            log
        })
    } catch (error) {
        if (error instanceof TaskStoreFullError) {
            if (!res.headersSent) {
                res.status(StatusCodes.SERVICE_UNAVAILABLE).json({
                    error: { message: 'Too many open tasks for this flow', type: 'server_error', code: 'task_store_full' }
                })
            }
            return
        }
        next(error)
    }
}

export default {
    getAgentCard,
    handleRpc
}
