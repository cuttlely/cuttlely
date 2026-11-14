// Build a bounded read-only lookup for test values. Identifiers come from the saved statement.
// The lookup never copies the statement itself and never writes.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const SENSITIVE = /password|secret|token|credential|ssn|api_?key|authorization/i

export interface Binding {
    param: string
    table: string
    column: string
    op: '=' | '>=' | '<=' | '>' | '<'
}

export interface JoinEdge {
    leftTable: string
    leftColumn: string
    rightTable: string
    rightColumn: string
}

interface Token {
    kind: 'word' | 'param' | 'op' | 'dot' | 'string'
    text: string
    quoted?: boolean
}

function tokenize(sql: string): Token[] {
    const tokens: Token[] = []
    let i = 0
    while (i < sql.length) {
        const c = sql[i]
        const pair = sql.slice(i, i + 2)
        if (/\s/.test(c)) {
            i += 1
            continue
        }
        if (pair === '--') {
            const end = sql.slice(i).search(/[\r\n]/)
            i = end < 0 ? sql.length : i + end
            continue
        }
        if (pair === '/*') {
            const end = sql.indexOf('*/', i + 2)
            i = end < 0 ? sql.length : end + 2
            continue
        }
        if (c === '"') {
            i += 1
            let text = ''
            while (i < sql.length) {
                if (sql[i] === '"') {
                    if (sql[i + 1] === '"') {
                        text += '"'
                        i += 2
                        continue
                    }
                    i += 1
                    break
                }
                text += sql[i]
                i += 1
            }
            if (text) tokens.push({ kind: 'word', text, quoted: true })
            continue
        }
        if (c === "'") {
            i += 1
            let text = ''
            while (i < sql.length) {
                if (sql[i] === "'") {
                    if (sql[i + 1] === "'") {
                        text += "'"
                        i += 2
                        continue
                    }
                    i += 1
                    break
                }
                text += sql[i++]
            }
            tokens.push({ kind: 'string', text })
            continue
        }
        if (c === '$' && sql[i + 1] === '$') {
            const end = sql.indexOf('$$', i + 2)
            i = end < 0 ? sql.length : end + 2
            continue
        }
        if (c === ':') {
            if (sql[i + 1] === ':') {
                i += 2
                continue
            }
            let j = i + 1
            while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j += 1
            const name = sql.slice(i + 1, j)
            if (name) tokens.push({ kind: 'param', text: name })
            i = j
            continue
        }
        if (c === '.') {
            tokens.push({ kind: 'dot', text: '.' })
            i += 1
            continue
        }
        if ('=<>'.includes(c)) {
            const op = sql.startsWith('>=', i) ? '>=' : sql.startsWith('<=', i) ? '<=' : sql.startsWith('<>', i) ? '<>' : c
            tokens.push({ kind: 'op', text: op })
            i += op.length
            continue
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1
            while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j += 1
            tokens.push({ kind: 'word', text: sql.slice(i, j) })
            i = j
            continue
        }
        i += 1
    }
    return tokens
}

function ident(token: Token | undefined): string {
    if (!token || token.kind !== 'word') return ''
    if (token.quoted) return token.text
    if (!IDENT.test(token.text)) return ''
    return token.text
}

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

function quoteQualified(name: string): string {
    return name
        .split('.')
        .filter(Boolean)
        .map((part) => quoteIdent(part))
        .join('.')
}

export function allowedTable(name: string, relations: string[]): boolean {
    const needle = name.toLowerCase()
    const needleBare = needle.includes('.') ? needle.slice(needle.lastIndexOf('.') + 1) : needle
    return relations.some((relation) => {
        const text = relation.trim().toLowerCase()
        if (!text) return false
        const bare = text.includes('.') ? text.slice(text.lastIndexOf('.') + 1) : text
        return text === needle || bare === needleBare || bare === needle || text === needleBare
    })
}

export interface DiscoveryPlan {
    text: string
    bindings: Binding[]
}

export function planDiscovery(sql: string, relations: string[]): DiscoveryPlan | { error: string } {
    if (!Array.isArray(relations) || relations.length === 0) {
        return { error: 'This node has no selected tables, so test values were not read from the database.' }
    }
    const tokens = tokenize(sql)
    const aliases = new Map<string, string>()
    const bindings: Binding[] = []
    const joins: JoinEdge[] = []

    const readQualified = (index: number): { name: string; next: number } | null => {
        const first = ident(tokens[index])
        if (!first) return null
        if (tokens[index + 1]?.kind === 'dot') {
            const second = ident(tokens[index + 2])
            if (!second) return { name: first, next: index + 1 }
            return { name: `${first}.${second}`, next: index + 3 }
        }
        return { name: first, next: index + 1 }
    }
    const keyword = (text: string) => /^(on|join|left|right|inner|outer|cross|where|group|order|limit|as)$/i.test(text)

    for (let i = 0; i < tokens.length; i += 1) {
        const word = tokens[i]
        if (word.kind !== 'word' || word.quoted || !/^(from|join)$/i.test(word.text)) continue
        const qualified = readQualified(i + 1)
        if (!qualified) continue
        const bare = qualified.name.includes('.') ? qualified.name.slice(qualified.name.lastIndexOf('.') + 1) : qualified.name
        let alias = bare
        let cursor = qualified.next
        const next = tokens[cursor]
        if (next?.kind === 'word' && !next.quoted && /^as$/i.test(next.text)) {
            const named = ident(tokens[cursor + 1])
            if (named) {
                alias = named
                cursor += 2
            }
        } else if (next?.kind === 'word' && (next.quoted || !keyword(next.text))) {
            const named = ident(next)
            if (named) {
                alias = named
                cursor += 1
            }
        }
        aliases.set(alias.toLowerCase(), qualified.name)
        aliases.set(bare.toLowerCase(), qualified.name)
        aliases.set(qualified.name.toLowerCase(), qualified.name)
        i = Math.max(i, cursor - 1)
    }

    const fromTables = [...new Set(aliases.values())]
    const columnRef = (index: number): { table: string; column: string; next: number } | null => {
        const first = ident(tokens[index])
        if (!first) return null
        if (tokens[index + 1]?.kind !== 'dot') {
            // `WHERE month = :month` names one column on the only table in FROM.
            if (fromTables.length !== 1 || keyword(first)) return null
            return { table: fromTables[0], column: first, next: index + 1 }
        }
        const second = ident(tokens[index + 2])
        if (!second) return null
        if (tokens[index + 3]?.kind === 'dot') {
            const third = ident(tokens[index + 4])
            if (!third) return null
            const qualified = `${first}.${second}`
            const table = aliases.get(qualified.toLowerCase()) || aliases.get(second.toLowerCase()) || qualified
            return { table, column: third, next: index + 5 }
        }
        const table = aliases.get(first.toLowerCase()) || first
        return { table, column: second, next: index + 3 }
    }

    for (let i = 0; i < tokens.length; i += 1) {
        const left = columnRef(i)
        if (!left) continue
        const between = tokens[left.next]
        if (between?.kind === 'word' && /^between$/i.test(between.text) && !between.quoted) {
            const low = tokens[left.next + 1]
            const and = tokens[left.next + 2]
            const high = tokens[left.next + 3]
            if (
                low?.kind === 'param' &&
                and?.kind === 'word' &&
                /^and$/i.test(and.text) &&
                high?.kind === 'param' &&
                !SENSITIVE.test(left.column)
            ) {
                bindings.push({ param: low.text, table: left.table, column: left.column, op: '>=' })
                bindings.push({ param: high.text, table: left.table, column: left.column, op: '<=' })
            }
            continue
        }
        const op = tokens[left.next]
        if (!op || op.kind !== 'op') continue
        const rightParam = tokens[left.next + 1]
        if (rightParam?.kind === 'param' && ['=', '>=', '<=', '>', '<'].includes(op.text)) {
            if (SENSITIVE.test(left.column)) continue
            bindings.push({
                param: rightParam.text,
                table: left.table,
                column: left.column,
                op: op.text as Binding['op']
            })
            continue
        }
        const right = columnRef(left.next + 1)
        if (right && op.text === '=') {
            joins.push({
                leftTable: left.table,
                leftColumn: left.column,
                rightTable: right.table,
                rightColumn: right.column
            })
        }
    }

    if (!bindings.length) return { error: 'The saved query has no column comparisons that can supply test values.' }
    const tables = [...new Set(bindings.map((item) => item.table))]
    const quotable = (name: string) => {
        const parts = name.split('.')
        return parts.length > 0 && parts.every((part) => part.length > 0 && part.length <= 128 && !/[\u0000"]/.test(part))
    }
    for (const table of tables) {
        if (!quotable(table) || !allowedTable(table, relations)) {
            return { error: `Test values were not read from ${table}, because that table is not selected on this node.` }
        }
    }
    for (const join of joins) {
        if (!allowedTable(join.leftTable, relations) || !allowedTable(join.rightTable, relations)) {
            return { error: 'Test values were not read across a table that is not selected on this node.' }
        }
    }

    const selected = new Map<string, Binding>()
    for (const binding of bindings) {
        if (SENSITIVE.test(binding.column)) continue
        const previous = selected.get(binding.param)
        if (!previous) selected.set(binding.param, binding)
    }
    const used = [...selected.values()]
    if (!used.length) return { error: 'The parameters that remain are sensitive, so test values were not read from those columns.' }

    const select = used
        .map((binding) => `${quoteQualified(binding.table)}.${quoteIdent(binding.column)} AS ${quoteIdent(binding.param)}`)
        .join(', ')
    const from = quoteQualified(used[0].table)
    const rest = tables.filter((table) => table !== used[0].table)
    const joinSql = rest
        .map((table) => {
            const edge = joins.find(
                (item) =>
                    (item.leftTable === used[0].table && item.rightTable === table) ||
                    (item.rightTable === used[0].table && item.leftTable === table) ||
                    (item.leftTable === table && tables.includes(item.rightTable)) ||
                    (item.rightTable === table && tables.includes(item.leftTable))
            )
            if (!edge) return ''
            const on = `${quoteQualified(edge.leftTable)}.${quoteIdent(edge.leftColumn)} = ${quoteQualified(edge.rightTable)}.${quoteIdent(
                edge.rightColumn
            )}`
            return ` JOIN ${quoteQualified(table)} ON ${on}`
        })
        .join('')
    if (rest.length && !joinSql) {
        return { error: 'The saved query relates several tables, but the relationship was not clear enough to pick matching test values.' }
    }
    const where = used.map((binding) => `${quoteQualified(binding.table)}.${quoteIdent(binding.column)} IS NOT NULL`).join(' AND ')
    const text = `SELECT DISTINCT ${select} FROM ${from}${joinSql} WHERE ${where} LIMIT 20`
    if (text.length > 4000) return { error: 'The lookup for test values was too large, so it was not run.' }
    return { text, bindings: used }
}

export interface ParamSpec {
    name: string
    type?: string
    required?: boolean
    default?: unknown
    allowedValues?: unknown[]
    min?: unknown
    max?: unknown
    secure?: boolean
}

function textOf(value: unknown): string {
    if (value === undefined || value === null) return ''
    return String(value).trim()
}

function allowedMatch(param: ParamSpec, value: string): boolean {
    if (!Array.isArray(param.allowedValues) || !param.allowedValues.length) return true
    return param.allowedValues.some((item) => textOf(item) === value)
}

function decimalCompare(left: string, right: string): number {
    const parts = (raw: string) => {
        let sign = 1
        let text = raw.trim()
        if (text.startsWith('-')) {
            sign = -1
            text = text.slice(1)
        } else if (text.startsWith('+')) text = text.slice(1)
        const [wholeRaw, fracRaw = ''] = text.split('.')
        return { sign, whole: wholeRaw.replace(/^0+/, '') || '0', frac: fracRaw.replace(/0+$/, '') }
    }
    const a = parts(left)
    const b = parts(right)
    if (a.sign !== b.sign) return a.sign - b.sign
    const textCompare = (x: string, y: string) => (x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0)
    const whole = textCompare(a.whole, b.whole)
    if (whole) return whole * a.sign
    const width = Math.max(a.frac.length, b.frac.length)
    return textCompare(a.frac.padEnd(width, '0'), b.frac.padEnd(width, '0')) * a.sign
}

function inRange(param: ParamSpec, value: string): boolean {
    const min = textOf(param.min)
    const max = textOf(param.max)
    if (param.type === 'int8') {
        try {
            const number = BigInt(value)
            if (min && number < BigInt(min)) return false
            if (max && number > BigInt(max)) return false
        } catch {
            return false
        }
        return true
    }
    if (param.type === 'numeric') {
        if (min && decimalCompare(value, min) < 0) return false
        if (max && decimalCompare(value, max) > 0) return false
        return true
    }
    if (min && value < min) return false
    if (max && value > max) return false
    return true
}

function coerce(param: ParamSpec, value: unknown): unknown {
    let text = textOf(value)
    if (['date', 'timestamp', 'timestamptz'].includes(param.type || '')) {
        const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
        if (!date || !Number.isFinite(date.getTime())) return undefined
        text = param.type === 'date' ? date.toISOString().slice(0, 10) : date.toISOString()
    }
    if (!text) return undefined
    if (param.type === 'bool') {
        if (text === 'true' || text === 't') return true
        if (text === 'false' || text === 'f') return false
        return undefined
    }
    if (param.type === 'int8' && !/^-?\d+$/.test(text)) return undefined
    if (param.type === 'numeric' && !/^-?\d+(\.\d+)?$/.test(text)) return undefined
    if (!allowedMatch(param, text) || !inRange(param, text)) return undefined
    if (param.type === 'bool') return text === 'true'
    return text
}

export function valuesFromDiscovery(
    params: ParamSpec[],
    rows: Array<Record<string, unknown>>,
    bindings: Binding[]
): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    const byParam = new Map(bindings.map((item) => [item.param, item]))
    const grouped = new Map<string, Binding[]>()
    for (const binding of bindings) {
        const key = `${binding.table}.${binding.column}`
        const list = grouped.get(key) || []
        list.push(binding)
        grouped.set(key, list)
    }
    for (const [, list] of grouped) {
        const lower = list.find((item) => item.op === '>=' || item.op === '>')
        const upper = list.find((item) => item.op === '<=' || item.op === '<')
        if (!lower || !upper || !rows.length) continue
        const column = lower.param
        const spec = params.find((item) => item.name === lower.param)
        if (!spec) continue
        const numbers = rows
            .map((row) => coerce(spec, row[column] ?? row[lower.column]))
            .filter((v) => v !== undefined)
            .map(String)
        const numeric = numbers.every((item) => /^-?\d+(\.\d+)?$/.test(item))
        numbers.sort((left, right) => (numeric ? decimalCompare(left, right) : left < right ? -1 : left > right ? 1 : 0))
        if (!numbers.length) continue
        const low = coerce(params.find((item) => item.name === lower.param) || { name: lower.param }, numbers[0])
        let last = numbers[numbers.length - 1]
        if (upper.op === '<' && ['date', 'timestamp', 'timestamptz'].includes(spec.type || '')) {
            const end = new Date(last)
            end.setTime(end.getTime() + (spec.type === 'date' ? 86400000 : 1))
            last = spec.type === 'date' ? end.toISOString().slice(0, 10) : end.toISOString()
        }
        const high = coerce(params.find((item) => item.name === upper.param) || { name: upper.param }, last)
        if (low !== undefined) values[lower.param] = low
        if (high !== undefined) values[upper.param] = high
    }

    for (const row of rows) {
        let fits = true
        const candidate: Record<string, unknown> = {}
        for (const binding of bindings) {
            if (binding.op !== '=') continue
            const param = params.find((item) => item.name === binding.param)
            if (!param || param.secure) continue
            const raw = row[binding.param] ?? row[binding.column]
            const value = coerce(param || { name: binding.param }, raw)
            if (value === undefined) {
                fits = false
                break
            }
            candidate[binding.param] = value
        }
        if (!fits) continue
        Object.assign(values, candidate)
        break
    }

    for (const param of params) {
        if (values[param.name] !== undefined) continue
        if (param.secure) {
            if (param.default !== undefined && param.default !== null && textOf(param.default)) values[param.name] = param.default
            continue
        }
        if (Array.isArray(param.allowedValues) && param.allowedValues.length) {
            const pick = param.allowedValues.map((item) => coerce(param, item)).find((item) => item !== undefined)
            if (pick !== undefined) {
                values[param.name] = pick
                continue
            }
        }
        if (param.default !== undefined && param.default !== null && textOf(param.default) !== '') {
            const fallback = coerce(param, param.default)
            if (fallback !== undefined) values[param.name] = fallback
        }
        if (values[param.name] === undefined && byParam.has(param.name)) continue
    }
    // Calendar parameters have useful bounded samples even when the statement builds
    // its bounds in a CTE instead of comparing a base column directly.
    const today = new Date()
    for (const param of params) {
        if (param.secure || !param.required || values[param.name] !== undefined) continue
        if (byParam.has(param.name)) continue
        let candidate: unknown
        if (['numeric', 'int8'].includes(param.type || '') && !['year', 'month'].includes(param.name)) candidate = param.min ?? 0
        if (param.type === 'bool') candidate = false
        if (param.type === 'int8' && param.name === 'year') candidate = today.getUTCFullYear()
        if (param.type === 'int8' && param.name === 'quarter') candidate = Math.floor(today.getUTCMonth() / 3) + 1
        if (param.type === 'int8' && param.name === 'month') candidate = today.getUTCMonth() + 1
        if (param.type === 'date' && ['start_date', 'quarter_start'].includes(param.name)) {
            candidate = new Date(
                Date.UTC(today.getUTCFullYear(), param.name === 'quarter_start' ? Math.floor(today.getUTCMonth() / 3) * 3 : 0, 1)
            )
        }
        if (param.type === 'date' && param.name === 'end_date')
            candidate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1))
        if (candidate !== undefined) {
            const coerced = coerce(param, candidate)
            if (coerced !== undefined) values[param.name] = coerced
        }
    }
    return values
}

export function missingRequired(params: ParamSpec[], values: Record<string, unknown>): string[] {
    return params
        .filter(
            (param) =>
                param.required !== false && (values[param.name] === undefined || values[param.name] === null || values[param.name] === '')
        )
        .map((param) => param.name)
}

// Expression parameters cannot always be traced through CTEs. Offer bounded candidate
// lookups using only columns explicitly referenced on selected base tables. The normal
// query test still validates the candidate; this never changes the saved statement.
export function expressionLookups(sql: string, relations: string[], params: ParamSpec[]): DiscoveryPlan[] {
    const tokens = tokenize(sql)
    const aliases = new Map<string, string>()
    for (let i = 0; i < tokens.length - 1; i++) {
        if (!/^(from|join)$/i.test(tokens[i].text) || tokens[i].kind !== 'word') continue
        let table = ident(tokens[i + 1])
        let end = i + 2
        if (tokens[end]?.kind === 'dot') {
            table += '.' + ident(tokens[end + 1])
            end += 2
        }
        if (!table || !allowedTable(table, relations)) continue
        if (tokens[end]?.text.toLowerCase() === 'as') end++
        const alias = ident(tokens[end])
        aliases.set(table.split('.').pop()!.toLowerCase(), table)
        if (alias && !/^(where|on|join|left|right|group|order|limit|union)$/i.test(alias)) aliases.set(alias.toLowerCase(), table)
    }
    const columns: Array<{ table: string; column: string }> = []
    for (let i = 0; i < tokens.length - 2; i++) {
        if (tokens[i + 1].kind !== 'dot') continue
        const table = aliases.get(ident(tokens[i]).toLowerCase())
        const column = ident(tokens[i + 2])
        if (table && column && !SENSITIVE.test(column) && !columns.some((x) => x.table === table && x.column === column))
            columns.push({ table, column })
    }
    const plans: DiscoveryPlan[] = []
    for (const param of params) {
        if (param.secure || SENSITIVE.test(param.name)) continue
        const name = param.name.toLowerCase()
        const stem = name.replace(/_(query|ids|id|name)$/, '')
        const score = (c: { table: string; column: string }) => {
            const col = c.column.toLowerCase()
            if (col === name) return 100
            if (/_ids$/.test(name) && col === name.slice(0, -1)) return 95
            if (/_query$/.test(name) && col === stem + '_name') return 90
            if (col === 'name' && /_(name|query)$/.test(name) && c.table.toLowerCase().includes(stem)) return 85
            if (col === 'id' && /_ids?$/.test(name) && c.table.toLowerCase().includes(stem)) return 85
            if (col === name + '_label') return 80
            if (['date', 'timestamp', 'timestamptz'].includes(param.type || '') && /date|timestamp|_ts$|_at$/.test(col)) return 50
            return 0
        }
        for (const column of columns
            .filter((c) => score(c) > 0)
            .sort((a, b) => score(b) - score(a))
            .slice(0, 3)) {
            const ref = `${quoteQualified(column.table)}.${quoteIdent(column.column)}`
            plans.push({
                text: `SELECT DISTINCT ${ref} AS ${quoteIdent(param.name)} FROM ${quoteQualified(
                    column.table
                )} WHERE ${ref} IS NOT NULL LIMIT 20`,
                bindings: [{ param: param.name, ...column, op: '=' }]
            })
        }
    }
    return plans
}

// Literal alternatives explicitly compared with a parameter (or its same-named CTE
// column) are authored choices, not invented sample identities.
export function literalSamples(sql: string, params: ParamSpec[]): Record<string, unknown> {
    const tokens = tokenize(sql)
    const values: Record<string, unknown> = {}
    for (const param of params) {
        if (!param.required || param.secure || SENSITIVE.test(param.name)) continue
        const candidates: Array<{ value: unknown; priority: number }> = []
        for (let i = 0; i < tokens.length - 2; i++) {
            const t = tokens[i]
            if (t.text !== param.name || !['param', 'word'].includes(t.kind)) continue
            // Parentheses have already been removed by the tokenizer. Look through
            // a short normalization/cast expression, stopping at another parameter
            // or a clause boundary. Prefer explicit IN alternatives over sentinels.
            for (let j = i + 1; j < Math.min(i + 12, tokens.length - 1); j++) {
                const op = tokens[j]
                if (op.kind === 'param' || /^(select|from|where|and|or|then|else)$/i.test(op.text)) break
                if (op.text !== '=' && op.text.toLowerCase() !== 'in') continue
                if (tokens[j - 1]?.text.toLowerCase() === 'not') break
                const value = tokens[j + 1]
                if (value.kind === 'string') {
                    const converted = coerce(param, value.text)
                    if (converted !== undefined) candidates.push({ value: converted, priority: op.text.toLowerCase() === 'in' ? 1 : 0 })
                }
                break
            }
        }
        const chosen = candidates.sort((a, b) => b.priority - a.priority)[0]
        if (chosen) values[param.name] = chosen.value
    }
    return values
}
