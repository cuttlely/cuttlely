import { INodeParams } from '@cuttlely/components'
import { IReactFlowObject } from '../Interface'

export const isChatflowKeyProtected = (apiKeyId: string | null | undefined): boolean => typeof apiKeyId === 'string' && apiKeyId.length > 0

const SECRET_PARAM_TYPES = new Set(['password', 'file', 'folder'])

// Names that suggest a credential: api/access/private/client keys, secrets, tokens, passwords, auth, sessions, cookies.
const SECRET_INPUT_NAME =
    /(api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|secret|token|passw|authori[sz]ation|auth[_-]?key|cookie|session[_-]?(key|token|secret)|credential|^key$)/i
// Any other name ending in "key" counts as a credential unless it names a field or lookup key.
const KEY_SUFFIX = /key$/i
const STRUCTURAL_KEY =
    /(memory|input|output|text|content|metadata|source[_-]?id|embedding|vector|partition|prompt|project|space|issue|file|payload|sort|primary|state|json|return|topic|cache|route|lookup|group)[_-]?key$/i
// Token-count settings (maxTokens, maxOutputTokens, maxTokenLimit) are ordinary numbers, not credentials.
const TOKEN_COUNT_WORD = /(token[_-]?limit|tokens)/gi
// Names dropped even on declared, non-password inputs: credential references and clear credential words.
const DECLARED_SECRET_NAME = /(credential|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|passw)/i
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
/** True when a query or fragment parameter name has a credential word as one of its parts (split on _ - . and camelCase). */
const isUrlCredentialParam = (name: string): boolean => {
    if (URL_CREDENTIAL_COMPOUND.has(name.toLowerCase().replace(/[_.-]/g, ''))) return true
    const parts = name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_.-]+/)
    return parts.some((part) => URL_CREDENTIAL_PART.has(part.toLowerCase()))
}
// Declared inputs dropped by name alone.
const DECLARED_AUTH_NAME = /^(authorization|auth)$/i

/** Parameter names in a query or fragment, split on & ; and a ? inside a fragment, percent-decoded. */
const urlParamNames = (part: string): string[] =>
    part
        .split(/[?&;]/)
        .map((piece) => piece.split('=')[0])
        .filter(Boolean)
        .map((name) => {
            try {
                return decodeURIComponent(name.replace(/\+/g, ' '))
            } catch {
                return name
            }
        })

/** True when a parsed URL carries userinfo or a credential query or fragment parameter (including a ?query inside the fragment). */
const urlCarriesCredential = (url: URL, raw: string): boolean => {
    if (url.username || url.password) return true
    // Userinfo the parser may not report (for example percent-encoded): anything before @ in the authority.
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw) || /^\/\/[^/?#]*@/.test(raw)) return true
    // Matrix parameters in path segments (/x;token=...) count too.
    const matrix = url.pathname
        .split('/')
        .flatMap((segment) => segment.split(';').slice(1))
        .join('&')
    const names = [...urlParamNames(url.search.replace(/^\?/, '')), ...urlParamNames(url.hash.replace(/^#/, '')), ...urlParamNames(matrix)]
    return names.some((name) => isUrlCredentialParam(name))
}

/** True for a string that is a URL (absolute or scheme-relative) carrying userinfo or a credential parameter. */
const isCredentialUrl = (value: string): boolean => {
    const raw = value.trim()
    if (!/^([a-z][a-z0-9+.-]*:)?\/\//i.test(raw)) return false
    let url: URL
    try {
        url = new URL(raw, 'https://base.invalid')
    } catch {
        return /@/.test(raw.split(/[/?#]/, 3).join('/'))
    }
    return urlCarriesCredential(url, raw)
}

// URLs that appear anywhere inside text.
const URL_IN_TEXT = /(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>`\\]+/gi

/** True when a string is, or contains, a credential-carrying URL. */
const containsCredentialUrl = (value: string): boolean =>
    isCredentialUrl(value) || [...value.matchAll(URL_IN_TEXT)].some((match) => isCredentialUrl(match[0]))

/** True for an http(s) URL with no userinfo and no credential-looking query or fragment parameters. */
const isPlainUrl = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    let url: URL
    try {
        url = new URL(value)
    } catch {
        return false
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return !urlCarriesCredential(url, value.trim())
}

/** Name rule for declared, non-password inputs; token-count words are ignored. */
const isDeclaredSecretInput = (name: string, value: unknown): boolean => {
    if (DECLARED_AUTH_NAME.test(name)) return true
    const stripped = name.replace(TOKEN_COUNT_WORD, '')
    if (DECLARED_SECRET_NAME.test(stripped)) return true
    return DECLARED_TOKEN_NAME.test(stripped) && !isPlainUrl(value)
}
// Header names that can carry credentials.
const SECRET_HEADER_NAME = /(auth|key|token|secret|session|cookie)/i
// Credential-shaped values anywhere in a string.
const SECRET_VALUE =
    /(\bsk-|\bsk_|\brk_(live|test)_|\bpk_live_|\bxai-|\bghp_|\bgho_|\bgithub_pat_|\bxox[abposr]-|\bxapp-|\bAKIA[0-9A-Z]{8,}|\bAIza[0-9A-Za-z_-]{10,}|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)/

/** True when a string value contains something shaped like a credential (provider key, bearer token, JWT). */
export const looksLikeSecretValue = (value: unknown): boolean => typeof value === 'string' && SECRET_VALUE.test(value)

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

/** Repeatedly JSON-unwraps and percent-decodes a string, recording every layer. */
const decodeLayers = (value: string): DecodedLayers => {
    const strings = [value]
    let text = value
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
                text = parsed
                strings.push(text)
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
            if (decoded !== undefined && decoded !== text) {
                if (percentLayers >= MAX_DECODE_LAYERS) return { strings, jsonEncoded, tooDeep: true }
                percentLayers += 1
                viaPercent = true
                text = decoded
                strings.push(text)
                continue
            }
        }
        return { strings, jsonEncoded, tooDeep: false }
    }
}

/** True when a plain string layer is credential-shaped or carries a credential URL. */
const isUnsafeText = (text: string): boolean => looksLikeSecretValue(text) || containsCredentialUrl(text)

/** The string layers to value-check: all of them, except the JSON text of a structured bottom (its contents are walked instead). */
const textLayers = (layers: DecodedLayers): string[] => (layers.structured ? layers.strings.slice(0, -1) : layers.strings)

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

/** True for an object that is exactly a { key, value } pair. */
const isExactPair = (value: Record<string, unknown>): boolean => {
    const names = Object.keys(value)
    return names.length === 2 && 'key' in value && 'value' in value
}

/** True for an object that holds a key/value pair (it has both), whatever else it carries. */
const isPairLike = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value) && 'key' in value && 'value' in value

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
        if (layers.tooDeep || textLayers(layers).some(isUnsafeText)) return DROP
        if (layers.structured) return cleanStructured(value, layers, (parsed) => scrubHeaderTree(parsed, depth + 1))
        return /^\s*[[{]/.test(value) ? DROP : value
    }
    if (Array.isArray(value)) {
        const out: unknown[] = []
        for (const item of value) {
            if (isPairLike(item) && (typeof item.key !== 'string' || isSecretHeaderName(item.key))) continue
            const cleaned = scrubHeaderTree(item, depth + 1)
            if (cleaned !== DROP) out.push(cleaned)
        }
        return out
    }
    if (value && typeof value === 'object') {
        // An object holding a pair is judged by its key, like an array item. Only an exact { key, value } keeps the label.
        if (isPairLike(value) && (typeof value.key !== 'string' || isSecretHeaderName(value.key))) return DROP
        const exactPair = isExactPair(value as Record<string, unknown>)
        const out: Record<string, unknown> = {}
        for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
            if (!(exactPair && (name === 'key' || name === 'value')) && isSecretHeaderName(name)) continue
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
        if (layers.tooDeep || textLayers(layers).some(isUnsafeText)) return DROP
        if (layers.structured) return cleanStructured(value, layers, (parsed) => scrubValue(parsed, depth + 1))
        return value
    }
    if (Array.isArray(value)) {
        const out: unknown[] = []
        for (const item of value) {
            if (isPairLike(item) && (typeof item.key !== 'string' || isSecretNestedName(item.key) || isSecretHeaderName(item.key))) continue
            const scrubbed = scrubValue(item, depth + 1)
            if (scrubbed !== DROP) out.push(scrubbed)
        }
        return out
    }
    if (value && typeof value === 'object') {
        // An object holding a pair is judged by its key, like an array item. Only an exact { key, value } keeps the label.
        if (isPairLike(value) && (typeof value.key !== 'string' || isSecretNestedName(value.key) || isSecretHeaderName(value.key)))
            return DROP
        const exactPair = isExactPair(value as Record<string, unknown>)
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (!(exactPair && key === 'key') && isSecretNestedName(key)) continue
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

/** A string, number or boolean with nothing credential-shaped in it, or undefined. */
const publicScalar = (value: unknown): string | number | boolean | undefined => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
        // Allowlist: plain text only. Anything JSON-encoded at any layer, credential-shaped once decoded, or changed by the scrubber is dropped.
        const layers = decodeLayers(value)
        if (layers.tooDeep || layers.jsonEncoded || layers.strings.some(isUnsafeText)) return undefined
        return scrubSecrets(value) === value ? value : undefined
    }
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
