// What the page error card shows. An API error carries an HTTP status and the server's message.
// A request that got no answer (network drop, timeout, proxy or CORS failure) has no status, so the
// card says the server could not be reached instead of reading a status that is not there.
export const NO_ANSWER_MESSAGE = 'The server could not be reached. Check your connection, then reload the page.'

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
