import { StatusCodes } from 'http-status-codes'
import { AppError } from '../errors/appError'
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

/** Retry-After for a provider 429 that names no wait of its own. */
export const DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS = 30
const MAX_RETRY_AFTER_SECONDS = 3600

type Loose = Record<string, unknown>

const asObject = (value: unknown): Loose | undefined => (value && typeof value === 'object' ? (value as Loose) : undefined)

/** The error and the errors it wraps (`cause`), at most a few deep. */
const errorChain = (error: unknown): Loose[] => {
    const chain: Loose[] = []
    let current = asObject(error)
    while (current && chain.length < 5 && !chain.includes(current)) {
        chain.push(current)
        current = asObject(current.cause)
    }
    return chain
}

const headerValue = (headers: unknown, name: string): string | undefined => {
    const bag = asObject(headers)
    if (!bag) return undefined
    if (typeof bag.get === 'function') {
        const value = (bag.get as (key: string) => unknown).call(headers, name)
        return typeof value === 'string' ? value : undefined
    }
    for (const [key, value] of Object.entries(bag)) {
        if (key.toLowerCase() !== name) continue
        if (typeof value === 'string' || typeof value === 'number') return String(value)
        if (Array.isArray(value) && value.length) return String(value[0])
    }
    return undefined
}

/** Seconds from a provider's retry-after-ms or Retry-After header (seconds or an HTTP date), if it sent one. */
const providerRetryAfter = (chain: Loose[], now: number): number | undefined => {
    for (const error of chain) {
        for (const headers of [error.headers, asObject(error.response)?.headers]) {
            const ms = Number(headerValue(headers, 'retry-after-ms'))
            if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000)
            const raw = headerValue(headers, 'retry-after')
            if (!raw) continue
            const seconds = Number(raw)
            if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
            const date = Date.parse(raw)
            if (Number.isFinite(date)) return Math.ceil((date - now) / 1000)
        }
    }
    return undefined
}

const statusOf = (error: Loose): number | undefined => {
    for (const value of [error.status, error.statusCode, asObject(error.response)?.status]) {
        const status = Number(value)
        if (Number.isInteger(status) && status > 0) return status
    }
    return undefined
}

// Out of credit is a billing problem, not a busy provider: waiting does not help, so it is not reported as 429.
const isOutOfQuota = (error: Loose, message: string) =>
    error.name === 'InsufficientQuotaError' ||
    error.code === 'insufficient_quota' ||
    asObject(error.error)?.code === 'insufficient_quota' ||
    /insufficient_quota|exceeded your current quota/i.test(message)

// Only the text survives some paths (a queue worker, a node that rethrows the message).
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|resource.?has.?been.?exhausted|resource_exhausted/i

/**
 * A model provider that kept answering 429 (rate limited) after the retries: the wait to pass on, else null.
 * Our own 4xx errors are not this; they keep their status in toPredictionError.
 */
export const providerRateLimit = (error: unknown, now = Date.now()): { retryAfterSeconds: number } | null => {
    const chain = errorChain(error)
    if (!chain.length) return null
    const messages = chain.map((item) => (typeof item.message === 'string' ? item.message : '')).join(' ')
    if (chain.some((item) => isOutOfQuota(item, messages))) return null
    const limited =
        chain.some((item) => statusOf(item) === 429 || item.lc_error_code === 'MODEL_RATE_LIMIT') ||
        (/\b429\b/.test(messages) && RATE_LIMIT_TEXT.test(messages))
    if (!limited) return null
    const wanted = providerRetryAfter(chain, now) ?? DEFAULT_RATE_LIMIT_RETRY_AFTER_SECONDS
    return { retryAfterSeconds: Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, wanted)) }
}

const isHarnessError = (error: unknown, message: string) =>
    Boolean((error as { harnessError?: boolean })?.harnessError) || /cannot run:/i.test(message)

/**
 * The error a prediction run throws to its caller. A client error (4xx, for example 402 quota, 403, 404, 422 or 429)
 * keeps its status; a model provider that keeps rate limiting is 429 with Retry-After (the provider's wait when it
 * sent one); a harness that cannot run is 422; anything else is 500.
 */
const MISSING_CREDENTIAL = /\bCredential \S+ not found\b/
const MISSING_CREDENTIAL_MESSAGE = 'A credential this flow uses was not found. Select a credential on the card.'

export const toPredictionError = (error: unknown): AppError => {
    if (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500) return error
    const limited = providerRateLimit(error)
    if (limited) {
        const rateLimited = new AppError(
            StatusCodes.TOO_MANY_REQUESTS,
            `The model provider (or another service this flow calls) is limiting requests right now. Try again in ${limited.retryAfterSeconds} seconds.`
        )
        rateLimited.retryAfterSeconds = limited.retryAfterSeconds
        return rateLimited
    }
    const message = getErrorMessage(error)
    if ((error as { code?: unknown })?.code === 'key_not_allowed') return new AppError(StatusCodes.FORBIDDEN, message)
    // A missing or unreadable credential is a flow setup problem. Do not echo the credential id, even from a harness.
    if (MISSING_CREDENTIAL.test(message)) return new AppError(StatusCodes.UNPROCESSABLE_ENTITY, MISSING_CREDENTIAL_MESSAGE)
    if (isHarnessError(error, message)) return new AppError(StatusCodes.UNPROCESSABLE_ENTITY, message)
    return new AppError(StatusCodes.INTERNAL_SERVER_ERROR, message)
}

/**
 * What a stream's error event says about the failure once the HTTP status is already 200: the status the same
 * request would have had without streaming, and its code.
 */
export const errorEventDetails = (error: unknown): { status: number; code: string; retryAfter?: number } => {
    const failure = toPredictionError(error)
    const status = failure.statusCode
    const code = PREDICTION_ERROR_CODES[status] || (status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR')
    return failure.retryAfterSeconds ? { status, code, retryAfter: failure.retryAfterSeconds } : { status, code }
}
