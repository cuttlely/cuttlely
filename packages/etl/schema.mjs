// Schema and coercion rules for Streaming Files (E6, spec 5.1.4). Values are coerced only by these documented rules,
// nothing is truncated, and a value that does not fit rejects its record with a reason instead of being changed.
import { EtlError } from './errors.mjs'
import { canonicalJson, JsonBigInt, jsonDepth, JsonStrictError, MAX_DEPTH, parseStrict } from './json-strict.mjs'

export const TYPES = new Set(['string', 'integer', 'bigint', 'number', 'decimal', 'boolean', 'date', 'datetime', 'json'])
export const DEFAULT_CAPS = { maxMetadataChars: 2000, maxMetadataKeys: 64, maxJsonBytes: 64 * 1024 }
const LOADER_FLATTEN_DEPTH = 3

// A record-level rejection: code from the reason table, optional field, and a short message.
export class RecordReject extends Error {
    constructor(code, field, message) {
        super(message)
        this.code = code
        this.field = field || null
    }

    get reason() {
        return this.field ? `${this.code}:${this.field}` : this.code
    }
}

const reject = (code, field, message) => {
    throw new RecordReject(code, field, message)
}

export function parseSchema(input) {
    if (input === undefined || input === null || input === '') return null
    let schema = input
    if (typeof input === 'string') {
        try {
            schema = JSON.parse(input)
        } catch (error) {
            throw new EtlError('bad_schema', `The schema is not valid JSON: ${error.message}`)
        }
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
        throw new EtlError('bad_schema', 'The schema must be a JSON object.')
    const fields = schema.fields && typeof schema.fields === 'object' ? schema.fields : {}
    const out = {
        fields: {},
        unknownColumns: schema.unknownColumns === 'ignore' ? 'ignore' : 'keep',
        nullValues: Array.isArray(schema.nullValues) ? schema.nullValues.map(String) : [''],
        caps: {
            maxMetadataChars: positive(schema.maxMetadataChars, DEFAULT_CAPS.maxMetadataChars),
            maxMetadataKeys: positive(schema.maxMetadataKeys, DEFAULT_CAPS.maxMetadataKeys),
            maxJsonBytes: DEFAULT_CAPS.maxJsonBytes,
            // Raw row or line size cap for the readers (row_too_large); default 1 MiB, at most 64 MiB.
            maxRecordBytes: Math.min(positive(schema.maxRecordBytes, 1 << 20), 64 << 20)
        }
    }
    for (const [name, raw] of Object.entries(fields)) {
        const def = typeof raw === 'string' ? { type: raw } : { ...(raw || {}) }
        if (!TYPES.has(def.type)) throw new EtlError('bad_schema', `Schema field "${name}" has unknown type "${def.type}".`)
        if (def.type === 'decimal') {
            const precision = Number(def.precision)
            const scale = Number(def.scale ?? 0)
            if (!Number.isInteger(precision) || !Number.isInteger(scale) || precision < 1 || scale < 0 || scale > precision)
                throw new EtlError('bad_schema', `Schema field "${name}" needs an integer precision and a scale between 0 and precision.`)
            def.precision = precision
            def.scale = scale
        }
        if (def.type === 'datetime' && def.timezone) {
            try {
                new Intl.DateTimeFormat('en-US', { timeZone: def.timezone })
            } catch {
                throw new EtlError('bad_schema', `Schema field "${name}" has an unknown timezone "${def.timezone}".`)
            }
        }
        if (def.maxLength !== undefined && !(Number(def.maxLength) > 0))
            throw new EtlError('bad_schema', `Schema field "${name}" has a bad maxLength.`)
        out.fields[name] = def
    }
    return out
}

function positive(value, fallback) {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export function defaultCaps() {
    return { ...DEFAULT_CAPS }
}

const isAsciiSpace = (code) => code === 32 || (code >= 9 && code <= 13)
// Trims space, tab, LF, VT, FF and CR (not the Unicode spaces String.trim also removes), scanning in from both ends.
export function trimAsciiSpace(value) {
    let start = 0
    let end = value.length
    while (start < end && isAsciiSpace(value.charCodeAt(start))) start += 1
    while (end > start && isAsciiSpace(value.charCodeAt(end - 1))) end -= 1
    return value.slice(start, end)
}
const INTEGER = /^[+-]?\d+$/
// The fraction is optional as a whole, so a run of digits has only one way to match.
export const NUMBER = /^[+-]?(\d+(?:\.\d*)?|\.\d+)([eE][+-]?\d+)?$/
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?$/

function realDay(y, m, d) {
    if (m < 1 || m > 12 || d < 1) return false
    return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function validClock(h, mi, s) {
    return h <= 23 && mi <= 59 && s <= 59
}

// Offset (ms) of `timeZone` at instant t: wall clock read as UTC, minus t.
function zoneOffset(t, timeZone) {
    const parts = {}
    for (const p of new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    }).formatToParts(new Date(t)))
        parts[p.type] = p.value
    const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second)
    return wall - Math.floor(t / 1000) * 1000
}

// A naive wall-clock time in an IANA zone to a UTC instant. Times skipped or repeated by a DST change are rejected.
export function zonedToUtc(fields, timeZone) {
    const { y, m, d, h, mi, s, ms } = fields
    const guess = Date.UTC(y, m - 1, d, h, mi, s, ms)
    const candidates = new Set()
    for (const probe of [guess - 86400000, guess, guess + 86400000]) {
        const t = guess - zoneOffset(probe, timeZone)
        if (t + zoneOffset(t, timeZone) === guess) candidates.add(t)
    }
    if (candidates.size === 0) return { error: 'skipped' }
    if (candidates.size > 1) return { error: 'ambiguous' }
    return { value: [...candidates][0] }
}

function fraction(text) {
    return text ? Math.floor(Number(`0${text}`) * 1000 + 1e-9) : 0
}

// Coerces one value for schema field `name`. `raw` is a CSV string or a JSON value. Returns the metadata value, or null.
export function coerceValue(name, def, raw, { fromCsv = false } = {}) {
    const type = def.type
    if (raw === null || raw === undefined) {
        if (def.required) reject('required_missing', name, `${name} is required`)
        return null
    }
    const bad = (why) => reject('type_error', name, `${name}: ${why}`)
    if (type === 'string') {
        if (typeof raw === 'object' && !(raw instanceof JsonBigInt)) bad('expected a string, got an object')
        const value = raw instanceof JsonBigInt ? raw.$bigint : String(raw)
        if (def.maxLength && value.length > Number(def.maxLength))
            reject('value_too_long', name, `${name} is ${value.length} characters (maxLength ${def.maxLength})`)
        return value
    }
    if (type === 'json') {
        let value = raw
        if (fromCsv) {
            try {
                value = parseStrict(trimAsciiSpace(String(raw)))
            } catch (error) {
                if (error instanceof JsonStrictError) reject(error.code, name, `${name}: ${error.message}`)
                throw error
            }
        }
        if (jsonDepth(value) > MAX_DEPTH) reject('json_too_deep', name, `${name} is nested deeper than ${MAX_DEPTH} levels`)
        const text = canonicalJson(value)
        if (Buffer.byteLength(text) > DEFAULT_CAPS.maxJsonBytes) reject('json_too_large', name, `${name} is larger than 64 KiB`)
        return text
    }
    if (typeof raw === 'object' && !(raw instanceof JsonBigInt)) reject('nested_metadata', name, `${name} holds an object or array`)
    const isBig = raw instanceof JsonBigInt
    const text = isBig ? raw.$bigint : typeof raw === 'string' ? trimAsciiSpace(raw) : null
    if (type === 'integer') {
        if (typeof raw === 'number') {
            if (!Number.isInteger(raw)) bad('not an integer')
            return raw === 0 ? 0 : raw
        }
        if (typeof raw === 'boolean' || text === null || !INTEGER.test(text)) bad(`"${raw}" is not an integer`)
        const n = Number(text)
        if (!Number.isSafeInteger(n)) reject('unsafe_integer', name, `${name} = ${text} is beyond ±(2^53−1); type it bigint`)
        return n === 0 ? 0 : n
    }
    if (type === 'bigint') {
        let digits = text
        if (typeof raw === 'number') {
            if (!Number.isSafeInteger(raw)) bad('not an exact integer')
            digits = String(raw)
        }
        if (digits === null || !INTEGER.test(digits)) bad(`"${raw}" is not an integer`)
        return BigInt(digits).toString()
    }
    if (type === 'number') {
        if (typeof raw === 'number') return raw === 0 ? 0 : raw
        if (isBig) return Number(raw.$bigint)
        if (text === null || !NUMBER.test(text)) bad(`"${raw}" is not a number`)
        const n = Number(text)
        if (!Number.isFinite(n)) bad(`"${raw}" overflows`)
        return n === 0 ? 0 : n
    }
    if (type === 'decimal') {
        const source = typeof raw === 'number' ? String(raw) : text
        const m = source === null ? null : DECIMAL.exec(source)
        if (!m) bad(`"${raw}" is not a plain decimal`)
        const intDigits = m[2].replace(/^0+(?=\d)/, '')
        const frac = m[3] || ''
        if (frac.length > def.scale) bad(`"${raw}" has more than ${def.scale} fraction digits`)
        if ((intDigits === '0' ? 0 : intDigits.length) > def.precision - def.scale)
            bad(`"${raw}" has more than ${def.precision - def.scale} integer digits`)
        const padded = def.scale ? `${intDigits}.${frac.padEnd(def.scale, '0')}` : intDigits
        const zero = /^[0.]+$/.test(padded)
        return `${m[1] === '-' && !zero ? '-' : ''}${padded}`
    }
    if (type === 'boolean') {
        if (typeof raw === 'boolean') return raw
        const token = String(text ?? raw).toLowerCase()
        const trueValues = ['true', '1', ...(def.trueValues || []).map((v) => String(v).toLowerCase())]
        const falseValues = ['false', '0', ...(def.falseValues || []).map((v) => String(v).toLowerCase())]
        if (typeof raw === 'number') {
            if (raw === 1) return true
            if (raw === 0) return false
        }
        if (trueValues.includes(token)) return true
        if (falseValues.includes(token)) return false
        bad(`"${raw}" is not a boolean`)
    }
    if (type === 'date') {
        const m = text === null ? null : DATE.exec(text)
        if (!m || !realDay(+m[1], +m[2], +m[3])) bad(`"${raw}" is not a YYYY-MM-DD calendar day`)
        return text
    }
    if (type === 'datetime') {
        if (typeof raw === 'number' || (def.format && typeof text === 'string' && NUMBER.test(text))) {
            const n = Number(raw)
            if (def.format === 'epoch_s') return new Date(n * 1000).toISOString()
            if (def.format === 'epoch_ms') return new Date(n).toISOString()
            bad('a number needs format epoch_s or epoch_ms')
        }
        if (text === null) bad(`"${raw}" is not a datetime`)
        let m = RFC3339.exec(text)
        if (m) {
            const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
            if (!realDay(y, mo, d) || !validClock(h, mi, s)) bad(`"${raw}" is not a real time`)
            let offset = 0
            if (!/^[Zz]$/.test(m[8])) {
                const sign = m[8][0] === '-' ? -1 : 1
                const [oh, om] = m[8].slice(1).split(':').map(Number)
                if (oh > 23 || om > 59) bad(`"${raw}" has a bad offset`)
                offset = sign * (oh * 60 + om) * 60000
            }
            return new Date(Date.UTC(y, mo - 1, d, h, mi, s, fraction(m[7])) - offset).toISOString()
        }
        m = NAIVE.exec(text)
        if (m) {
            if (!def.timezone) bad(`"${raw}" has no offset and the field declares no timezone`)
            const [y, mo, d, h, mi] = m.slice(1, 6).map(Number)
            const s = Number(m[6] || 0)
            if (!realDay(y, mo, d) || !validClock(h, mi, s)) bad(`"${raw}" is not a real time`)
            const utc = zonedToUtc({ y, m: mo, d, h, mi, s, ms: fraction(m[7]) }, def.timezone)
            if (utc.error === 'skipped') bad(`"${raw}" does not exist in ${def.timezone} (skipped by a DST change)`)
            if (utc.error === 'ambiguous') bad(`"${raw}" happens twice in ${def.timezone} (DST change)`)
            return new Date(utc.value).toISOString()
        }
        bad(`"${raw}" is not an RFC 3339 datetime`)
    }
    bad(`unknown type ${type}`)
}

// Applies the metadata caps to a finished metadata object: null values are omitted (stores differ on null support),
// strings above the cap and too many keys reject the record. Nothing is cut. `typed` lists schema-typed fields whose
// own maxLength or json limits already applied.
export function finishMetadata(metadata, { caps = DEFAULT_CAPS, typed = {} } = {}) {
    const out = {}
    let keys = 0
    for (const [key, value] of Object.entries(metadata)) {
        if (value === null || value === undefined) continue
        if (typeof value === 'object') reject('nested_metadata', key, `${key} holds an object or array`)
        if (typeof value === 'string' && !typed[key] && value.length > caps.maxMetadataChars)
            reject('value_too_long', key, `${key} is ${value.length} characters (cap ${caps.maxMetadataChars})`)
        keys += 1
        out[key] = value
    }
    if (keys > caps.maxMetadataKeys) reject('too_many_metadata_keys', null, `${keys} metadata keys (cap ${caps.maxMetadataKeys})`)
    return out
}

// JSON values from a JSONL record to metadata. Scalars keep their JSON type, big integers become exact strings, nested
// values reject (unless the schema types the field json), and schema fields are coerced.
export function jsonMetadata(obj, { schema, skip = [] } = {}) {
    const out = {}
    const typed = {}
    const fields = schema?.fields || {}
    for (const [name, def] of Object.entries(fields)) {
        if (skip.includes(name)) continue
        out[name] = coerceValue(name, def, Object.hasOwn(obj, name) ? obj[name] : null)
        typed[name] = true
    }
    for (const [key, value] of Object.entries(obj)) {
        if (skip.includes(key) || typed[key]) continue
        if (schema && schema.unknownColumns === 'ignore') continue
        if (value instanceof JsonBigInt) out[key] = value.$bigint
        else if (value !== null && typeof value === 'object') reject('nested_metadata', key, `${key} holds an object or array`)
        else out[key] = value
    }
    return { metadata: out, typed }
}

// Loader metadata can't be shaped by the user, so nested values are flattened to dotted keys (depth 3) and anything
// deeper is stored as canonical JSON text. Returns { metadata, flattened }.
export function flattenLoaderMetadata(metadata) {
    const out = {}
    let flattened = 0
    const walk = (prefix, value, depth) => {
        if (value === null || value === undefined) {
            out[prefix] = null
            return
        }
        if (typeof value !== 'object' || value instanceof Date) {
            out[prefix] = value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? value.toString() : value
            return
        }
        if (depth >= LOADER_FLATTEN_DEPTH) {
            out[prefix] = canonicalJson(value)
            flattened += 1
            return
        }
        flattened += 1
        const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value)
        if (!entries.length) out[prefix] = Array.isArray(value) ? '[]' : '{}'
        for (const [key, child] of entries) walk(`${prefix}.${key}`, child, depth + 1)
    }
    for (const [key, value] of Object.entries(metadata || {})) {
        if (value !== null && typeof value === 'object' && !(value instanceof Date)) walk(key, value, 1)
        else out[key] = value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? value.toString() : value
    }
    return { metadata: out, flattened }
}
