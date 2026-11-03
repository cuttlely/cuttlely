// Sort presentation rows only. The answer text, downloads and source evidence stay unchanged.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const missing = /^(?:unknown|n\/?a|not available|not provided|not recorded|not applicable|null|none(?: in window)?|[—–-])?$/i
const riskLevels = {
    'no risk': 0,
    'low risk': 1,
    'slight risk': 1,
    'moderate risk': 2,
    'medium risk': 2,
    'high risk': 3,
    'critical risk': 4
}

function numberValue(text) {
    let value = text.replace(/\u2212/g, '-').trim()
    const negative = value.startsWith('(') && value.endsWith(')')
    if (negative) value = value.slice(1, -1).trim()
    value = value
        .replace(/^(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|HKD|SGD|INR)\s*/i, '')
        .replace(/\s*(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|HKD|SGD|INR)$/i, '')
        .replace(/^([+-]?)\p{Sc}\s*/u, '$1')
        .replace(/\s*\p{Sc}$/u, '')
        .trim()
    if (!/^[+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)%?$/.test(value)) return null
    const parsed = Number(value.replace(/[,%]/g, '')) * (negative ? -1 : 1)
    return Number.isFinite(parsed) && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER ? parsed : null
}

function dateValue(text) {
    // Avoid interpreting IDs, bare years, or ambiguous slash dates as dates.
    if (!/^(?:\d{4}-\d{2}-\d{2}(?:[T ].+)?|\d{1,2}[ -][A-Za-z]{3,9}[ ,/-]+\d{4}|[A-Za-z]{3,9} \d{1,2},? \d{4})$/.test(text)) return null
    const value = Date.parse(text)
    return Number.isFinite(value) ? value : null
}

/** Return original row indices, with unknowns last in both directions and stable ties. */
export function tableRowOrder(rows, column, direction = 'ascending', header = '') {
    const values = rows.map((row) => String(row[column] ?? '').trim())
    const known = values.filter((value) => !missing.test(value))
    const identifier = /\b(?:ids?|identifiers?|codes?|sku|zip|postal)\b/i.test(header)
    let key = (value) => value
    if (!identifier && known.length && known.every((value) => numberValue(value) !== null)) key = numberValue
    else if (!identifier && known.length && known.every((value) => dateValue(value) !== null)) key = dateValue
    else if (
        /\brisk\b/i.test(header) &&
        known.length &&
        known.every((value) => Object.prototype.hasOwnProperty.call(riskLevels, value.toLowerCase()))
    )
        key = (value) => riskLevels[value.toLowerCase()]
    const keys = values.map((value) => (missing.test(value) ? null : key(value)))
    const sign = direction === 'descending' ? -1 : 1
    return rows
        .map((_, index) => index)
        .sort((a, b) => {
            if (keys[a] === null || keys[b] === null) return keys[a] === keys[b] ? a - b : keys[a] === null ? 1 : -1
            const compared = typeof keys[a] === 'number' ? keys[a] - keys[b] : collator.compare(keys[a], keys[b])
            return compared * sign || a - b
        })
}

/** Add native keyboard-accessible controls to already sanitized widget tables. */
export function makeTablesSortable(root, state = new Map()) {
    root.querySelectorAll('table').forEach((table, tableIndex) => {
        if (table.tHead?.rows.length !== 1 || table.tBodies.length !== 1) return
        const headers = Array.from(table.tHead.rows[0].cells)
        const body = table.tBodies[0]
        const rows = Array.from(body.rows)
        if (
            !rows.length ||
            [...headers, ...rows.flatMap((row) => Array.from(row.cells))].some((cell) => cell.colSpan !== 1 || cell.rowSpan !== 1)
        )
            return
        if (rows.some((row) => row.cells.length !== headers.length)) return
        const labels = headers.map((header) => header.textContent.trim())
        const values = rows.map((row) => Array.from(row.cells, (cell) => cell.textContent))
        const buttons = headers.map((header, column) => {
            if (!labels[column] || header.querySelector('a,button,input,select,textarea')) return null
            const button = table.ownerDocument.createElement('button')
            button.type = 'button'
            button.className = 'md-table-sort'
            button.append(...header.childNodes)
            const indicator = table.ownerDocument.createElement('span')
            indicator.className = 'md-table-sort-icon'
            indicator.setAttribute('aria-hidden', 'true')
            button.append(indicator)
            header.scope = 'col'
            header.append(button)
            button.addEventListener('click', () => {
                const prior = state.get(tableIndex)
                apply({ column, direction: prior?.column === column && prior.direction === 'ascending' ? 'descending' : 'ascending' })
                button.focus({ preventScroll: true })
            })
            return button
        })
        function apply(sort) {
            if (sort && buttons[sort.column]) {
                state.set(tableIndex, sort)
                body.append(...tableRowOrder(values, sort.column, sort.direction, labels[sort.column]).map((index) => rows[index]))
            }
            buttons.forEach((button, column) => {
                if (!button) return
                const active = sort?.column === column
                headers[column].setAttribute('aria-sort', active ? sort.direction : 'none')
                const next = active && sort.direction === 'ascending' ? 'descending' : 'ascending'
                button.setAttribute('aria-label', `Sort by ${labels[column]}, ${next}`)
                button.title = `Sort displayed rows by ${labels[column]} (${next})`
                button.lastChild.textContent = active ? (sort.direction === 'ascending' ? '↑' : '↓') : '↕'
            })
        }
        apply(state.get(tableIndex))
    })
}
