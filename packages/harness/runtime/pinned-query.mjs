import { checkReadOnlySql } from './analyst-relations.mjs'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const PINNED_PREFIX = 'pq_'
export const PINNED_TOOL_RE = /(^|__)pq_[a-z0-9_]+$/
export const PARAM_TYPES = Object.freeze(['text', 'int8', 'numeric', 'date', 'timestamp', 'timestamptz', 'bool'])
export const isPinnedToolName = (name) => typeof name === 'string' && PINNED_TOOL_RE.test(name)
export const pinnedQueriesEnabled = (env = process.env) => env.CUTTLELY_PINNED_QUERIES === '1' || env.CUTTLELY_PINNED_QUERIES === 'true'
export class PinnedQueryError extends Error {
    constructor(message, code = 'invalid_query') {
        super(message)
        this.name = 'PinnedQueryError'
        this.code = code
        this.outcome = 'expected'
        this.cuttlelyOutcome = 'expected'
    }
}
export class PinnedParamError extends PinnedQueryError {
    constructor(message) {
        super(message, 'invalid_params')
        this.name = 'PinnedParamError'
    }
}
const fail = (message, code) => {
    throw new PinnedQueryError(message, code)
}
const canonical = (v) =>
    Array.isArray(v)
        ? v.map(canonical)
        : v && typeof v === 'object'
        ? Object.fromEntries(
              Object.keys(v)
                  .sort()
                  .map((k) => [k, canonical(v[k])])
          )
        : v
const json = (v) => JSON.stringify(canonical(v))
const hash = (v) => createHash('sha256').update(v).digest('hex')
const normal = (s) => {
    const text = String(s).replace(/\s+/g, ' ')
    let end = text.length
    while (end > 0 && (text[end - 1] === ';' || text[end - 1] === ' ')) end--
    return text.slice(0, end).trim()
}

// Position-aware lexer. Quoted text never contributes parameters or clause words.
function scan(sql, allowPositional = false) {
    const tokens = []
    let depth = 0
    for (let i = 0; i < sql.length; ) {
        const start = i,
            c = sql[i],
            pair = sql.slice(i, i + 2)
        if (/\s/.test(c)) {
            i++
            continue
        }
        if (pair === '--') {
            const end = sql.slice(i).search(/[\r\n]/)
            i = end < 0 ? sql.length : i + end
            continue
        }
        if (pair === '/*') {
            let nesting = 1
            i += 2
            while (i < sql.length && nesting) {
                if (sql.slice(i, i + 2) === '/*') {
                    nesting++
                    i += 2
                } else if (sql.slice(i, i + 2) === '*/') {
                    nesting--
                    i += 2
                } else i++
            }
            if (nesting) fail('Unclosed SQL comment.', 'syntax')
            continue
        }
        if (c === "'" || c === '"') {
            const escape = c === "'" && /[eE]/.test(sql[i - 1] || '') && !/[\w$]/.test(sql[i - 2] || '')
            i++
            let closed = false
            while (i < sql.length) {
                if (escape && sql[i] === '\\') {
                    i += 2
                    continue
                }
                if (sql[i] === c) {
                    if (sql[i + 1] === c) {
                        i += 2
                        continue
                    }
                    i++
                    closed = true
                    break
                }
                i++
            }
            if (!closed) fail('Unclosed SQL quote.', 'syntax')
            tokens.push({ text: sql.slice(start, i), start, end: i, depth, quoted: true })
            continue
        }
        if (c === '$') {
            const positional = sql.slice(i).match(/^\$\d+/)?.[0]
            if (positional) {
                if (!allowPositional) fail('Raw positional parameters are not allowed.', 'raw_parameter')
                i += positional.length
                tokens.push({ text: positional, start, end: i, depth, positional: true })
                continue
            }
            const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]
            if (tag) {
                const end = sql.indexOf(tag, i + tag.length)
                if (end < 0) fail('Unclosed dollar quote.', 'syntax')
                i = end + tag.length
                tokens.push({ text: sql.slice(start, i), start, end: i, depth, quoted: true })
                continue
            }
        }
        if (pair === '::') {
            tokens.push({ text: pair, start, end: i + 2, depth })
            i += 2
            continue
        }
        if (c === ':' && /^:[A-Za-z_][A-Za-z0-9_]*/.test(sql.slice(i))) {
            const text = sql.slice(i).match(/^:[A-Za-z_][A-Za-z0-9_]*/)[0]
            i += text.length
            tokens.push({ text, param: text.slice(1), start, end: i, depth })
            continue
        }
        const word = sql.slice(i).match(/^(?:[A-Za-z_][A-Za-z0-9_$]*|\d+)/)?.[0]
        if (word) {
            i += word.length
            tokens.push({ text: word, start, end: i, depth })
            continue
        }
        if (c === '(') depth++
        if (c === ')') depth--
        tokens.push({ text: c, start, end: ++i, depth })
    }
    return tokens
}
function specs(entry) {
    const params = entry.params ?? []
    if (!Array.isArray(params)) fail('Parameters must be a list.', 'param_spec')
    const seen = new Set()
    for (const p of params) {
        if (
            !p ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name) ||
            /^(sql|statement|query|cursor|page|binds|__proto__|constructor|prototype)$/i.test(p.name)
        )
            fail('Invalid or reserved parameter name.', 'param_name')
        if (seen.has(p.name)) fail(`Duplicate parameter ${p.name}.`, 'duplicate_param')
        seen.add(p.name)
        if (!PARAM_TYPES.includes(p.type)) fail(`Unsupported type for ${p.name}.`, 'param_type')
    }
    return params
}
export function compilePinned(entry, args) {
    const sql = String(entry.sql || ''),
        params = specs(entry),
        tokens = scan(sql)
    for (let i = 0; i < tokens.length; i++) {
        if (!['::', 'as'].includes(tokens[i].text.toLowerCase())) continue
        let j = i + 1
        if (tokens[j + 1]?.text === '.') j += 2
        const type = tokens[j]?.text.replace(/^"|"$/g, '').toLowerCase()
        if (
            /^(oid|regclass|regproc|regprocedure|regoper|regoperator|regtype|regnamespace|regrole|regcollation|regconfig|regdictionary)$/.test(
                type || ''
            )
        )
            fail('Object identifier casts are not allowed in pinned SQL.', 'param_cast')
    }
    if (tokens.some((t) => t.text === ';')) fail('Semicolons are not allowed.', 'semicolon')
    const top = tokens.filter((t) => t.depth === 0 && !t.quoted)
    const limit = top.findIndex((t) => /^limit$/i.test(t.text))
    if (
        limit < 0 ||
        !/^\d+$/.test(top[limit + 1]?.text || '') ||
        !['offset', 'for', undefined].includes(top[limit + 2]?.text?.toLowerCase())
    )
        fail('A literal top-level LIMIT is required.', 'limit')
    // LIMIT/OFFSET expressions at every nesting level must be literal, never model parameters.
    for (let i = 0; i < tokens.length; i++)
        if (!tokens[i].quoted && /^(limit|offset)$/i.test(tokens[i].text)) {
            for (let j = i + 1; j < tokens.length && tokens[j].depth >= tokens[i].depth; j++) {
                if (!tokens[j].quoted && /^(offset|limit|for|union|except|intersect)$/i.test(tokens[j].text)) break
                if (tokens[j].param) fail('Parameters in LIMIT or OFFSET are not allowed.', 'limit_parameter')
            }
        }
    const byName = new Map(params.map((p) => [p.name, p])),
        order = [],
        seen = new Set()
    const spans = []
    let runText = '',
        checkText = '',
        at = 0
    for (const t of tokens.filter((t) => t.param)) {
        if (
            /[A-Za-z0-9_$\u0080-\uffff:]/.test(sql[t.start - 1] || '') ||
            /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[t.end] || '') ||
            (sql[t.end] === ':' && sql.slice(t.end, t.end + 2) !== '::')
        )
            fail('A parameter must be separated from an identifier.', 'param_position')
        const p = byName.get(t.param)
        if (!p) fail(`Missing specification for ${t.param}.`, 'missing_spec')
        if (!seen.has(p.name)) {
            seen.add(p.name)
            order.push(p.name)
        }
        const prefix = sql.slice(at, t.start),
            cast = `::pg_catalog.${p.type}`
        spans.push({
            runStart: runText.length + prefix.length,
            checkStart: checkText.length + prefix.length,
            index: order.indexOf(p.name) + 1,
            type: p.type
        })
        runText += `${prefix}$${order.indexOf(p.name) + 1}${cast}`
        checkText += `${prefix}NULL${cast}`
        at = t.end
    }
    for (const p of params) if (!seen.has(p.name)) fail(`Unused parameter ${p.name}.`, 'unused_param')
    runText += sql.slice(at)
    checkText += sql.slice(at)
    assertCheckRunPair(runText, checkText, spans)
    return {
        runText,
        checkText,
        binds: args === undefined ? null : validateArgs(entry, args),
        order,
        statementHash: hash(normal(runText) + '\n' + json(params))
    }
}
// Spans are offsets emitted while compiling, never discovered by replacing SQL text.
export function assertCheckRunPair(runText, checkText, spans) {
    let r = 0,
        c = 0
    for (const span of spans) {
        const { runStart, checkStart, index, type } = span
        if (!PARAM_TYPES.includes(type) || !Number.isSafeInteger(index) || index < 1 || runStart < r || checkStart < c)
            fail('Invalid parameter span.', 'check_run_pair')
        const run = `$${index}::pg_catalog.${type}`,
            check = `NULL::pg_catalog.${type}`
        if (
            runText.slice(r, runStart) !== checkText.slice(c, checkStart) ||
            runText.slice(runStart, runStart + run.length) !== run ||
            checkText.slice(checkStart, checkStart + check.length) !== check
        )
            fail('Check and run texts differ outside typed parameter spans.', 'check_run_pair')
        r = runStart + run.length
        c = checkStart + check.length
    }
    if (runText.slice(r) !== checkText.slice(c)) fail('Check and run texts differ.', 'check_run_pair')
    // No raw or uncast positional site may hide outside the emitted spans.
    const sites = scan(runText, true).filter((t) => t.positional)
    if (sites.length !== spans.length || sites.some((t, i) => t.start !== spans[i].runStart))
        fail('Untracked positional parameter.', 'check_run_pair')
    return true
}
export const statementHash = (entry) => compilePinned(entry).statementHash

function decimalString(s) {
    const m = /^([+-]?)(\d*(?:\.\d*)?)(?:[eE]([+-]?\d+))?$/.exec(s)
    if (!m || s.length > 4096) throw Error()
    const exponent = Number(m[3] || 0)
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) throw Error()
    const [integer, fraction = ''] = m[2].split('.')
    let digits = integer + fraction
    const point = integer.length + exponent
    let out =
        point <= 0
            ? '0.' + '0'.repeat(-point) + digits
            : point >= digits.length
            ? digits + '0'.repeat(point - digits.length)
            : digits.slice(0, point) + '.' + digits.slice(point)
    out = out
        .replace(/^0+(?=\d)/, '')
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, '')
    return (m[1] === '-' && /[1-9]/.test(out) ? '-' : '') + out
}
function decimalCompare(a, b) {
    const places = Math.max((a.split('.')[1] || '').length, (b.split('.')[1] || '').length)
    const integer = (s) => BigInt(s.replace('.', '') + '0'.repeat(places - (s.split('.')[1] || '').length))
    const x = integer(a),
        y = integer(b)
    return x < y ? -1 : x > y ? 1 : 0
}
function valueString(type, value) {
    if (type === 'text') {
        if (typeof value !== 'string' || value.includes('\0') || value.length > 10000) throw Error()
        return value
    }
    if (type === 'bool') {
        if (value === true) return 'true'
        if (value === false) return 'false'
        throw Error()
    }
    if (typeof value !== 'string' && typeof value !== 'number') throw Error()
    const s = String(value)
    if (type === 'int8') {
        if (!/^-?\d+$/.test(s) || (typeof value === 'number' && !Number.isSafeInteger(value))) throw Error()
        const n = BigInt(s)
        if (n < -9223372036854775808n || n > 9223372036854775807n) throw Error()
        return String(n)
    }
    if (type === 'numeric') {
        if ((typeof value === 'string' && !/^-?\d+(\.\d+)?$/.test(s)) || (typeof value === 'number' && !Number.isFinite(value)))
            throw Error()
        return decimalString(s)
    }
    const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
    if (
        !date ||
        +date[1] < 1 ||
        +date[2] < 1 ||
        +date[2] > 12 ||
        +date[3] < 1 ||
        +date[3] > new Date(Date.UTC(+date[1], +date[2], 0)).getUTCDate()
    )
        throw Error()
    if (type === 'date') {
        if (s.length !== 10) throw Error()
        return s
    }
    const time =
        type === 'timestamp'
            ? /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?$/
            : /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|[+-](\d{2}):(\d{2}))$/
    const m = time.exec(s)
    if (!m || +m[1] > 23 || +m[2] > 59 || +m[3] > 59 || (m[6] && (+m[6] > 15 || +m[7] > 59))) throw Error()
    return s.replace(' ', 'T')
}
export function validateArgs(entry, args) {
    const params = specs(entry),
        { order } = compilePinned(entry)
    const bad = (name) => {
        throw new PinnedParamError(`Invalid parameter ${name}. Expected parameters: ${params.map((p) => p.name).join(', ') || '(none)'}.`)
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) bad('(arguments)')
    for (const k of Object.keys(args)) if (!params.some((p) => p.name === k)) bad(k)
    const values = new Map()
    for (const p of params) {
        let v = Object.hasOwn(args, p.name) ? args[p.name] : p.default
        if (v === undefined || v === null) {
            if (p.required) bad(p.name)
            values.set(p.name, null)
            continue
        }
        try {
            v = valueString(p.type, v)
            if (p.allowedValues && !p.allowedValues.some((a) => a === (Object.hasOwn(args, p.name) ? args[p.name] : p.default))) bad(p.name)
            if (
                p.min !== undefined &&
                (p.type === 'numeric'
                    ? decimalCompare(v, valueString('numeric', p.min)) < 0
                    : p.type === 'int8'
                    ? BigInt(v) < BigInt(p.min)
                    : v < valueString(p.type, p.min))
            )
                bad(p.name)
            if (
                p.max !== undefined &&
                (p.type === 'numeric'
                    ? decimalCompare(v, valueString('numeric', p.max)) > 0
                    : p.type === 'int8'
                    ? BigInt(v) > BigInt(p.max)
                    : v > valueString(p.type, p.max))
            )
                bad(p.name)
        } catch {
            bad(p.name)
        }
        values.set(p.name, v)
    }
    return order.map((name) => values.get(name))
}
export function stampPayload({ workspaceId, cred, statementHash, params, tables, functions, testedColumns }) {
    return json({
        workspaceId,
        cred,
        statementHash,
        params,
        tables: [...(tables || [])].sort(),
        functions: [...(functions || [])].sort(),
        testedColumns
    })
}
export const computeStamp = (keyBuf, payload) => createHmac('sha256', keyBuf).update(payload).digest('hex')
export function verifyStamp(keyBuf, payload, stamp) {
    if (typeof stamp !== 'string' || !/^[a-f0-9]{64}$/.test(stamp)) return false
    return timingSafeEqual(Buffer.from(computeStamp(keyBuf, payload), 'hex'), Buffer.from(stamp, 'hex'))
}
export function pinnedToolDefinition(entry) {
    if (!/^pq_[a-z0-9_]+$/.test(entry.name) || entry.name.length > 64) fail('Invalid pinned tool name.', 'tool_name')
    compilePinned(entry)
    const properties = Object.fromEntries(
        specs(entry).map((p) => [
            p.name,
            {
                type: p.type === 'bool' ? 'boolean' : p.type === 'int8' || p.type === 'numeric' ? ['string', 'number'] : 'string',
                ...(p.allowedValues ? { enum: p.allowedValues } : {}),
                ...(p.default !== undefined ? { default: p.default } : {})
            }
        ])
    )
    return {
        name: entry.name,
        description: entry.description || entry.purpose || '',
        inputSchema: {
            type: 'object',
            properties,
            required: specs(entry)
                .filter((p) => p.required && p.default === undefined)
                .map((p) => p.name),
            additionalProperties: false
        }
    }
}
export function sqlTraceFields(sql, { preview } = {}) {
    const text = String(sql || ''),
        result = { sqlHash: hash(normal(text)) }
    if (preview) {
        const bytes = Buffer.from(text)
        let end = Math.min(bytes.length, 4096)
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
        result.sql = bytes.subarray(0, end).toString('utf8')
        if (bytes.length > end) result.sqlTruncated = true
    }
    return result
}

// Low-level helper: the caller must first complete the node scope/routine checks on
// checkText, then enter its read-only run transaction on this same connection.
let prepareSequence = 0
export async function suggestParamTypes(client, runner, sqlWithUncastParams) {
    checkReadOnlySql(sqlWithUncastParams)
    const tokens = scan(runner.checkedRunSql || '', true)
    let uncast = '',
        at = 0
    for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].positional) continue
        const cast = tokens.slice(i + 1, i + 5)
        if (cast[0]?.text !== '::' || cast[1]?.text !== 'pg_catalog' || cast[2]?.text !== '.' || !PARAM_TYPES.includes(cast[3]?.text))
            continue
        uncast += runner.checkedRunSql.slice(at, tokens[i].end)
        at = cast[3].end
    }
    uncast += (runner.checkedRunSql || '').slice(at)
    if (!runner.pinnedChecksComplete || uncast !== sqlWithUncastParams)
        throw new PinnedQueryError('Parameter suggestions require the node checks first.', 'unchecked_suggestion')
    const name = `cuttlely_pinned_types_${++prepareSequence}`
    const protocolName = `${name}_parse`
    const map = {
        int2: 'int8',
        int4: 'int8',
        int8: 'int8',
        smallint: 'int8',
        integer: 'int8',
        bigint: 'int8',
        float4: 'numeric',
        float8: 'numeric',
        real: 'numeric',
        'double precision': 'numeric',
        numeric: 'numeric',
        varchar: 'text',
        bpchar: 'text',
        'character varying': 'text',
        character: 'text',
        text: 'text',
        date: 'date',
        timestamp: 'timestamp',
        'timestamp without time zone': 'timestamp',
        timestamptz: 'timestamptz',
        'timestamp with time zone': 'timestamptz',
        bool: 'bool',
        boolean: 'bool'
    }
    await client.query('SAVEPOINT cuttlely_pinned_types')
    try {
        await client.query({ name: protocolName, text: `PREPARE ${name} AS ${sqlWithUncastParams}` })
        const result = await client.query(
            'SELECT t::text AS type FROM pg_catalog.pg_prepared_statements p, unnest(p.parameter_types) WITH ORDINALITY AS a(t, n) WHERE p.name = $1 ORDER BY n',
            [name]
        )
        return result.rows.map((row) => map[row.type] || null)
    } catch {
        await client.query('ROLLBACK TO SAVEPOINT cuttlely_pinned_types')
        return null
    } finally {
        await client.query(`DEALLOCATE ${name}`).catch(() => {})
        // DEALLOCATE of a PREPARE that failed can itself abort the transaction.
        await client.query('ROLLBACK TO SAVEPOINT cuttlely_pinned_types').catch(() => {})
        await client.query(`DEALLOCATE ${protocolName}`).catch(() => {})
        await client.query('ROLLBACK TO SAVEPOINT cuttlely_pinned_types').catch(() => {})
        await client.query('RELEASE SAVEPOINT cuttlely_pinned_types')
    }
}
