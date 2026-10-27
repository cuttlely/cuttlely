import { isAnalystCapSummary, sourceName, wantsAnalystRows } from './context.mjs'
import { isPinnedToolName } from './pinned-names.mjs'

const TASK_LIMIT = 500

const CHIEF_REASONS = {
    'chief.memory': 'Older turns were shortened so Harness Prime stayed inside its context budget.',
    'chief.request': 'The question was shortened so Harness Prime stayed inside its context budget.',
    'chief.instructions': 'Harness Prime instructions were shortened to fit the context budget.',
    'chief.toolResult': 'Specialist tool text was shortened before Harness Prime read it.',
    'chief.sources': 'Source snippets were shortened before Harness Prime read them.'
}

const SPECIALIST_PARTS = {
    instructions: (name) => `Instructions for ${name} were shortened to fit the specialist context budget.`,
    memory: (name) => `Older turns were dropped from ${name}'s prompt to fit the context budget.`,
    task: (name) => `The task for ${name} was shortened to fit the specialist context budget.`,
    toolResult: (name) => `Tool text from ${name} was shortened before Harness Prime read it.`,
    sources: (name) => `Source snippets from ${name} were shortened before Harness Prime read them.`
}

// Shared with history.mjs: SQL previews and the question shrink to fit this limit.
export const TRACE_JSON_LIMIT = 20000

// The same replacements previewText uses, with no length cut. A secret past the
// first 240 or 500 characters is still a secret.
export function redactSecrets(value) {
    return String(value ?? '')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
        .replace(/\bxai-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, '[redacted]')
}

// Browser-safe: trace.mjs is also used by the trace panel.
export function sqlPreviewFields(sql) {
    const bytes = new TextEncoder().encode(redactSecrets(sql))
    let end = Math.min(bytes.length, 4096)
    if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
    return {
        sql: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, end)),
        ...(end < bytes.length ? { sqlTruncated: true } : {})
    }
}

function redactTraceQuestion(value) {
    return redactSecrets(
        String(value ?? '')
            .replace(/\s+/g, ' ')
            .trim()
    )
}

function traceJsonFits(trace) {
    return JSON.stringify(trace).length <= TRACE_JSON_LIMIT
}

// Budget the serialized JSON, including escaping and truncation flags. Work
// latest-first; hashes, timings and the caller's tool objects stay untouched.
function fitTraceSqlPreviews(trace) {
    if (traceJsonFits(trace)) return trace
    trace.specialists = trace.specialists.map((item) => ({ ...item, tools: item.tools.map((tool) => ({ ...tool })) }))
    const tools = trace.specialists.flatMap((item) => item.tools)
    for (let index = tools.length - 1; index >= 0; index -= 1) {
        const tool = tools[index]
        if (typeof tool.sql !== 'string') continue
        const sql = tool.sql
        tool.sqlTruncated = true
        delete tool.sql
        if (!traceJsonFits(trace)) continue
        // Find the longest prefix that fits, without splitting a code point.
        const characters = Array.from(sql)
        let lo = 1
        let hi = characters.length
        let best = 0
        while (lo <= hi) {
            const mid = (lo + hi) >> 1
            tool.sql = characters.slice(0, mid).join('')
            if (traceJsonFits(trace)) {
                best = mid
                lo = mid + 1
            } else hi = mid - 1
        }
        if (best) tool.sql = characters.slice(0, best).join('')
        else delete tool.sql
        break
    }
    return trace
}

// A question that does not fit is cut, and marked so the caption does not treat
// the remaining words as the question the run asked. The row count and preview stay.
function fitTraceQuestion(trace, question) {
    const redacted = redactTraceQuestion(question)
    if (!redacted) return trace
    const full = { ...trace, question: redacted }
    if (traceJsonFits(full)) return full
    let lo = 0
    let hi = redacted.length
    let best = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const cut = `${redacted.slice(0, mid)}…`
        if (traceJsonFits({ ...trace, question: cut, questionCut: true })) {
            best = mid
            lo = mid + 1
        } else hi = mid - 1
    }
    if (best < 0) return trace
    return { ...trace, question: `${redacted.slice(0, best)}…`, questionCut: true }
}

// A cut question is not evidence that the answer has the rows. Callers that still
// have the sent prompt, the previous chat message, or an uncut preview pass that instead.
export function traceQuestionForCaption(trace) {
    if (!trace || trace.questionCut) return ''
    return typeof trace.question === 'string' ? trace.question.trim() : ''
}

export function publicTask(task) {
    const value = String(task ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    if (value.length <= TASK_LIMIT) return value
    return `${value.slice(0, TASK_LIMIT)}…`
}

export function publicModelLabel(binding) {
    if (!binding || typeof binding !== 'object') return ''
    const label = String(binding.label || binding.nodeName || '').trim()
    const raw = binding.inputs && (binding.inputs.modelName || binding.inputs.model)
    const model = typeof raw === 'string' ? raw.trim() : ''
    const safeModel = model && model.length <= 80 && !/sk-|api[_-]?key|bearer |secret|password/i.test(model) ? model : ''
    if (label && safeModel && label !== safeModel) return `${label} · ${safeModel}`
    return label || safeModel
}

export function publicSourceName(doc) {
    const name = sourceName(doc)
    if (!name) return ''
    const normalized = name.replace(/\\/g, '/')
    if (normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
        const base = normalized.split('/').filter(Boolean).pop()
        return base || 'source'
    }
    return name.slice(0, 180)
}

export function publicSources(sources) {
    const seen = new Set()
    const list = []
    for (const doc of sources || []) {
        const name = publicSourceName(doc)
        if (!name || seen.has(name)) continue
        seen.add(name)
        list.push({ name })
        if (list.length >= 8) break
    }
    return list
}

export function explainTruncation(field) {
    const key = String(field || '')
    if (CHIEF_REASONS[key]) return CHIEF_REASONS[key]
    const match = /^specialist:([^.]+)\.(.+)$/.exec(key)
    if (match && SPECIALIST_PARTS[match[2]]) return SPECIALIST_PARTS[match[2]](match[1])
    return key ? `${key} was shortened to fit the context budget.` : 'Part of the prompt was shortened to fit the context budget.'
}

export function sumCallTokens(calls) {
    let prompt = 0
    let completion = 0
    let cached = 0
    let seen = false
    let cachedSeen = false
    for (const call of calls || []) {
        if (!call?.tokens) continue
        seen = true
        prompt += Number(call.tokens.prompt) || 0
        completion += Number(call.tokens.completion) || 0
        if (call.tokens.cached != null) {
            cachedSeen = true
            cached += Number(call.tokens.cached) || 0
        }
    }
    if (!seen) return null
    return cachedSeen ? { prompt, completion, cached } : { prompt, completion }
}

export const LOCAL_TOOL_BATCH = /takes exactly one entry for local tools/i

export function routeSummary(trace) {
    if (!trace) return ''
    if (trace.direct) {
        const name = trace.specialists?.[0]?.name || 'one specialist'
        return `Direct to ${name}`
    }
    if (trace.route?.status === 'running' || trace.route?.status === 'pending') return 'Harness Prime is choosing specialists'
    const steps = trace.route?.steps || []
    if (!steps.length) return 'Harness Prime answered directly'
    // A step that waited for another reads "then": "Harness Prime sent work to analyst, then writer".
    return `Harness Prime sent work to ${steps
        .filter((step) => step.specialist)
        .map((step) => (step.after ? `then ${step.specialist}` : step.specialist))
        .join(', ')}`
}

export function toolChipLabel(tool) {
    const status =
        tool?.status === 'running' ? 'running' : tool?.status === 'failed' ? 'failed' : tool?.status === 'retried' ? 'retried' : 'done'
    return `${tool?.name || 'tool'} · ${status}`
}

// Matches the analyst row-cap maximum. The query already returns only the rows this page shows.
export const TRACE_ROW_LIMIT = 1000

// A new query step stores a short preview, not the page. These caps keep that preview small.
// The row cap below is the same ceiling the analyst uses: 100 unless the admin setting says otherwise, never above 1000.
export const TRACE_PREVIEW_ROWS = 5
export const TRACE_PREVIEW_COLUMNS = 4
export const TRACE_PREVIEW_CELL_CHARS = 40
export const TRACE_PREVIEW_BYTES = 1024
export const TRACE_ROW_CAP_DEFAULT = 100
export const TRACE_ROW_CAP_MAX = 1000

function isAnalystQueryChip(name) {
    const value = String(name || '')
    return value === 'query' || value.endsWith('__query') || isPinnedToolName(value)
}

function isFreeSqlChip(name) {
    const value = String(name || '')
    return value === 'query' || value.endsWith('__query')
}

function rowCell(value) {
    if (value == null) return ''
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
}

function readEnv(env) {
    if (env && typeof env === 'object') return env
    const proc = globalThis.process
    if (proc && proc.env) return proc.env
    return {}
}

function parseAnalystResult(detail) {
    try {
        let body = JSON.parse(String(detail))?.result
        if (typeof body === 'string') body = JSON.parse(body)
        if (!body || typeof body !== 'object' || Array.isArray(body)) return null
        return body
    } catch {
        return null
    }
}

function plainRows(rows) {
    return (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object' && !Array.isArray(row))
}

function finiteCount(value) {
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

// Unset keeps previews on. false, 0, off, and no turn them off. Any other value stays on.
export function analystTracePreviewsEnabled(env) {
    const raw = readEnv(env).CUTTLELY_ANALYST_TRACE_PREVIEW
    if (raw == null || String(raw).trim() === '') return true
    const value = String(raw).trim().toLowerCase()
    return value !== 'false' && value !== '0' && value !== 'off' && value !== 'no'
}

// Matches the admin row cap: unset or unusable stays at 100, and nothing above 1000 is kept.
// A fraction between 0 and 1 is one row, so a small override cannot fall through to the default.
export function analystTraceRowCap(env) {
    const raw = readEnv(env).CUTTLELY_ANALYST_ROW_CAP
    if (raw == null || String(raw).trim() === '') return TRACE_ROW_CAP_DEFAULT
    const n = Number(String(raw).trim())
    if (!Number.isFinite(n) || n <= 0) return TRACE_ROW_CAP_DEFAULT
    if (n < 1) return 1
    return Math.min(Math.floor(n), TRACE_ROW_CAP_MAX)
}

function clipText(value, limit) {
    const text = rowCell(value)
    if (text.length <= limit) return text
    if (limit <= 1) return '…'
    return `${text.slice(0, limit - 1)}…`
}

function previewBytes(preview) {
    const json = JSON.stringify(preview)
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length
    return json.length
}

function clipSummary(summary) {
    const text = typeof summary === 'string' ? summary.trim() : ''
    if (text.length <= 180) return text
    return `${text.slice(0, 179)}…`
}

// Rows past the cap are dropped before the preview is built. The preview then keeps the first few rows and
// columns, cuts each value short, and shrinks until the JSON fits in the byte cap.
export function analystQueryPreview(body, env) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.rows)) return null
    const cap = analystTraceRowCap(env)
    const available = plainRows(body.rows)
    const source = available.slice(0, cap)
    const rowCount = source.length
    // A next page exists only when the analyst marked the result truncated. A short preview of a finished page is not one.
    const nextPage = body.truncated === true
    if (!analystTracePreviewsEnabled(env) || !rowCount) return { rowCount, preview: null }
    const columns = []
    for (const row of source) {
        for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
    }
    let rowTake = Math.min(TRACE_PREVIEW_ROWS, source.length)
    let colTake = Math.min(TRACE_PREVIEW_COLUMNS, columns.length)
    let cellLimit = TRACE_PREVIEW_CELL_CHARS
    let summaryText = clipSummary(body.summary)
    const columnCount = columns.length
    for (let guard = 0; guard < 80; guard += 1) {
        const shownColumns = columns.slice(0, colTake).map((name) => clipText(name, cellLimit))
        const shownRows = source.slice(0, rowTake).map((row) => columns.slice(0, colTake).map((key) => clipText(row[key], cellLimit)))
        const preview = {
            columns: shownColumns,
            rows: shownRows,
            moreRows: source.length > shownRows.length,
            nextPage,
            moreColumns: columnCount > shownColumns.length,
            columnCount,
            ...(summaryText ? { summary: summaryText } : {})
        }
        if (previewBytes(preview) <= TRACE_PREVIEW_BYTES) return { rowCount, preview }
        if (rowTake > 1) {
            rowTake -= 1
            continue
        }
        if (colTake > 1) {
            colTake -= 1
            continue
        }
        if (cellLimit > 8) {
            cellLimit = Math.max(8, Math.floor(cellLimit / 2))
            continue
        }
        if (summaryText) {
            summaryText = ''
            continue
        }
        break
    }
    return {
        rowCount,
        preview: {
            columns: columns.slice(0, 1).map((name) => clipText(name, 8)),
            rows: [[clipText(source[0]?.[columns[0]], 8)]],
            moreRows: source.length > 1,
            nextPage,
            moreColumns: columnCount > 1,
            columnCount
        }
    }
}

// The rows an analyst query returned, from the result an older trace kept on that query's chip.
// A new trace stores analystQueryPreview instead, so this stays for runs saved before that.
export function analystChipRows(tool) {
    if (!tool?.detail || !isAnalystQueryChip(tool.name)) return null
    const body = parseAnalystResult(tool.detail)
    if (!body || !Array.isArray(body.rows)) return null
    const rows = plainRows(body.rows).slice(0, TRACE_ROW_LIMIT)
    if (!rows.length) return null
    const columns = []
    for (const row of rows) {
        for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
    }
    return {
        columns,
        rows: rows.map((row) => columns.map((key) => rowCell(row[key]))),
        summary: typeof body.summary === 'string' ? body.summary.trim() : '',
        truncated: body.truncated === true
    }
}

// What the run card draws for one query chip. A recorded preview wins. An older chip that still has its
// rows in detail falls back to that list. A chip with neither still returns null so the step renders.
export function analystStepView(tool) {
    if (!tool || !isAnalystQueryChip(tool.name)) return null
    const preview = tool.preview
    if (preview && typeof preview === 'object' && Array.isArray(preview.columns) && Array.isArray(preview.rows)) {
        const rows = preview.rows.filter((row) => Array.isArray(row)).map((row) => row.map((cell) => (cell == null ? '' : String(cell))))
        const rowCount = finiteCount(tool.rowCount) ?? rows.length
        if (rows.length || rowCount > 0) {
            return {
                rowCount,
                columns: preview.columns.map((column) => String(column)),
                rows,
                summary: typeof preview.summary === 'string' ? preview.summary : '',
                moreRows: preview.moreRows === true || rowCount > rows.length,
                nextPage: preview.nextPage === true,
                moreColumns: preview.moreColumns === true,
                columnCount: finiteCount(preview.columnCount) ?? preview.columns.length,
                legacy: false
            }
        }
    }
    const legacy = analystChipRows(tool)
    if (legacy) {
        return {
            rowCount: legacy.rows.length,
            columns: legacy.columns,
            rows: legacy.rows,
            summary: legacy.summary,
            moreRows: false,
            nextPage: legacy.truncated === true,
            moreColumns: false,
            columnCount: legacy.columns.length,
            legacy: true
        }
    }
    const rowCount = finiteCount(tool.rowCount)
    if (rowCount == null) return null
    return {
        rowCount,
        columns: [],
        rows: [],
        summary: '',
        moreRows: false,
        nextPage: false,
        moreColumns: false,
        columnCount: 0,
        legacy: false
    }
}

// The step timings of one analyst query: finite, non-negative numbers under known names, nothing else.
const QUERY_TIMING_FIELDS = [
    'connectMs',
    'dbMs',
    'cuttlelyMs',
    'bridgeMs',
    'guardMs',
    'planMs',
    'countMs',
    'pageMs',
    'probeMs',
    'serializeMs',
    'totalMs',
    'statementRuns',
    'roundTrips'
]

export function queryStepTimings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const out = {}
    for (const field of QUERY_TIMING_FIELDS) {
        const n = value[field]
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[field] = n
    }
    return Object.keys(out).length ? out : null
}

// The public query step keeps the row count and, when previews are on, the short preview.
// The full page stays out of the trace. A create or a failure keeps its short detail.

function hashHex(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : ''
}

function pinnedTrace(tool, body) {
    const fromTool = tool?.pinned && typeof tool.pinned === 'object' && !Array.isArray(tool.pinned) ? tool.pinned : null
    const fromBody = body?.pinned && typeof body.pinned === 'object' && !Array.isArray(body.pinned) ? body.pinned : null
    if (!fromTool && !fromBody && body?.columnsChanged !== true) return null
    const source = { ...(fromBody || {}), ...(fromTool || {}) }
    const pinned = {}
    if (source.id != null) pinned.id = source.id
    if (source.name != null) pinned.name = source.name
    if (source.version != null) pinned.version = source.version
    const hash = source.hash || source.statementHash
    if (hash != null) pinned.hash = hash
    if (source.params && typeof source.params === 'object' && !Array.isArray(source.params)) pinned.params = source.params
    if (source.columnsChanged === true || body?.columnsChanged === true) pinned.columnsChanged = true
    const rowCount = finiteCount(source.rowCount) ?? (Array.isArray(body?.rows) ? body.rows.length : null)
    if (rowCount != null) pinned.rowCount = rowCount
    return Object.keys(pinned).length ? pinned : null
}

function stepExtras(tool, body) {
    const pinned = isPinnedToolName(tool?.name) ? pinnedTrace(tool, body) : null
    const free = isFreeSqlChip(tool?.name) && Array.isArray(tool?.freeSqlWithPin) && tool.freeSqlWithPin.length ? tool.freeSqlWithPin : null
    return { ...(pinned ? { pinned } : {}), ...(free ? { freeSqlWithPin: free } : {}) }
}

function detailWithoutTraceSql(detail, body) {
    if (!body || !Object.prototype.hasOwnProperty.call(body, '_cuttlelyTraceSql')) return String(detail)
    const copy = { ...body }
    delete copy._cuttlelyTraceSql
    try {
        const outer = JSON.parse(String(detail))
        if (outer && typeof outer === 'object' && !Array.isArray(outer) && typeof outer.result === 'string') {
            return JSON.stringify({ ...outer, result: JSON.stringify(copy) })
        }
    } catch {
        // The detail was the result object itself.
    }
    return JSON.stringify(copy)
}

export function publicToolStep(tool, env) {
    const analyst = isAnalystQueryChip(tool?.name)
    const body = analyst && tool?.detail ? parseAnalystResult(tool.detail) : null
    const sqlHash = analyst ? tool?.sqlHash || hashHex(body?.sqlHash) : ''
    const ownSql = analyst && tool?.sql !== undefined
    const previewSql =
        analyst && analystTracePreviewsEnabled(env)
            ? ownSql
                ? tool.sql
                : typeof body?._cuttlelyTraceSql === 'string'
                ? body._cuttlelyTraceSql
                : undefined
            : undefined
    const sqlFields = sqlHash
        ? {
              sqlHash,
              ...(previewSql !== undefined
                  ? { ...sqlPreviewFields(previewSql), ...(ownSql && tool.sqlTruncated ? { sqlTruncated: true } : {}) }
                  : {})
          }
        : {}
    const timings = analyst ? queryStepTimings(tool?.timings) : null
    const base = { name: tool?.name, status: tool?.status, ...(timings ? { timings } : {}), ...sqlFields, ...stepExtras(tool, body) }
    if (!tool?.detail || !analyst) {
        return tool?.detail ? { ...base, detail: detailWithoutTraceSql(tool.detail, body) } : base
    }
    if (!body || !Array.isArray(body.rows)) return { ...base, detail: detailWithoutTraceSql(tool.detail, body) }
    const shaped = analystQueryPreview(body, env)
    const next = { ...base, rowCount: shaped.rowCount }
    if (shaped.preview) next.preview = shaped.preview
    return next
}

// Rows are written back only when the summary is a page line AND the question asks for the rows.
// That is the same pair of tests preserveAnalystRows uses. A missing question is not that case.
function rowsRestoredInAnswer(view, question) {
    if (!view) return false
    const asked = typeof question === 'string' ? question.trim() : ''
    if (!asked || !wantsAnalystRows(asked)) return false
    return isAnalystCapSummary(view.summary)
}

// The caption under a query preview. "Say show more" follows truncated.
// The in-chat sentence follows the page line and the same question the handoff used.
export function analystPreviewCaption(view, question) {
    if (!view) return ''
    const shown = view.rows.length
    const total = view.rowCount
    const parts = []
    if (shown < total) parts.push(`Showing ${shown} of ${total} rows.`)
    else parts.push(`${total} row${total === 1 ? '' : 's'}.`)
    if (view.moreColumns && view.columnCount > view.columns.length) {
        parts.push(`Showing ${view.columns.length} of ${view.columnCount} columns.`)
    }
    if (rowsRestoredInAnswer(view, question)) parts.push('The rest of these rows are in the answer in this chat.')
    else if (shown < total) parts.push('The answer can show fewer rows than the query returned.')
    if (view.nextPage) parts.push('Say show more for the next page.')
    return parts.join(' ')
}

// A batched local tool_call is rejected, then the model sends one call at a time.
// That first rejection is recovered when a later tool in the same turn finishes.
export function settleToolChips(tools) {
    const list = (tools || []).filter((tool) => tool && typeof tool === 'object').map((tool) => ({ ...tool }))
    for (let i = 0; i < list.length; i += 1) {
        const tool = list[i]
        if (tool.status !== 'failed' || tool.name !== 'tool_call') continue
        if (!LOCAL_TOOL_BATCH.test(String(tool.detail || ''))) continue
        const recovered = list.slice(i + 1).some((later) => later.status === 'done' || later.status === 'retried')
        if (recovered) tool.status = 'retried'
    }
    return list
}

export function snapshotSpecialist({ calls, tools, name, configuredModel, failed = false, env } = {}) {
    const related = (calls || []).filter((call) => call.name === name && (call.role === 'specialist' || call.role === 'fill'))
    const last = [...related].reverse().find((call) => call.model)
    const ownTools = settleToolChips(
        (tools || [])
            .filter((tool) => tool.specialist === name)
            .map((tool) =>
                publicToolStep(
                    {
                        ...tool,
                        name: tool.name,
                        status: tool.status === 'running' && failed ? 'failed' : tool.status,
                        ...(tool.detail ? { detail: tool.detail } : {}),
                        ...(tool.timings ? { timings: tool.timings } : {})
                    },
                    env
                )
            )
    )
    return {
        model: last?.model || configuredModel || '',
        fallback: last?.fallback || '',
        tokens: sumCallTokens(related),
        tools: ownTools
    }
}

export function formatDuration(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return ''
    const value = Math.max(0, Number(ms))
    if (value < 1000) return `${Math.round(value)} ms`
    const seconds = value / 1000
    if (seconds < 10) return `${seconds.toFixed(1)} s`
    return `${Math.round(seconds)} s`
}

export function formatTokens(tokens) {
    if (!tokens || (tokens.prompt == null && tokens.completion == null)) return ''
    const count = (value) => (value == null ? '—' : Number(value).toLocaleString('en-US'))
    const cached = Number(tokens.cached) > 0 ? ` (${count(tokens.cached)} cached)` : ''
    return `${count(tokens.prompt)} in${cached} · ${count(tokens.completion)} out`
}

function blankRoute() {
    return { status: 'pending', ms: null, model: '', fallback: '', tokens: null, steps: [] }
}

function blankHandoff() {
    return { status: 'pending', ms: null, model: '', fallback: '', tokens: null }
}

export function emptyTrace(harness = '') {
    return {
        harness: harness || '',
        status: 'running',
        direct: false,
        wallMs: null,
        error: '',
        timings: { routeMs: 0, specialistsMs: 0, handoffMs: 0, profileMs: 0, profileSkipped: false },
        tokens: { prompt: null, completion: null },
        truncated: [],
        route: blankRoute(),
        specialists: [],
        handoff: blankHandoff()
    }
}

function specialistShell(name) {
    return {
        name,
        task: '',
        status: 'running',
        model: '',
        fallback: '',
        ms: null,
        tokens: null,
        tools: [],
        sources: [],
        error: ''
    }
}

function withSpecialist(trace, name, patch) {
    const specialists = trace.specialists.map((item) => ({ ...item, tools: [...item.tools], sources: [...item.sources] }))
    let index = specialists.findIndex((item) => item.name === name)
    if (index < 0) {
        specialists.push(specialistShell(name))
        index = specialists.length - 1
    }
    const current = specialists[index]
    const next = { ...current }
    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) next[key] = value
    }
    specialists[index] = next
    return specialists
}

function noteTool(specialists, event) {
    const name = event.specialist || ''
    const next = withSpecialist({ specialists }, name, {})
    const specialist = next.find((item) => item.name === name)
    const tools = [...specialist.tools]
    if (event.phase === 'start') {
        const traced = event.sqlHash || event.pinned || event.freeSqlWithPin
        tools.push({
            name: event.name || 'tool',
            status: 'running',
            ...(traced
                ? publicToolStep({
                      name: event.name,
                      status: 'running',
                      ...(event.sqlHash ? { sqlHash: event.sqlHash } : {}),
                      ...(event.sql !== undefined ? { sql: event.sql } : {}),
                      ...(event.sqlTruncated ? { sqlTruncated: true } : {}),
                      ...(event.pinned ? { pinned: event.pinned } : {}),
                      ...(event.freeSqlWithPin ? { freeSqlWithPin: event.freeSqlWithPin } : {})
                  })
                : {})
        })
    } else {
        const open = [...tools].reverse().find((tool) => tool.name === event.name && tool.status === 'running')
        const status = event.error ? 'failed' : 'done'
        const detail = event.detail ? String(event.detail) : ''
        if (open) {
            open.status = status
            if (detail) open.detail = detail
        } else tools.push({ name: event.name || 'tool', status, ...(detail ? { detail } : {}) })
    }
    return withSpecialist({ specialists: next }, name, { tools: settleToolChips(tools) })
}

// Until the final event brings the run's report, the header total is the sum of the steps that have reported.
export function liveTraceTokens(trace) {
    const parts = [trace?.route?.tokens, ...(trace?.specialists || []).map((item) => item.tokens), trace?.handoff?.tokens]
    let prompt = 0
    let completion = 0
    let cached = 0
    let seen = false
    let cachedSeen = false
    for (const part of parts) {
        if (!part || (part.prompt == null && part.completion == null)) continue
        seen = true
        prompt += Number(part.prompt) || 0
        completion += Number(part.completion) || 0
        if (part.cached != null) {
            cachedSeen = true
            cached += Number(part.cached) || 0
        }
    }
    if (!seen) return { prompt: null, completion: null }
    return { prompt, completion, ...(cachedSeen ? { cached } : {}) }
}

export function reduceHarnessEvent(trace, event) {
    const next = reduceHarnessStep(trace, event)
    if (!event || typeof event !== 'object' || event.type === 'final' || !next || next === trace) return next
    return { ...next, tokens: liveTraceTokens(next) }
}

function reduceHarnessStep(trace, event) {
    const current = trace || emptyTrace(event?.harness)
    if (!event || typeof event !== 'object') return current
    if (event.type === 'final') {
        if (event.trace?.specialists && event.trace?.route) {
            return event.trace.status === 'running' ? { ...event.trace, status: 'completed' } : event.trace
        }
        return traceFromPayload(event) || current
    }
    const next = {
        ...current,
        harness: event.harness || current.harness,
        tokens: { ...current.tokens },
        timings: { ...current.timings },
        truncated: [...current.truncated],
        route: { ...current.route, steps: [...(current.route.steps || [])] },
        specialists: current.specialists.map((item) => ({
            ...item,
            tools: item.tools.map((tool) => ({ ...tool })),
            sources: item.sources.map((source) => ({ ...source }))
        })),
        handoff: { ...current.handoff }
    }
    if (event.type === 'route' && event.phase === 'start') {
        next.route = { ...next.route, status: 'running' }
        return next
    }
    if (event.type === 'route' && event.phase === 'done') {
        next.direct = Boolean(event.direct)
        next.route = {
            ...next.route,
            status: 'done',
            ms: event.ms ?? next.route.ms,
            model: event.model || next.route.model,
            fallback: event.fallback || next.route.fallback || '',
            tokens: event.tokens === undefined ? next.route.tokens : event.tokens,
            ...(event.parseError
                ? {
                      parseError: String(event.parseError),
                      rawLength: Number(event.rawLength) || 0,
                      rawSha256: String(event.rawSha256 || ''),
                      retried: Boolean(event.retried),
                      ...(event.fallbackSpecialist ? { fallbackSpecialist: String(event.fallbackSpecialist) } : {})
                  }
                : event.fallbackSpecialist
                ? { fallbackSpecialist: String(event.fallbackSpecialist) }
                : {}),
            steps: Array.isArray(event.steps)
                ? event.steps.map((step) => ({
                      specialist: step.specialist,
                      task: step.task || '',
                      ...(step.after ? { after: step.after } : {})
                  }))
                : next.route.steps
        }
        return next
    }
    if (event.type === 'specialist' && event.phase === 'start') {
        next.specialists = withSpecialist(next, event.name, {
            status: 'running',
            task: event.task || '',
            model: event.model || ''
        })
        return next
    }
    if (event.type === 'specialist' && (event.phase === 'done' || event.phase === 'failed')) {
        next.specialists = withSpecialist(next, event.name, {
            status: event.status || (event.phase === 'failed' ? 'failed' : 'completed'),
            ms: event.ms ?? null,
            model: event.model || undefined,
            fallback: event.fallback || '',
            tokens: event.tokens === undefined ? undefined : event.tokens,
            tools: Array.isArray(event.tools) ? settleToolChips(event.tools) : undefined,
            sources: event.sources || undefined,
            error: event.error || '',
            task: event.task || undefined
        })
        return next
    }
    if (event.type === 'tool') {
        next.specialists = noteTool(next.specialists, event)
        return next
    }
    if (event.type === 'handoff' && event.phase === 'start') {
        next.handoff = { ...next.handoff, status: 'running', model: event.model || next.handoff.model }
        return next
    }
    if (event.type === 'handoff' && event.phase === 'done') {
        next.handoff = {
            ...next.handoff,
            status: 'done',
            ms: event.ms ?? next.handoff.ms,
            model: event.model || next.handoff.model,
            fallback: event.fallback || next.handoff.fallback || '',
            tokens: event.tokens === undefined ? next.handoff.tokens : event.tokens
        }
        return next
    }
    return next
}

export function failTrace(trace, message) {
    if (!trace) return trace
    const text = typeof message === 'string' ? message : message?.message || message?.error || 'The harness run stopped.'
    const reason = String(text).slice(0, 300)
    return {
        ...trace,
        status: 'failed',
        error: reason,
        specialists: (trace.specialists || []).map((item) =>
            item.status === 'running' ? { ...item, status: 'failed', error: item.error || 'Stopped before it finished.' } : item
        ),
        route: trace.route?.status === 'running' ? { ...trace.route, status: 'failed' } : trace.route,
        handoff: trace.handoff?.status === 'running' ? { ...trace.handoff, status: 'failed' } : trace.handoff
    }
}

export function buildRunTrace({
    harness,
    direct = false,
    steps = [],
    agents = [],
    timings = {},
    report = {},
    profileSkipped = false,
    wallMs = null,
    routeModel = '',
    routeTokens = null,
    routeFallback = '',
    handoffModel = '',
    handoffTokens = null,
    handoffFallback = '',
    handoffStatus = '',
    directDetail = null,
    routeParse = null,
    question = ''
} = {}) {
    const routeMs = timings.routeMs ?? 0
    const specialistsMs = timings.specialistsMs ?? timings.toolMs ?? 0
    const handoffMs = direct ? 0 : timings.handoffMs ?? 0
    const truncated = (report?.truncated || []).filter(Boolean).map((field) => ({ field, reason: explainTruncation(field) }))
    const body = {
        harness: harness || '',
        status: (agents || []).some((agent) => agent.status === 'failed') ? 'partial' : 'completed',
        direct: Boolean(direct),
        wallMs,
        error: '',
        timings: {
            routeMs,
            specialistsMs,
            handoffMs,
            profileMs: timings.profileMs ?? 0,
            profileSkipped: Boolean(profileSkipped)
        },
        tokens: {
            prompt: report?.tokens?.prompt ?? null,
            completion: report?.tokens?.completion ?? null,
            cached: report?.tokens?.cached ?? null
        },
        truncated,
        route: {
            status: 'done',
            ms: routeMs,
            model: routeModel || '',
            fallback: routeFallback || '',
            tokens: routeTokens,
            ...(routeParse?.error
                ? {
                      parseError: String(routeParse.error),
                      rawLength: Number(routeParse.rawLength) || 0,
                      rawSha256: String(routeParse.rawSha256 || ''),
                      retried: Boolean(routeParse.retried),
                      ...(routeParse.fallbackSpecialist ? { fallbackSpecialist: String(routeParse.fallbackSpecialist) } : {})
                  }
                : routeParse?.fallbackSpecialist
                ? { fallbackSpecialist: String(routeParse.fallbackSpecialist) }
                : {}),
            steps: (steps || []).map((step) => ({
                specialist: step.specialist || step.name || '',
                task: publicTask(step.task),
                ...(step.after ? { after: step.after } : {})
            }))
        },
        specialists: (agents || []).map((agent) => ({
            name: agent.name,
            task: publicTask(agent.task),
            status: agent.status || 'completed',
            model: agent.model || '',
            fallback: agent.fallback || '',
            ms: agent.ms ?? null,
            tokens: agent.tokens || null,
            tools: settleToolChips(agent.tools || []),
            sources: agent.sources || [],
            error: agent.error || ''
        })),
        handoff:
            direct || handoffStatus === 'skipped'
                ? { status: 'skipped', ms: null, model: '', fallback: '', tokens: null }
                : {
                      status: 'done',
                      ms: handoffMs,
                      model: handoffModel || '',
                      fallback: handoffFallback || '',
                      tokens: handoffTokens
                  },
        ...(direct && directDetail ? { directDetail } : {})
    }
    const reserved = fitTraceSqlPreviews({ ...body, question: redactTraceQuestion(question) })
    delete reserved.question
    return fitTraceQuestion(reserved, question)
}

export function traceFromPayload(payload) {
    let value = payload
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value)
        } catch {
            return null
        }
    }
    if (!value || typeof value !== 'object') return null
    if (value.trace?.specialists && value.trace?.route) {
        return value.trace.status === 'running' ? { ...value.trace, status: 'completed' } : value.trace
    }
    if (!value.harness && !Array.isArray(value.agents)) return null
    const rawTimings = value.timings || {}
    const reportTimings = value.report?.timings || {}
    const direct = rawTimings.fillMs != null || rawTimings.toolMs != null || rawTimings.prepareMs != null
    const timings = {
        routeMs: reportTimings.routeMs ?? rawTimings.routeMs ?? 0,
        specialistsMs: reportTimings.specialistsMs ?? rawTimings.specialistsMs ?? rawTimings.toolMs ?? 0,
        handoffMs: reportTimings.handoffMs ?? rawTimings.handoffMs ?? 0,
        profileMs: reportTimings.profileMs ?? rawTimings.profileMs ?? 0
    }
    const agents = (value.agents || []).map((agent) => ({
        ...agent,
        sources: Array.isArray(agent.sources) ? agent.sources : []
    }))
    return buildRunTrace({
        harness: value.harness || '',
        direct,
        steps: agents.map((agent) => ({ specialist: agent.name, task: agent.task || '' })),
        agents,
        timings,
        report: value.report || {},
        profileSkipped: timings.profileMs === 0,
        wallMs: timings.routeMs + timings.specialistsMs + timings.handoffMs
    })
}
