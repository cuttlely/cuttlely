export class EtlError extends Error {
    constructor(code, message, status = 400) {
        super(message)
        this.name = 'EtlError'
        this.code = code
        this.status = status
        this.etlError = true
    }
}

export function errorMessage(error) {
    if (!error) return 'Unknown error'
    if (typeof error === 'string') return error
    return error.message || String(error)
}
