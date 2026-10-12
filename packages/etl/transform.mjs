import { splitList } from './ignore.mjs'
import { initNode } from './nodes.mjs'
import { RecordReject } from './schema.mjs'
import { repairChunkBoundaries } from './text.mjs'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function boolInput(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback
    return value === true || value === 'true'
}

function stripHtml(text) {
    return text
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code) => {
            if (code[0] === '#') {
                const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
                return Number.isFinite(n) ? String.fromCodePoint(n) : match
            }
            return ENTITIES[code.toLowerCase()] ?? match
        })
}

function normalizeWhitespace(text) {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function parseMetadata(value) {
    if (!value) return {}
    if (typeof value === 'object') return value
    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function fillTemplate(template, metadata) {
    return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_, key) => {
        const value = metadata[key]
        return value === undefined || value === null ? '' : String(value)
    })
}

function lookup(metadata, key) {
    if (Object.hasOwn(metadata, key)) return metadata[key]
    let value = metadata
    for (const part of key.split('.')) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined
        value = value[part]
    }
    return value
}

// Key template for loader sources (E8, O4): {{name}} or {name}, dotted paths allowed (loader metadata is flattened to
// dotted keys). Strict: a missing or empty value fails the record with missing_key instead of becoming ''.
export function fillKeyTemplate(template, metadata) {
    return String(template).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\{([A-Za-z0-9_.-]+)\}/g, (_, a, b) => {
        const key = a || b
        const value = lookup(metadata || {}, key)
        if (value === undefined || value === null || value === '' || typeof value === 'object')
            throw new RecordReject('missing_key', null, `the key template needs "${key}", which this document does not have`)
        return String(value)
    })
}

// The key template of the transform nearest the store (the last one that sets it), or null.
export function keyTemplateOf(specs = []) {
    let template = null
    for (const spec of specs) {
        const value = String(spec?.inputs?.keyTemplate || '').trim()
        if (value) template = value
    }
    return template
}

export function compileTransform(spec) {
    const inputs = spec?.inputs || {}
    const options = {
        unicode: boolInput(inputs.normalizeUnicode, true),
        whitespace: boolInput(inputs.normalizeWhitespace, true),
        html: boolInput(inputs.stripHtml, false),
        minChars: Number(inputs.minChars) > 0 ? Number(inputs.minChars) : 1,
        prefix: String(inputs.prefixTemplate || '').replace(/\\n/g, '\n'),
        add: parseMetadata(inputs.metadata),
        keep: splitList(inputs.keepMetadataKeys),
        omit: splitList(inputs.omitMetadataKeys)
    }
    return (doc, stats) => {
        let text = doc.pageContent || ''
        if (options.unicode) {
            const normalized = text.normalize('NFC')
            if (stats && normalized !== text) stats.nfc = (stats.nfc || 0) + 1
            text = normalized
        }
        if (options.html) text = stripHtml(text)
        if (options.whitespace) text = normalizeWhitespace(text)
        let metadata = { ...doc.metadata, ...options.add }
        if (options.keep.length) {
            metadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => options.keep.includes(key) || key === 'source'))
        }
        for (const key of options.omit) delete metadata[key]
        if (text.length < options.minChars) return null
        if (options.prefix) text = fillTemplate(options.prefix, metadata) + text
        return { ...doc, pageContent: text, metadata }
    }
}

export function compileTransforms(specs = []) {
    const steps = specs.map(compileTransform)
    return (doc, stats) => {
        let current = doc
        for (const step of steps) {
            current = step(current, stats)
            if (!current) return null
        }
        return current
    }
}

export async function createSplitter(spec, ctx) {
    if (!spec) return null
    const splitter = await initNode(spec, { ctx })
    if (!splitter || (typeof splitter.splitText !== 'function' && typeof splitter.splitDocuments !== 'function')) {
        throw new Error(`${spec.label} did not return a text splitter.`)
    }
    return splitter
}

// Flowise splitters are LangChain text splitters: splitDocuments is the path a chat flow uses, splitText is the fallback.
// Character splitters count UTF-16 units and can cut a surrogate pair in two; the boundary repair puts it back (E17).
export async function splitDoc(splitter, doc) {
    if (!splitter) return [doc.pageContent]
    if (typeof splitter.splitDocuments === 'function') {
        const parts = await splitter.splitDocuments([{ pageContent: doc.pageContent, metadata: doc.metadata || {} }])
        return repairChunkBoundaries(parts.map((part) => part.pageContent).filter((text) => text))
    }
    if (typeof splitter.splitText === 'function') return repairChunkBoundaries(await splitter.splitText(doc.pageContent))
    throw new Error('This text splitter has neither splitDocuments nor splitText.')
}
