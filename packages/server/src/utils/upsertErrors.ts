import { StatusCodes } from 'http-status-codes'
import { AppError } from '../errors/appError'
import { getErrorMessage } from '../errors/utils'

/** The 4xx status an error carries (an AppError or a component error such as a missing model credential), if any. */
export const clientErrorStatus = (error: unknown): number | undefined => {
    if (!error || typeof error !== 'object') return undefined
    const status = Number((error as { statusCode?: unknown }).statusCode)
    return Number.isInteger(status) && status >= 400 && status < 500 ? status : undefined
}

/** Keep a client error's status through the vector-upsert wrappers; anything else is a 500 with the given prefix. */
export const toUpsertAppError = (error: unknown, prefix = ''): AppError => {
    const status = clientErrorStatus(error)
    if (status !== undefined) return error instanceof AppError ? error : new AppError(status, getErrorMessage(error))
    return new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `${prefix}${getErrorMessage(error)}`)
}
