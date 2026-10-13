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
