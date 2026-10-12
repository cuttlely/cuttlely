import crypto from 'node:crypto'
import { freshNodeInstance, resolveInputs } from './bridge.mjs'

const CHOICE_NOTE_TAIL = 'Reply with JSON only: {"tool":"<name>","arguments":{...}} or {"answer":"<text>"}.'

// Accepts a JSON object of the tool's fields, or a single wordless string when the schema has one string field.
export function validArgs(schema, text) {
    const properties = schema?.properties || {}
    const keys = Object.keys(properties)
    const trimmed = String(text ?? '').trim()
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed)
            const required = Array.isArray(schema?.required) ? schema.required : []
            if (
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed) &&
                required.every((key) => key in parsed) &&
                Object.keys(parsed).every((key) => keys.includes(key))
            ) {
                return parsed
            }
        } catch {
            return null
        }
    }
    if (keys.length !== 1 || properties[keys[0]]?.type !== 'string') return null
    const property = properties[keys[0]]
    const args = { [keys[0]]: trimmed }
    if (Array.isArray(property.enum)) return property.enum.includes(trimmed) ? args : null
    if (typeof property.pattern === 'string') {
        try {
            return new RegExp(property.pattern).test(trimmed) ? args : null
        } catch {
            return null
        }
    }
    // Input with no words (an expression, an id, a number) leaves the model nothing to interpret.
    return trimmed && !/\p{L}/u.test(trimmed) ? args : null
}

const WORD_NUMBERS = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90
}

const NUMBER_ONES = 'one|two|three|four|five|six|seven|eight|nine'
const NUMBER_TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety'

// validArgs rejects any letter, so "What is 17 times 3?" would otherwise wait on a model fill.
// Returns an expression, or null when the question is not plain arithmetic.
export function normalizeArithmeticQuestion(text) {
    let value = String(text ?? '').trim()
    if (!value) return null
    value = value
        .replace(/[?？!！]+$/g, '')
        .replace(/[.。]+$/g, '')
        .trim()
    const prefix = /^(?:please\s+)?(?:what(?:'s|’s|\s+is|s\b)|how\s+much\s+is|calculate|compute|evaluate)\s+/i
    for (let i = 0; i < 3 && prefix.test(value); i += 1) value = value.replace(prefix, '').trim()
    value = value.replace(/\s+please$/i, '').trim()
    if (!value) return null
    value = value.replace(new RegExp(`\\b(${NUMBER_TENS})[-\\s](${NUMBER_ONES})\\b`, 'gi'), (_, tens, ones) =>
        String(WORD_NUMBERS[tens.toLowerCase()] + WORD_NUMBERS[ones.toLowerCase()])
    )
    const names = Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length)
    value = value.replace(new RegExp(`\\b(${names.join('|')})\\b`, 'gi'), (word) => String(WORD_NUMBERS[word.toLowerCase()]))
    value = value.replace(/(\d)\s+point\s+(\d+)/gi, '$1.$2')
    const phrases = [
        [/\bdivided\s+by\b/gi, '/'],
        [/\bmultiplied\s+by\b/gi, '*'],
        [/\bto\s+the\s+power\s+of\b/gi, '^'],
        [/\btimes\b/gi, '*'],
        [/\bplus\b/gi, '+'],
        [/\bminus\b/gi, '-'],
        [/\bsquared\b/gi, '^2'],
        [/\bcubed\b/gi, '^3']
    ]
    for (const [pattern, token] of phrases) value = value.replace(pattern, ` ${token} `)
    value = value.replace(/(\d)\s*[x×]\s*(?=\d)/gi, '$1 * ')
    value = value.replace(/÷/g, ' / ')
    value = value.replace(/(\d),(?=\d{3}\b)/g, '$1')
    value = value.replace(/\s+/g, ' ').trim()
    value = value
        .replace(/\s*([+*/])\s*/g, ' $1 ')
        .replace(/\s+/g, ' ')
        .trim()
    value = value.replace(/(\d)\s*\^\s*(\d+)/g, '$1^$2')
    // A leftover word, two numbers with no operator, or "* + 3" stays with the model.
    if (!/^-?\d+(?:\.\d+)?(?:\^\d+)?(?:\s*[+\-*/]\s*-?\d+(?:\.\d+)?(?:\^\d+)?)*$/.test(value)) return null
    return value
}

export function toolCallingWarning(label) {
    return `${label} has no native tool calling; this specialist will choose tools from a JSON prompt, which is less reliable.`
}

function describedTools(tools) {
    return (tools || []).map((tool) => {
        const fn = tool?.function || tool || {}
        return {
            name: String(fn.name || tool?.name || ''),
            description: String(fn.description || tool?.description || ''),
            schema: fn.parameters || tool?.parameters || tool?.schema || { type: 'object', properties: {} }
        }
    })
}

function choiceNote(tools) {
    const lines = ['You can call exactly one tool or answer directly. Tools:']
    for (const tool of describedTools(tools)) {
        lines.push(`- ${tool.name}: ${tool.description}`)
        lines.push(`  arguments JSON schema: ${JSON.stringify(tool.schema)}`)
    }
    lines.push(CHOICE_NOTE_TAIL)
    return lines.join('\n')
}

function messageText(content) {
    if (typeof content === 'string') return content
    if (content == null) return ''
    return JSON.stringify(content)
}

function withChoiceNote(messages, tools) {
    const note = choiceNote(tools)
    const copy = (messages || []).map((message) => ({ ...message }))
    const system = copy.find((message) => message.role === 'system')
    if (system) system.content = `${messageText(system.content)}\n${note}`
    else copy.unshift({ role: 'system', content: note })
    return copy
}

function firstObject(text) {
    const start = text.indexOf('{')
    if (start === -1) return null
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i]
        if (inString) {
            if (escape) escape = false
            else if (ch === '\\') escape = true
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') depth += 1
        else if (ch === '}') {
            depth -= 1
            if (depth === 0) return text.slice(start, i + 1)
        }
    }
    return null
}

function interpretChoice(content, tools) {
    const text = String(content ?? '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    const slice = firstObject(text)
    if (!slice) return { error: 'The reply was not JSON.' }
    let body
    try {
        body = JSON.parse(slice)
    } catch (error) {
        return { error: error.message || 'The reply was not JSON.' }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'The reply was not a JSON object.' }
    if (body.tool == null || body.tool === '') {
        if (body.answer == null) return { error: 'The reply needs "tool" and "arguments", or "answer".' }
        return { content: typeof body.answer === 'string' ? body.answer : JSON.stringify(body.answer), toolCalls: [] }
    }
    const described = describedTools(tools)
    const tool = described.find((item) => item.name === String(body.tool))
    if (!tool) return { error: `Unknown tool "${body.tool}".` }
    const raw = body.arguments
    const args = validArgs(tool.schema, typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}))
    if (!args) return { error: `Arguments for ${tool.name} do not match the schema.` }
    return {
        content: '',
        toolCalls: [
            {
                id: `call_${crypto.randomBytes(4).toString('hex')}`,
                function: { name: tool.name, arguments: JSON.stringify(args) }
            }
        ]
    }
}

// invoke(messages) returns { content, usage }. retries is how many times an invalid choice is sent back.
export async function fallbackToolChoice(invoke, messages, tools, { retries = 1 } = {}) {
    let prompted = withChoiceNote(messages, tools)
    let reply = await invoke(prompted)
    let parsed = interpretChoice(reply?.content, tools)
    let left = retries
    while (parsed.error && left > 0) {
        left -= 1
        prompted = [...prompted, { role: 'user', content: parsed.error }]
        reply = await invoke(prompted)
        parsed = interpretChoice(reply?.content, tools)
    }
    if (parsed.error) return { content: String(reply?.content ?? ''), toolCalls: [], usage: reply?.usage ?? null }
    return { content: parsed.content ?? '', toolCalls: parsed.toolCalls || [], usage: reply?.usage ?? null }
}

export function rejectsToolCalls(error) {
    const status = error?.status ?? error?.statusCode ?? error?.response?.status
    if (Number(status) !== 400) return false
    return /tool|function/i.test(String(error?.message || ''))
}

function specialistHasTools(specialist) {
    return (specialist?.modules || []).length > 0 || (specialist?.mcpServers || []).length > 0
}

// Save-time probe. An init failure becomes a warning and does not fail the save.
export async function toolCallingWarnings(record, ctx = {}) {
    const warnings = []
    const flowOptions = ctx.flowOptions || {}
    for (const specialist of record?.specialists || []) {
        if (!specialistHasTools(specialist)) continue
        const model = specialist.model?.nodeName ? specialist.model : record.chief?.model
        if (!model?.nodeName) continue
        const label = model.label || model.nodeName
        // filePath is how the server's node pool names the class. loadNode is the test hook.
        // Without either, freshNodeInstance scans every component file; that is not a save check.
        const canInit = Boolean(ctx.componentNodes?.[model.nodeName]?.filePath) || typeof ctx.loadNode === 'function'
        if (!canInit) continue
        try {
            const instance = await freshNodeInstance(model.nodeName, ctx)
            const nodeData = await resolveInputs(model, { ...ctx, flowOptions }, new Map(), '')
            const chat = typeof instance?.init === 'function' ? await instance.init(nodeData, '', flowOptions) : null
            if (!chat || typeof chat.bindTools !== 'function') warnings.push(toolCallingWarning(label))
        } catch (error) {
            warnings.push(String(error?.message || error || 'The chat model failed to initialize.'))
        }
    }
    return warnings
}
