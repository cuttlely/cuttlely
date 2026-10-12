import { randomUUID } from 'node:crypto'
import { settleToolChips } from './trace.mjs'
import { database, immediate } from './lock.mjs'
import { assertHarnessName } from './store.mjs'

// The list is a product surface. It keeps status, latency, token counts, and short previews.
// Document bodies, tool arguments, and credentials stay on the turn payload, not in this table.
const PREVIEW = 240
const KEEP = 100
const TRACE_ID = /^[A-Za-z0-9_-]{1,80}$/
const SOURCES = new Set(['playground', 'api', 'prediction'])

function ensure(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS run_history (
            id TEXT PRIMARY KEY,
            harness_name TEXT NOT NULL,
            chat_id TEXT,
            status TEXT NOT NULL,
            source TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            latency_ms INTEGER,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            error_code TEXT,
            error_message TEXT,
            input_preview TEXT,
            text_preview TEXT,
            agents_json TEXT,
            timings_json TEXT,
            trace_id TEXT,
            trace_json TEXT
        );
        CREATE INDEX IF NOT EXISTS run_history_harness ON run_history (harness_name, started_at DESC);
    `)
    const columns = db.prepare('PRAGMA table_info(run_history)').all()
    if (!columns.some((column) => column.name === 'trace_json')) {
        db.exec('ALTER TABLE run_history ADD COLUMN trace_json TEXT')
    }
}

export function previewText(value, limit = PREVIEW) {
    let text = String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    text = text
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
        .replace(/\bxai-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, '[redacted]')
    if (text.length > limit) text = `${text.slice(0, limit)}…`
    return text
}

export function safeTraceId(value) {
    return typeof value === 'string' && TRACE_ID.test(value) ? value : null
}

function sourceOf(value) {
    return SOURCES.has(value) ? value : 'prediction'
}

function harnessNameOf(name) {
    try {
        return assertHarnessName(name)
    } catch {
        return null
    }
}

function tokenNumber(value) {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
}

function tokensOf(result) {
    const tokens = result?.report?.tokens
    if (!tokens || typeof tokens !== 'object') return { prompt: null, completion: null }
    return {
        prompt: tokenNumber(tokens.prompt),
        completion: tokenNumber(tokens.completion)
    }
}

function timingsOf(result) {
    const raw = result?.report?.timings || result?.timings
    if (!raw || typeof raw !== 'object') return null
    const out = {}
    for (const key of ['routeMs', 'specialistsMs', 'handoffMs', 'profileMs', 'fillMs', 'toolMs']) {
        if (Number.isFinite(raw[key])) out[key] = Math.max(0, Math.round(raw[key]))
    }
    return Object.keys(out).length ? out : null
}

function agentsOf(result) {
    if (!Array.isArray(result?.agents)) return []
    return result.agents.slice(0, 16).map((agent) => {
        const row = {
            name: String(agent?.name || '').slice(0, 64),
            status: String(agent?.status || '').slice(0, 32),
            ms: Number.isFinite(agent?.ms) ? Math.max(0, Math.round(agent.ms)) : null
        }
        if (agent?.error) row.error = previewText(agent.error, 120)
        return row
    })
}

function toPublic(row) {
    let agents = []
    let timings = null
    try {
        const parsed = JSON.parse(row.agents_json || '[]')
        agents = Array.isArray(parsed) ? parsed : []
    } catch {
        agents = []
    }
    try {
        timings = row.timings_json ? JSON.parse(row.timings_json) : null
    } catch {
        timings = null
    }
    const traceId = row.trace_id || null
    let trace = null
    try {
        trace = row.trace_json ? JSON.parse(row.trace_json) : null
    } catch {
        trace = null
    }
    return {
        id: row.id,
        harness: row.harness_name,
        chatId: row.chat_id || '',
        status: row.status,
        source: row.source,
        startedAt: new Date(row.started_at).toISOString(),
        finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
        latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
        tokens: {
            prompt: row.prompt_tokens == null ? null : Number(row.prompt_tokens),
            completion: row.completion_tokens == null ? null : Number(row.completion_tokens)
        },
        error: row.error_code || row.error_message ? { code: row.error_code || 'harness_failed', message: row.error_message || '' } : null,
        inputPreview: row.input_preview || '',
        textPreview: row.text_preview || '',
        agents,
        timings,
        trace,
        traceId,
        tracePath: traceId ? `/execution/${traceId}` : null
    }
}

export function harnessRunRecordStatus(result, error) {
    if (error?.code === 'aborted') return 'cancelled'
    if (!result || error) return 'failed'
    const tools = (result.trace?.specialists || []).flatMap((item) => settleToolChips(item.tools || []))
    if (tools.some((tool) => tool.status === 'failed')) return 'completed_with_errors'
    return 'succeeded'
}

function traceForRecord(result) {
    const trace = result?.trace
    if (!trace || typeof trace !== 'object' || !Array.isArray(trace.specialists)) return trace
    return {
        ...trace,
        specialists: trace.specialists.map((item) => ({
            ...item,
            tools: settleToolChips(item.tools || [])
        }))
    }
}

function traceJson(result) {
    const trace = result?.trace
    if (!trace || typeof trace !== 'object' || !trace.route) return null
    try {
        const body = JSON.stringify(trace)
        if (body.length > 20000) return null
        return body
    } catch {
        return null
    }
}

function prune(db, name) {
    db.prepare(
        `DELETE FROM run_history
         WHERE harness_name = ?
           AND id NOT IN (
                SELECT id FROM run_history WHERE harness_name = ? ORDER BY started_at DESC, id DESC LIMIT ?
           )`
    ).run(name, name, KEEP)
}

export function beginHarnessRun({ name, chatId, source, startedAt, input, traceId } = {}) {
    const harnessName = harnessNameOf(name)
    if (!harnessName) return null
    const id = `run_${randomUUID()}`
    const started = Number.isFinite(startedAt) ? startedAt : Date.now()
    immediate((db) => {
        ensure(db)
        db.prepare(
            `INSERT INTO run_history (
                id, harness_name, chat_id, status, source, started_at, input_preview, trace_id
             ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`
        ).run(id, harnessName, chatId ? String(chatId) : '', sourceOf(source), started, previewText(input), safeTraceId(traceId))
        prune(db, harnessName)
    })
    return getRun(harnessName, id)
}

export function finishHarnessRun(pending, { result, error, finishedAt, traceId } = {}) {
    if (!pending?.id || !pending?.harness) return null
    const finished = Number.isFinite(finishedAt) ? finishedAt : Date.now()
    const started = Date.parse(pending.startedAt)
    const latency = Number.isFinite(started) ? Math.max(0, finished - started) : 0
    const recorded = result ? { ...result, trace: traceForRecord(result) } : result
    const status = harnessRunRecordStatus(recorded, error)
    const tokens = tokensOf(result)
    const timings = timingsOf(result)
    const agents = agentsOf(result)
    immediate((db) => {
        ensure(db)
        db.prepare(
            `UPDATE run_history
             SET status = ?, finished_at = ?, latency_ms = ?, prompt_tokens = ?, completion_tokens = ?,
                 error_code = ?, error_message = ?, text_preview = ?, agents_json = ?, timings_json = ?,
                 trace_json = ?, trace_id = COALESCE(?, trace_id)
             WHERE id = ? AND harness_name = ?`
        ).run(
            status,
            finished,
            latency,
            tokens.prompt,
            tokens.completion,
            error ? String(error.code || 'harness_failed').slice(0, 64) : null,
            error ? previewText(error.message || '', 240) : null,
            previewText(recorded?.text || ''),
            JSON.stringify(agents),
            timings ? JSON.stringify(timings) : null,
            traceJson(recorded),
            safeTraceId(traceId),
            pending.id,
            pending.harness
        )
    })
    return getRun(pending.harness, pending.id)
}

export function listRuns(name, { limit = 50 } = {}) {
    const harnessName = harnessNameOf(name)
    if (!harnessName) return []
    const cap = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50
    const db = database()
    ensure(db)
    return db
        .prepare('SELECT * FROM run_history WHERE harness_name = ? ORDER BY started_at DESC, id DESC LIMIT ?')
        .all(harnessName, cap)
        .map(toPublic)
}

export function getRun(name, id) {
    const harnessName = harnessNameOf(name)
    if (!harnessName || typeof id !== 'string' || !id.startsWith('run_')) return null
    const db = database()
    ensure(db)
    const row = db.prepare('SELECT * FROM run_history WHERE id = ? AND harness_name = ?').get(id, harnessName)
    return row ? toPublic(row) : null
}

export function attachTrace(name, id, traceId) {
    const safe = safeTraceId(traceId)
    const existing = getRun(name, id)
    if (!safe || !existing) return null
    immediate((db) => {
        ensure(db)
        db.prepare('UPDATE run_history SET trace_id = ? WHERE id = ? AND harness_name = ?').run(safe, existing.id, existing.harness)
    })
    return getRun(existing.harness, existing.id)
}
