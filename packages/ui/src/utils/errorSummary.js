import { isConnectionUnavailable } from '@/api/resilience'

// What the page error card shows. An API error carries an HTTP status and the server's message.
// A request that got no answer (network drop, timeout, proxy or CORS failure) has no status, so the
// card says the server could not be reached instead of reading a status that is not there.
export const NO_ANSWER_MESSAGE = 'The server could not be reached. Check your connection, then reload the page.'
export const SAVE_NO_ANSWER_MESSAGE =
    'Save failed. The server could not be reached. Your edits are still on the canvas. Press Save again when the connection is back.'
export const PUBLISH_NO_ANSWER_MESSAGE =
    'Publish not confirmed. The server could not be reached, so Cuttlely cannot tell whether this version went Live. Check the Live status before you publish again.'

export const errorSummary = (error) => {
    const status = error?.response?.status
    const data = error?.response?.data
    const serverMessage = typeof data === 'string' ? data : data?.message
    if (status) return { status: `Status: ${status}`, message: typeof serverMessage === 'string' ? serverMessage : '' }
    if (error?.response === undefined && (error?.isAxiosError || error?.request))
        return { status: 'No response', message: NO_ANSWER_MESSAGE }
    if (typeof error === 'string') return { status: 'Error', message: error }
    return { status: 'Error', message: typeof error?.message === 'string' && error.message ? error.message : NO_ANSWER_MESSAGE }
}

export const errorSummaryText = (error) => {
    const { status, message } = errorSummary(error)
    return message ? `${status}\n${message}` : status
}

// The server's message for a failed API call, for a toast or an inline error.
// A request that got no answer has no response body, so this says the server could not be reached.
export const requestFailureMessage = (error) => {
    const data = error?.response?.data
    if (typeof data === 'string' && data) return data
    if (typeof data?.message === 'string' && data.message) return data.message
    if (error?.response === undefined && (error?.isAxiosError || error?.request)) return NO_ANSWER_MESSAGE
    return typeof error?.message === 'string' && error.message ? error.message : NO_ANSWER_MESSAGE
}

// Canvas writes are deliberately not retried. A write that gets no application answer may still have reached the
// server, so Publish reconciles before claiming what changed. A failed request leaves the editor mounted and dirty,
// so do not tell the person to reload and discard the edits they can save again.
const writeFailureMessage = (error, fallback, noAnswerMessage) => {
    if (isConnectionUnavailable(error)) return noAnswerMessage
    const data = error?.response?.data
    if (typeof data === 'string' && data) return data
    if (typeof data?.message === 'string' && data.message) return data.message
    return typeof error?.message === 'string' && error.message ? error.message : fallback
}

export const saveFailureMessage = (error, fallback = 'Save failed') => writeFailureMessage(error, fallback, SAVE_NO_ANSWER_MESSAGE)

export const publishFailureMessage = (error, fallback = 'Publish failed.') =>
    writeFailureMessage(error, fallback, PUBLISH_NO_ANSWER_MESSAGE)

export const settingFailureMessage = (error, fallback = 'That setting could not be saved.') => {
    const fallbackSentence = /[.!?]$/.test(fallback) ? fallback : `${fallback}.`
    return writeFailureMessage(
        error,
        fallback,
        `${fallbackSentence} The server could not be reached. Try again when the connection is back.`
    )
}

// Nested configuration is a read, so gateway failures have already used the quiet retries. Do not put a proxy's
// HTML response into the panel; keep ordinary application error messages for answered, non-gateway failures.
export const configurationLoadFailureMessage = (error) => {
    if (isConnectionUnavailable(error)) {
        return error?.response === undefined ? 'The server did not answer.' : 'The server could not be reached.'
    }
    const data = error?.response?.data
    const serverMessage = typeof data === 'string' ? data : data?.message
    if (typeof serverMessage === 'string' && serverMessage) return serverMessage
    return `The server answered with status ${error?.response?.status ?? 'unknown'}.`
}
