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
// Query or fragment parameter names that carry credentials inside a URL.
const URL_SECRET_PARAM = /(token|key|secret|sig|passw)/i
// Exact query or fragment parameter names that mark a URL as carrying a credential.
const URL_CREDENTIAL_PARAM = /^(api[_-]?key|apikey|access[_-]?token|token|key|secret|password|sig|signature|client[_-]?secret)$/i
// Declared inputs dropped by name alone.
const DECLARED_AUTH_NAME = /^(authorization|auth)$/i

/** True for a string that parses as a URL carrying userinfo or a credential query or fragment parameter. */
const isCredentialUrl = (value: string): boolean => {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) return false
    let url: URL
    try {
        url = new URL(value.trim())
    } catch {
        return false
    }
    if (url.username || url.password) return true
    const params = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.replace(/^#/, '')).keys()]
    return params.some((name) => URL_CREDENTIAL_PARAM.test(name))
}

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
    if (url.username || url.password) return false
    const params = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.replace(/^#/, '')).keys()]
    return !params.some((name) => URL_SECRET_PARAM.test(name))
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
const HEADERS_KEY = /^headers$/i

/**
 * Removes credential-carrying header entries at every depth of a headers value: { key, value } pairs and object
 * properties whose name is a secret header name, including per-node maps such as headers.<nodeId>.X-Custom-Auth.
 * JSON strings are parsed, cleaned and re-serialized; a string that is not JSON is left to the value check.
 */
const scrubHeaderTree = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return DROP
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
        try {
            const cleaned = scrubHeaderTree(JSON.parse(trimmed), depth + 1)
            return cleaned === DROP ? DROP : JSON.stringify(cleaned)
        } catch {
            return DROP
        }
    }
    if (Array.isArray(value)) {
        const out: unknown[] = []
        for (const item of value) {
            const pairKey = item && typeof item === 'object' ? (item as Record<string, unknown>).key : undefined
            if (typeof pairKey === 'string' && isSecretHeaderName(pairKey)) continue
            const cleaned = scrubHeaderTree(item, depth + 1)
            if (cleaned !== DROP) out.push(cleaned)
        }
        return out
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
            if (name !== 'key' && name !== 'value' && isSecretHeaderName(name)) continue
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
    if (typeof value === 'string') return looksLikeSecretValue(value) || isCredentialUrl(value) ? DROP : value
    if (Array.isArray(value)) {
        const out: unknown[] = []
        for (const item of value) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                const pairKey = (item as Record<string, unknown>).key
                if (typeof pairKey === 'string' && (isSecretNestedName(pairKey) || isSecretHeaderName(pairKey))) continue
            }
            const scrubbed = scrubValue(item, depth + 1)
            if (scrubbed !== DROP) out.push(scrubbed)
        }
        return out
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            // "key" here is the label of a { key, value } pair; the pair itself is checked in the array branch.
            if (key !== 'key' && isSecretNestedName(key)) continue
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
        const kept = key === 'headers' && value ? sanitizeHeaders(value) : scrubSecrets(value)
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
    if (typeof value === 'string') return scrubSecrets(value) === undefined ? undefined : value
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
