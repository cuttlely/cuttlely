// Talks to the Cuttlely server's public chat endpoints. See README "Server API used".

import { createEventParser } from './sse.js'

export class ChatApiError extends Error {
    constructor(status, message, code) {
        super(message || `Request failed (${status})`)
        this.status = status
        this.code = code || ''
    }
}

async function readError(res) {
    let message = ''
    try {
        const body = await res.text()
        try {
            const json = JSON.parse(body)
            message = typeof json?.message === 'string' ? json.message : typeof json?.error === 'string' ? json.error : ''
        } catch {
            message = body
        }
    } catch {
        // ignore
    }
    return new ChatApiError(res.status, String(message || '').slice(0, 300))
}

export function createClient({ apiHost, flowId, fetchImpl }) {
    const host = String(apiHost || '').replace(/\/+$/, '')
    const id = encodeURIComponent(flowId)
    const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args))

    return {
        host,

        async loadConfig() {
            const res = await doFetch(`${host}/api/v1/public-chatbotConfig/${id}`, { headers: { Accept: 'application/json' } })
            if (!res.ok) throw await readError(res)
            const body = await res.text()
            try {
                return JSON.parse(body)
            } catch {
                return {}
            }
        },

        /**
         * Sends one turn. Streams when the flow can stream; otherwise the server answers with JSON.
         * handlers: onEvent({ event, data, ... }) for each stream event, onJson(body) for a JSON answer.
         */
        async send(body, handlers = {}, signal) {
            const files = Array.isArray(body.files) ? body.files : []
            const payload = { ...body, streaming: true }
            delete payload.files
            let init
            if (files.length) {
                const form = new FormData()
                for (const [key, value] of Object.entries(payload)) {
                    if (value === undefined || value === null) continue
                    form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
                }
                for (const file of files) form.append('files', file, file.name)
                init = { method: 'POST', body: form, signal, headers: { Accept: 'text/event-stream, application/json' } }
            } else {
                init = {
                    method: 'POST',
                    body: JSON.stringify(payload),
                    signal,
                    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' }
                }
            }
            const res = await doFetch(`${host}/api/v1/prediction/${id}`, init)
            if (!res.ok) throw await readError(res)
            const type = res.headers.get('content-type') || ''
            if (type.includes('text/event-stream') && res.body && typeof res.body.getReader === 'function') {
                const parser = createEventParser((evt) => handlers.onEvent?.(evt))
                const reader = res.body.getReader()
                const decoder = new TextDecoder()
                for (;;) {
                    const { value, done } = await reader.read()
                    if (done) break
                    parser.push(decoder.decode(value, { stream: true }))
                }
                parser.push(decoder.decode())
                parser.end()
                return
            }
            const text = await res.text()
            let json
            try {
                json = JSON.parse(text)
            } catch {
                json = { text }
            }
            handlers.onJson?.(json)
        },

        async feedback({ messageId, chatId, rating }) {
            const res = await doFetch(`${host}/api/v1/feedback/${id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ chatflowid: flowId, chatId, messageId, rating })
            })
            if (!res.ok) throw await readError(res)
        },

        /** URL of a file the run saved for this chat (charts and other image artifacts). */
        fileUrl(chatId, name) {
            const fileName = String(name || '').replace(/^FILE-STORAGE::/, '')
            const params = new URLSearchParams({ chatflowId: flowId, chatId: chatId || '', fileName })
            return `${host}/api/v1/get-upload-file?${params.toString()}`
        },

        /** Reads a session file with the token in a header, for pages where the session cookie is not sent. */
        async fileBlob(url, sessionToken) {
            const res = await doFetch(url, { headers: sessionToken ? { 'x-cuttlely-session-token': sessionToken } : {} })
            if (!res.ok) throw await readError(res)
            return res.blob()
        }
    }
}

/** What to tell a visitor for a failed request. */
export function describeError(error, custom) {
    const status = error?.status
    if (status === 401) return { kind: 'private', message: 'This chat is private or needs a key.' }
    if (status === 403) return { kind: 'origin', message: 'This chat is not available on this site.' }
    if (status === 404) return { kind: 'missing', message: 'This chat could not be found.' }
    if (status === 429) return { kind: 'busy', message: 'Too many messages. Wait a moment and try again.' }
    if (error?.name === 'TypeError' || status === 0)
        return { kind: 'offline', message: 'Could not reach the chat. Check your connection and try again.' }
    return { kind: 'error', message: custom || 'Something went wrong. Try again.' }
}
