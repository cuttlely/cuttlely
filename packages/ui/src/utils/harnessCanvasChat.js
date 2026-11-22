// External callers. Always the published harness.
export function harnessRunPath(name) {
    return `/api/v1/harnesses/${encodeURIComponent(name)}/runs`
}

// Canvas chat and Try it. The same internal route a chatflow test chat uses, so a draft runs before Publish.
export function harnessCanvasRunPath(chatflowId) {
    return `/api/v1/internal-prediction/${encodeURIComponent(chatflowId)}`
}

// One Enter is one request. Shift+Enter stays a newline. A send already in flight is ignored.
export function acceptChatSubmit({ key, shiftKey = false, composing = false, text = '', busy = false } = {}) {
    if (busy || composing || shiftKey) return false
    if (key != null && key !== 'Enter') return false
    return Boolean(String(text || '').trim())
}

export const HARNESS_BUSY_MESSAGE = 'A reply is still in progress in this chat. Try again in a moment.'

export function harnessResponseError(status, text) {
    let body
    try {
        body = JSON.parse(text)
    } catch {
        // Non-JSON transport errors retain their text.
    }
    return Object.assign(new Error(body?.message || text.slice(0, 300) || `Harness run failed (${status}).`), {
        status,
        code: body?.code
    })
}

export function harnessBusyNotice(error) {
    const status = error?.status ?? error?.response?.status
    const data = error?.response?.data || error
    return (status === 409 || data?.code === 'busy') &&
        (data?.code === 'busy' || String(data?.message || '').endsWith(HARNESS_BUSY_MESSAGE))
        ? HARNESS_BUSY_MESSAGE
        : ''
}

export function keepUnsentHarnessMessage(messages, input, notice) {
    const lastUser = messages.findLastIndex((message) => message.type === 'userMessage' && message.message === input)
    return [
        ...messages.map((message, index) => (index === lastUser ? { ...message, notSent: true } : message)),
        { message: notice, type: 'apiMessage', notice: true }
    ]
}
