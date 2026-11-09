import { AppError } from '../../errors/appError'

/** Distinguishes caller/resource policy refusals from a flow's embed Origin rule in external adapters. */
export class AccessKeyPolicyError extends AppError {
    constructor(message: string) {
        super(403, message)
    }
}

/** Retains prediction's existing plain-text streaming Origin refusal without confusing it with key scope errors. */
export class FlowOriginPolicyError extends AppError {
    constructor(message: string) {
        super(403, message)
    }
}

/** Resource-resolution outages share the sanitized access-key error boundary. */
export class AccessKeyUnavailableError extends AppError {
    constructor(message = 'Access key verification is unavailable.') {
        super(503, message)
    }
}
export class AccessKeyLimitError extends AppError {
    constructor() {
        super(429, 'Access key request limit reached.')
    }
}
export function isMissingAccessResource(error: unknown): boolean {
    return error instanceof AppError && error.statusCode === 404
}
