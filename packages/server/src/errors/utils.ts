import { MissingModelCredentialError, missingModelCredentialMessage } from '@cuttlely/components'

type ErrorWithMessage = {
    message: string
}

const isErrorWithMessage = (error: unknown): error is ErrorWithMessage => {
    return (
        typeof error === 'object' && error !== null && 'message' in error && typeof (error as Record<string, unknown>).message === 'string'
    )
}

const toErrorWithMessage = (maybeError: unknown): ErrorWithMessage => {
    if (isErrorWithMessage(maybeError)) return maybeError

    try {
        return new Error(JSON.stringify(maybeError))
    } catch {
        // fallback in case there's an error stringifying the maybeError
        // like with circular references for example.
        return new Error(String(maybeError))
    }
}

export const getErrorMessage = (error: unknown) => {
    return toErrorWithMessage(error).message
}

const CREDENTIAL_MESSAGE_PREFIX = 'Pick a credential on the '
const CREDENTIAL_MESSAGE_SUFFIX = ' node.'
const MISSING_MODEL_CREDENTIAL_STATUS = 422

/** Walk this far up a cause chain looking for a missing-credential error. */
export const MISSING_CREDENTIAL_CAUSE_DEPTH = 8

/** Return the card label when message is exactly the missing-credential card text. */
export const credentialLabelFromMessage = (message: string): string | undefined => {
    if (!message.startsWith(CREDENTIAL_MESSAGE_PREFIX) || !message.endsWith(CREDENTIAL_MESSAGE_SUFFIX)) return undefined
    const label = message.slice(CREDENTIAL_MESSAGE_PREFIX.length, -CREDENTIAL_MESSAGE_SUFFIX.length)
    if (!label || message !== missingModelCredentialMessage(label)) return undefined
    return label
}

/**
 * Find a missing-credential error by type or by 422 + exact card message.
 * Walks `cause` up to MISSING_CREDENTIAL_CAUSE_DEPTH. Returns that credential
 * error (or one rebuilt from its message) and never the wrapper or any other
 * error from the chain.
 */
export const findMissingModelCredentialError = (error: unknown): MissingModelCredentialError | undefined => {
    let current: unknown = error
    for (let depth = 0; depth <= MISSING_CREDENTIAL_CAUSE_DEPTH; depth++) {
        if (current == null || typeof current !== 'object') return undefined
        if (typeof MissingModelCredentialError === 'function' && current instanceof MissingModelCredentialError) {
            return current
        }
        const status = Number((current as { statusCode?: unknown }).statusCode)
        const message = typeof (current as { message?: unknown }).message === 'string' ? (current as { message: string }).message : ''
        const label = credentialLabelFromMessage(message)
        if (status === MISSING_MODEL_CREDENTIAL_STATUS && label) {
            return new MissingModelCredentialError(label)
        }
        current = (current as { cause?: unknown }).cause
    }
    return undefined
}

/** BullMQ rejects waitUntilFinished with only the worker's failedReason, losing the error class and status. */
export const fromQueueFailure = (error: unknown): never => {
    const credentialError = findMissingModelCredentialError(error)
    if (credentialError) throw credentialError
    // BullMQ keeps only the failedReason string, so match the exact card message on the thrown Error.
    if (error instanceof Error) {
        const label = credentialLabelFromMessage(error.message)
        if (label) throw new MissingModelCredentialError(label)
    }
    throw error
}
