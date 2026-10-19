import { timingSafeEqual } from 'crypto'
import { NextFunction, Request, RequestHandler, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../errors/appError'

export class ExternalAgentError extends AppError {
    code: string
    type: string
    constructor(status: number, code: string, type: string, message: string) {
        super(status, message)
        this.code = code
        this.type = type
    }
}

export const sendExternalAgentError = (res: Response, err: ExternalAgentError): void => {
    if (res.headersSent) {
        res.end()
        return
    }
    res.status(err.statusCode).json({
        error: {
            message: err.message,
            type: err.type,
            code: err.code
        }
    })
}

const headerString = (value: string | string[] | undefined): string | undefined => {
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
    return undefined
}

const keysEqual = (left: string, right: string): boolean => {
    try {
        const a = Buffer.from(left)
        const b = Buffer.from(right)
        if (a.length !== b.length) return false
        return timingSafeEqual(a, b)
    } catch {
        return false
    }
}

const BEARER_PREFIX = 'Bearer '

/**
 * Header syntax for IBM's Bearer and API-key schemes. The flow's key is still checked by
 * `authorizeFlowAccess`. Moves the parsed body to `req.orchestrate` and clears `req.body`
 * so a client `streaming` field cannot change how origin refusals are answered.
 */
export const externalAgentAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    try {
        const authorization = headerString(req.headers.authorization)
        const apiKey = headerString(req.headers['x-api-key'])
        const hasAuthorization = authorization !== undefined && authorization !== ''
        const hasApiKey = apiKey !== undefined && apiKey !== ''

        if (hasAuthorization && !authorization.startsWith(BEARER_PREFIX)) {
            throw new ExternalAgentError(StatusCodes.UNAUTHORIZED, 'unauthorized', 'authentication_error', 'Unauthorized')
        }

        const bearerKey = hasAuthorization ? authorization.slice(BEARER_PREFIX.length) : undefined

        if (hasAuthorization && hasApiKey) {
            if (!keysEqual(bearerKey as string, apiKey)) {
                throw new ExternalAgentError(
                    StatusCodes.BAD_REQUEST,
                    'credentials_conflict',
                    'invalid_request_error',
                    'Authorization and X-API-Key do not match'
                )
            }
        } else if (!hasAuthorization && hasApiKey) {
            req.headers.authorization = `${BEARER_PREFIX}${apiKey}`
        }

        ;(req as Request & { orchestrate?: unknown }).orchestrate = req.body
        req.body = {}
        next()
    } catch (error) {
        next(error)
    }
}

const allowKeyless = (): boolean => process.env.CUTTLELY_ORCHESTRATE_ALLOW_KEYLESS === 'true' && process.env.NODE_ENV !== 'production'

export const refuseKeylessFlow: RequestHandler = (_req: Request, res: Response, next: NextFunction) => {
    try {
        const flow = res.locals.chatflow as { apikeyid?: string | null } | undefined
        const keyed = typeof flow?.apikeyid === 'string' && flow.apikeyid.length > 0
        if (keyed || allowKeyless()) return next()
        throw new ExternalAgentError(
            StatusCodes.FORBIDDEN,
            'keyless_flow',
            'permission_error',
            'Bind an API key to this flow to call it from Orchestrate.'
        )
    } catch (error) {
        next(error)
    }
}
