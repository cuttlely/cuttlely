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
// Saved credential references (credential, credentialId) are never public, whatever the declared type.
const CREDENTIAL_REF_NAME = /credential/i
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

/**
 * Walks a value and removes anything credential-shaped: strings that look like keys, properties with
 * credential names, and { key, value } pairs whose key is a credential name. Returns DROP when nothing is left to keep.
 */
const scrubValue = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return DROP
    if (typeof value === 'string') return looksLikeSecretValue(value) ? DROP : value
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
            const scrubbed = scrubValue(item, depth + 1)
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
    try {
        // Array format: [{ key: string, value: string }, ...] (e.g. HTTP agentflow node)
        if (Array.isArray(rawHeaders)) {
            return scrubSecrets(rawHeaders.filter((h: { key?: unknown }) => !(typeof h?.key === 'string' && isSecretHeaderName(h.key))))
        }
        // Object/string format: Record<string, string> or JSON string thereof
        const headers: Record<string, unknown> = typeof rawHeaders === 'string' ? JSON.parse(rawHeaders) : { ...(rawHeaders as object) }
        for (const h of Object.keys(headers)) {
            if (isSecretHeaderName(h)) delete headers[h]
        }
        const scrubbed = scrubSecrets(headers)
        if (scrubbed === undefined) return undefined
        return typeof rawHeaders === 'string' ? JSON.stringify(scrubbed) : scrubbed
    } catch {
        // Drop headers that cannot be parsed
        return undefined
    }
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
        if (!param && !anchor) continue
        if (param && SECRET_PARAM_TYPES.has(param.type)) continue
        // A declared, non-password input is kept by name and only its value is checked; undeclared ones also get the name check.
        // Credential ID references are dropped by name either way, like node.data.credential.
        if (param ? CREDENTIAL_REF_NAME.test(key) : isSecretInputName(key)) continue
        const value = inputs[key]
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
const PUBLIC_DISPLAY_FIELDS = [
    'title',
    'titleAvatarSrc',
    'titleBackgroundColor',
    'titleTextColor',
    'backgroundColor',
    'welcomeMessage',
    'errorMessage',
    'fontSize',
    'starterPrompts',
    'generateNewSession'
] as const
const PUBLIC_DISPLAY_OBJECTS: Record<string, readonly string[]> = {
    botMessage: ['showAvatar', 'avatarSrc', 'backgroundColor', 'textColor'],
    userMessage: ['backgroundColor', 'textColor'],
    textInput: ['placeholder', 'backgroundColor', 'textColor', 'sendButtonColor'],
    chatFeedback: ['status'],
    followUpPrompts: ['status']
}

/** The display-only part of a saved chatbotConfig, for signed-out callers. */
export const publicChatbotDisplayConfig = (config: unknown): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    if (!config || typeof config !== 'object' || Array.isArray(config)) return result
    const source = config as Record<string, unknown>
    for (const field of PUBLIC_DISPLAY_FIELDS) {
        if (source[field] === undefined) continue
        const kept = scrubSecrets(source[field])
        if (kept !== undefined) result[field] = kept
    }
    for (const [field, keys] of Object.entries(PUBLIC_DISPLAY_OBJECTS)) {
        const value = source[field]
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const picked: Record<string, unknown> = {}
        for (const key of keys) {
            const kept = scrubSecrets((value as Record<string, unknown>)[key])
            if (kept !== undefined) picked[key] = kept
        }
        result[field] = picked
    }
    return result
}

/**
 * What GET /api/v1/public-chatflows/:id returns for a public chatflow: id, name, whether an API key is required,
 * and the display part of chatbotConfig plus overrideConfig (which the shared chat page sends with each question),
 * with anything credential-shaped removed. Never the flow graph.
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
    const override = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).overrideConfig : undefined
    if (override && typeof override === 'object' && !Array.isArray(override)) {
        const { headers, ...rest } = override as Record<string, unknown>
        const kept = scrubSecrets(rest) as Record<string, unknown> | undefined
        if (kept !== undefined) {
            if (headers !== undefined && headers !== null) {
                const keptHeaders = sanitizeHeaders(headers)
                if (keptHeaders !== undefined) kept.headers = keptHeaders
            }
            display.overrideConfig = kept
        }
    }
    return {
        id: chatflow.id,
        name: chatflow.name,
        isPublic: Boolean(chatflow.isPublic),
        hasApiKey: isChatflowKeyProtected(chatflow.apikeyid),
        chatbotConfig: JSON.stringify(display)
    }
}
