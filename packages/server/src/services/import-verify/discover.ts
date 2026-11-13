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
    kind: 'word' | 'param' | 'op' | 'dot'
    text: string
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
        if (c === "'" || c === '"') {
            i += 1
            while (i < sql.length) {
                if (sql[i] === c) {
                    if (sql[i + 1] === c) {
                        i += 2
                        continue
                    }
                    i += 1
                    break
                }
                i += 1
            }
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
    if (!token || token.kind !== 'word' || !IDENT.test(token.text)) return ''
    return token.text
}

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

export function allowedTable(name: string, relations: string[]): boolean {
    const needle = name.toLowerCase()
    return relations.some((relation) => {
        const text = relation.trim().toLowerCase()
        if (!text) return false
        const bare = text.includes('.') ? text.slice(text.lastIndexOf('.') + 1) : text
        return bare === needle || text === needle
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

    for (let i = 0; i < tokens.length; i += 1) {
        const word = tokens[i]
        if (word.kind !== 'word' || !/^(from|join)$/i.test(word.text)) continue
        const table = ident(tokens[i + 1])
        if (!table) continue
        let alias = table
        const next = tokens[i + 2]
        if (next?.kind === 'word' && !/^(on|join|left|right|inner|outer|cross|where|group|order|limit|as)$/i.test(next.text)) {
            alias = ident(next) || table
        } else if (next?.kind === 'word' && /^as$/i.test(next.text)) {
            alias = ident(tokens[i + 3]) || table
        }
        aliases.set(alias.toLowerCase(), table)
        aliases.set(table.toLowerCase(), table)
    }

    const columnRef = (index: number): { table: string; column: string; next: number } | null => {
        const first = ident(tokens[index])
        if (!first) return null
        if (tokens[index + 1]?.kind === 'dot') {
            const column = ident(tokens[index + 2])
            if (!column) return null
            const table = aliases.get(first.toLowerCase()) || first
            return { table, column, next: index + 3 }
        }
        return null
    }

    for (let i = 0; i < tokens.length; i += 1) {
        const left = columnRef(i)
        if (!left) continue
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
    for (const table of tables) {
        if (!IDENT.test(table) || !allowedTable(table, relations)) {
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
        .map((binding) => `${quoteIdent(binding.table)}.${quoteIdent(binding.column)} AS ${quoteIdent(binding.param)}`)
        .join(', ')
    const from = quoteIdent(used[0].table)
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
            const on = `${quoteIdent(edge.leftTable)}.${quoteIdent(edge.leftColumn)} = ${quoteIdent(edge.rightTable)}.${quoteIdent(
                edge.rightColumn
            )}`
            return ` JOIN ${quoteIdent(table)} ON ${on}`
        })
        .join('')
    if (rest.length && !joinSql) {
        return { error: 'The saved query relates several tables, but the relationship was not clear enough to pick matching test values.' }
    }
    const where = used.map((binding) => `${quoteIdent(binding.table)}.${quoteIdent(binding.column)} IS NOT NULL`).join(' AND ')
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
    const text = textOf(value)
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
        const numbers = rows
            .map((row) => textOf(row[column] ?? row[lower.column]))
            .filter(Boolean)
            .sort()
        if (!numbers.length) continue
        const low = coerce(params.find((item) => item.name === lower.param) || { name: lower.param }, numbers[0])
        const high = coerce(params.find((item) => item.name === upper.param) || { name: upper.param }, numbers[numbers.length - 1])
        if (low !== undefined) values[lower.param] = low
        if (high !== undefined) values[upper.param] = high
    }

    for (const row of rows) {
        let fits = true
        const candidate: Record<string, unknown> = {}
        for (const binding of bindings) {
            if (binding.op !== '=') continue
            const param = params.find((item) => item.name === binding.param)
            if (param?.secure) continue
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
