import express, { NextFunction, Request, RequestHandler, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import orchestrateController from '../../controllers/orchestrate'
import predictionsController from '../../controllers/predictions'
import { AppError } from '../../errors/appError'
import { authorizeFlowAccess } from '../../utils/authorizeFlowAccess'
import { ExternalAgentError, externalAgentAuth, refuseKeylessFlow, sendExternalAgentError } from '../../utils/externalAgentAuth'
import { threadLogHash } from '../../utils/externalThread'
import logger from '../../utils/logger'

const wrap =
    (handler: RequestHandler): RequestHandler =>
    (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next)
    }

/** Compare the media type only, so `application/json; charset=utf-8` is accepted. */
export const isJsonContentType = (header: unknown): boolean => {
    const raw = Array.isArray(header) ? header[0] : header
    if (typeof raw !== 'string') return false
    const media = raw.split(';', 1)[0].trim().toLowerCase()
    return media === 'application/json'
}

export const orchestrateContentTypeGuard: RequestHandler = (req, res, next) => {
    if (isJsonContentType(req.headers['content-type'])) return next()
    sendExternalAgentError(
        res,
        new ExternalAgentError(
            StatusCodes.UNSUPPORTED_MEDIA_TYPE,
            'content_type_invalid',
            'invalid_request_error',
            'Content-Type must be application/json'
        )
    )
}

export const orchestrateJsonParser = express.json({ limit: '1mb' })

const orchestrateLogHook: RequestHandler = (req, res, next) => {
    const started = Date.now()
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {}
    const fields = Object.keys(body).sort().join(',')
    const stream = body.stream === true
    const threadHeader = req.headers['x-ibm-thread-id']
    const thread = threadLogHash(typeof threadHeader === 'string' ? threadHeader : undefined)
    const pathLabel = (req.originalUrl || req.url || '').includes('/chat/completions') ? 'chat/completions' : 'base'
    const flow = req.params.id || 'none'
    res.on('finish', () => {
        logger.info(
            `[orchestrate] flow=${flow} path=${pathLabel} thread=${thread} stream=${stream} fields=${fields} status=${res.statusCode} ms=${
                Date.now() - started
            }`
        )
    })
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

export const orchestrateErrorHandler = (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
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
    sendExternalAgentError(
        res,
        new ExternalAgentError(StatusCodes.INTERNAL_SERVER_ERROR, 'internal_error', 'server_error', 'The flow could not finish')
    )
}

const router = express.Router()

router.post(
    ['/:id', '/:id/chat/completions'],
    orchestrateLogHook,
    wrap(predictionsController.getRateLimiterMiddleware),
    wrap(externalAgentAuth),
    wrap(authorizeFlowAccess({ getChatflowId: (req) => req.params.id, keyOnly: true, checkOrigin: true })),
    wrap(refuseKeylessFlow),
    wrap(orchestrateController.createCompletion)
)
router.use(orchestrateErrorHandler)

export default router
