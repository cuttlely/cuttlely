// Token counts here are ceil(chars / 4). That is an estimate, not a provider tokenizer.
export const CHARS_PER_TOKEN = 4
export const DEFAULT_SPECIALIST_CONTEXT_TOKENS = 4000
export const DEFAULT_CHIEF_CONTEXT_TOKENS = 6000
export const CHIEF_TOOL_CHARS = 480
// How much of each specialist's answer Harness Prime reads. A specialist can set its own limit; a full context
// shrinks every limit in steps before anything else is cut.
export const SPECIALIST_HANDOFF_CHARS = 4000
export const HANDOFF_CHARS_LIMITS = { min: 160, max: 20000 }
// -1 means no limit: Harness Prime reads the whole answer. A full context still shrinks it like any other limit.
export const HANDOFF_NO_LIMIT = -1
const HANDOFF_SHRINK_STEPS = [1600, CHIEF_TOOL_CHARS, 160, 40, 0]

export function specialistHandoffChars(value) {
    const n = Math.floor(Number(value))
    if (n === HANDOFF_NO_LIMIT) return HANDOFF_NO_LIMIT
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.min(HANDOFF_CHARS_LIMITS.max, Math.max(HANDOFF_CHARS_LIMITS.min, n))
}

// Only an analyst result with rows gets the wider row limit; every other answer keeps its own limit. A full context
// lowers cap for every other answer, and rowCap for row results.
function handoffLimit(result, { cap, rowCap }) {
    const set = specialistHandoffChars(result?.handoffChars)
    const own = set === HANDOFF_NO_LIMIT ? Infinity : set || SPECIALIST_HANDOFF_CHARS
    return analystRowResult(result) ? Math.min(Math.max(ANALYST_ROW_HANDOFF_CHARS, own), rowCap) : Math.min(own, cap)
}
export const SOURCE_SNIPPET_CHARS = 200
export const SOURCE_LIMIT = 8

const MARK = '\n[truncated]'

export function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN)
}

export function specialistContextTokens() {
    return contextTokenLimit(DEFAULT_SPECIALIST_CONTEXT_TOKENS, process.env.CUTTLELY_HARNESS_SPECIALIST_CONTEXT_TOKENS)
}

export function chiefContextTokens() {
    return contextTokenLimit(DEFAULT_CHIEF_CONTEXT_TOKENS, process.env.CUTTLELY_HARNESS_CHIEF_CONTEXT_TOKENS)
}

function contextTokenLimit(fallback, raw) {
    if (raw == null || String(raw).trim() === '') return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return fallback
    return Math.floor(n)
}

export function fitText(text, tokenBudget) {
    const value = String(text ?? '')
    if (tokenBudget == null) return { text: value, truncated: false }
    if (tokenBudget <= 0) return { text: '', truncated: value.length > 0 }
    if (estimateTokens(value) <= tokenBudget) return { text: value, truncated: false }
    if (estimateTokens(MARK) > tokenBudget) return { text: '', truncated: true }
    let end = Math.max(0, tokenBudget * CHARS_PER_TOKEN - MARK.length)
    if (end > 0 && end < value.length) {
        const code = value.charCodeAt(end - 1)
        if (code >= 0xd800 && code <= 0xdbff) end -= 1
    }
    return { text: `${value.slice(0, end)}${MARK}`, truncated: true }
}

function push(list, name) {
    if (name && !list.includes(name)) list.push(name)
}

function asHistory(history) {
    return (history || []).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content ?? '')
    }))
}

function tokensOf(messages) {
    return estimateTokens(messages.map((message) => message.content).join('\n'))
}

export function sourceName(doc) {
    const meta = doc?.metadata || {}
    for (const key of ['source', 'title', 'file', 'filename', 'url']) {
        if (typeof meta[key] === 'string' && meta[key].trim()) return meta[key].trim()
    }
    return ''
}

export function sourceNames(sources) {
    const names = []
    for (const doc of sources || []) {
        const name = sourceName(doc)
        if (name && !names.includes(name)) names.push(name)
    }
    return names
}

function clipBody(raw, limit) {
    const value = String(raw ?? '')
    if (limit <= 0) return { text: value ? '[truncated]' : '', cut: value.length > 0 }
    if (value.length <= limit) return { text: value, cut: false }
    const end = Math.max(0, limit - MARK.length)
    return { text: `${value.slice(0, end)}${MARK}`, cut: true }
}

// The first of url/source/link/href that is an http(s) URL.
export function sourceUrl(doc) {
    const meta = doc?.metadata || {}
    for (const key of ['url', 'source', 'link', 'href']) {
        const value = meta[key]
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (/^https?:\/\//i.test(trimmed)) return trimmed
    }
    return ''
}

function sourceBlock(sources, snippetChars) {
    const lines = []
    let cut = false
    let named = 0
    for (const doc of sources || []) {
        const name = sourceName(doc) || sourceUrl(doc)
        if (!name) continue
        named += 1
        if (lines.length >= SOURCE_LIMIT) {
            cut = true
            continue
        }
        const raw = String(doc.pageContent || '')
            .replace(/\s+/g, ' ')
            .trim()
        const limit = Math.max(0, snippetChars)
        if (raw.length > limit) cut = true
        const url = sourceUrl(doc)
        const label = url && url !== name ? `${name} - ${url}` : name
        lines.push(`- [${label}] ${raw.slice(0, limit)}`)
    }
    if (named > SOURCE_LIMIT) cut = true
    return { text: lines.length ? `Sources:\n${lines.join('\n')}` : '', cut }
}

function sectionFor(result, toolChars, snippetChars, truncated) {
    const body =
        result.status === 'completed'
            ? clipBody(result.text, handoffLimit(result, toolChars))
            : { text: `Error: ${result.error || 'failed'}`, cut: false }
    const sources = result.status === 'completed' ? sourceBlock(result.sources, snippetChars) : { text: '', cut: false }
    if (body.cut) push(truncated, `specialist:${result.name}.toolResult`)
    if (sources.cut) push(truncated, `specialist:${result.name}.sources`)
    const tools = Array.isArray(result.tools) ? result.tools.filter(Boolean) : []
    const toolLine = tools.length ? `Tools: ${tools.join(', ')}` : 'Tools: none'
    const section = [`### ${result.name} (${result.status})`, `Task: ${result.task}`, toolLine, body.text, sources.text]
        .filter(Boolean)
        .join('\n')
    return section
}

function handoffMessages({ system, memory, history, request, results, toolChars, snippetChars, truncated }) {
    const report = (results || []).map((result) => sectionFor(result, toolChars, snippetChars, truncated)).join('\n\n')
    const fullSystem = [system, memory ? `Session memory:\n${memory}` : ''].filter(Boolean).join('\n\n')
    const user = results?.length ? `Request: ${request}\n\nSpecialist results:\n${report}` : String(request ?? '')
    return [{ role: 'system', content: fullSystem }, ...asHistory(history), { role: 'user', content: user }]
}

// Chief handoff: names and short snippets, then a hard token cap. Full documents stay off this prompt.
export function fitHandoff({ system, memory = '', history = [], request = '', results = [], chiefBudget = chiefContextTokens() } = {}) {
    const truncated = []
    let toolChars = { cap: Infinity, rowCap: Infinity }
    let snippetChars = SOURCE_SNIPPET_CHARS
    let memoryText = memory || ''
    let hist = [...history]
    let requestText = String(request ?? '')
    let systemText = String(system ?? '')
    const build = () =>
        handoffMessages({
            system: systemText,
            memory: memoryText,
            history: hist,
            request: requestText,
            results,
            toolChars,
            snippetChars,
            truncated
        })
    let messages = build()
    if (!chiefBudget || tokensOf(messages) <= chiefBudget) return { messages, truncated }

    const mark = (name) => push(truncated, name)
    const protectRows = (results || []).some((result) => ANALYST_SUMMARY_LINE.test(String(result.text || '')))
    const shrink = (name, apply) => {
        if (tokensOf(messages) <= chiefBudget) return
        const before = messages.map((message) => message.content).join('\n')
        apply()
        messages = build()
        if (messages.map((message) => message.content).join('\n') !== before) mark(name)
    }
    // Paged analyst rows stay whole up to the row limit; every other answer still shrinks.
    for (const next of HANDOFF_SHRINK_STEPS) {
        shrink('chief.toolResult', () => {
            if (toolChars.cap > next) toolChars = { ...toolChars, cap: next }
            if (!protectRows && toolChars.rowCap > next) toolChars = { ...toolChars, rowCap: next }
        })
    }
    if (protectRows) {
        shrink('chief.toolResult', () => {
            if (toolChars.rowCap > ANALYST_ROW_HANDOFF_CHARS) toolChars = { ...toolChars, rowCap: ANALYST_ROW_HANDOFF_CHARS }
        })
    }
    shrink('chief.sources', () => {
        if (snippetChars > 40) snippetChars = 40
    })
    while (tokensOf(messages) > chiefBudget && hist.length) {
        hist = hist.slice(1)
        mark('chief.memory')
        messages = build()
    }
    shrink('chief.memory', () => {
        if (memoryText) memoryText = fitText(memoryText, 24).text
    })
    shrink('chief.request', () => {
        const keep = estimateTokens(messages[0]?.content || '')
        requestText = fitText(requestText, Math.max(0, chiefBudget - keep)).text
    })
    shrink('chief.instructions', () => {
        systemText = fitText(systemText, Math.max(16, Math.floor(chiefBudget / 2))).text
    })
    return { messages, truncated }
}

export function fitSpecialistPrompt({
    name,
    instructions = '',
    memory = '',
    history = [],
    task = '',
    budget = specialistContextTokens(),
    keepTask = false
} = {}) {
    let memoryText = memory || ''
    let hist = [...history]
    let taskText = String(task ?? '')
    let instructionText = String(instructions ?? '')
    const truncated = []
    const build = () => {
        const system = [instructionText, memoryText ? `Session memory:\n${memoryText}` : ''].filter(Boolean).join('\n\n')
        return [{ role: 'system', content: system }, ...asHistory(hist), { role: 'user', content: taskText }]
    }
    let messages = build()
    if (!budget || tokensOf(messages) <= budget) return { messages, truncated }
    const mark = (field) => push(truncated, `specialist:${name}.${field}`)
    while (tokensOf(messages) > budget && hist.length) {
        hist = hist.slice(1)
        mark('memory')
        messages = build()
    }
    if (tokensOf(messages) > budget && memoryText) {
        // With keepTask the memory takes whatever room the task leaves, so a short task keeps more memory.
        const room = keepTask ? budget - estimateTokens(taskText) - estimateTokens(instructionText) - 8 : 0
        memoryText = fitText(memoryText, Math.max(16, room)).text
        mark('memory')
        messages = build()
    }
    if (tokensOf(messages) > budget) {
        const others = estimateTokens(taskText) + estimateTokens(memoryText ? `Session memory:\n${memoryText}` : '')
        const fitted = fitText(instructionText, Math.max(0, budget - others))
        instructionText = fitted.text
        if (fitted.truncated) mark('instructions')
        messages = build()
    }
    // keepTask: the task is what the specialist was asked to do, so it is never cut; the caller's model
    // has room for it even when the memory had to be shortened.
    if (!keepTask && tokensOf(messages) > budget) {
        const keep = estimateTokens(messages[0]?.content || '')
        const fitted = fitText(taskText, Math.max(0, budget - keep))
        taskText = fitted.text
        if (fitted.truncated) mark('task')
        messages = build()
    }
    return { messages, truncated }
}

export function fitChiefMessages({ system, memory = '', history = [], user = '', budget = chiefContextTokens() } = {}) {
    let memoryText = memory || ''
    let hist = [...history]
    let userText = String(user ?? '')
    let systemText = String(system ?? '')
    const truncated = []
    const build = () => {
        const fullSystem = [systemText, memoryText ? `Session memory:\n${memoryText}` : ''].filter(Boolean).join('\n\n')
        return [{ role: 'system', content: fullSystem }, ...asHistory(hist), { role: 'user', content: userText }]
    }
    let messages = build()
    if (!budget || tokensOf(messages) <= budget) return { messages, truncated }
    const mark = (name) => push(truncated, name)
    while (tokensOf(messages) > budget && hist.length) {
        hist = hist.slice(1)
        mark('chief.memory')
        messages = build()
    }
    if (tokensOf(messages) > budget && memoryText) {
        memoryText = fitText(memoryText, 24).text
        mark('chief.memory')
        messages = build()
    }
    if (tokensOf(messages) > budget) {
        const keep = estimateTokens(messages[0]?.content || '')
        const fitted = fitText(userText, Math.max(0, budget - keep))
        userText = fitted.text
        if (fitted.truncated) mark('chief.request')
        messages = build()
    }
    if (tokensOf(messages) > budget) {
        const fitted = fitText(systemText, Math.max(16, Math.floor(budget / 2)))
        systemText = fitted.text
        if (fitted.truncated) mark('chief.instructions')
        messages = build()
    }
    return { messages, truncated }
}

export const ANALYST_ROW_HANDOFF_CHARS = 12000

export const ANALYST_PAGE_SUMMARY =
    /rows \d+-\d+(?: of \d+)? \((?:page \d+ of \d+, say "show more" for the next page|page \d+ of \d+, last page|more rows available, say "show more" for the next page|page \d+, last page|last page)\)/
export const ANALYST_SUMMARY_LINE = new RegExp(`${ANALYST_PAGE_SUMMARY.source}|returned \\d+ of \\d+\\+? rows \\(truncated\\)`)

export function isAnalystCapSummary(summary) {
    return new RegExp(`^(?:${ANALYST_SUMMARY_LINE.source})$`).test(String(summary || '').trim())
}

// A count or a total does not ask for the rows, so the answer keeps the specialist's sentence.
// A listing verb in the same question still asks for the rows.
export function wantsAnalystRows(question) {
    const text = String(question || '')
    const aggregate = /\b(how many|count|number of|total|sum|average|avg|mean)\b/i.test(text)
    const listing = /\b(list|show|select\s+\*|all rows|every row|each row)\b/i.test(text)
    if (aggregate && !listing) return false
    return true
}

export function compactAnalystPageText(content) {
    const text = String(content || '')
    const line = text.match(ANALYST_SUMMARY_LINE)?.[0]
    if (!line) return text
    const lines = text
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
    if (lines.length <= 2) return text
    return line
}

export function isAnalystQueryTool(name) {
    const value = String(name || '')
        .trim()
        .toLowerCase()
    if (!value || value === 'tool_call' || value === 'tool_search' || value === 'tool_describe') return false
    return value === 'query' || value.endsWith('__query')
}

function analystRowResult(result) {
    const text = String(result?.text || '')
    if (ANALYST_SUMMARY_LINE.test(text)) return true
    const tools = Array.isArray(result?.tools) ? result.tools : []
    const analyst = tools.some((tool) => isAnalystQueryTool(typeof tool === 'string' ? tool.split(' ')[0] : tool?.name))
    return analyst && text.split('\n').filter((line) => line.trim()).length > 4
}

function unwrapToolPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (typeof value.result === 'string') {
        const inner = value.result.trim()
        if (!inner || inner.endsWith('...')) return null
        try {
            const parsed = JSON.parse(inner)
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
        } catch {
            return null
        }
    }
    if (value.rows || value.command != null || value.error || value.summary) return value
    return null
}

export function parseAnalystToolDetail(detail) {
    const text = String(detail || '').trim()
    if (!text || text.endsWith('...')) return null
    try {
        return unwrapToolPayload(JSON.parse(text))
    } catch {
        return null
    }
}

function plainSqlChange(sql, body) {
    const verb = String(sql || '')
        .trim()
        .split(/\s+/)[0]
        .toLowerCase()
    const count = Number(body?.rowCount)
    const counted = Number.isFinite(count) ? count : null
    if (verb === 'drop') return 'Dropped table'
    if (verb === 'create') return 'Created table'
    if (verb === 'insert') return counted == null ? 'Inserted rows' : `Inserted ${counted} rows`
    if (verb === 'update') return counted == null ? 'Updated rows' : `Updated ${counted} rows`
    if (verb === 'delete') return counted == null ? 'Deleted rows' : `Deleted ${counted} rows`
    if (counted != null && counted > 0) return `Changed ${counted} rows`
    return 'The statement finished.'
}

function formatAnalystDataRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return String(row)
    return Object.entries(row)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ')
}

export function analystHandoffLine(row) {
    return formatAnalystDataRow(row)
}

// Room left for the page line, so a full page of rows plus that line still fits the handoff budget.
const ANALYST_PAGE_LINE_RESERVE = 160

// The rows that fit in the handoff budget. The store returns this prefix and advances the cursor by
// the same count, so a later page starts at the next row instead of skipping the ones the budget cut.
export function analystShownRows(rows, budget = ANALYST_ROW_HANDOFF_CHARS) {
    const list = Array.isArray(rows) ? rows : []
    const room = Math.max(0, Math.floor(Number(budget) || 0))
    const kept = []
    let used = 0
    for (const row of list) {
        const line = formatAnalystDataRow(row)
        const extra = (kept.length ? 1 : 0) + line.length
        const limit = kept.length === 0 ? room : Math.max(0, room - ANALYST_PAGE_LINE_RESERVE)
        if (used + extra > limit) {
            if (!kept.length && line.length) kept.push(row)
            break
        }
        kept.push(row)
        used += extra
    }
    return kept
}

// How many of these line lengths fit in one page. The rules match analystShownRows.
function shownLineCount(lengths, budget) {
    const room = Math.max(0, Math.floor(Number(budget) || 0))
    let used = 0
    let kept = 0
    for (const raw of lengths) {
        const lineLength = Math.max(0, Number(raw) || 0)
        const extra = (kept ? 1 : 0) + lineLength
        const limit = kept === 0 ? room : Math.max(0, room - ANALYST_PAGE_LINE_RESERVE)
        if (used + extra > limit) {
            if (!kept && lineLength) kept = 1
            break
        }
        kept += 1
        used += extra
    }
    return kept
}

// Page count for a length-only pass. The row text itself is not required.
export function analystPagesFromLineLengths(lengths, pageSize, budget = ANALYST_ROW_HANDOFF_CHARS) {
    const list = Array.isArray(lengths) ? lengths : []
    const size = Math.max(1, Math.floor(Number(pageSize)) || 1)
    let offset = 0
    let count = 0
    while (offset < list.length && count <= list.length) {
        count += 1
        const shown = shownLineCount(list.slice(offset, offset + size), budget)
        offset += Math.max(1, shown)
    }
    return count
}

export function presentAnalystToolResult(result, sql = '') {
    const body = unwrapToolPayload(result) || (result && typeof result === 'object' && !Array.isArray(result) ? result : null)
    if (!body) return ''
    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim()
    if (Array.isArray(body.rows)) {
        const lines = analystShownRows(body.rows).map((row) => formatAnalystDataRow(row))
        const summary = isAnalystCapSummary(body.summary) ? String(body.summary).trim() : ''
        return [...lines, summary].filter(Boolean).join('\n')
    }
    if (body.command != null || body.rowCount != null) return plainSqlChange(sql, body)
    return ''
}

export function analystPayloadsFor(tools, specialistName) {
    return analystToolPayloads(tools, specialistName)
}

// Row candidates for fill-in come from the capped SELECT that produced the truncated line.
// Status payloads from other statements in the same step are not rows.
export function cappedAnalystRowLines(payloads) {
    if (!Array.isArray(payloads) || !payloads.length) return null
    const lines = []
    let found = false
    for (const body of payloads) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.rows)) continue
        const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
        if (!isAnalystCapSummary(summary)) continue
        found = true
        for (const row of analystShownRows(body.rows)) {
            const line = formatAnalystDataRow(row).trim()
            if (line) lines.push(line)
        }
    }
    return found ? lines : null
}

function analystToolPayloads(tools, specialistName) {
    return analystToolEntries(tools, specialistName).map((entry) => entry.body)
}

function analystToolEntries(tools, specialistName) {
    const entries = []
    for (const tool of tools || []) {
        if (specialistName && tool.specialist && tool.specialist !== specialistName) continue
        if (!isAnalystQueryTool(tool.name)) continue
        const body = parseAnalystToolDetail(tool.detail)
        if (body) entries.push({ sql: String(tool.sql || '').trim(), body })
    }
    return entries
}

function isCappedAnalystPayload(body) {
    return Boolean(body && Array.isArray(body.rows) && isAnalystCapSummary(body.summary))
}

function isAnalystStatusPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Array.isArray(body.rows)) return false
    if (typeof body.error === 'string' && body.error.trim()) return false
    return body.command != null || body.rowCount != null
}

function tableFromSql(sql) {
    const text = String(sql || '')
        .replace(/\s+/g, ' ')
        .trim()
    const match = text.match(
        /^(?:insert\s+into|update|delete\s+from|drop\s+table(?:\s+if\s+exists)?|create\s+table(?:\s+if\s+not\s+exists)?)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*))?)/i
    )
    if (!match) return ''
    return match[1]
        .split('.')
        .pop()
        .replace(/^[`"[]|[`"\]]$/g, '')
}

// A write is worth handing to Prime only when the statement names the table.
// `Changed 150 rows` has no table, so a later capped page must not carry it.
function contextualWriteLine(sql, body) {
    const table = tableFromSql(sql)
    if (!table) return ''
    const verb = String(sql || '')
        .trim()
        .split(/\s+/)[0]
        .toLowerCase()
    const count = Number(body?.rowCount)
    const counted = Number.isFinite(count) ? count : null
    if (verb === 'insert') return counted == null ? `Inserted rows into ${table}` : `Inserted ${counted} rows into ${table}`
    if (verb === 'update') return counted == null ? `Updated rows in ${table}` : `Updated ${counted} rows in ${table}`
    if (verb === 'delete') return counted == null ? `Deleted rows from ${table}` : `Deleted ${counted} rows from ${table}`
    if (verb === 'drop') return `Dropped table ${table}`
    if (verb === 'create') return `Created table ${table}`
    return ''
}

const TRAILING_ANALYST_STATUS =
    /^(?:Changed \d+ rows|Inserted \d+ rows|Updated \d+ rows|Deleted \d+ rows|Returned \d+ rows?|The statement finished\.|Dropped table(?:\s+\S+)?)(?:\.)?$/

// A bare status line after the page line is Prime copying the specialist handoff.
// The match is the whole line, so a sentence that only mentions a change stays.
export function stripTrailingAnalystStatus(answer) {
    const text = String(answer || '').trim()
    if (!text) return text
    const lines = text.split('\n')
    let pageAt = -1
    for (let i = 0; i < lines.length; i += 1) {
        if (isAnalystCapSummary(lines[i])) pageAt = i
    }
    if (pageAt < 0) return text
    let end = lines.length
    let removed = false
    while (end > pageAt + 1) {
        const line = lines[end - 1].trim()
        if (!line) {
            end -= 1
            continue
        }
        if (TRAILING_ANALYST_STATUS.test(line)) {
            removed = true
            end -= 1
            continue
        }
        break
    }
    if (!removed) return text
    while (end > pageAt + 1 && !lines[end - 1].trim()) end -= 1
    return lines.slice(0, end).join('\n').trim()
}

export function groundAnalystSpecialistText(text, tools, specialistName) {
    const raw = String(text || '').trim()
    const entries = analystToolEntries(tools, specialistName)
    if (!entries.length) return raw
    const hasCappedRows = entries.some((entry) => isCappedAnalystPayload(entry.body))
    if (hasCappedRows) {
        const writes = []
        const parts = []
        const seenWrites = new Set()
        for (const entry of entries) {
            if (isAnalystStatusPayload(entry.body)) {
                const note = contextualWriteLine(entry.sql, entry.body)
                if (note && !seenWrites.has(note)) {
                    seenWrites.add(note)
                    writes.push(note)
                }
                continue
            }
            const shown = presentAnalystToolResult(entry.body)
            if (shown) parts.push(shown)
        }
        const grounded = [...writes, ...parts].filter(Boolean).join('\n\n')
        return grounded || raw
    }
    const rendered = entries.map((entry) => presentAnalystToolResult(entry.body)).filter(Boolean)
    if (!rendered.length) return raw
    const onlySummary = new RegExp(`^${ANALYST_SUMMARY_LINE.source}$`).test(raw)
    const rawJson = /^(returned\s+)?\{[\s\S]*\}$/.test(raw)
    if (onlySummary || rawJson) return rendered.join('\n\n')
    return raw
}
