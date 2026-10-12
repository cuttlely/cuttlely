export class AppError extends Error {
    statusCode: number
    /** Sent as the Retry-After header (seconds) when the error answers the request, for example a provider's 429. */
    retryAfterSeconds?: number
    constructor(statusCode: number, message: string) {
        super(message)
        this.statusCode = statusCode
        // Leave name unset. Error.prototype.name stays "Error", which is what a response stack and a log line already carry.
        // capture the stack trace of the error from anywhere in the application
        Error.captureStackTrace(this, this.constructor)
    }
}
