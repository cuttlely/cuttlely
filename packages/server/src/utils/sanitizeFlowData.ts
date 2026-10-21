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
// Canvas ids are `<nodeName>_<n>` (chatOpenAI_0). A link is only that id's `.data.instance`.
const NODE_REFERENCE = /^\{\{([A-Za-z][A-Za-z0-9_]*_\d+)\.data\.instance\}\}$/
const TOKEN_PREFIX = /(?:^|[^A-Za-z0-9])(?:sk-|pk-|ghp_|xox[a-z]-|xai-)/i
const HIGH_ENTROPY_RUN = /[A-Za-z0-9+/=_-]{32,}/g
// In func, a slash ends a run. A path is not one long run.
const HIGH_ENTROPY_RUN_CODE = /[A-Za-z0-9+=_-]{32,}/g
const PLAIN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Checked before any normalization. Comfortably above real prompt and tool text. Display fields keep their shorter limits.
const MAX_TEMPLATE_TEXT = 20000
const MAX_URL_TEXT = 8192
const MAX_NFKC_EXPANSION = 4
// A letter, then scheme characters, then `:`, then a letter, digit, or `/`.
// Checked on the original, normalized, and fully decoded text.
// Scanned in one pass (see hasSchemeLike) so the time stays linear in the text length.
// A known scheme whose colon is followed by a tab or a line break. A normal space after the colon stays allowed.
// Ordinary labels such as "History:" are not in this list.
const NAMED_SCHEME_ACROSS_BREAK =
    /(?:^|[^A-Za-z0-9])(?:javascript|vbscript|data|file|blob|https?):[^\S\t\n\v\f\r\u2028\u2029]*[\t\n\v\f\r\u2028\u2029]/i
// Hidden characters, by Unicode property rather than a hand-picked list: every control except tab and line breaks,
// every format character, every default-ignorable code point (variation selectors, fillers, tags and the like),
// and the no-break spaces. Tab and line breaks stay, so a label on its own line is not joined to the next line.
const INVISIBLE_CLASS = '[\\u0000-\\u0008\\u000e-\\u001f\\u007f-\\u009f\\u00a0\\u202f\\p{Cf}\\p{Default_Ignorable_Code_Point}]'
const INVISIBLE = new RegExp(INVISIBLE_CLASS, 'gu')
const INVISIBLE_CHAR = new RegExp(INVISIBLE_CLASS, 'u')
const HYPHEN_LIKE = /[\u2010-\u2015\u2212]/g
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

const foldHyphens = (value: string): string => {
    HYPHEN_LIKE.lastIndex = 0
    return value.replace(HYPHEN_LIKE, '-')
}

// One check reuses a folded form instead of running NFKC again on the same text.
let foldCache: Map<string, string | undefined> | null = null

const withFoldCache = <T>(fn: () => T): T => {
    if (foldCache) return fn()
    foldCache = new Map()
    try {
        return fn()
    } finally {
        foldCache = null
    }
}

// NFKC and look-alike folding. Hyphens U+2010 through U+2015 and U+2212 are read as ASCII hyphen. Invisible characters are left in place so a later pass can still remove them. Undefined when NFKC makes a run more than four times longer.
const foldMarks = (value: string): string | undefined => {
    if (foldCache?.has(value)) return foldCache.get(value)
    const out: string[] = []
    let pending: string[] = []
    const flush = (): boolean => {
        if (!pending.length) return true
        const segment = pending.join('')
        pending = []
        const normalized = segment.normalize('NFKC')
        if (normalized.length > segment.length * MAX_NFKC_EXPANSION) return false
        const folded = foldHyphens(normalized)
        let piece = ''
        for (const char of folded) piece += HOMOGLYPHS[char] ?? char
        out.push(piece)
        return true
    }
    let expanded = false
    for (const char of foldHyphens(value)) {
        if (INVISIBLE_CHAR.test(char)) {
            if (!flush()) {
                expanded = true
                break
            }
            out.push(char)
        } else pending.push(char)
    }
    if (!expanded && !flush()) expanded = true
    const result = expanded ? undefined : out.join('')
    foldCache?.set(value, result)
    return result
}

// Invisible characters become spaces, then NFKC and look-alike folding. Undefined when NFKC grows too far.
const foldText = (value: string): string | undefined => {
    const folded = foldMarks(value.replace(INVISIBLE, ' '))
    if (folded === undefined) return undefined
    return folded.replace(INVISIBLE, ' ')
}

// The same characters are deleted, then NFKC and look-alike folding. Undefined when NFKC grows too far.
const removedForm = (value: string): string | undefined => {
    const folded = foldMarks(value.replace(INVISIBLE, ''))
    if (folded === undefined) return undefined
    return folded.replace(INVISIBLE, '')
}

// Invisible characters and every other whitespace character are deleted. Undefined when NFKC grows too far.
const compactForm = (value: string): string | undefined => {
    const removed = removedForm(value)
    if (removed === undefined) return undefined
    return removed.replace(/\s+/g, '')
}

// Percent-decoding and JSON unwrapping. Invisible characters stay in this pass so a break before a token prefix still counts.
const decodeLayers = (start: string, state: { layers: number }): string | undefined => {
    let text = start
    for (;;) {
        const folded = foldMarks(text)
        if (folded === undefined) return undefined
        text = folded
        const trimmed = text.trim()
        if (trimmed.startsWith('"') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed)
                if (typeof parsed === 'string') {
                    state.layers += 1
                    if (state.layers > MAX_NORMALIZE_LAYERS) return undefined
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
                state.layers += 1
                if (state.layers > MAX_NORMALIZE_LAYERS) return undefined
                text = decoded
                continue
            }
        }
        return text
    }
}

/** Plain text after NFKC, look-alike folding, percent-decoding, and JSON unwrapping. Invisible characters are removed from the original and from the decoded text, then percent-decoding and JSON unwrapping run again. Undefined when that cannot be finished. */
const plainForCheck = (value: string): string | undefined => {
    const state = { layers: 0 }
    const decoded = decodeLayers(value, state)
    if (decoded === undefined) return undefined
    // Removal happens on the original as well, before NFKC turns a no-break space into a normal space.
    const candidates = [value.replace(INVISIBLE, ''), decoded.replace(INVISIBLE, '')]
    let combined = decoded
    const seen = new Set<string>([value, decoded])
    for (const candidate of candidates) {
        if (seen.has(candidate)) continue
        seen.add(candidate)
        const again = decodeLayers(candidate, state)
        if (again === undefined) return undefined
        if (again !== candidate && !seen.has(again)) {
            seen.add(again)
            combined += '\n' + again
        }
    }
    return combined
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

const hasHighEntropyRun = (text: string, code = false): boolean => {
    const pattern = code ? HIGH_ENTROPY_RUN_CODE : HIGH_ENTROPY_RUN
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
        const run = match[0]
        const classes = Number(/[0-9]/.test(run)) + Number(/[a-z]/.test(run)) + Number(/[A-Z]/.test(run)) + Number(/[+/=_]/.test(run))
        if (classes >= 2 && shannon(run) >= 3.5) return true
    }
    return false
}

const isAsciiLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
const isSchemeChar = (c: string): boolean => isAsciiLetter(c) || (c >= '0' && c <= '9') || c === '+' || c === '.' || c === '-'
const isUrlStart = (c: string): boolean => isAsciiLetter(c) || (c >= '0' && c <= '9') || c === '/'

/** A letter, then letters, digits, `+`, `.` or `-`, then `:` and a letter, digit, or `/`. One linear pass, no regex. */
export const hasSchemeLike = (text: string): boolean => {
    let runHasLetter = false
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (c === ':') {
            const next = text[i + 1]
            if (runHasLetter && next !== undefined && isUrlStart(next)) return true
            runHasLetter = false
        } else if (isSchemeChar(c)) {
            if (isAsciiLetter(c)) runHasLetter = true
        } else {
            runHasLetter = false
        }
    }
    return false
}

export const hasNamedSchemeAcrossBreak = (text: string): boolean => NAMED_SCHEME_ACROSS_BREAK.test(text)

/** `//`, an `@` with a non-space on both sides, or a scheme-like word whose colon is followed by a letter, digit, or `/`. A named scheme with a tab or a line break after the colon counts too. */
const hasUnsafeFreeText = (text: string): boolean =>
    text.includes('//') || /\S@\S/.test(text) || hasSchemeLike(text) || hasNamedSchemeAcrossBreak(text)

const hasTokenOrUnsafePattern = (text: string): boolean => TOKEN_PREFIX.test(text) || hasUnsafeFreeText(text)

const hasTokenOrEntropy = (text: string, code = false): boolean => TOKEN_PREFIX.test(text) || hasHighEntropyRun(text, code)

/**
 * Token and free-text patterns on the raw text, the spaced form, and the form with invisible characters removed.
 * A token prefix is also checked after every whitespace character is removed.
 */
const patternFails = (value: string): boolean => {
    if (value.length > MAX_TEMPLATE_TEXT || hasTokenOrUnsafePattern(value)) return true
    const folded = foldText(value)
    if (folded === undefined || hasTokenOrUnsafePattern(folded)) return true
    const removed = removedForm(value)
    if (removed === undefined || hasTokenOrUnsafePattern(removed)) return true
    const compact = compactForm(value)
    if (compact === undefined) return true
    return TOKEN_PREFIX.test(compact)
}

/** A token prefix or a long high-entropy run on the raw text, the spaced form, and the form with invisible characters removed. Spaces stay, so ordinary words are not joined into one run. The whitespace-free form is only for a token prefix, in patternFails. */
const entropyFails = (value: string, code = false): boolean => {
    if (value.length > MAX_TEMPLATE_TEXT || hasTokenOrEntropy(value, code)) return true
    const folded = foldText(value)
    if (folded === undefined || hasTokenOrEntropy(folded, code)) return true
    const removed = removedForm(value)
    if (removed === undefined || hasTokenOrEntropy(removed, code)) return true
    return false
}

/**
 * Decoded text when the original and the fully decoded text are free of a token prefix and of an unsafe free-text pattern
 * on each checked form. Undefined when decoding cannot finish or any form matches.
 */
const plainIfAllowed = (value: string): string | undefined => {
    if (value.length > MAX_TEMPLATE_TEXT) return undefined
    const plain = plainForCheck(value)
    if (plain === undefined) return undefined
    if (patternFails(value) || patternFails(plain)) return undefined
    return plain
}

/** True when a string can be kept. The original value is kept or the whole value is left out. */
const stringIsSafe = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length > MAX_TEMPLATE_TEXT) return false
    // Reject an obvious raw match before normalization. Folded forms still run below.
    if (hasTokenOrUnsafePattern(value)) return false
    return withFoldCache(() => {
        const plain = plainIfAllowed(value)
        if (plain === undefined) return false
        return !entropyFails(value) && !entropyFails(plain)
    })
}

/** Token prefix on the raw text, the spaced form, the removed form, and the whitespace-free form. */
const tokenPatternFails = (value: string): boolean => {
    if (value.length > MAX_TEMPLATE_TEXT || TOKEN_PREFIX.test(value)) return true
    const folded = foldText(value)
    if (folded === undefined || TOKEN_PREFIX.test(folded)) return true
    const removed = removedForm(value)
    if (removed === undefined || TOKEN_PREFIX.test(removed)) return true
    const compact = compactForm(value)
    if (compact === undefined) return true
    return TOKEN_PREFIX.test(compact)
}

/**
 * Tool func is source text. It uses the token-prefix, high-entropy, and decoding checks.
 * An address, `//`, `@`, or a scheme-like word does not by itself leave it out.
 */
const codeIsSafe = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length > MAX_TEMPLATE_TEXT) return false
    if (TOKEN_PREFIX.test(value)) return false
    return withFoldCache(() => {
        const plain = plainForCheck(value)
        if (plain === undefined) return false
        if (tokenPatternFails(value) || tokenPatternFails(plain)) return false
        return !entropyFails(value, true) && !entropyFails(plain, true)
    })
}

const TEMPLATE_NAME = /^template$/i
const isSafeStringName = (name: string): boolean => SAFE_STRING_NAME.test(name) || TEMPLATE_NAME.test(name) || HTTP_TOOL_NAME.test(name)

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

const referenceNodeId = (value: string): string | undefined => NODE_REFERENCE.exec(value)?.[1]

const isNodeReference = (value: unknown, nodeIds: ReadonlySet<string>): boolean => {
    const one = (item: unknown): boolean => {
        if (typeof item !== 'string') return false
        const id = referenceNodeId(item)
        return id !== undefined && nodeIds.has(id)
    }
    if (typeof value === 'string') return one(value)
    return Array.isArray(value) && value.length > 0 && value.every(one)
}

/** A path segment or host label that matches a token prefix or a long high-entropy run, on the raw and decoded forms. Spaces stay for the long-run check. */
const partHasSecret = (text: string): boolean => {
    if (text.length > MAX_TEMPLATE_TEXT) return true
    return withFoldCache(() => {
        if (patternFails(text) || entropyFails(text)) return true
        const plain = plainForCheck(text)
        if (plain === undefined) return true
        return plain !== text && (patternFails(plain) || entropyFails(plain))
    })
}

/** http or https, written back as scheme, host, and path. No user info, port, query, or fragment. */
export const rebuildHttpUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_TEXT) return undefined
    const trimmed = value.trim()
    if (!trimmed) return undefined
    let url: URL
    try {
        url = new URL(trimmed)
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
        if (decoded.includes('@') || decoded.includes(':') || partHasSecret(decoded)) return undefined
    }
    for (const label of url.hostname.split('.')) {
        if (!label) continue
        // A punycode label came from non-ASCII text the checks above never saw as written, so the address is left out.
        if (label.toLowerCase().startsWith('xn--') || partHasSecret(label)) return undefined
    }
    return `${url.protocol}//${url.hostname}${url.pathname}`
}

const keepString = (value: unknown): string | undefined => (stringIsSafe(value) ? value : undefined)

/** A whole async option value that is only a UUID is not treated as a long high-entropy run. Spaces stay for that run. The whitespace-free form is only for a token prefix. */
const keepAsyncOption = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length > MAX_TEMPLATE_TEXT) return undefined
    return withFoldCache(() => keepAsyncOptionCached(value))
}

const keepAsyncOptionCached = (value: string): string | undefined => {
    const plain = plainIfAllowed(value)
    if (plain === undefined) return undefined
    const folded = foldText(plain)
    const removed = removedForm(plain)
    const compactValue = compactForm(value)
    const compactPlain = compactForm(plain)
    if (folded === undefined || removed === undefined || compactValue === undefined || compactPlain === undefined) return undefined
    const spaced = [value, plain, folded, removed]
    const joined = [compactValue, compactPlain]
    if ([...spaced, ...joined].some((form) => TOKEN_PREFIX.test(form))) return undefined
    const isUuid = (form: string) => PLAIN_UUID.test(form.trim())
    const uuid = [...spaced, ...joined].some(isUuid)
    if (!uuid && spaced.some((form) => hasHighEntropyRun(form))) return undefined
    if (uuid && spaced.some((form) => !isUuid(form) && hasHighEntropyRun(form))) return undefined
    return value
}

/**
 * Template inputs for one node. Kept values come only from the declared input type.
 * `dropped` names settings that were present and left out.
 */
export const sanitizeNodeInputs = (
    inputs: Record<string, unknown> | undefined,
    inputParams: INodeParams[] | DeclaredParam[] | undefined,
    inputAnchors?: { name?: string }[] | undefined,
    nodeIds?: ReadonlySet<string>
): { inputs: Record<string, unknown>; dropped: string[] } => {
    const result: Record<string, unknown> = {}
    const dropped: string[] = []
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return { inputs: result, dropped }
    const params = flattenParams(inputParams)
    const anchors = Array.isArray(inputAnchors) ? inputAnchors : []
    const knownNodes = nodeIds ?? new Set<string>()
    for (const name of Object.keys(inputs)) {
        const value = inputs[name]
        const param = params.find((item) => item.name === name)
        const anchor = anchors.find((item) => item?.name === name)
        if (!param && anchor && isNodeReference(value, knownNodes)) {
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
        } else if (param.type === 'asyncOptions') kept = keepAsyncOption(value)
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

const jsonContainer = (value: string): unknown | undefined => {
    const trimmed = value.trim()
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return undefined
    try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
        return undefined
    }
    return undefined
}

/** A string uses the whole-value text check. A JSON array or object is safe only when every nested string is. */
const toolValueIsSafe = (value: unknown): boolean => {
    if (typeof value === 'string') {
        if (value.length > MAX_TEMPLATE_TEXT) return false
        const container = jsonContainer(value)
        if (container !== undefined) {
            if (withFoldCache(() => patternFails(value) || entropyFails(value))) return false
            return toolValueIsSafe(container)
        }
        return stringIsSafe(value)
    }
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'boolean' || value === null) return true
    if (Array.isArray(value)) return value.every((item) => toolValueIsSafe(item))
    if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>).every(([key, child]) => stringIsSafe(key) && toolValueIsSafe(child))
    }
    return false
}

/**
 * Custom tool template fields saved from the marketplace.
 * func uses the token-prefix, high-entropy, and decoding checks and is left out whole on a match.
 * An address, //, @, or a scheme-like word does not by itself leave func out.
 * schema uses the whole-value text check and is left out whole on a match.
 * iconSrc is rebuilt as scheme, host, and path, or left out.
 * dropped names the fields that were present and left out.
 */
export const sanitizeToolTemplate = (tool: unknown): { iconSrc?: string; schema?: unknown; func?: string; dropped: string[] } => {
    const source = asRecord(tool) ?? {}
    const dropped: string[] = []
    const result: { iconSrc?: string; schema?: unknown; func?: string; dropped: string[] } = { dropped }
    if (!isBlank(source.func)) {
        if (typeof source.func === 'string' && codeIsSafe(source.func)) result.func = source.func
        else dropped.push('func')
    }
    if (source.schema !== undefined && source.schema !== null && source.schema !== '') {
        if (typeof source.schema === 'string' && source.schema.length > MAX_TEMPLATE_TEXT) dropped.push('schema')
        else if (typeof source.schema === 'string' || Array.isArray(source.schema) || asRecord(source.schema)) {
            // Emit a rebuilt copy of what was checked, never the saved text: a JSON string is parsed and written again,
            // so a duplicate key or escaped text that the parsed value no longer holds is not carried over.
            const container = typeof source.schema === 'string' ? jsonContainer(source.schema) : source.schema
            if (toolValueIsSafe(source.schema)) {
                if (container === undefined) result.schema = source.schema
                else {
                    const rebuilt = JSON.stringify(container)
                    result.schema = typeof source.schema === 'string' ? rebuilt : JSON.parse(rebuilt)
                }
            } else dropped.push('schema')
        } else dropped.push('schema')
    }
    if (!isBlank(source.iconSrc)) {
        const iconSrc = rebuildHttpUrl(source.iconSrc)
        if (iconSrc !== undefined) result.iconSrc = iconSrc
        else dropped.push('iconSrc')
    }
    return result
}

// Same split the canvas uses: these types are fields, anything else is a link anchor.
const PARAM_TYPES = new Set([
    'asyncOptions',
    'asyncMultiOptions',
    'options',
    'multiOptions',
    'array',
    'datagrid',
    'string',
    'number',
    'boolean',
    'password',
    'json',
    'code',
    'date',
    'file',
    'folder',
    'tabs',
    'conditionFunction',
    'timePicker',
    'weekDaysPicker',
    'monthDaysPicker',
    'datePicker',
    'credential'
])

type TemplateComponent = {
    name?: string
    label?: string
    description?: string
    category?: string
    tags?: unknown
    version?: unknown
    type?: string
    color?: string
    hideOutput?: boolean
    hideInput?: boolean
    baseClasses?: unknown
    inputs?: DeclaredParam[]
    inputParams?: DeclaredParam[]
    inputAnchors?: DeclaredParam[]
    credential?: DeclaredParam
    outputs?: unknown
}

// Canvas ids are `<nodeName>_<n>`, including a name that itself contains `_`.
const NODE_ID = /^[A-Za-z][A-Za-z0-9_]*_\d+$/
const NODE_TYPES = new Set(['customNode', 'stickyNote', 'agentFlow', 'iteration'])

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const plainCopy = <T>(value: T): T | undefined => {
    try {
        return JSON.parse(JSON.stringify(value)) as T
    } catch {
        return undefined
    }
}

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

const stringList = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const items = value.filter((item): item is string => typeof item === 'string')
    return items.length ? items : undefined
}

/** id, a known canvas type, and finite position, width, and height. Every other field is left out. */
const shellOf = (node: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (typeof node.id !== 'string' || !NODE_ID.test(node.id)) return undefined
    const shell: Record<string, unknown> = { id: node.id }
    if (typeof node.type === 'string' && NODE_TYPES.has(node.type)) shell.type = node.type
    const position = asRecord(node.position)
    if (position && finiteNumber(position.x) && finiteNumber(position.y)) shell.position = { x: position.x, y: position.y }
    if (finiteNumber(node.width)) shell.width = node.width
    if (finiteNumber(node.height)) shell.height = node.height
    return shell
}

const componentParts = (component: TemplateComponent): { params: DeclaredParam[]; anchors: DeclaredParam[] } => {
    if (Array.isArray(component.inputs) || (component.credential && typeof component.credential === 'object')) {
        const params: DeclaredParam[] = []
        const anchors: { name?: string }[] = []
        if (component.credential && typeof component.credential === 'object') params.push(component.credential)
        for (const input of component.inputs ?? []) {
            if (!input || typeof input !== 'object') continue
            const type = typeof input.type === 'string' ? input.type : ''
            if (PARAM_TYPES.has(type)) params.push(input)
            else anchors.push(input)
        }
        return { params, anchors }
    }
    return {
        params: Array.isArray(component.inputParams) ? component.inputParams : [],
        anchors: Array.isArray(component.inputAnchors) ? component.inputAnchors : []
    }
}

const withInputId = (item: DeclaredParam, nodeId: string): Record<string, unknown> => {
    const copy = (plainCopy(item) ?? {}) as Record<string, unknown>
    const name = typeof copy.name === 'string' ? copy.name : ''
    const type = typeof copy.type === 'string' ? copy.type : ''
    if (name) copy.id = `${nodeId}-input-${name}-${type}`
    return copy
}

const outputValueMap = (component: TemplateComponent, anchors: Array<Record<string, unknown>>): Record<string, string> => {
    if (component.hideOutput || !Array.isArray(component.outputs)) return {}
    const values: Record<string, string> = {}
    for (const anchor of anchors) {
        const name = typeof anchor.name === 'string' ? anchor.name : ''
        if (!name) continue
        const fallback = anchor.default
        values[name] = typeof fallback === 'string' && fallback ? fallback : ''
    }
    return values
}

const classList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []

const isAgentFlowComponent = (component: TemplateComponent): boolean => component.category === 'Agent Flows'

const outputAnchorList = (component: TemplateComponent, nodeId: string): Array<Record<string, unknown>> => {
    if (component.hideOutput) return []
    const outputs = Array.isArray(component.outputs) ? component.outputs : []
    const name = textOf(component.name) || 'output'
    const label = textOf(component.label) || name
    if (isAgentFlowComponent(component)) {
        if (outputs.length) return outputs.map((_, index) => ({ id: `${nodeId}-output-${index}`, label, name }))
        return [{ id: `${nodeId}-output-${name}`, label, name }]
    }
    if (outputs.length) {
        const options = outputs.map((output) => {
            const item = asRecord(output) ?? {}
            const classes = classList(item.baseClasses)
            const outputName = textOf(item.name) || 'output'
            const suffix = classes.length > 1 ? classes.join('|') : classes[0] || ''
            const type = classes.length > 1 ? classes.join(' | ') : classes[0] || textOf(item.type) || ''
            const option: Record<string, unknown> = {
                id: `${nodeId}-output-${outputName}-${suffix}`,
                name: outputName,
                label: textOf(item.label) || outputName,
                description: textOf(item.description) || '',
                type
            }
            if (typeof item.isAnchor === 'boolean') option.isAnchor = item.isAnchor
            if (typeof item.hidden === 'boolean') option.hidden = item.hidden
            return option
        })
        const first = asRecord(outputs[0])
        return [
            {
                name: 'output',
                label: 'Output',
                type: 'options',
                description: textOf(first?.description) || '',
                options,
                default: textOf(first?.name) || ''
            }
        ]
    }
    const classes = classList(component.baseClasses)
    return [
        {
            id: `${nodeId}-output-${name}-${classes.join('|')}`,
            name,
            label: textOf(component.type) || name,
            description: textOf(component.description) || '',
            type: classes.join(' | ')
        }
    ]
}

const outputHandleIds = (anchors: Array<Record<string, unknown>>): Set<string> => {
    const ids = new Set<string>()
    for (const anchor of anchors) {
        if (typeof anchor.id === 'string' && anchor.id) ids.add(anchor.id)
        if (!Array.isArray(anchor.options)) continue
        for (const option of anchor.options) {
            const item = asRecord(option)
            if (typeof item?.id === 'string' && item.id) ids.add(item.id)
        }
    }
    return ids
}

const inputHandleIds = (
    component: TemplateComponent,
    nodeId: string,
    params: DeclaredParam[],
    anchors: { name?: string; type?: string }[]
): Set<string> => {
    const ids = new Set<string>()
    for (const item of [...params, ...anchors]) {
        const name = typeof item?.name === 'string' ? item.name : ''
        if (!name) continue
        const type = typeof item?.type === 'string' ? item.type : ''
        ids.add(`${nodeId}-input-${name}-${type}`)
    }
    if (isAgentFlowComponent(component)) ids.add(nodeId)
    return ids
}

const EDGE_TYPES = new Set(['buttonedge', 'agentFlow'])
const PLAIN_EDGE = /^[A-Za-z0-9_.:| -]{1,1000}$/

// Connection ids are long structured strings, so the character set and token prefixes are checked.
const plainEdgeString = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= 1000 && PLAIN_EDGE.test(value) && !patternFails(value)

const emptyHandles = (): { outputs: Set<string>; inputs: Set<string> } => ({ outputs: new Set(), inputs: new Set() })

const rebuildEdges = (edges: unknown[], handles: Map<string, { outputs: Set<string>; inputs: Set<string> }>): unknown[] => {
    const out: unknown[] = []
    for (const edge of edges) {
        if (!edge || typeof edge !== 'object' || Array.isArray(edge)) continue
        const current = edge as Record<string, unknown>
        if (!plainEdgeString(current.id) || !plainEdgeString(current.type) || !EDGE_TYPES.has(current.type)) continue
        if (typeof current.source !== 'string' || typeof current.target !== 'string') continue
        if (typeof current.sourceHandle !== 'string' || typeof current.targetHandle !== 'string') continue
        const source = handles.get(current.source)
        const target = handles.get(current.target)
        if (!source || !target) continue
        if (!source.outputs.has(current.sourceHandle) || !target.inputs.has(current.targetHandle)) continue
        out.push({
            id: current.id,
            source: current.source,
            target: current.target,
            sourceHandle: current.sourceHandle,
            targetHandle: current.targetHandle,
            type: current.type
        })
    }
    return out
}

const credentialDropped = (data: Record<string, unknown>): boolean => {
    if (typeof data.credential === 'string' && data.credential) return true
    return Boolean(data.credential && typeof data.credential === 'object')
}

const asComponent = (value: unknown): TemplateComponent | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as TemplateComponent
}

/** A saved flow reduced to template fields, plus the nodes whose settings were left out. */
export const buildTemplateFlow = (
    flowData: { nodes?: unknown; edges?: unknown } | null | undefined,
    componentNodes?: Record<string, unknown> | null
): TemplateFlow => {
    const sourceNodes = Array.isArray(flowData?.nodes) ? flowData.nodes : []
    const sourceEdges = Array.isArray(flowData?.edges) ? flowData.edges : []
    const droppedSettings: DroppedNodeSettings[] = []
    const nodeIds = new Set<string>()
    const handles = new Map<string, { outputs: Set<string>; inputs: Set<string> }>()
    for (const node of sourceNodes) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) continue
        const current = node as Record<string, unknown>
        if (typeof current.id === 'string' && NODE_ID.test(current.id)) nodeIds.add(current.id)
    }
    const nodes: unknown[] = []
    for (const node of sourceNodes) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            droppedSettings.push({ nodeId: '', label: 'node', inputs: ['node'] })
            continue
        }
        const current = node as Record<string, unknown>
        const shell = shellOf(current)
        if (!shell) {
            droppedSettings.push({ nodeId: '', label: 'node', inputs: ['node'] })
            continue
        }
        const data = asRecord(current.data)
        const nodeId = String(shell.id)
        if (!data) {
            handles.set(nodeId, emptyHandles())
            nodes.push(shell)
            continue
        }
        const nodeName = typeof data.name === 'string' ? data.name : ''
        const component = asComponent(nodeName && componentNodes ? componentNodes[nodeName] : undefined)
        const inputs = asRecord(data.inputs)
        if (!component) {
            const dropped = inputs ? Object.keys(inputs).filter((name) => !isBlank(inputs[name])) : []
            if (credentialDropped(data)) dropped.push('credential')
            droppedSettings.push({ nodeId, label: nodeId, inputs: dropped })
            handles.set(nodeId, emptyHandles())
            nodes.push({ ...shell, data: { id: nodeId, selected: false, inputs: {} } })
            continue
        }
        const { params, anchors } = componentParts(component)
        const builtOutputs = outputAnchorList(component, nodeId)
        handles.set(nodeId, {
            outputs: outputHandleIds(builtOutputs),
            inputs: inputHandleIds(component, nodeId, params, anchors)
        })
        const sanitized = sanitizeNodeInputs(inputs, params, anchors, nodeIds)
        const dropped = [...sanitized.dropped]
        if (credentialDropped(data)) dropped.push('credential')
        const label = textOf(component.label) || textOf(component.name) || nodeId
        if (dropped.length) droppedSettings.push({ nodeId, label, inputs: dropped })
        const nextData: Record<string, unknown> = {
            id: nodeId,
            name: textOf(component.name) || nodeName,
            selected: false,
            inputParams: params.map((item) => withInputId(item, nodeId)),
            inputAnchors: anchors.map((item) => withInputId(item, nodeId)),
            inputs: sanitized.inputs,
            outputAnchors: builtOutputs,
            outputs: outputValueMap(component, builtOutputs)
        }
        const labelText = textOf(component.label)
        if (labelText) nextData.label = labelText
        const description = textOf(component.description)
        if (description) nextData.description = description
        const category = textOf(component.category)
        if (category) nextData.category = category
        const tags = stringList(component.tags)
        if (tags) nextData.tags = tags
        if (typeof component.version === 'number' && Number.isFinite(component.version)) nextData.version = component.version
        if (typeof component.type === 'string') nextData.type = component.type
        if (typeof component.color === 'string') nextData.color = component.color
        if (typeof component.hideOutput === 'boolean') nextData.hideOutput = component.hideOutput
        if (typeof component.hideInput === 'boolean') nextData.hideInput = component.hideInput
        const baseClasses = stringList(component.baseClasses)
        if (baseClasses) nextData.baseClasses = baseClasses
        nodes.push({ ...shell, data: nextData })
    }
    return { nodes, edges: rebuildEdges(sourceEdges, handles), droppedSettings }
}

const displayText = (value: unknown, field: string): string | undefined => {
    if (typeof value !== 'string') return undefined
    const limit = TEXT_LIMITS[field]
    // Length is decided before any other work. Display fields stay shorter than template text.
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
