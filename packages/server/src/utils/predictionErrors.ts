import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import { getErrorMessage } from '../errors/utils'

// A short code for each status a prediction can fail with, so a client can act on it without reading the message.
export const PREDICTION_ERROR_CODES: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    402: 'QUOTA_EXCEEDED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    413: 'TOO_LARGE',
    422: 'CANNOT_RUN',
    429: 'RATE_LIMITED',
    500: 'INTERNAL_ERROR'
}

const isHarnessError = (error: unknown, message: string) =>
    Boolean((error as { harnessError?: boolean })?.harnessError) || /cannot run:/i.test(message)

/**
 * The error a prediction run throws to its caller. A client error (4xx, for example 402 quota, 403, 404, 422 or 429)
 * keeps its status; a harness that cannot run is 422; anything else is 500.
 */
export const toPredictionError = (error: unknown): InternalFlowiseError => {
    if (error instanceof InternalFlowiseError && error.statusCode >= 400 && error.statusCode < 500) return error
    const message = getErrorMessage(error)
    if (isHarnessError(error, message)) return new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, message)
    return new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, message)
}

/**
 * What a stream's error event says about the failure once the HTTP status is already 200: the status the same
 * request would have had without streaming, and its code.
 */
export const errorEventDetails = (error: unknown): { status: number; code: string } => {
    const status = toPredictionError(error).statusCode
    return { status, code: PREDICTION_ERROR_CODES[status] || (status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR') }
}
