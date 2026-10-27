// Pure checks for the pinned-query test route. The compiler in the runtime module
// still decides what is legal SQL. This file only shapes the request and the words
// the builder sees.

export const PARAM_TYPES = ['text', 'int8', 'numeric', 'date', 'timestamp', 'timestamptz', 'bool'] as const

export const BODY_KEYS = new Set(['nodeId', 'entry', 'sampleValues', 'canvas'])
export const SUGGEST_KEYS = new Set(['nodeId', 'sql', 'params', 'canvas'])
// The editor's unsaved values for the node under test. A connection URL is never accepted.
export const CANVAS_KEYS = new Set(['credential', 'inputs'])
export const CANVAS_INPUT_KEYS = new Set([
    'analystRelations',
    'analystAllowedFunctions',
    'analystRowCap',
    'analystTimeoutSeconds',
    'pinnedQueries'
])
export const ENTRY_KEYS = new Set([
    'id',
    'name',
    'purpose',
    'description',
    'sql',
    'params',
    'rowCap',
    'version',
    'testedStamp',
    'testedAt',
    'testedBy',
    'testedColumns',
    'needsRetest',
    'statementHash',
    'columnsChanged'
])
export const PARAM_KEYS = new Set(['name', 'type', 'required', 'default', 'allowedValues', 'min', 'max', 'secure'])

export const CALLER_URL_MESSAGE =
    'The test uses the node on this canvas and its credential. Do not send a connection URL or settings for other nodes.'

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const TOOL_RE = /^pq_[a-z0-9_]{1,61}$/
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export class PinnedRequestError extends Error {
    statusCode: number
    constructor(statusCode: number, message: string) {
        super(message)
        this.statusCode = statusCode
    }
}

export function pinnedQueriesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.CUTTLELY_PINNED_QUERIES === '1' || env.CUTTLELY_PINNED_QUERIES === 'true'
}

export function updatePermissionFor(type?: string | null): string {
    if (type === 'AGENTFLOW' || type === 'MULTIAGENT') return 'agentflows:update'
    if (type === 'ASSISTANT') return 'assistants:update'
    return 'chatflows:update'
}

function ownKeys(value: unknown): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    return Object.keys(value as Record<string, unknown>)
}

export function assertExactKeys(value: unknown, allowed: Set<string>, message = CALLER_URL_MESSAGE): void {
    for (const key of ownKeys(value)) {
        if (!allowed.has(key)) throw new PinnedRequestError(400, message)
    }
}

// Position-aware name scan. Matches the runtime compiler: skip quotes, nested
// comments, dollar quotes and casts. A ':' glued to an identifier is still a
// name so the compiler can refuse it.
export function scanParamNames(sql: string): string[] {
    const names: string[] = []
    const seen = new Set<string>()
    const text = String(sql || '')
    for (let i = 0; i < text.length; ) {
        const pair = text.slice(i, i + 2)
        if (pair === '--') {
            const end = text.indexOf('\n', i)
            i = end < 0 ? text.length : end + 1
            continue
        }
        if (pair === '/*') {
            let nesting = 1
            i += 2
            while (i < text.length && nesting) {
                if (text.slice(i, i + 2) === '/*') {
                    nesting += 1
                    i += 2
                } else if (text.slice(i, i + 2) === '*/') {
                    nesting -= 1
                    i += 2
                } else i += 1
            }
            continue
        }
        const ch = text[i]
        if (ch === "'" || ch === '"') {
            i += 1
            while (i < text.length) {
                if (text[i] === ch) {
                    if (text[i + 1] === ch) {
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
        if (ch === '$') {
            const tag = text.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)
            if (tag) {
                const end = text.indexOf(tag[0], i + tag[0].length)
                i = end < 0 ? text.length : end + tag[0].length
                continue
            }
        }
        if (pair === '::') {
            i += 2
            continue
        }
        if (ch === ':' && /^:[A-Za-z_][A-Za-z0-9_]*/.test(text.slice(i))) {
            const token = text.slice(i).match(/^:[A-Za-z_][A-Za-z0-9_]*/)![0]
            const name = token.slice(1)
            if (!seen.has(name)) {
                seen.add(name)
                names.push(name)
            }
            i += token.length
            continue
        }
        i += 1
    }
    return names
}

export function quoteIdent(name: string): string {
    return `"${String(name).replace(/"/g, '""')}"`
}

// Compiler output uses `($n::pg_catalog.<type>)`. Replace those whole tokens from
// the highest index so `$10` is not eaten by `$1`. A short `$n` inside a literal stays.
// The type suggestion compares the uncast form, for example `region=($1)`.
export function uncastCompiled(runSql: string, order: string[]): { uncast: string; check: string } {
    let uncast = String(runSql || '')
    let check = String(runSql || '')
    for (let n = order.length; n >= 1; n -= 1) {
        for (const type of PARAM_TYPES) {
            const token = `($${n}::pg_catalog.${type})`
            uncast = uncast.split(token).join(`($${n})`)
            check = check.split(token).join(`(NULL::pg_catalog.${type})`)
        }
    }
    return { uncast, check }
}

export function statementLimit(sql: string): number | null {
    const match = String(sql || '').match(/\bLIMIT\s+(\d+)(?:\s+OFFSET\s+\d+)?\s*$/i)
    if (!match) return null
    const n = Number(match[1])
    return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export function plainGuard(error: unknown): string {
    const raw = error instanceof Error ? error.message : 'The test failed.'
    return raw
        .replace(/postgres(?:ql)?:\/\/\S+/gi, '[hidden]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500)
}

export function successGuard(input: { relations: string[]; functions: string[] }): string[] {
    const lines = [
        'The read-only check passed.',
        'The statement is one SELECT or WITH query, with a LIMIT and no semicolon.',
        input.relations.length
            ? 'It only reads the tables and views ticked on the node.'
            : 'No tables are ticked, so this login can read every table it is allowed to read.',
        'It ran on the connection saved on the node, with the row cap and timeout saved there.'
    ]
    if (input.functions.length) lines.splice(3, 0, 'Functions outside the catalog were checked against the allowed list.')
    return lines
}

export interface NormalizedParam {
    name: string
    type: string
    required: boolean
    default?: unknown
    allowedValues?: unknown[]
    min?: unknown
    max?: unknown
    secure?: boolean
}

function copyBound(value: unknown): unknown {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
    return undefined
}

export function normalizeParams(value: unknown): NormalizedParam[] {
    if (!Array.isArray(value)) throw new PinnedRequestError(400, 'Parameters must be a list.')
    return value.map((item) => {
        assertExactKeys(item, PARAM_KEYS)
        const row = item as Record<string, unknown>
        const name = typeof row.name === 'string' ? row.name : ''
        if (!NAME_RE.test(name)) throw new PinnedRequestError(400, 'A parameter name must be letters, digits and underscores.')
        const type = typeof row.type === 'string' ? row.type : ''
        if (!PARAM_TYPES.includes(type as (typeof PARAM_TYPES)[number])) {
            throw new PinnedRequestError(400, `Choose a type for ${name}.`)
        }
        const param: NormalizedParam = {
            name,
            type,
            required: row.required !== false
        }
        if (row.default !== undefined) {
            const bound = copyBound(row.default)
            if (bound === undefined) throw new PinnedRequestError(400, `The default for ${name} must be text, a number, or true or false.`)
            param.default = bound
        }
        if (row.allowedValues !== undefined) {
            if (!Array.isArray(row.allowedValues)) throw new PinnedRequestError(400, `Allowed values for ${name} must be a list.`)
            param.allowedValues = row.allowedValues.map((entry) => {
                const bound = copyBound(entry)
                if (bound === undefined)
                    throw new PinnedRequestError(400, `Allowed values for ${name} must be text, numbers, or true or false.`)
                return bound
            })
        }
        if (row.min !== undefined) param.min = copyBound(row.min)
        if (row.max !== undefined) param.max = copyBound(row.max)
        if (row.secure === true) param.secure = true
        return param
    })
}

export interface NormalizedEntry {
    id: string
    name: string
    purpose: string
    description: string
    sql: string
    params: NormalizedParam[]
    rowCap?: number
    version: number
}

export function normalizeEntry(value: unknown): NormalizedEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PinnedRequestError(400, 'The query to test is missing.')
    assertExactKeys(value, ENTRY_KEYS)
    const entry = value as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (!ID_RE.test(id)) throw new PinnedRequestError(400, 'The query id is missing.')
    const name = typeof entry.name === 'string' ? entry.name : ''
    if (!TOOL_RE.test(name)) throw new PinnedRequestError(400, 'The tool name must be pq_ plus a short slug.')
    const sql = typeof entry.sql === 'string' ? entry.sql : ''
    if (!sql.trim()) throw new PinnedRequestError(400, 'Write the SQL to test.')
    if (sql.length > 200000) throw new PinnedRequestError(400, 'That SQL is too long to test.')
    const purpose = typeof entry.purpose === 'string' ? entry.purpose.trim() : ''
    if (!purpose) throw new PinnedRequestError(400, 'Write a one-line purpose.')
    const description = typeof entry.description === 'string' ? entry.description : ''
    const version = entry.version === undefined ? 1 : Number(entry.version)
    if (!Number.isInteger(version) || version < 1 || version > 1000000) throw new PinnedRequestError(400, 'The version is not valid.')
    const normalized: NormalizedEntry = {
        id,
        name,
        purpose,
        description,
        sql,
        params: normalizeParams(entry.params ?? []),
        version
    }
    if (entry.rowCap !== undefined && entry.rowCap !== '' && entry.rowCap !== null) {
        const cap = Number(entry.rowCap)
        if (!Number.isInteger(cap) || cap < 1) throw new PinnedRequestError(400, 'The row cap must be a whole number.')
        normalized.rowCap = cap
    }
    return normalized
}

export function sampleArgs(value: unknown): Record<string, unknown> {
    if (value === undefined || value === null) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PinnedRequestError(400, 'Sample values must be an object of parameter names.')
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
        out[key] = (value as Record<string, unknown>)[key]
    }
    return out
}

export function readJson(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const text = value.trim()
    if (!text) return undefined
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

export function flowNodes(flowData: unknown): any[] {
    const parsed = typeof flowData === 'string' ? readJson(flowData) : flowData
    const nodes = parsed && typeof parsed === 'object' ? (parsed as { nodes?: unknown }).nodes : undefined
    return Array.isArray(nodes) ? nodes : []
}

export function findPostgresNode(nodes: any[], nodeId: string): any | null {
    for (const node of nodes) {
        const id = node?.id || node?.data?.id
        if (id === nodeId) return node
    }
    return null
}

export function relationNames(value: unknown): string[] {
    const parsed = readJson(value)
    const list = Array.isArray(parsed) ? parsed : []
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of list) {
        const name = typeof item === 'string' ? item.trim() : ''
        if (!name || seen.has(name)) continue
        seen.add(name)
        out.push(name)
    }
    return out
}

export function functionLines(value: unknown): string[] {
    if (typeof value !== 'string' || /\{\{|\$vars|\$flow/.test(value)) return []
    const out: string[] = []
    for (const raw of value.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        out.push(line)
    }
    return out
}

// The node stamps every non-blank line, notes included. The query path above
// ignores notes. A saved stamp has to match the node, so the test route uses this list.
export function stampAllowedFunctions(value: unknown): string[] {
    if (typeof value !== 'string' || /\{\{|\$vars|\$flow/.test(value)) return []
    return value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
}

export function optionalPositive(value: unknown): number | undefined {
    if (value === undefined || value === null || String(value).trim() === '') return undefined
    const n = Number(value)
    return Number.isInteger(n) && n > 0 ? n : undefined
}

export function savedPins(inputs: Record<string, unknown> | undefined): any[] {
    const parsed = readJson(inputs?.pinnedQueries)
    return Array.isArray(parsed) ? parsed : []
}

export function sameSpec(saved: any, entry: NormalizedEntry): boolean {
    if (!saved || typeof saved !== 'object') return false
    if (String(saved.sql || '') !== entry.sql) return false
    const params = Array.isArray(saved.params) ? saved.params : []
    if (params.length !== entry.params.length) return false
    for (let i = 0; i < params.length; i += 1) {
        const left = params[i] || {}
        const right = entry.params[i]
        const leftRequired = left.required !== false
        if (left.name !== right.name || left.type !== right.type || leftRequired !== right.required) return false
        if (JSON.stringify(left.default ?? null) !== JSON.stringify(right.default ?? null)) return false
        if (JSON.stringify(left.allowedValues ?? null) !== JSON.stringify(right.allowedValues ?? null)) return false
        if (JSON.stringify(left.min ?? null) !== JSON.stringify(right.min ?? null)) return false
        if (JSON.stringify(left.max ?? null) !== JSON.stringify(right.max ?? null)) return false
        if (Boolean(left.secure) !== Boolean(right.secure)) return false
    }
    return true
}

export function columnProbeSql(statement: string, names: string[]): string {
    const cols = names.map((name) => `pg_typeof(${quoteIdent(name)})::text AS ${quoteIdent(name)}`).join(', ')
    return `SELECT ${cols} FROM (\n${statement}\n) AS pinned_types LIMIT 1`
}
