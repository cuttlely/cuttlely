// Prediction API client for the pressure test: plain JSON calls and SSE streams, with timing. Never prints a key.
import fs from 'node:fs'
import { BASE } from './lib.mjs'
import { pt } from './paths.mjs'

export const STATE_FILE = process.env.E2E_API_STATE || pt('api-state.json')
export const KEYS_FILE = process.env.E2E_API_KEYS || pt('apikeys.json')
export const PROXY = process.env.E2E_PROXY_URL || 'http://127.0.0.1:3120'

export const loadState = () => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {})
export const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
export const loadKeys = () => (fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) : {})
export function saveKeys(keys) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 })
    fs.chmodSync(KEYS_FILE, 0o600)
}

function headers({ key, origin, extra } = {}) {
    const h = { 'content-type': 'application/json' }
    if (key) h.authorization = `Bearer ${key}`
    if (origin) h.origin = origin
    return { ...h, ...(extra || {}) }
}

// Non-streaming prediction. Returns status, ms, a few headers, and the parsed body.
export async function predict(flowId, body, { key, origin, base = BASE, extra, timeoutMs = 120000 } = {}) {
    const t0 = performance.now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
        const res = await fetch(`${base}/api/v1/prediction/${flowId}`, {
            method: 'POST',
            headers: headers({ key, origin, extra }),
            body: JSON.stringify(body),
            signal: ctl.signal
        })
        const text = await res.text()
        let data
        try {
            data = JSON.parse(text)
        } catch {
            data = text
        }
        return { status: res.status, ms: performance.now() - t0, headers: pickHeaders(res.headers), data, raw: text }
    } catch (error) {
        return {
            status: error.name === 'AbortError' ? 'TIMEOUT' : 'NETERR',
            ms: performance.now() - t0,
            error: String(error.cause?.code || error.name)
        }
    } finally {
        clearTimeout(timer)
    }
}

export function pickHeaders(h) {
    const out = {}
    for (const name of [
        'content-type',
        'access-control-allow-origin',
        'access-control-allow-credentials',
        'access-control-allow-methods',
        'access-control-allow-headers',
        'retry-after',
        'ratelimit-limit',
        'ratelimit-remaining',
        'ratelimit-reset',
        'x-ratelimit-limit',
        'x-ratelimit-remaining',
        'vary',
        'x-accel-buffering'
    ]) {
        const v = h.get(name)
        if (v !== null) out[name] = v
    }
    return out
}

// Streaming prediction over SSE. Records the event order, time to first byte and first token, and how it ended.
export async function stream(flowId, body, { key, origin, base = BASE, abortAfterTokens, timeoutMs = 120000 } = {}) {
    const t0 = performance.now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort('timeout'), timeoutMs)
    const out = { status: null, events: [], order: [], tokens: 0, text: '', firstByteMs: null, firstTokenMs: null, ms: null, ended: null }
    try {
        const res = await fetch(`${base}/api/v1/prediction/${flowId}`, {
            method: 'POST',
            headers: headers({ key, origin }),
            body: JSON.stringify({ ...body, streaming: true }),
            signal: ctl.signal
        })
        out.status = res.status
        out.headers = pickHeaders(res.headers)
        if (!(res.headers.get('content-type') || '').includes('event-stream')) {
            out.raw = await res.text()
            try {
                out.data = JSON.parse(out.raw)
            } catch {}
            out.ms = performance.now() - t0
            out.ended = 'not-sse'
            return out
        }
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (out.firstByteMs === null) out.firstByteMs = performance.now() - t0
            buf += dec.decode(value, { stream: true })
            let idx
            while ((idx = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, idx)
                buf = buf.slice(idx + 2)
                const dataLine = block
                    .split('\n')
                    .filter((l) => l.startsWith('data:'))
                    .map((l) => l.slice(5))
                    .join('\n')
                if (!dataLine) continue
                let ev
                try {
                    ev = JSON.parse(dataLine)
                } catch {
                    ev = { event: 'unparsed', data: dataLine.slice(0, 200) }
                }
                const name = ev.event || 'unknown'
                if (name === 'token') {
                    out.tokens += 1
                    out.text += typeof ev.data === 'string' ? ev.data : ''
                    if (out.firstTokenMs === null) out.firstTokenMs = performance.now() - t0
                }
                if (out.order[out.order.length - 1] !== name) out.order.push(name)
                if (name !== 'token') out.events.push({ event: name, atMs: Math.round(performance.now() - t0), data: ev.data })
                if (abortAfterTokens && out.tokens >= abortAfterTokens) {
                    out.ended = 'client-aborted'
                    out.abortedAtMs = performance.now() - t0
                    ctl.abort('client abort')
                    return out
                }
            }
        }
        out.ended = 'server-closed'
    } catch (error) {
        out.ended = out.ended || (ctl.signal.aborted ? 'TIMEOUT' : `NETERR:${error.cause?.code || error.name}`)
    } finally {
        clearTimeout(timer)
        out.ms = performance.now() - t0
    }
    return out
}

export function pct(list, p) {
    if (!list.length) return null
    const s = [...list].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}
