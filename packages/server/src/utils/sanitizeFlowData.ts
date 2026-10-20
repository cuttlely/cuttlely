import { INodeParams } from '@cuttlely/components'
import { IReactFlowObject } from '../Interface'

export const isChatflowKeyProtected = (apiKeyId: string | null | undefined): boolean => typeof apiKeyId === 'string' && apiKeyId.length > 0

const SECRET_PARAM_TYPES = new Set(['password', 'file', 'folder'])

// Names that suggest a credential: api/access/private/client keys, secrets, tokens, passwords, auth, sessions, cookies.
const SECRET_INPUT_NAME =
    /(api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|secret|token|passw|authori[sz]ation|auth[_-]?key|cookie|session[_-]?(key|token|secret)|credential|signature|(^|[_.-])sig($|[_.-])|^key$)/i
// Any other name ending in "key" counts as a credential unless it names a field or lookup key.
const KEY_SUFFIX = /key$/i
const STRUCTURAL_KEY =
    /(memory|input|output|text|content|metadata|source[_-]?id|embedding|vector|partition|prompt|project|space|issue|file|payload|sort|primary|state|json|return|topic|cache|route|lookup|group)[_-]?key$/i
// Token-count settings (maxTokens, maxOutputTokens, maxTokenLimit) are ordinary numbers, not credentials.
const TOKEN_COUNT_WORD = /(token[_-]?limit|tokens)/gi
// Names dropped even on declared, non-password inputs: credential references and clear credential words.
const DECLARED_SECRET_NAME = /(credential|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|passw|signature)/i
// Token-named declared inputs are dropped unless they hold a plain URL (accessTokenUrl, tokenUrl).
const DECLARED_TOKEN_NAME = /token/i
// Query or fragment parameter name parts that carry credentials inside a URL (whole parts, case-insensitive).
const URL_CREDENTIAL_PART = new Set([
    'token',
    'key',
    'secret',
    'sig',
    'signature',
    'password',
    'passwd',
    'pwd',
    'auth',
    'credential',
    'credentials'
])
// Lowercase compounds with no separator to split on.
const URL_CREDENTIAL_COMPOUND = new Set([
    'apikey',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'authtoken',
    'sessiontoken',
    'clientsecret',
    'apisecret',
    'secretkey',
    'accesskey',
    'privatekey',
    'sastoken'
])
// Control, format and zero-width characters, removed before any match.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g

/** NFKC, invisible characters removed, and JSON-style escaped slashes unescaped, so look-alike forms match the rules. */
const normalizeText = (value: string): string => value.normalize('NFKC').replace(INVISIBLE, '').replace(/\\\//g, '/')

/** True when a query or fragment parameter name is a credential name: by word part, or by its alphanumeric-only form. */
const isUrlCredentialParam = (rawName: string): boolean => {
    const name = normalizeText(rawName)
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (URL_CREDENTIAL_COMPOUND.has(compact) || URL_CREDENTIAL_PART.has(compact)) return true
    const parts = name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
    return parts.some((part) => URL_CREDENTIAL_PART.has(part.toLowerCase()))
}

/** Splits a query, fragment or matrix string into [name, value] pairs on ? & ; (percent-decoding fails closed with undefined). */
const urlPairs = (part: string): [string, string][] | undefined => {
    const out: [string, string][] = []
    for (const piece of part.split(/[?&;]/)) {
        if (!piece) continue
        const at = piece.indexOf('=')
        const rawName = at === -1 ? piece : piece.slice(0, at)
        const rawValue = at === -1 ? '' : piece.slice(at + 1)
        try {
            out.push([decodeURIComponent(rawName.replace(/\+/g, ' ')), decodeURIComponent(rawValue.replace(/\+/g, ' '))])
        } catch {
            return undefined
        }
    }
    return out
}

// The start of anything URL-like: a scheme followed by one or more slashes or backslashes, or a scheme-relative //.
const URL_START = /([a-z][a-z0-9+.-]*:[/\\]+|(?<![:/\\])\/\/)/gi
// user:password@host with no scheme.
const BARE_USERINFO = /[^\s/:@'"<>]+:[^\s/@'"<>]*@[^\s/@'"<>]+\.[a-z]/i
const MAX_URL_DEPTH = 4

/**
 * True when text holds a credential-carrying URL anywhere: userinfo (by authority text, not only what the parser reports),
 * a credential query, fragment or matrix parameter, a URL nested in a parameter value, or URL-like text that does not parse.
 */
const containsCredentialUrl = (rawText: string, depth = 0): boolean => {
    if (depth > MAX_URL_DEPTH) return true
    const text = normalizeText(rawText)
    if (BARE_USERINFO.test(text)) return true
    for (const match of text.matchAll(URL_START)) {
        const start = match.index ?? 0
        const candidate = text.slice(start).split(/[\s"'<>`]/)[0]
        const afterSlashes = candidate.slice(match[0].length)
        const authority = afterSlashes.split(/[/?#\\]/)[0]
        if (authority.includes('@')) return true
        let url: URL
        try {
            url = new URL(candidate.replace(/\\/g, '/'), 'https://base.invalid')
        } catch {
            return true
        }
        if (url.username || url.password) return true
        const matrix = url.pathname
            .split('/')
            .flatMap((segment) => segment.split(';').slice(1))
            .join('&')
        const pairs = [url.search.replace(/^\?/, ''), url.hash.replace(/^#/, ''), matrix].map(urlPairs)
        for (const list of pairs) {
            if (list === undefined) return true
            for (const [name, value] of list) {
                if (isUrlCredentialParam(name)) return true
                if (value && (looksLikeSecretValue(value) || containsCredentialUrl(value, depth + 1))) return true
            }
        }
    }
    return false
}

/** True for an http(s) URL with no userinfo and no credential-looking parameters anywhere in it. */
const isPlainUrl = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return false
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return !containsCredentialUrl(value)
}

// Declared inputs dropped by name alone.
const DECLARED_AUTH_NAME = /^(authorization|auth)$/i

/** Name rule for declared, non-password inputs; token-count words are ignored. */
const isDeclaredSecretInput = (name: string, value: unknown): boolean => {
    if (DECLARED_AUTH_NAME.test(name)) return true
    const stripped = name.replace(TOKEN_COUNT_WORD, '')
    if (DECLARED_SECRET_NAME.test(stripped)) return true
    return DECLARED_TOKEN_NAME.test(stripped) && !isPlainUrl(value)
}
// Header names that can carry credentials.
const SECRET_HEADER_NAME = /(auth|key|token|secret|session|cookie|signature|(^|[^a-z])sig($|[^a-z])|passw|credential)/i
// Credential-shaped values anywhere in a string.
const SECRET_VALUE =
    /(\bsk-|\bsk_|\brk_(live|test)_|\bpk_live_|\bxai-|\bghp_|\bgho_|\bgithub_pat_|\bxox[abposr]-|\bxapp-|\bAKIA[0-9A-Z]{8,}|\bAIza[0-9A-Za-z_-]{10,}|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)/

/** True when a string value contains something shaped like a credential (provider key, bearer token, JWT). */
export const looksLikeSecretValue = (value: unknown): boolean =>
    typeof value === 'string' && (SECRET_VALUE.test(value) || SECRET_VALUE.test(normalizeText(value)))

/** True when an input or property name suggests it holds a credential. */
export const isSecretInputName = (name: string): boolean => {
    const stripped = name.replace(TOKEN_COUNT_WORD, '')
    if (SECRET_INPUT_NAME.test(stripped)) return true
    return KEY_SUFFIX.test(stripped) && !STRUCTURAL_KEY.test(stripped)
}

// Short names that only mean a credential when they are the whole name (so passThrough or bypass survive).
const SECRET_EXACT_NESTED_NAME = /^(auth|pass)$/i

/** Name check for properties nested inside a kept value: the input-name rule plus exact auth/pass. */
const isSecretNestedName = (name: string): boolean => isSecretInputName(name) || SECRET_EXACT_NESTED_NAME.test(name)

/** True when an HTTP header name can carry credentials. */
export const isSecretHeaderName = (name: string): boolean => SECRET_HEADER_NAME.test(name)

const DROP = Symbol('drop')

// Each kind of encoding (JSON string literal, percent-encoding) is unwrapped at most this many times.
const MAX_DECODE_LAYERS = 3

interface DecodedLayers {
    /** The original string and every string it decodes to, outermost first. */
    strings: string[]
    /** The object or array at the bottom, how many JSON encodings wrap it, and whether percent-decoding was involved. */
    structured?: { parsed: object; jsonLayers: number; viaPercent: boolean }
    /** True when JSON parsing produced a string, object or array at any layer. */
    jsonEncoded: boolean
    /** True when the value is still encoded after MAX_DECODE_LAYERS of either kind. */
    tooDeep: boolean
}

/** Repeatedly JSON-unwraps and percent-decodes a normalized string, recording every layer. */
const decodeLayers = (value: string): DecodedLayers => {
    const strings = [value]
    let text = normalizeText(value)
    if (text !== value) strings.push(text)
    let jsonLayers = 0
    let percentLayers = 0
    let viaPercent = false
    let jsonEncoded = false
    for (;;) {
        const trimmed = text.trim()
        if (/^[[{"]/.test(trimmed)) {
            let parsed: unknown
            let ok = true
            try {
                parsed = JSON.parse(trimmed)
            } catch {
                ok = false
            }
            if (ok && parsed && typeof parsed === 'object') {
                if (jsonLayers >= MAX_DECODE_LAYERS) return { strings, jsonEncoded: true, tooDeep: true }
                return { strings, structured: { parsed, jsonLayers: jsonLayers + 1, viaPercent }, jsonEncoded: true, tooDeep: false }
            }
            if (ok && typeof parsed === 'string') {
                if (jsonLayers >= MAX_DECODE_LAYERS) return { strings, jsonEncoded: true, tooDeep: true }
                jsonLayers += 1
                jsonEncoded = true
                text = normalizeText(parsed)
                strings.push(parsed, text)
                continue
            }
        }
        if (/%[0-9a-f]{2}/i.test(text)) {
            let decoded: string | undefined
            try {
                decoded = decodeURIComponent(text)
            } catch {
                decoded = undefined
            }
            // A string with percent escapes that does not decode cleanly cannot be classified.
            if (decoded === undefined) return { strings, jsonEncoded, tooDeep: true }
            if (decoded !== text) {
                if (percentLayers >= MAX_DECODE_LAYERS) return { strings, jsonEncoded, tooDeep: true }
                percentLayers += 1
                viaPercent = true
                text = normalizeText(decoded)
                strings.push(decoded, text)
                continue
            }
        }
        return { strings, jsonEncoded, tooDeep: false }
    }
}

/** True when a plain string layer is credential-shaped or carries a credential URL. */
const isUnsafeText = (text: string): boolean => looksLikeSecretValue(text) || containsCredentialUrl(text)

/**
 * True when any layer fails: every plain layer gets the value and URL checks, and the raw JSON text of a structured
 * bottom is scanned for secret-shaped values too (so duplicate keys cannot hide one); its parsed contents are walked separately.
 */
const anyLayerUnsafe = (layers: DecodedLayers): boolean => {
    const plain = layers.structured ? layers.strings.slice(0, -1) : layers.strings
    if (plain.some(isUnsafeText)) return true
    if (layers.structured) {
        const raw = layers.strings[layers.strings.length - 1]
        if (looksLikeSecretValue(raw) || containsCredentialUrl(raw)) return true
    }
    return false
}

/** Serializes a value the same number of times it was JSON-encoded. */
const reencode = (value: unknown, layers: number): string => {
    let out = JSON.stringify(value)
    for (let i = 1; i < layers; i += 1) out = JSON.stringify(out)
    return out
}

/**
 * Cleans a decoded structured value with clean() and re-encodes it. A percent-encoded structure is kept only when
 * cleaning changed nothing, since it cannot be re-encoded exactly.
 */
const cleanStructured = (value: string, layers: DecodedLayers, clean: (parsed: unknown) => unknown): unknown => {
    const structured = layers.structured as NonNullable<DecodedLayers['structured']>
    const cleaned = clean(structured.parsed)
    if (cleaned === DROP) return DROP
    if (structured.viaPercent) return JSON.stringify(cleaned) === JSON.stringify(structured.parsed) ? value : DROP
    return reencode(cleaned, structured.jsonLayers)
}

// Fields that label a header or setting pair: { key | name | header, value }.
const PAIR_LABELS = ['key', 'name', 'header'] as const

/** The label field of an object holding a pair (a value plus key, name or header), or undefined. */
const pairLabelField = (value: unknown): (typeof PAIR_LABELS)[number] | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('value' in value)) return undefined
    return PAIR_LABELS.find((label) => label in (value as Record<string, unknown>))
}

/** True for an object holding a pair. */
const isPairLike = (value: unknown): value is Record<string, unknown> => pairLabelField(value) !== undefined

/** The label text of a pair; a pair with several labels or a non-string label returns undefined (cannot be classified). */
const pairLabel = (value: Record<string, unknown>): string | undefined => {
    const labels = PAIR_LABELS.filter((label) => label in value)
    if (labels.length !== 1) return undefined
    const label = value[labels[0]]
    return typeof label === 'string' ? normalizeText(label) : undefined
}

/** True for an object that is exactly a { key | name | header, value } pair; only then is the label field exempt from name rules. */
const isExactPair = (value: Record<string, unknown>): boolean => Object.keys(value).length === 2 && isPairLike(value)

/** A pair whose label cannot be read, or names a credential (header rule, plus the field-name rule outside headers), is dropped. */
const isSecretPairLabel = (label: string | undefined, headersOnly: boolean): boolean =>
    label === undefined || isSecretHeaderName(label) || (!headersOnly && isSecretNestedName(label))

const HEADERS_KEY = /headers$/i

/**
 * Removes credential-carrying header entries at every depth of a headers value: { key, value } pairs and object
 * properties whose name is a secret header name, including per-node maps such as headers.<nodeId>.X-Custom-Auth.
 * JSON strings are parsed, cleaned and re-serialized; a string that is not JSON is left to the value check.
 */
const scrubHeaderTree = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return DROP
    if (typeof value === 'string') {
        const layers = decodeLayers(value)
        if (layers.tooDeep || anyLayerUnsafe(layers)) return DROP
        if (layers.structured) return cleanStructured(value, layers, (parsed) => scrubHeaderTree(parsed, depth + 1))
        return /^\s*[[{]/.test(value) ? DROP : value
    }
    if (Array.isArray(value)) {
        const out: unknown[] = []
        for (const item of value) {
            if (isPairLike(item) && isSecretPairLabel(pairLabel(item), true)) continue
            const cleaned = scrubHeaderTree(item, depth + 1)
            if (cleaned !== DROP) out.push(cleaned)
        }
        return out
    }
    if (value && typeof value === 'object') {
        // An object holding a pair is judged by its key, like an array item. Only an exact { key, value } keeps the label.
        if (isPairLike(value) && isSecretPairLabel(pairLabel(value), true)) return DROP
        const exactPair = isExactPair(value as Record<string, unknown>)
        const out: Record<string, unknown> = {}
        for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
            if (!(exactPair && (name === 'value' || name === pairLabelField(value))) && isSecretHeaderName(normalizeText(name))) continue
            const cleaned = scrubHeaderTree(item, depth + 1)
            if (cleaned !== DROP) out[name] = cleaned
        }
        return out
    }
    return value
}

/**
 * Walks a value and removes anything credential-shaped: strings that look like keys, properties with
 * credential names, and { key, value } pairs whose key is a credential name. Returns DROP when nothing is left to keep.
 */
const scrubValue = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return DROP
    if (typeof value === 'string') {
        // Every layer (JSON-unwrapped and percent-decoded) is checked; a serialized object or array is cleaned and re-encoded.
        const layers = decodeLayers(value)
        if (layers.tooDeep || anyLayerUnsafe(layers)) return DROP
        if (layers.structured) return cleanStructured(value, layers, (parsed) => scrubValue(parsed, depth + 1))
        return value
    }
    if (Array.isArray(value)) {
        const out: unknown[] = []
        for (const item of value) {
            if (isPairLike(item) && isSecretPairLabel(pairLabel(item), false)) continue
            const scrubbed = scrubValue(item, depth + 1)
            if (scrubbed !== DROP) out.push(scrubbed)
        }
        return out
    }
    if (value && typeof value === 'object') {
        // An object holding a pair is judged by its key, like an array item. Only an exact { key, value } keeps the label.
        if (isPairLike(value) && isSecretPairLabel(pairLabel(value), false)) return DROP
        const exactPair = isExactPair(value as Record<string, unknown>)
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (!(exactPair && key === pairLabelField(value)) && isSecretNestedName(normalizeText(key))) continue
            // Anything under a key named headers, at any depth, also loses its credential header entries.
            const headerSafe = HEADERS_KEY.test(key) ? scrubHeaderTree(item) : item
            if (headerSafe === DROP) continue
            const scrubbed = scrubValue(headerSafe, depth + 1)
            if (scrubbed !== DROP) out[key] = scrubbed
        }
        return out
    }
    return value
}

/** Deep copy of a value with credential-shaped parts removed, or undefined when the whole value must go. */
export const scrubSecrets = (value: unknown): unknown => {
    const scrubbed = scrubValue(value)
    return scrubbed === DROP ? undefined : scrubbed
}

const sanitizeHeaders = (rawHeaders: unknown): unknown => {
    // Array, object or JSON-string headers, cleaned at every depth (per-node maps included), then value-checked.
    const cleaned = scrubHeaderTree(rawHeaders)
    if (cleaned === DROP) return undefined
    if (typeof cleaned === 'string' && /^\s*[[{]/.test(cleaned)) {
        const scrubbed = scrubSecrets(JSON.parse(cleaned))
        return scrubbed === undefined ? undefined : JSON.stringify(scrubbed)
    }
    return scrubSecrets(cleaned)
}

/**
 * Allowlist filter for a node's saved inputs on public and template responses.
 * An input is kept only when the node defines it (inputParams or inputAnchors) with a non-secret type. Inputs declared
 * in inputParams are judged by type, not name; anchor-only inputs must also have a non-credential name. Kept values are walked and anything credential-shaped inside them is removed.
 */
export const sanitizeNodeInputs = (
    inputs: Record<string, unknown> | undefined,
    inputParams: INodeParams[] | undefined,
    inputAnchors?: { name?: string }[] | undefined
): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    if (!inputs || typeof inputs !== 'object') return result
    const params = Array.isArray(inputParams) ? inputParams : []
    const anchors = Array.isArray(inputAnchors) ? inputAnchors : []
    for (const key of Object.keys(inputs)) {
        const param = params.find((p) => p?.name === key)
        const anchor = anchors.find((a) => a?.name === key)
        // Companion config of a loadConfig param (e.g. llmModelConfig for llmModel): kept, with credentials scrubbed.
        const configOf =
            !param && !anchor && key.endsWith('Config') ? params.find((p) => p?.loadConfig && `${p.name}Config` === key) : undefined
        if (configOf) {
            const kept = scrubSecrets(inputs[key])
            if (kept !== undefined) result[key] = kept
            continue
        }
        if (!param && !anchor) continue
        if (param && SECRET_PARAM_TYPES.has(param.type)) continue
        // A declared, non-password input is kept by name and only its value is checked; undeclared ones also get the name check.
        const value = inputs[key]
        // Declared inputs still drop clear credential names (and token names unless the value is a plain URL).
        if (param ? isDeclaredSecretInput(key, value) : isSecretInputName(key)) continue
        const kept = HEADERS_KEY.test(key) && value ? sanitizeHeaders(value) : scrubSecrets(value)
        if (kept !== undefined) result[key] = kept
    }
    return result
}

/**
 * Sanitizes flowData before returning it from a public endpoint.
 * Keeps only defined, non-secret inputs (see sanitizeNodeInputs), removes credential ID
 * references and auth-related HTTP headers so sensitive credentials are never exposed.
 */
export const sanitizeFlowDataForPublicEndpoint = (flowDataString: string): string => {
    if (!flowDataString) return flowDataString
    try {
        const flowData: IReactFlowObject = JSON.parse(flowDataString)
        if (!Array.isArray(flowData.nodes)) return flowDataString

        for (const node of flowData.nodes) {
            if (!node.data) continue

            // Remove credential ID reference
            delete node.data.credential

            if (!node.data.inputs) continue
            node.data.inputs = sanitizeNodeInputs(node.data.inputs, node.data.inputParams, node.data.inputAnchors)
        }

        return JSON.stringify(flowData)
    } catch {
        return JSON.stringify({ nodes: [], edges: [] })
    }
}

// chatbotConfig fields the chat widget (packages/chat-widget/src/config.js) reads. Nothing else leaves a public response.
// Scalar fields: kept only when the value is a string, number or boolean.
const PUBLIC_DISPLAY_SCALARS = [
    'title',
    'titleAvatarSrc',
    'titleBackgroundColor',
    'titleTextColor',
    'backgroundColor',
    'welcomeMessage',
    'errorMessage',
    'fontSize',
    'generateNewSession'
] as const
// Object fields: only the listed keys, each a scalar.
const PUBLIC_DISPLAY_OBJECTS: Record<string, readonly string[]> = {
    botMessage: ['showAvatar', 'avatarSrc', 'backgroundColor', 'textColor'],
    userMessage: ['backgroundColor', 'textColor'],
    textInput: ['placeholder', 'backgroundColor', 'textColor', 'sendButtonColor'],
    chatFeedback: ['status'],
    followUpPrompts: ['status']
}

// Query names a public display URL may carry.
const PUBLIC_URL_PARAM = /^(utm_[a-z0-9_]+|ref|lang|page)$/
// A scheme with slashes, a scheme-relative //, or a slash-less scheme that can run or embed content.
const PUBLIC_URL_START = /([a-z][a-z0-9+.-]*:[/\\]+|(?<![:/])\/\/|\b(mailto|javascript|data|vbscript|file|blob):)/gi

/** True for a URL in public display text that is plain http(s): no userinfo, and only allowlisted query names, no fragment pairs. */
const isPublicSafeUrl = (candidate: string): boolean => {
    if (!/^https?:\/\/[^/?#@\s]+([/?#][^\s]*)?$/i.test(candidate)) return false
    let url: URL
    try {
        url = new URL(candidate)
    } catch {
        return false
    }
    if (url.username || url.password || url.host.includes('@')) return false
    for (const name of url.searchParams.keys()) if (!PUBLIC_URL_PARAM.test(name)) return false
    // A fragment is kept only as a plain anchor.
    if (url.hash && !/^#[A-Za-z0-9_-]*$/.test(url.hash)) return false
    return true
}

/**
 * Allowlist for a public display string. It must be printable text with no control or zero-width characters, no %, no
 * backslash, no HTML character references, no JSON, no userinfo, no secret-shaped value, and any URL in it must be plain
 * http(s) with allowlisted query names. Anything else is dropped whole; a public value is never repaired.
 */
const isPublicDisplayText = (value: string): boolean => {
    if (/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/.test(value)) return false
    if (/[%\\]/.test(value) || /&#?[a-z0-9]+;/i.test(value)) return false
    const folded = value.normalize('NFKC')
    for (const text of folded === value ? [value] : [value, folded]) {
        if (looksLikeSecretValue(text) || BARE_USERINFO.test(text)) return false
        if (/^\s*[[{"]/.test(text)) {
            try {
                const parsed = JSON.parse(text)
                if (parsed !== null && (typeof parsed === 'object' || typeof parsed === 'string')) return false
            } catch {
                // not JSON
            }
        }
        for (const match of text.matchAll(PUBLIC_URL_START)) {
            // Trailing sentence punctuation is not part of the URL.
            const candidate = text
                .slice(match.index ?? 0)
                .split(/[\s"'<>`)\]]/)[0]
                .replace(/[.,;:!?]+$/, '')
            if (!isPublicSafeUrl(candidate)) return false
        }
    }
    return true
}

/** A string, number or boolean that passes the public display allowlist, or undefined. */
const publicScalar = (value: unknown): string | number | boolean | undefined => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') return isPublicDisplayText(value) && scrubSecrets(value) === value ? value : undefined
    return undefined
}

/** starterPrompts as an array of { prompt } (saved as an array or an index-keyed object); anything else is dropped. */
const publicStarterPrompts = (value: unknown): { prompt: string }[] | undefined => {
    if (!value || typeof value !== 'object') return undefined
    const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
    const out: { prompt: string }[] = []
    for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const prompt = (item as Record<string, unknown>).prompt
        if (typeof prompt !== 'string' || publicScalar(prompt) === undefined) continue
        out.push({ prompt })
    }
    return out
}

/** The display-only part of a saved chatbotConfig, for signed-out callers. Every value is shape-checked. */
export const publicChatbotDisplayConfig = (config: unknown): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    if (!config || typeof config !== 'object' || Array.isArray(config)) return result
    const source = config as Record<string, unknown>
    for (const field of PUBLIC_DISPLAY_SCALARS) {
        const kept = publicScalar(source[field])
        if (kept !== undefined) result[field] = kept
    }
    const prompts = publicStarterPrompts(source.starterPrompts)
    if (prompts !== undefined) result.starterPrompts = prompts
    for (const [field, keys] of Object.entries(PUBLIC_DISPLAY_OBJECTS)) {
        const value = source[field]
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const picked: Record<string, unknown> = {}
        for (const key of keys) {
            const kept = publicScalar((value as Record<string, unknown>)[key])
            if (kept !== undefined) picked[key] = kept
        }
        result[field] = picked
    }
    return result
}

/**
 * What GET /api/v1/public-chatflows/:id returns for a public chatflow: id, name, whether an API key is required,
 * and the display part of chatbotConfig. Never overrideConfig or the flow graph.
 */
export const publicChatflowSummary = (chatflow: {
    id: string
    name?: string
    isPublic?: boolean
    apikeyid?: string | null
    chatbotConfig?: string | null
}): Record<string, unknown> => {
    let parsed: unknown = {}
    try {
        parsed = chatflow.chatbotConfig ? JSON.parse(chatflow.chatbotConfig) : {}
    } catch {
        parsed = {}
    }
    const display = publicChatbotDisplayConfig(parsed)
    return {
        id: chatflow.id,
        name: chatflow.name,
        isPublic: Boolean(chatflow.isPublic),
        hasApiKey: isChatflowKeyProtected(chatflow.apikeyid),
        chatbotConfig: JSON.stringify(display)
    }
}
