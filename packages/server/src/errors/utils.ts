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

/** BullMQ rejects waitUntilFinished with only the worker's failedReason, losing the error class and status. */
export const fromQueueFailure = (error: unknown): never => {
    if (error instanceof Error) {
        const prefix = 'Pick a credential on the '
        const suffix = ' node.'
        if (error.message.startsWith(prefix) && error.message.endsWith(suffix)) {
            const label = error.message.slice(prefix.length, -suffix.length)
            if (error.message === missingModelCredentialMessage(label)) throw new MissingModelCredentialError(label)
        }
    }
    throw error
}
