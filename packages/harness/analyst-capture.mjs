import crypto from 'node:crypto'
import { analystTracePreviewsEnabled, sqlPreviewFields } from './trace.mjs'
import { ANALYST_PAGE_TTL_MS } from './runtime/analyst-page.mjs'

// Hermes tool events only carry a short preview. The gateway sees the full analyst result.
// A running specialist takes the rows recorded while it was in flight.
// Each analyst tool call also gets an id: the Hermes tool call id, or this run's sequence
// plus a fingerprint of the SQL. Saved traces do not store that id.

const pending = []
const calls = new Map()
const listeners = new Map()
const cursors = new Map()

function runKey(harness, specialist, chatId) {
    return `${String(harness || '')}\0${String(specialist || '')}\0${String(chatId || '')}`
}

// Drops trailing semicolons and spaces with a scan from the end, so a long run of them stays linear.
function withoutTrailingSemicolons(text) {
    let end = text.length
    while (end > 0 && (text[end - 1] === ';' || text[end - 1] === ' ')) end -= 1
    return text.slice(0, end).trim()
}

function normalisedStatement(sql) {
    return withoutTrailingSemicolons(String(sql || '').replace(/\s+/g, ' '))
}

function statementFingerprint(sql, cursor) {
    const statement = normalisedStatement(sql)
    if (statement) return crypto.createHash('sha256').update(statement).digest('hex').slice(0, 16)
    const token = String(cursor || '').trim()
    if (token) return crypto.createHash('sha256').update(`cursor:${token}`).digest('hex').slice(0, 16)
    return 'none'
}

// Full hash uses the same whitespace/trailing-semicolon normalisation as the call fingerprint.
// Redaction precedes the UTF-8 byte cap; the hash always describes the original statement.
export function sqlTraceFields(sql, { preview = false } = {}) {
    const text = String(sql ?? '')
    const normalised = normalisedStatement(text)
    const sqlHash = crypto.createHash('sha256').update(normalised).digest('hex')
    if (!preview) return { sqlHash }
    return { sqlHash, ...sqlPreviewFields(text) }
}

export function analystSqlTrace({ harness, specialist, chatId = '', sql = '', cursor = '' } = {}, env) {
    if (sql) return sqlTraceFields(sql, { preview: analystTracePreviewsEnabled(env) })
    const key = runKey(harness, specialist, chatId) + '\0' + cursor
    const cached = cursors.get(key)
    if (cached && Date.now() - cached.at < ANALYST_PAGE_TTL_MS) {
        const { at, ...fields } = cached
        if (!analystTracePreviewsEnabled(env)) return { sqlHash: fields.sqlHash }
        return fields
    }
    return sqlTraceFields('', { preview: analystTracePreviewsEnabled(env) })
}

// Hermes has the public MCP name; the gateway has the full arguments. Either can arrive first.
export function analystStartCapture(emit, { gatewayName } = {}) {
    const starts = []
    const metadata = []
    // A gateway id taken from the Hermes tool call pairs exactly. A sequence id (Hermes sent none) pairs by name, in order.
    const matches = (start, entry) => {
        if (entry.pairById && start.callId) return start.callId === entry.call.callId
        return start.name === entry.call.name || start.name.endsWith(`__${entry.call.name}`)
    }
    function drain() {
        for (let i = 0; i < starts.length; ) {
            const index = metadata.findIndex((call) => matches(starts[i], call))
            if (index < 0) {
                i += 1
                continue
            }
            const [start] = starts.splice(i, 1)
            const [{ call }] = metadata.splice(index, 1)
            emit({ ...start, ...call, name: start.name, ...(start.callId ? { callId: start.callId } : {}) })
        }
    }
    return {
        hermesStarted(start) {
            if (gatewayName !== undefined && start.name !== gatewayName) {
                emit(start)
                return
            }
            starts.push(start)
            drain()
        },
        gatewayStarted(call, { pairById = false } = {}) {
            metadata.push({ call, pairById })
            drain()
        },
        // Raw MCP tools have no gateway arguments; retain their existing lifecycle event.
        flush() {
            for (const start of starts.splice(0)) emit(start)
        }
    }
}

export function analystCaptureId({ callId = '', seq = 0, sql = '', cursor = '' } = {}) {
    const hermes = String(callId || '').trim()
    if (hermes) return hermes.slice(0, 200)
    const n = Number(seq)
    if (!Number.isInteger(n) || n < 1) return ''
    return `${n}:${statementFingerprint(sql, cursor)}`
}

export function beginAnalystCalls(harness, specialist, chatId = '', onStart = null) {
    listeners.delete(runKey(harness, specialist, chatId))
    if (onStart) listeners.set(runKey(harness, specialist, chatId), onStart)
    calls.set(runKey(harness, specialist, chatId), [])
}

export function endAnalystCalls(harness, specialist, chatId = '') {
    calls.delete(runKey(harness, specialist, chatId))
    listeners.delete(runKey(harness, specialist, chatId))
}

export function noteAnalystGatewayCall({
    harness,
    specialist,
    chatId = '',
    callId = '',
    sql = '',
    cursor = '',
    toolName = 'query',
    pinned = null
} = {}) {
    const key = runKey(harness, specialist, chatId)
    const list = calls.get(key) || []
    calls.set(key, list)
    const seq = list.length + 1
    const id = analystCaptureId({ callId, seq, sql, cursor })
    const traceFields = analystSqlTrace({ harness, specialist, chatId, sql, cursor })
    list.push({ id, seq, traceFields, ...(pinned ? { pinned } : {}) })
    const onStart = listeners.get(key)
    if (typeof onStart === 'function')
        onStart(
            { name: toolName, callId: id, ...traceFields, ...(pinned ? { pinned } : {}) },
            { pairById: Boolean(String(callId || '').trim()) }
        )
    return id
}

export function analystCallsFor(harness, specialist, chatId = '') {
    return calls.get(runKey(harness, specialist, chatId)) || []
}

// timings is the store's step-timing record for the call (numbers only), shown on the run trace's query step.
const EMPTY_SQL_HASH = sqlTraceFields('').sqlHash

export function recordAnalystResult({
    harness,
    specialist,
    chatId = '',
    result,
    callId = '',
    at = Date.now(),
    timings = null,
    sql = '',
    cursor = '',
    pinned = null,
    toolName = '',
    sourceTurn = '',
    freeSqlWithPin = null,
    executedSql = ''
} = {}) {
    if (!harness || !specialist || result == null) return
    const call = (calls.get(runKey(harness, specialist, chatId)) || []).find((item) => item.id === callId)
    let traceFields = call?.traceFields || analystSqlTrace({ harness, specialist, chatId, sql, cursor })
    // A pinned call is noted before the node compiles the statement. The executed text replaces that empty hash.
    if (executedSql && traceFields?.sqlHash === EMPTY_SQL_HASH) {
        traceFields = analystSqlTrace({ harness, specialist, chatId, sql: executedSql, cursor: '' })
    }
    if (result?.cursor) {
        const now = Date.now()
        for (const [key, value] of cursors) if (now - value.at >= ANALYST_PAGE_TTL_MS) cursors.delete(key)
        cursors.set(runKey(harness, specialist, chatId) + '\0' + result.cursor, { ...traceFields, at: now })
    }
    pending.push({
        traceFields,
        ...(pinned ? { pinned } : {}),
        ...(Array.isArray(freeSqlWithPin) && freeSqlWithPin.length ? { freeSqlWithPin } : {}),
        harness: String(harness),
        specialist: String(specialist),
        chatId: String(chatId || ''),
        callId: String(callId || '').trim(),
        result,
        ...(toolName ? { toolName } : {}),
        ...(sourceTurn ? { sourceTurn } : {}),
        ...(timings && typeof timings === 'object' ? { timings } : {}),
        at,
        claimed: false
    })
    if (pending.length > 200) pending.splice(0, pending.length - 200)
}

// specialist is the analyst that returned the cursor, so "show more" pages that analyst when a harness has several.
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
        if (Number.isFinite(ttl) && ttl >= 0 && age >= ttl) return { expired: true, summary, specialist: item.specialist }
        // A pinned query's cursor pages through the same pq_ tool; free SQL pages through query.
        const tool = typeof item.pinned?.name === 'string' ? item.pinned.name : ''
        return { token, summary, specialist: item.specialist, ...(tool ? { tool } : {}) }
    }
    return null
}

export function takeAnalystResults({ harness, specialist, chatId = '', since = 0, callIds, sourceTurn } = {}) {
    const name = String(harness || '')
    const who = String(specialist || '')
    const chat = String(chatId || '')
    const rows = pending.filter(
        (item) =>
            !item.claimed &&
            item.harness === name &&
            item.specialist === who &&
            item.chatId === chat &&
            item.at >= since &&
            (!Array.isArray(callIds) || callIds.includes(item.callId)) &&
            (sourceTurn === undefined || item.sourceTurn === sourceTurn)
    )
    for (const item of rows) item.claimed = true
    return rows.map((item) => ({
        traceFields: item.traceFields,
        result: item.result,
        ...(item.toolName ? { toolName: item.toolName } : {}),
        ...(item.sourceTurn ? { sourceTurn: item.sourceTurn } : {}),
        callId: item.callId || '',
        ...(item.timings ? { timings: item.timings } : {}),
        ...(item.pinned ? { pinned: item.pinned } : {}),
        ...(item.freeSqlWithPin ? { freeSqlWithPin: item.freeSqlWithPin } : {})
    }))
}

export function resetAnalystCapture() {
    pending.length = 0
    calls.clear()
    listeners.clear()
    cursors.clear()
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
    for (const key of cursors.keys()) {
        const parts = key.split('\0')
        if (parts[0] === name && parts[2] === chat) cursors.delete(key)
    }
    for (const key of [...calls.keys()]) {
        const parts = key.split('\0')
        if (parts[0] === name && parts[2] === chat) {
            calls.delete(key)
            listeners.delete(key)
        }
    }
}
