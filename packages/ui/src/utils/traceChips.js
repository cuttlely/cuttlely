// Plain words for the tool chips on a run card, and the CSV and copy text of a result table. Display only:
// the recorded trace is read as it is and never changed.

const KNOWN = {
    query: 'Query',
    describe: 'Describe table',
    list_tables: 'List tables',
    list_relations: 'List tables',
    pin_definition: 'Read saved query SQL'
}

// mcp__<server>__<tool> splits into its server and tool. A plain local tool name has no server.
export function splitToolName(name) {
    const text = String(name || '').trim()
    const match = /^mcp__(.+?)__(.+)$/.exec(text)
    if (match) return { server: match[1], tool: match[2] }
    return { server: '', tool: text }
}

const PINNED = /^pq_[a-z0-9_]+$/i

// A step only the analyst records: a SQL hash, a row preview, a row count or a pinned query record.
function analystEvidence(tool) {
    return Boolean(
        tool &&
            (typeof tool.sqlHash === 'string' || (tool.preview && typeof tool.preview === 'object') || tool.rowCount != null || tool.pinned)
    )
}

// The MCP servers whose tool names get plain words: the specialist's own tool server (named after the
// specialist, which is where its Postgres (MCP) tools run), a server named analyst, and any server whose
// steps carry analyst-only fields. Tools on any other server keep their names, as "server · tool".
export function analystServers(tools, specialistName) {
    const servers = new Set(['analyst'])
    const own = String(specialistName || '').replace(/[^A-Za-z0-9_]/g, '_')
    if (own) servers.add(own)
    for (const tool of tools || []) {
        const { server, tool: short } = splitToolName(tool?.name)
        if (server && (analystEvidence(tool) || PINNED.test(short))) servers.add(server)
    }
    return servers
}

export function friendlyToolName(name, servers = analystServers([])) {
    const { server, tool: short } = splitToolName(name)
    if (server && !servers.has(server)) return short ? `${server} · ${short}` : server
    if (KNOWN[short]) return KNOWN[short]
    if (PINNED.test(short)) {
        const words = short.slice(3).replace(/_+/g, ' ').trim()
        return words ? `Saved query: ${words}` : 'Saved query'
    }
    return short || 'Tool'
}

// "Query · 4 rows", "Query · failed". A finished step says nothing about its status.
export function friendlyChipLabel(tool, view, servers) {
    const parts = [friendlyToolName(tool?.name, servers)]
    if (tool?.status === 'running') parts.push('running')
    else if (tool?.status === 'failed') parts.push('failed')
    else if (tool?.status === 'retried') parts.push('retried')
    if (view && view.rowCount != null) parts.push(`${view.rowCount} row${view.rowCount === 1 ? '' : 's'}`)
    return parts.join(' · ')
}

// A leading =, +, - or @ would run as a formula in a spreadsheet, so it is kept as text.
// A plain number such as -120.5 or +3 is not a formula and is left as it is.
const PLAIN_NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/
export const asText = (text) => (/^[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text)

function csvCell(value) {
    const safe = asText(value == null ? '' : String(value))
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function tableCsv(view) {
    const columns = Array.isArray(view?.columns) ? view.columns : []
    const rows = Array.isArray(view?.rows) ? view.rows : []
    return [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
}

// Tab-separated, which pastes into a spreadsheet as cells.
export function tableText(view) {
    const columns = Array.isArray(view?.columns) ? view.columns : []
    const rows = Array.isArray(view?.rows) ? view.rows : []
    return [columns, ...rows].map((row) => row.map((cell) => asText(String(cell ?? '')).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n')
}

// The run card keeps a short preview of a query: at most 5 rows and 4 columns, with long values cut and
// ending in an ellipsis. When anything was cut, Copy and CSV say they export the preview.
export function previewIsPartial(view) {
    if (!view || view.legacy) return false
    const rows = Array.isArray(view.rows) ? view.rows : []
    const columns = Array.isArray(view.columns) ? view.columns : []
    if (view.moreRows || view.moreColumns) return true
    if (Number.isFinite(view.rowCount) && view.rowCount > rows.length) return true
    if (Number.isFinite(view.columnCount) && view.columnCount > columns.length) return true
    return [columns, ...rows].some((row) => row.some((cell) => String(cell ?? '').endsWith('…')))
}

export function exportText(view) {
    if (previewIsPartial(view)) {
        return { copy: 'Copy preview', csv: 'Preview CSV', file: 'query-preview.csv', copied: 'Preview copied.' }
    }
    return { copy: 'Copy', csv: 'CSV', file: 'query-rows.csv', copied: 'Rows copied.' }
}

// sqlPreviewFields keeps the first 4096 bytes. A run record that is still too big keeps less, or no SQL.
export const SQL_PREVIEW_BYTES = 4096
export function sqlCutNote(sql, sqlTruncated) {
    if (sqlTruncated !== true) return ''
    if (typeof sql !== 'string' || !sql) return 'The SQL was too long to keep in this run record.'
    const bytes = new TextEncoder().encode(sql).length
    return bytes > SQL_PREVIEW_BYTES - 4 ? 'SQL cut at 4 KB.' : 'SQL cut short to fit this run record.'
}
