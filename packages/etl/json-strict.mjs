// Strict RFC 8259 JSON for JSONL records (E5). Unlike JSON.parse it rejects duplicate keys, caps nesting depth, and
// keeps integers beyond ±(2^53−1) exactly as JsonBigInt tokens instead of rounding them. NaN and Infinity are not
// JSON and are rejected. Errors carry a code from the record reason table: parse_error, duplicate_json_key, json_too_deep.

export const MAX_DEPTH = 32
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

export class JsonBigInt {
    constructor(digits) {
        this.$bigint = digits
        Object.freeze(this)
    }

    toJSON() {
        return this.$bigint
    }
}

export class JsonStrictError extends Error {
    constructor(code, message, field) {
        super(message)
        this.code = code
        this.field = field
    }
}

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

export function parseStrict(text, { maxDepth = MAX_DEPTH } = {}) {
    const s = String(text)
    let i = 0
    const fail = (message) => {
        throw new JsonStrictError('parse_error', `${message} at character ${i + 1}.`)
    }
    const ws = () => {
        while (i < s.length) {
            const c = s.charCodeAt(i)
            if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i += 1
            else break
        }
    }
    const string = () => {
        i += 1
        let out = ''
        let start = i
        for (;;) {
            if (i >= s.length) fail('Unterminated string')
            const c = s.charCodeAt(i)
            if (c === 0x22) {
                out += s.slice(start, i)
                i += 1
                return out
            }
            if (c < 0x20) fail('Control character in a string')
            if (c === 0x5c) {
                out += s.slice(start, i)
                const e = s[i + 1]
                if (e === 'u') {
                    const hex = s.slice(i + 2, i + 6)
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Bad \\u escape')
                    out += String.fromCharCode(parseInt(hex, 16))
                    i += 6
                } else if (e in ESCAPES) {
                    out += ESCAPES[e]
                    i += 2
                } else fail('Bad escape')
                start = i
                continue
            }
            i += 1
        }
    }
    const number = () => {
        const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i, i + 400))
        if (!m) fail('Bad number')
        i += m[0].length
        if (!m[2] && !m[3]) {
            const n = Number(m[0])
            if (!Number.isSafeInteger(n)) {
                const big = BigInt(m[0])
                if (big > MAX_SAFE || big < -MAX_SAFE) return new JsonBigInt(big.toString())
            }
            return n === 0 ? 0 : n
        }
        const n = Number(m[0])
        if (!Number.isFinite(n)) fail('Number out of range')
        return n
    }
    const value = (depth, path) => {
        ws()
        const c = s[i]
        if (c === '{') {
            if (depth + 1 > maxDepth) throw new JsonStrictError('json_too_deep', `JSON is nested deeper than ${maxDepth} levels.`, path)
            i += 1
            const obj = {}
            const seen = new Set()
            ws()
            if (s[i] === '}') {
                i += 1
                return obj
            }
            for (;;) {
                ws()
                if (s[i] !== '"') fail('Expected a key')
                const key = string()
                const keyPath = path ? `${path}.${key}` : key
                if (seen.has(key)) throw new JsonStrictError('duplicate_json_key', `Key "${keyPath}" appears twice in one object.`, keyPath)
                seen.add(key)
                ws()
                if (s[i] !== ':') fail('Expected ":"')
                i += 1
                const v = value(depth + 1, keyPath)
                Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true })
                ws()
                if (s[i] === ',') {
                    i += 1
                    continue
                }
                if (s[i] === '}') {
                    i += 1
                    return obj
                }
                fail('Expected "," or "}"')
            }
        }
        if (c === '[') {
            if (depth + 1 > maxDepth) throw new JsonStrictError('json_too_deep', `JSON is nested deeper than ${maxDepth} levels.`, path)
            i += 1
            const arr = []
            ws()
            if (s[i] === ']') {
                i += 1
                return arr
            }
            for (;;) {
                arr.push(value(depth + 1, `${path}[${arr.length}]`))
                ws()
                if (s[i] === ',') {
                    i += 1
                    continue
                }
                if (s[i] === ']') {
                    i += 1
                    return arr
                }
                fail('Expected "," or "]"')
            }
        }
        if (c === '"') return string()
        if (c === '-' || (c >= '0' && c <= '9')) return number()
        if (s.startsWith('true', i)) {
            i += 4
            return true
        }
        if (s.startsWith('false', i)) {
            i += 5
            return false
        }
        if (s.startsWith('null', i)) {
            i += 4
            return null
        }
        fail(i >= s.length ? 'Unexpected end of input' : `Unexpected "${c}"`)
    }
    const result = value(0, '')
    ws()
    if (i < s.length) fail('Unexpected text after the value')
    return result
}

// Canonical JSON text: sorted keys, JsonBigInt as its digits. Used for fields typed `json`.
export function canonicalJson(value) {
    if (value instanceof JsonBigInt) return value.$bigint
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(',')}}`
    }
    return JSON.stringify(value ?? null)
}

export function jsonDepth(value) {
    if (value instanceof JsonBigInt || !value || typeof value !== 'object') return 0
    let max = 0
    for (const child of Array.isArray(value) ? value : Object.values(value)) max = Math.max(max, jsonDepth(child))
    return max + 1
}
