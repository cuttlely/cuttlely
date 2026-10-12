import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'

// Name and code, not instanceof: the storage package and the server can each load their own multer.
const isMulterFileTooLarge = (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false
    const error = err as { name?: string; code?: string }
    return error.name === 'MulterError' && error.code === 'LIMIT_FILE_SIZE'
}

const asClientError = (err: AppError): AppError => {
    if (isMulterFileTooLarge(err)) {
        return new AppError(StatusCodes.BAD_REQUEST, 'File is too large to upload. The limit is 25 MB.')
    }
    return err
}

// we need eslint because we have to pass next arg for the error middleware
// eslint-disable-next-line
async function errorHandlerMiddleware(err: AppError, req: Request, res: Response, next: NextFunction) {
    const error = asClientError(err)
    const statusCode = error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR
    if (error.message.includes('401 Incorrect API key provided'))
        error.message = '401 Unauthorized – check your API key and ensure it has access to the requested model.'
    let displayedError = {
        statusCode,
        success: false,
        message: error.message,
        // Provide error stack trace only in development
        stack: process.env.NODE_ENV === 'development' ? error.stack : {}
    }

    // Once headers are sent a stream has started, and the streaming controller reports the error as an event on it.
    // Before that every request gets the JSON error, whatever `streaming` says (an odd value used to get no answer at all).
    if (!res.headersSent) {
        // A provider's 429 passes on how long to wait.
        if (error.retryAfterSeconds && error.retryAfterSeconds > 0) res.setHeader('Retry-After', String(error.retryAfterSeconds))
        res.setHeader('Content-Type', 'application/json')
        res.status(displayedError.statusCode).json(displayedError)
    }
}

export default errorHandlerMiddleware
