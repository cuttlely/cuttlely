import express, { NextFunction, Request, RequestHandler, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import a2aController from '../../controllers/a2a'
import predictionsController from '../../controllers/predictions'
import { AppError } from '../../errors/appError'
import { authorizeFlowAccess } from '../../utils/authorizeFlowAccess'
import { ExternalAgentError, externalAgentAuth, refuseKeylessFlow, sendExternalAgentError } from '../../utils/externalAgentAuth'
import logger from '../../utils/logger'
import { isJsonContentType } from '../orchestrate'
import { assertA2aPublicBaseUrl } from '../../services/a2a/agentCard'
import { A2A_RPC_CODES, A2aRpcError, jsonRpcError } from '../../services/a2a/rpc'
import { A2aLogState, emptyA2aLog } from '../../services/a2a/executor'

export { assertA2aPublicBaseUrl }

export { isJsonContentType }

const wrap =
    (handler: RequestHandler): RequestHandler =>
    (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next)
    }

export function a2aAuthLabel(req: Request): 'bearer' | 'x-api-key' | 'none' {
    const authorization = req.headers.authorization
    const apiKey = req.headers['x-api-key']
    const hasBearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    const hasKey = typeof apiKey === 'string' && apiKey.length > 0
    if (hasBearer) return 'bearer'
    if (hasKey) return 'x-api-key'
    return 'none'
}

export function a2aFlowFromUrl(req: Request): string {
    const raw = (req.originalUrl || req.url || '').split('?')[0]
    const match = raw.match(/\/api\/v1\/a2a\/([^/]+)/i)
    if (match?.[1]) return match[1]
    return req.params?.id || 'none'
}

export function writeA2aLog(req: Request, res: Response, started: number, extra?: Partial<A2aLogState>): void {
    const log = { ...emptyA2aLog(), ...(res.locals.a2aLog as A2aLogState | undefined), ...extra }
    const status = res.statusCode
    if (status === 401 || status === 403 || status === 429) {
        log.method = '-'
        log.ctxSrc = '-'
        log.context = '-'
        log.rpc = '-'
        log.stream = false
    }
    const route = (req.originalUrl || req.url || '').includes('.well-known/agent-card.json') ? 'card' : 'rpc'
    logger.info(
        `[a2a] flow=${a2aFlowFromUrl(req)} route=${route} auth=${a2aAuthLabel(req)} method=${log.method} stream=${log.stream} ctx_src=${
            log.ctxSrc
        } context=${log.context} status=${status} rpc=${log.rpc} ms=${Date.now() - started}`
    )
}

export const a2aContentTypeGuard: RequestHandler = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next()
    if (isJsonContentType(req.headers['content-type'])) return next()
    const started = Date.now()
    sendExternalAgentError(
        res,
        new ExternalAgentError(
            StatusCodes.UNSUPPORTED_MEDIA_TYPE,
            'content_type_invalid',
            'invalid_request_error',
            'Content-Type must be application/json'
        )
    )
    writeA2aLog(req, res, started, { method: '-', rpc: '-' })
}

export const a2aJsonParser = express.json({ limit: '1mb' })

export const a2aBodyErrorHandler = (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (!err) return next()
    if (res.headersSent) {
        res.end()
        return
    }
    const started = Date.now()
    const typed = err as { type?: string }
    if (typed.type === 'entity.too.large') {
        res.status(StatusCodes.REQUEST_TOO_LONG).json({
            error: { message: 'Request body too large', type: 'invalid_request_error', code: 'body_too_large' }
        })
        writeA2aLog(req, res, started, { method: '-', rpc: '-' })
        return
    }
    if (typed.type === 'entity.parse.failed' || err instanceof SyntaxError) {
        res.status(StatusCodes.OK).json(jsonRpcError(null, A2A_RPC_CODES.parse, 'Parse error'))
        writeA2aLog(req, res, started, { method: '-', rpc: String(A2A_RPC_CODES.parse) })
        return
    }
    next(err)
}

const a2aLogHook: RequestHandler = (req, res, next) => {
    const started = Date.now()
    res.locals.a2aLog = emptyA2aLog()
    res.on('finish', () => writeA2aLog(req, res, started))
    next()
}

const mapAppError = (err: AppError): ExternalAgentError => {
    if (err.statusCode === StatusCodes.BAD_REQUEST) {
        return new ExternalAgentError(err.statusCode, 'flow_id_invalid', 'invalid_request_error', 'Invalid flow id')
    }
    if (err.statusCode === StatusCodes.UNAUTHORIZED) {
        return new ExternalAgentError(err.statusCode, 'unauthorized', 'authentication_error', 'Unauthorized')
    }
    if (err.statusCode === StatusCodes.FORBIDDEN) {
        return new ExternalAgentError(err.statusCode, 'origin_not_allowed', 'permission_error', err.message)
    }
    if (err.statusCode === StatusCodes.NOT_FOUND) {
        return new ExternalAgentError(err.statusCode, 'flow_not_found', 'invalid_request_error', 'Flow not found')
    }
    return new ExternalAgentError(StatusCodes.INTERNAL_SERVER_ERROR, 'internal_error', 'server_error', 'The flow could not finish')
}

export const a2aErrorHandler = (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (res.headersSent) {
        res.end()
        return
    }
    if (err instanceof ExternalAgentError) {
        sendExternalAgentError(res, err)
        return
    }
    if (err instanceof AppError) {
        sendExternalAgentError(res, mapAppError(err))
        return
    }
    const log = (res.locals.a2aLog || emptyA2aLog()) as A2aLogState
    log.rpc = String(A2A_RPC_CODES.internal)
    const id = (res.locals.a2aRpcId as string | number | null | undefined) ?? null
    if (err instanceof A2aRpcError) {
        log.rpc = String(err.code)
        const bodyId = err.code === A2A_RPC_CODES.invalidRequest || err.code === A2A_RPC_CODES.parse ? null : id
        res.status(StatusCodes.OK).json(jsonRpcError(bodyId, err.code, err.message))
        return
    }
    res.status(StatusCodes.OK).json(jsonRpcError(id, A2A_RPC_CODES.internal, 'Internal error'))
}

const router = express.Router()

router.get(
    '/:id/.well-known/agent-card.json',
    a2aLogHook,
    wrap(predictionsController.getRateLimiterMiddleware),
    wrap(externalAgentAuth),
    wrap(authorizeFlowAccess({ getChatflowId: (req) => req.params.id, keyOnly: true, checkOrigin: true })),
    wrap(refuseKeylessFlow),
    wrap(a2aController.getAgentCard)
)
router.post(
    '/:id',
    a2aLogHook,
    wrap(predictionsController.getRateLimiterMiddleware),
    wrap(externalAgentAuth),
    wrap(authorizeFlowAccess({ getChatflowId: (req) => req.params.id, keyOnly: true, checkOrigin: true })),
    wrap(refuseKeylessFlow),
    wrap(a2aController.handleRpc)
)
router.use(a2aErrorHandler)

export default router
