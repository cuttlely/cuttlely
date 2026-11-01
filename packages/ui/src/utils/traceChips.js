// Plain words for the tool chips on a run card, and the CSV and copy text of a result table. Display only:
// the recorded trace is read as it is and never changed.

const KNOWN = {
    query: 'Query',
    describe: 'Describe table',
    list_tables: 'List tables',
    list_relations: 'List tables',
    pin_definition: 'Read saved query SQL'
}

function tail(name) {
    const text = String(name || '').trim()
    const cut = text.lastIndexOf('__')
    return cut >= 0 ? text.slice(cut + 2) : text
}

export function friendlyToolName(name) {
    const short = tail(name)
    if (KNOWN[short]) return KNOWN[short]
    if (/^pq_[a-z0-9_]+$/.test(short)) {
        const words = short.slice(3).replace(/_+/g, ' ').trim()
        return words ? `Saved query: ${words}` : 'Saved query'
    }
    return short || 'Tool'
}

// "Query · 4 rows", "Query · failed". A finished step says nothing about its status.
export function friendlyChipLabel(tool, view) {
    const parts = [friendlyToolName(tool?.name)]
    if (tool?.status === 'running') parts.push('running')
    else if (tool?.status === 'failed') parts.push('failed')
    else if (tool?.status === 'retried') parts.push('retried')
    if (view && view.rowCount != null) parts.push(`${view.rowCount} row${view.rowCount === 1 ? '' : 's'}`)
    return parts.join(' · ')
}

function csvCell(value) {
    const text = value == null ? '' : String(value)
    // A leading =, +, - or @ would run as a formula in a spreadsheet, so it is kept as text.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
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
    return [columns, ...rows].map((row) => row.map((cell) => String(cell ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n')
}
