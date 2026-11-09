import { AppError } from '../../errors/appError'

export const ACCESS_KEY_DOCS = 'https://cuttlely.com/docs/how-to/access-keys/'
export function accessKeyHelp(status: number, message: string): string {
    if (message.includes(ACCESS_KEY_DOCS)) return message
    const fix =
        status === 401
            ? 'Send a current access key in Authorization: Bearer <key>. Ask the key owner to check expiry and revocation.'
            : status === 429
            ? 'Wait for the Retry-After time before trying again. For a daily or monthly quota, wait for its UTC reset or ask the key owner to raise the limit.'
            : 'Open Access Keys to check the required permissions, API operations, resource grants and caller restrictions, or ask your workspace admin.'
    return `${message} ${fix} Help: ${ACCESS_KEY_DOCS}`
}
export class AccessKeyAuthenticationError extends AppError {
    constructor() {
        super(401, accessKeyHelp(401, 'This request needs a valid access key for this workspace.'))
    }
}
export function explainAccessKeyError(error: unknown): unknown {
    if (error instanceof AppError && !(error instanceof FlowOriginPolicyError) && [401, 403, 429].includes(error.statusCode))
        error.message = accessKeyHelp(error.statusCode, error.message)
    return error
}
/** Distinguishes caller/resource policy refusals from a flow's embed Origin rule in external adapters. */
export class AccessKeyPolicyError extends AppError {
    constructor(message: string) {
        super(403, accessKeyHelp(403, message))
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
        super(429, accessKeyHelp(429, 'This access key has reached its request limit.'))
    }
}
export function isMissingAccessResource(error: unknown): boolean {
    return error instanceof AppError && error.statusCode === 404
}
