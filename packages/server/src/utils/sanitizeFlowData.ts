import { INodeParams } from '@cuttlely/components'

export const isChatflowKeyProtected = (apiKeyId: string | null | undefined): boolean => typeof apiKeyId === 'string' && apiKeyId.length > 0

export interface DroppedNodeSettings {
    nodeId: string
    label: string
    inputs: string[]
}

export interface TemplateFlow {
    nodes: unknown[]
    edges: unknown[]
    droppedSettings: DroppedNodeSettings[]
}

type DeclaredParam = {
    name?: string
    type?: string
    options?: Array<{ name?: unknown } | string>
    tabs?: DeclaredParam[]
}

const SAFE_STRING_NAME = /(?:prompt|systemmessage|description|label|placeholder|(?:tool|agent)name)$/i
const HTTP_TOOL_NAME = /^requests(?:get|post|put|delete)name$/i
const URL_FIELD_NAME = /^base(?:path|url)$/i
const HEADER_NAME = /headers$/i
const NODE_REFERENCE = /^\{\{[A-Za-z0-9_-]+\.data\.instance(?:\.[A-Za-z0-9_-]+)*\}\}$/
const TOKEN_PREFIX = /(?:^|[^A-Za-z0-9])(?:sk-|pk-|ghp_|xox[a-z]-)/i
const HIGH_ENTROPY_RUN = /[A-Za-z0-9+/=_-]{32,}/g
// word: followed by a non-space character. Applied to the normalized text, not tuned per field.
const SCHEME_LIKE = /[A-Za-z][A-Za-z0-9+.-]*:\S/
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g
const MAX_NORMALIZE_LAYERS = 5

// Letters that look like ASCII, so a token prefix written with them still matches.
const HOMOGLYPHS: Record<string, string> = {
    '\u0430': 'a',
    '\u0435': 'e',
    '\u043e': 'o',
    '\u0440': 'p',
    '\u0441': 'c',
    '\u0443': 'y',
    '\u0445': 'x',
    '\u0456': 'i',
    '\u0455': 's',
    '\u04bb': 'h',
    '\u0458': 'j',
    '\u043a': 'k',
    '\u0261': 'g',
    '\u0410': 'A',
    '\u0412': 'B',
    '\u0415': 'E',
    '\u041a': 'K',
    '\u041c': 'M',
    '\u041d': 'H',
    '\u041e': 'O',
    '\u0420': 'P',
    '\u0421': 'C',
    '\u0422': 'T',
    '\u0425': 'X',
    '\u0406': 'I',
    '\u0405': 'S',
    '\u0408': 'J',
    '\u0391': 'A',
    '\u0392': 'B',
    '\u0395': 'E',
    '\u0396': 'Z',
    '\u0397': 'H',
    '\u0399': 'I',
    '\u039a': 'K',
    '\u039c': 'M',
    '\u039d': 'N',
    '\u039f': 'O',
    '\u03a1': 'P',
    '\u03a4': 'T',
    '\u03a7': 'X',
    '\u03b1': 'a',
    '\u03bf': 'o',
    '\u03c1': 'p'
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const COLOR_CHANNEL = '(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?|(?:100|[1-9]?\\d)%)'
const COLOR_ALPHA = '(?:0(?:\\.\\d+)?|1(?:\\.0+)?|\\.\\d+)'
const RGB_COLOR = new RegExp(`^rgb\\(\\s*${COLOR_CHANNEL}\\s*,\\s*${COLOR_CHANNEL}\\s*,\\s*${COLOR_CHANNEL}\\s*\\)$`, 'i')
const RGBA_COLOR = new RegExp(
    `^rgba\\(\\s*${COLOR_CHANNEL}\\s*,\\s*${COLOR_CHANNEL}\\s*,\\s*${COLOR_CHANNEL}\\s*,\\s*${COLOR_ALPHA}\\s*\\)$`,
    'i'
)

type DisplayKind = 'text' | 'color' | 'boolean' | 'number' | 'image'

const TEXT_LIMITS: Record<string, number> = {
    title: 80,
    welcomeMessage: 2000,
    errorMessage: 300,
    placeholder: 120,
    prompt: 300
}

const PUBLIC_SCALARS: Record<string, DisplayKind> = {
    title: 'text',
    titleAvatarSrc: 'image',
    titleBackgroundColor: 'color',
    titleTextColor: 'color',
    backgroundColor: 'color',
    welcomeMessage: 'text',
    errorMessage: 'text',
    fontSize: 'number',
    generateNewSession: 'boolean'
}

const PUBLIC_OBJECTS: Record<string, Record<string, DisplayKind>> = {
    botMessage: { showAvatar: 'boolean', avatarSrc: 'image', backgroundColor: 'color', textColor: 'color' },
    userMessage: { backgroundColor: 'color', textColor: 'color' },
    textInput: { placeholder: 'text', backgroundColor: 'color', textColor: 'color', sendButtonColor: 'color' },
    chatFeedback: { status: 'boolean' },
    followUpPrompts: { status: 'boolean' }
}

const foldText = (value: string): string => {
    const normalized = value.normalize('NFKC').replace(INVISIBLE, '')
    let out = ''
    for (const char of normalized) out += HOMOGLYPHS[char] ?? char
    return out
}

/** Plain text after NFKC, look-alike folding, percent-decoding, and JSON unwrapping. Undefined when that cannot be finished. */
const plainForCheck = (value: string): string | undefined => {
    let text = value
    let layers = 0
    for (;;) {
        text = foldText(text)
        const trimmed = text.trim()
        if (trimmed.startsWith('"') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed)
                if (typeof parsed === 'string') {
                    layers += 1
                    if (layers > MAX_NORMALIZE_LAYERS) return undefined
                    text = parsed
                    continue
                }
                if (parsed !== null && typeof parsed === 'object') return undefined
            } catch {
                // The text is not JSON. Keep checking it as text.
            }
        }
        if (/%[0-9a-fA-F]{2}/.test(text)) {
            let decoded: string
            try {
                decoded = decodeURIComponent(text)
            } catch {
                return undefined
            }
            if (decoded !== text) {
                layers += 1
                if (layers > MAX_NORMALIZE_LAYERS) return undefined
                text = decoded
                continue
            }
        }
        return text
    }
}

const shannon = (value: string): number => {
    const counts = new Map<string, number>()
    for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
    let entropy = 0
    for (const count of counts.values()) {
        const p = count / value.length
        entropy -= p * Math.log2(p)
    }
    return entropy
}

const hasHighEntropyRun = (text: string): boolean => {
    HIGH_ENTROPY_RUN.lastIndex = 0
    for (const match of text.matchAll(HIGH_ENTROPY_RUN)) {
        const run = match[0]
        const classes = Number(/[0-9]/.test(run)) + Number(/[a-z]/.test(run)) + Number(/[A-Z]/.test(run)) + Number(/[+/=_]/.test(run))
        if (classes >= 2 && shannon(run) >= 3.5) return true
    }
    return false
}

/** //, an @ with a non-space on both sides, or a scheme-like word: immediately followed by a non-space. */
const hasUnsafeFreeText = (text: string): boolean => text.includes('//') || /\S@\S/.test(text) || SCHEME_LIKE.test(text)

/** True when a string can be kept. The original value is kept or the whole value is left out. */
const stringIsSafe = (value: unknown): value is string => {
    if (typeof value !== 'string') return false
    const plain = plainForCheck(value)
    if (plain === undefined) return false
    if (TOKEN_PREFIX.test(plain) || hasUnsafeFreeText(plain) || hasHighEntropyRun(plain)) return false
    return true
}

const isSafeStringName = (name: string): boolean => SAFE_STRING_NAME.test(name) || HTTP_TOOL_NAME.test(name)

const isBlank = (value: unknown): boolean => {
    if (value === undefined || value === null || value === '') return true
    if (Array.isArray(value)) return value.length === 0
    if (typeof value === 'object') return Object.keys(value as object).length === 0
    return false
}

const flattenParams = (inputParams: unknown): DeclaredParam[] => {
    const out: DeclaredParam[] = []
    const walk = (list: unknown) => {
        if (!Array.isArray(list)) return
        for (const item of list) {
            if (!item || typeof item !== 'object') continue
            const param = item as DeclaredParam
            if (typeof param.name === 'string' && param.name) out.push(param)
            if (Array.isArray(param.tabs)) walk(param.tabs)
        }
    }
    walk(inputParams)
    return out
}

const optionNames = (param: DeclaredParam): unknown[] => {
    if (!Array.isArray(param.options)) return []
    const names: unknown[] = []
    for (const option of param.options) {
        if (typeof option === 'string') names.push(option)
        else if (option && typeof option === 'object' && 'name' in option) names.push(option.name)
    }
    return names
}

const isListedOption = (value: unknown, param: DeclaredParam): boolean => optionNames(param).some((name) => Object.is(name, value))

const isNodeReference = (value: unknown): boolean => {
    if (typeof value === 'string') return NODE_REFERENCE.test(value)
    return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && NODE_REFERENCE.test(item))
}

/** http or https, written back as scheme, host, and path. No user info, port, query, or fragment. */
export const rebuildHttpUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) return undefined
    let url: URL
    try {
        url = new URL(value.trim())
    } catch {
        return undefined
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    if (url.username || url.password || !url.hostname) return undefined
    for (const segment of url.pathname.split('/')) {
        if (!segment) continue
        let decoded: string
        try {
            decoded = decodeURIComponent(segment)
        } catch {
            return undefined
        }
        if (decoded.includes('@') || decoded.includes(':')) return undefined
    }
    return `${url.protocol}//${url.hostname}${url.pathname}`
}

const keepString = (value: unknown): string | undefined => (stringIsSafe(value) ? value : undefined)

/**
 * Template inputs for one node. Kept values come only from the declared input type.
 * `dropped` names settings that were present and left out.
 */
export const sanitizeNodeInputs = (
    inputs: Record<string, unknown> | undefined,
    inputParams: INodeParams[] | DeclaredParam[] | undefined,
    inputAnchors?: { name?: string }[] | undefined
): { inputs: Record<string, unknown>; dropped: string[] } => {
    const result: Record<string, unknown> = {}
    const dropped: string[] = []
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return { inputs: result, dropped }
    const params = flattenParams(inputParams)
    const anchors = Array.isArray(inputAnchors) ? inputAnchors : []
    for (const name of Object.keys(inputs)) {
        const value = inputs[name]
        const param = params.find((item) => item.name === name)
        const anchor = anchors.find((item) => item?.name === name)
        if (!param && anchor && isNodeReference(value)) {
            result[name] = value
            continue
        }
        if (!param) {
            if (!isBlank(value)) dropped.push(name)
            continue
        }
        if (HEADER_NAME.test(name) || param.type === 'credential') {
            if (!isBlank(value)) dropped.push(name)
            continue
        }
        let kept: unknown
        if (param.type === 'number') kept = typeof value === 'number' && Number.isFinite(value) ? value : undefined
        else if (param.type === 'boolean') kept = typeof value === 'boolean' ? value : undefined
        else if (param.type === 'options') kept = isListedOption(value, param) ? value : undefined
        else if (param.type === 'multiOptions') {
            let items: unknown[] | undefined
            if (Array.isArray(value)) items = value
            else if (typeof value === 'string' && value.trim()) {
                try {
                    const parsed = JSON.parse(value)
                    if (Array.isArray(parsed)) items = parsed
                } catch {
                    items = undefined
                }
            }
            kept = items && items.every((item) => isListedOption(item, param)) ? value : undefined
        } else if (param.type === 'asyncOptions') kept = keepString(value)
        else if (param.type === 'string' && URL_FIELD_NAME.test(name)) kept = rebuildHttpUrl(value)
        else if (param.type === 'string' && isSafeStringName(name)) kept = keepString(value)
        else kept = undefined
        if (kept !== undefined) result[name] = kept
        else if (!isBlank(value)) dropped.push(name)
    }
    return { inputs: result, dropped }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
}

/** A saved flow reduced to template fields, plus the nodes whose settings were left out. */
export const buildTemplateFlow = (flowData: { nodes?: unknown; edges?: unknown } | null | undefined): TemplateFlow => {
    const sourceNodes = Array.isArray(flowData?.nodes) ? flowData.nodes : []
    const edges = Array.isArray(flowData?.edges) ? [...flowData.edges] : []
    const droppedSettings: DroppedNodeSettings[] = []
    const nodes = sourceNodes.map((node) => {
        if (!node || typeof node !== 'object') return node
        const current = node as Record<string, unknown>
        const data = asRecord(current.data)
        if (!data) return { ...current, selected: false }
        const nodeId = String(current.id || data.id || '')
        const label = typeof data.label === 'string' && data.label ? data.label : typeof data.name === 'string' ? data.name : nodeId
        const inputs = asRecord(data.inputs)
        const sanitized = sanitizeNodeInputs(
            inputs,
            data.inputParams as INodeParams[] | undefined,
            data.inputAnchors as { name?: string }[] | undefined
        )
        const dropped = [...sanitized.dropped]
        if (typeof data.credential === 'string' && data.credential) dropped.push('credential')
        else if (data.credential && typeof data.credential === 'object') dropped.push('credential')
        if (dropped.length) droppedSettings.push({ nodeId, label, inputs: dropped })
        return {
            ...current,
            selected: false,
            data: {
                id: data.id,
                label: data.label,
                version: data.version,
                name: data.name,
                type: data.type,
                color: data.color,
                hideOutput: data.hideOutput,
                hideInput: data.hideInput,
                baseClasses: data.baseClasses,
                tags: data.tags,
                category: data.category,
                description: data.description,
                inputParams: data.inputParams,
                inputAnchors: data.inputAnchors,
                inputs: sanitized.inputs,
                outputAnchors: data.outputAnchors,
                outputs: data.outputs,
                selected: false
            }
        }
    })
    return { nodes, edges, droppedSettings }
}

const displayText = (value: unknown, field: string): string | undefined => {
    if (typeof value !== 'string') return undefined
    const limit = TEXT_LIMITS[field]
    if (!limit || value.length === 0 || value.length > limit) return undefined
    return value
}

const displayColor = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    const color = value.trim()
    if (HEX_COLOR.test(color) || RGB_COLOR.test(color) || RGBA_COLOR.test(color)) return color
    return undefined
}

const displayValue = (value: unknown, kind: DisplayKind, field: string): unknown => {
    if (kind === 'text') return displayText(value, field)
    if (kind === 'color') return displayColor(value)
    if (kind === 'boolean') return typeof value === 'boolean' ? value : undefined
    if (kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    if (kind === 'image') return rebuildHttpUrl(value)
    return undefined
}

const publicStarterPrompts = (value: unknown): { prompt: string }[] | undefined => {
    if (!value || typeof value !== 'object') return undefined
    const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
    const out: { prompt: string }[] = []
    for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const prompt = displayText((item as Record<string, unknown>).prompt, 'prompt')
        if (prompt === undefined) continue
        out.push({ prompt })
    }
    return out.length ? out : undefined
}

/** Display fields for a signed-out caller. Each field is kept only when it matches its expected shape. */
export const publicChatbotDisplayConfig = (config: unknown): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    const source = asRecord(config)
    if (!source) return result
    for (const [field, kind] of Object.entries(PUBLIC_SCALARS)) {
        const kept = displayValue(source[field], kind, field)
        if (kept !== undefined) result[field] = kept
    }
    const prompts = publicStarterPrompts(source.starterPrompts)
    if (prompts) result.starterPrompts = prompts
    for (const [field, shape] of Object.entries(PUBLIC_OBJECTS)) {
        const value = asRecord(source[field])
        if (!value) continue
        const picked: Record<string, unknown> = {}
        for (const [child, kind] of Object.entries(shape)) {
            const kept = displayValue(value[child], kind, child)
            if (kept !== undefined) picked[child] = kept
        }
        if (Object.keys(picked).length) result[field] = picked
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
