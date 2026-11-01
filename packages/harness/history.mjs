import { randomUUID } from 'node:crypto'
import { TRACE_JSON_LIMIT, redactSecrets, settleToolChips } from './trace.mjs'
import { database, immediate } from './lock.mjs'
import { assertHarnessName } from './store.mjs'

// The list is a product surface. It keeps status, latency, token counts, and short previews.
// Document bodies, tool arguments, and credentials stay on the turn payload, not in this table.
const PREVIEW = 240
const KEEP = 100
const TRACE_ID = /^[A-Za-z0-9_-]{1,80}$/
const RUN_ID = /^run_[A-Za-z0-9-]{8,80}$/
const SOURCES = new Set(['playground', 'api', 'prediction', 'schedule'])
// A stored result is the answer an API caller fetches later. Larger answers keep the text and drop the rest.
const RESULT_JSON_LIMIT = 1024 * 1024
const OPEN_STATUSES = ['queued', 'running']
const DIAGNOSTIC_LIMIT = 8
const DIAGNOSTIC_JSON_LIMIT = 16384
const DIAGNOSTIC_CONTEXTS = new Set([
    'number',
    'compact_monetary',
    'word_scale_monetary',
    'duration',
    'percentage',
    'percentage_interval',
    'date',
    'currency'
])
const DIAGNOSTIC_CURRENCIES = new Set(
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY']
)
const DIAGNOSTIC_UNIT =
    /^(?:[KMB]|%|acv|nacv|racv|arr|tcv|ram|thousand|million|billion|accounts?|customers?|opportunities|renewals|deals|seats|licenses|events?|rows?|users?|tickets?|contracts?|records?|employees?|percent|points?|millisecond|second|minute|hour|day|week)$/i

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
            trace_json TEXT,
            diagnostics_json TEXT
        );
        CREATE INDEX IF NOT EXISTS run_history_harness ON run_history (harness_name, started_at DESC);
        CREATE TABLE IF NOT EXISTS run_results (
            run_id TEXT PRIMARY KEY,
            harness_name TEXT NOT NULL,
            result_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
    `)
    const columns = db.prepare('PRAGMA table_info(run_history)').all()
    if (!columns.some((column) => column.name === 'trace_json')) {
        db.exec('ALTER TABLE run_history ADD COLUMN trace_json TEXT')
    }
    // The API key that started the run. Null is a signed-in person or a flow prediction.
    if (!columns.some((column) => column.name === 'api_key_id')) {
        db.exec('ALTER TABLE run_history ADD COLUMN api_key_id TEXT')
    }
    // Private author diagnostics never enter toPublic(), results, previews or the ordinary trace.
    if (!columns.some((column) => column.name === 'diagnostics_json')) {
        db.exec('ALTER TABLE run_history ADD COLUMN diagnostics_json TEXT')
    }
}

function diagnosticClaims(value) {
    if (!Array.isArray(value)) return []
    const claims = []
    const seen = new Set()
    for (const item of value.slice(0, 64)) {
        if (claims.length >= DIAGNOSTIC_LIMIT) break
        if (
            !item ||
            typeof item !== 'object' ||
            !['unsupported_number', 'unsupported_duration', 'unsupported_percentage', 'unsupported_date', 'unsupported_currency'].includes(
                item.issue
            )
        )
            continue
        const { literal, unit = '', contextType = 'number', specialist, pins } = item
        if (typeof literal !== 'string' || literal.length > 80) continue
        const numericLiteral = /^[-+]?\d+(?:,\d{3})*(?:\.\d+)?[KMB]?$/.test(literal)
        const intervalLiteral = /^[-+]?\d+(?:\.\d+)?:[-+]?\d+(?:\.\d+)?$/.test(literal)
        const dateLiteral = /^\d{4}-\d{2}-\d{2}$/.test(literal)
        const currencyUnit = /^\p{Sc}$/u.test(unit) || DIAGNOSTIC_CURRENCIES.has(unit)
        if (
            typeof literal !== 'string' ||
            literal.length > 80 ||
            !(
                numericLiteral ||
                (contextType === 'percentage_interval' && intervalLiteral) ||
                (contextType === 'date' && dateLiteral) ||
                (contextType === 'currency' && currencyUnit && literal === unit)
            ) ||
            typeof unit !== 'string' ||
            unit.length > 80 ||
            (unit !== '' &&
                unit !== 'calendar_date' &&
                !DIAGNOSTIC_UNIT.test(unit) &&
                !/^\p{Sc}$/u.test(unit) &&
                !DIAGNOSTIC_CURRENCIES.has(unit)) ||
            !DIAGNOSTIC_CONTEXTS.has(contextType)
        )
            continue
        if ((item.issue === 'unsupported_duration') !== (contextType === 'duration')) continue
        if ((item.issue === 'unsupported_percentage') !== ['percentage', 'percentage_interval'].includes(contextType)) continue
        if ((item.issue === 'unsupported_date') !== (contextType === 'date')) continue
        if ((item.issue === 'unsupported_currency') !== (contextType === 'currency')) continue
        if (contextType === 'currency' && (!currencyUnit || !(numericLiteral || literal === unit))) continue
        if (contextType === 'percentage_interval' && (!intervalLiteral || unit !== '%')) continue
        if (contextType === 'percentage' && (!numericLiteral || unit !== '%')) continue
        if (contextType === 'date' && (!dateLiteral || unit !== 'calendar_date')) continue
        const claim = { issue: item.issue, literal, unit, contextType }
        if (specialist !== undefined) {
            if (typeof specialist !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(specialist)) continue
            claim.specialist = specialist
        }
        if (pins !== undefined) {
            if (
                !Array.isArray(pins) ||
                !pins.length ||
                pins.length > 16 ||
                pins.some((pin) => typeof pin !== 'string' || !/^pq_[a-z0-9_]{1,77}$/.test(pin))
            )
                continue
            claim.pins = [...new Set(pins)]
        }
        const key = JSON.stringify(claim)
        if (seen.has(key)) continue
        seen.add(key)
        if (Buffer.byteLength(JSON.stringify([...claims, claim])) > DIAGNOSTIC_JSON_LIMIT) break
        claims.push(claim)
    }
    return claims
}

function diagnosticsJson(value) {
    try {
        const claims = diagnosticClaims(value)
        return claims.length ? JSON.stringify(claims) : null
    } catch {
        // Optional diagnostics must not fail a completed run or retain arbitrary objects.
        return null
    }
}

function keyIdOf(value) {
    return typeof value === 'string' && value ? value.slice(0, 128) : null
}

// undefined or null reads every row. A string reads only the rows that key started.
function keyFilter(apiKeyId) {
    if (apiKeyId === undefined || apiKeyId === null) return { sql: '', args: [] }
    return { sql: ' AND api_key_id = ?', args: [String(apiKeyId)] }
}

export function previewText(value, limit = PREVIEW) {
    let text = String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    text = redactSecrets(text)
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
        if (body.length > TRACE_JSON_LIMIT) return null
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
    db.prepare(`DELETE FROM run_results WHERE harness_name = ? AND run_id NOT IN (SELECT id FROM run_history WHERE harness_name = ?)`).run(
        name,
        name
    )
}

export function safeRunId(value) {
    return typeof value === 'string' && RUN_ID.test(value) ? value : null
}

export function newRunId() {
    return `run_${randomUUID()}`
}

// A run the caller already holds an id for. The row says queued until the runner opens it.
export function queueHarnessRun({ id, name, chatId, source, input, apiKeyId } = {}) {
    const harnessName = harnessNameOf(name)
    if (!harnessName) return null
    const runId = safeRunId(id) || newRunId()
    immediate((db) => {
        ensure(db)
        db.prepare(
            `INSERT INTO run_history (id, harness_name, chat_id, status, source, started_at, input_preview, api_key_id)
             VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`
        ).run(runId, harnessName, chatId ? String(chatId) : '', sourceOf(source), Date.now(), previewText(input), keyIdOf(apiKeyId))
        prune(db, harnessName)
    })
    return getRun(harnessName, runId)
}

export function beginHarnessRun({ id, name, chatId, source, startedAt, input, traceId, apiKeyId } = {}) {
    const harnessName = harnessNameOf(name)
    if (!harnessName) return null
    const given = safeRunId(id)
    const runId = given || newRunId()
    const started = Number.isFinite(startedAt) ? startedAt : Date.now()
    immediate((db) => {
        ensure(db)
        // A queued row keeps its queue time, so latency counts the wait as well. A row a restart marked interrupted
        // while its job still waited for an external worker is opened again.
        const queued = given
            ? db
                  .prepare(
                      `SELECT 1 AS ok FROM run_history
                       WHERE id = ? AND harness_name = ? AND (status = 'queued' OR (status = 'failed' AND error_code = 'interrupted'))`
                  )
                  .get(given, harnessName)
            : null
        if (queued) {
            db.prepare(
                `UPDATE run_history
                 SET status = 'running', finished_at = NULL, latency_ms = NULL, error_code = NULL, error_message = NULL,
                     trace_id = COALESCE(?, trace_id)
                 WHERE id = ? AND harness_name = ?`
            ).run(safeTraceId(traceId), given, harnessName)
            return
        }
        db.prepare(
            `INSERT INTO run_history (
                id, harness_name, chat_id, status, source, started_at, input_preview, trace_id, api_key_id
             ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`
        ).run(
            runId,
            harnessName,
            chatId ? String(chatId) : '',
            sourceOf(source),
            started,
            previewText(input),
            safeTraceId(traceId),
            keyIdOf(apiKeyId)
        )
        prune(db, harnessName)
    })
    return getRun(harnessName, runId)
}

// A queued run that never reached the runner, for example a busy chat or a refused team.
export function failQueuedRun(name, id, error) {
    const harnessName = harnessNameOf(name)
    const runId = safeRunId(id)
    if (!harnessName || !runId) return null
    immediate((db) => {
        ensure(db)
        db.prepare(
            `UPDATE run_history
             SET status = 'failed', finished_at = ?, latency_ms = MAX(0, ? - started_at), error_code = ?, error_message = ?
             WHERE id = ? AND harness_name = ? AND status = 'queued'`
        ).run(
            Date.now(),
            Date.now(),
            String(error?.code || 'harness_failed').slice(0, 64),
            previewText(error?.message || '', 240),
            runId,
            harnessName
        )
    })
    return getRun(harnessName, runId)
}

// Runs left queued or running by a process that stopped. Only rows that started before `before` are closed.
export function interruptOpenRuns({ before = Date.now(), message = 'The server stopped before this run finished.' } = {}) {
    let changed = 0
    immediate((db) => {
        ensure(db)
        const info = db
            .prepare(
                `UPDATE run_history
                 SET status = 'failed', finished_at = ?, error_code = 'interrupted', error_message = ?
                 WHERE status IN (${OPEN_STATUSES.map(() => '?').join(', ')}) AND started_at < ?`
            )
            .run(Date.now(), previewText(message, 240), ...OPEN_STATUSES, before)
        changed = info.changes
    })
    return changed
}

function storedResult(result) {
    if (!result || typeof result !== 'object') return null
    const artifacts = Array.isArray(result.artifacts)
        ? result.artifacts.map((item) => (item && typeof item === 'object' ? { ...item, base64: undefined } : item))
        : []
    const full = {
        text: typeof result.text === 'string' ? result.text : '',
        agents: Array.isArray(result.agents) ? result.agents : [],
        sources: Array.isArray(result.sources) ? result.sources : [],
        artifacts,
        report: result.report && typeof result.report === 'object' ? result.report : null
    }
    try {
        const body = JSON.stringify(full)
        if (body.length <= RESULT_JSON_LIMIT) return body
    } catch {
        // Falls through to the text-only copy.
    }
    return JSON.stringify({
        text: full.text.slice(0, RESULT_JSON_LIMIT / 2),
        agents: [],
        sources: [],
        artifacts: [],
        report: null,
        truncated: true
    })
}

export function saveRunResult(name, id, result) {
    const harnessName = harnessNameOf(name)
    const runId = safeRunId(id)
    const body = storedResult(result)
    if (!harnessName || !runId || !body) return false
    immediate((db) => {
        ensure(db)
        const exists = db.prepare('SELECT 1 AS ok FROM run_history WHERE id = ? AND harness_name = ?').get(runId, harnessName)
        if (!exists) return
        db.prepare(
            `INSERT INTO run_results (run_id, harness_name, result_json, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(run_id) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at`
        ).run(runId, harnessName, body, Date.now())
    })
    return true
}

export function getRunResult(name, id) {
    const harnessName = harnessNameOf(name)
    const runId = safeRunId(id)
    if (!harnessName || !runId) return null
    const db = database()
    ensure(db)
    const row = db.prepare('SELECT result_json FROM run_results WHERE run_id = ? AND harness_name = ?').get(runId, harnessName)
    if (!row) return null
    try {
        return JSON.parse(row.result_json)
    } catch {
        return null
    }
}

export function finishHarnessRun(pending, { result, error, finishedAt, traceId, diagnostics } = {}) {
    if (!pending?.id || !pending?.harness) return null
    const finished = Number.isFinite(finishedAt) ? finishedAt : Date.now()
    const started = Date.parse(pending.startedAt)
    const latency = Number.isFinite(started) ? Math.max(0, finished - started) : 0
    const recorded = result ? { ...result, trace: traceForRecord(result) } : result
    const status = harnessRunRecordStatus(recorded, error)
    const tokens = tokensOf(result)
    const timings = timingsOf(result)
    const agents = agentsOf(result)
    const privateDiagnostics = diagnosticsJson(diagnostics)
    immediate((db) => {
        ensure(db)
        db.prepare(
            `UPDATE run_history
             SET status = ?, finished_at = ?, latency_ms = ?, prompt_tokens = ?, completion_tokens = ?,
                 error_code = ?, error_message = ?, text_preview = ?, agents_json = ?, timings_json = ?,
                 trace_json = ?, trace_id = COALESCE(?, trace_id), diagnostics_json = ?
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
            privateDiagnostics,
            pending.id,
            pending.harness
        )
    })
    return getRun(pending.harness, pending.id)
}

export function listRuns(name, { limit = 50, apiKeyId } = {}) {
    const harnessName = harnessNameOf(name)
    if (!harnessName) return []
    const cap = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 50
    const db = database()
    ensure(db)
    const filter = keyFilter(apiKeyId)
    return db
        .prepare(`SELECT * FROM run_history WHERE harness_name = ?${filter.sql} ORDER BY started_at DESC, id DESC LIMIT ?`)
        .all(harnessName, ...filter.args, cap)
        .map(toPublic)
}

export function getRun(name, id, { apiKeyId } = {}) {
    const harnessName = harnessNameOf(name)
    if (!harnessName || !safeRunId(id)) return null
    const db = database()
    ensure(db)
    const filter = keyFilter(apiKeyId)
    const row = db.prepare(`SELECT * FROM run_history WHERE id = ? AND harness_name = ?${filter.sql}`).get(id, harnessName, ...filter.args)
    return row ? toPublic(row) : null
}

// The service must enforce workspace and author permissions before using this private getter.
// Scope is identical to getRun(); ordinary run history and saved results never include these claims.
export function getRunDiagnostics(name, id, { apiKeyId } = {}) {
    const harnessName = harnessNameOf(name)
    if (!harnessName || !safeRunId(id)) return null
    const db = database()
    ensure(db)
    const filter = keyFilter(apiKeyId)
    const row = db
        .prepare(`SELECT diagnostics_json FROM run_history WHERE id = ? AND harness_name = ?${filter.sql}`)
        .get(id, harnessName, ...filter.args)
    if (!row) return null
    let claims = []
    try {
        claims = diagnosticClaims(JSON.parse(row.diagnostics_json || '[]'))
    } catch {
        // Legacy/corrupt private metadata is not a reason to break run-history access.
    }
    return { runId: id, harness: harnessName, claims }
}

// True when a run in this chat was started by someone else: another key, or a person when apiKeyId is null.
export function chatBelongsToOtherCaller(name, chatId, apiKeyId) {
    const harnessName = harnessNameOf(name)
    if (!harnessName || typeof chatId !== 'string' || !chatId) return false
    const db = database()
    ensure(db)
    const row = db
        .prepare(`SELECT 1 AS other FROM run_history WHERE harness_name = ? AND chat_id = ? AND COALESCE(api_key_id, '') <> ? LIMIT 1`)
        .get(harnessName, chatId, keyIdOf(apiKeyId) || '')
    return Boolean(row)
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
