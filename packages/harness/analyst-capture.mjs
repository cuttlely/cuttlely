import crypto from 'node:crypto'
import { ANALYST_PAGE_TTL_MS } from './runtime/analyst-page.mjs'

// Hermes tool events only carry a short preview. The gateway sees the full analyst result.
// A running specialist takes the rows recorded while it was in flight.
// Each analyst tool call also gets an id: the Hermes tool call id, or this run's sequence
// plus a fingerprint of the SQL. Saved traces do not store that id.

const pending = []
const calls = new Map()

function runKey(harness, specialist, chatId) {
    return `${String(harness || '')}\0${String(specialist || '')}\0${String(chatId || '')}`
}

function statementFingerprint(sql, cursor) {
    const statement = String(sql || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/(?:\s*;+)+\s*$/, '')
        .trim()
    if (statement) return crypto.createHash('sha256').update(statement).digest('hex').slice(0, 16)
    const token = String(cursor || '').trim()
    if (token) return crypto.createHash('sha256').update(`cursor:${token}`).digest('hex').slice(0, 16)
    return 'none'
}

export function analystCaptureId({ callId = '', seq = 0, sql = '', cursor = '' } = {}) {
    const hermes = String(callId || '').trim()
    if (hermes) return hermes.slice(0, 200)
    const n = Number(seq)
    if (!Number.isInteger(n) || n < 1) return ''
    return `${n}:${statementFingerprint(sql, cursor)}`
}

export function beginAnalystCalls(harness, specialist, chatId = '') {
    calls.set(runKey(harness, specialist, chatId), [])
}

export function endAnalystCalls(harness, specialist, chatId = '') {
    calls.delete(runKey(harness, specialist, chatId))
}

export function noteAnalystGatewayCall({ harness, specialist, chatId = '', callId = '', sql = '', cursor = '' } = {}) {
    const key = runKey(harness, specialist, chatId)
    const list = calls.get(key) || []
    calls.set(key, list)
    const seq = list.length + 1
    const id = analystCaptureId({ callId, seq, sql, cursor })
    list.push({ id, seq })
    return id
}

export function analystCallsFor(harness, specialist, chatId = '') {
    return calls.get(runKey(harness, specialist, chatId)) || []
}

export function recordAnalystResult({ harness, specialist, chatId = '', result, callId = '', at = Date.now() } = {}) {
    if (!harness || !specialist || result == null) return
    pending.push({
        harness: String(harness),
        specialist: String(specialist),
        chatId: String(chatId || ''),
        callId: String(callId || '').trim(),
        result,
        at,
        claimed: false
    })
    if (pending.length > 200) pending.splice(0, pending.length - 200)
}

export function latestAnalystCursor({ harness, chatId, now = Date.now(), ttlMs = ANALYST_PAGE_TTL_MS } = {}) {
    const name = String(harness || '')
    const chat = String(chatId || '')
    const ttl = Number(ttlMs)
    for (let i = pending.length - 1; i >= 0; i -= 1) {
        const item = pending[i]
        if (item.harness !== name) continue
        if (chat && item.chatId !== chat) continue
        const token = item.result && typeof item.result === 'object' ? item.result.cursor : ''
        if (typeof token !== 'string' || !token) continue
        const summary = String(item.result.summary || '')
        // The store drops the cursor when it expires. The capture still has the time,
        // so a later "show more" can say so without asking the analyst to guess.
        const age = now - Number(item.at || 0)
        if (Number.isFinite(ttl) && ttl >= 0 && age >= ttl) return { expired: true, summary }
        return { token, summary }
    }
    return null
}

export function takeAnalystResults({ harness, specialist, chatId = '', since = 0 } = {}) {
    const name = String(harness || '')
    const who = String(specialist || '')
    const chat = String(chatId || '')
    const rows = pending.filter(
        (item) => !item.claimed && item.harness === name && item.specialist === who && item.chatId === chat && item.at >= since
    )
    for (const item of rows) item.claimed = true
    return rows.map((item) => ({ result: item.result, callId: item.callId || '' }))
}

export function resetAnalystCapture() {
    pending.length = 0
    calls.clear()
}

// A publish-check replay must not leave a page cursor or a captured row for this chat.
// Other chats, including a published run of the same harness, stay.
export function dropAnalystCapture({ harness, chatId } = {}) {
    const name = String(harness || '')
    const chat = String(chatId || '')
    if (!name || !chat) return
    for (let i = pending.length - 1; i >= 0; i -= 1) {
        if (pending[i].harness === name && pending[i].chatId === chat) pending.splice(i, 1)
    }
    for (const key of [...calls.keys()]) {
        const parts = key.split('\0')
        if (parts[0] === name && parts[2] === chat) calls.delete(key)
    }
}
