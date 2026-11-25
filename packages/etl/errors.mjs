export class EtlError extends Error {
    constructor(code, message, status = 400, retryAfter) {
        super(message)
        this.name = 'EtlError'
        this.code = code
        this.status = status
        if (retryAfter !== undefined) this.retryAfter = retryAfter
        this.etlError = true
    }
}

export function errorMessage(error) {
    if (!error) return 'Unknown error'
    if (typeof error === 'string') return error
    return error.message || String(error)
}
