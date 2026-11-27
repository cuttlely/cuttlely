import { createRequire } from 'node:module'

// The node package publishes the read-only input shapes supported by the native runtime.
// Using its data export also works before the component TypeScript build has run.
const components = createRequire(new URL('../packages/components/package.json', import.meta.url))
const supported = components('@cuttlely/components/native-canvas-bindings')

function matches(binding, shape) {
    if (!binding || Array.isArray(binding) || binding.nodeData || (shape.type && binding.nodeName !== shape.type)) return false
    if (shape.credential && (typeof binding.credential !== 'string' || !binding.credential.trim())) return false
    if (shape.output && binding.outputs?.output !== shape.output) return false
    const inputs = binding.inputs || {}
    if (shape.inputs && Object.keys(inputs).some((name) => !shape.inputs.includes(name))) return false
    if (Object.entries(shape.equals || {}).some(([name, value]) => inputs[name] !== value)) return false
    if (shape.empty?.some((name) => inputs[name])) return false
    if (shape.credentialInput && inputs[shape.credentialInput] && inputs[shape.credentialInput] !== binding.credential) return false
    // A filter set by the tool must never replace a restriction on the attached source.
    if (shape.incompatibleInputs?.some((pair) => pair.every((path) => path.split('.').reduce((item, key) => item?.[key], binding))))
        return false
    const upstream = binding.upstream || {}
    const required = shape.upstream || {}
    return (
        Object.keys(upstream).every(
            (key) =>
                Object.hasOwn(required, key) ||
                (Object.hasOwn(shape.optionalUpstream || {}, key) && matches(upstream[key], shape.optionalUpstream[key]))
        ) && Object.entries(required).every(([key, child]) => matches(upstream[key], child))
    )
}

// The loader carries saved metadata into a document. URL and filename labels are not dereferenced.
// Bound the serialized data and nested key paths used by the released omit() implementation.
function plainDocumentMetadata({ metadata, omitMetadataKeys }) {
    if (
        omitMetadataKeys != null &&
        (typeof omitMetadataKeys !== 'string' ||
            omitMetadataKeys.length > 2048 ||
            /\b(?:__proto__|constructor|prototype)\b/.test(omitMetadataKeys))
    )
        return false
    if (metadata == null || metadata === '') return true
    try {
        const json = typeof metadata === 'string' ? metadata : JSON.stringify(metadata)
        if (Buffer.byteLength(json) > 16384) return false
        const parsed = JSON.parse(json)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
        const ordinary = (value, depth) => {
            if (depth > 16) return false
            return (
                value === null ||
                typeof value !== 'object' ||
                Object.entries(value).every(
                    ([key, child]) => !['__proto__', 'prototype', 'constructor'].includes(key) && ordinary(child, depth + 1)
                )
            )
        }
        return ordinary(parsed, 0)
    } catch {
        return false
    }
}

// A fresh prepared instance builds its index from the saved local documents for this turn.
// The canvas compiler represents a single list input as an array when its node metadata is available.
export function localMemoryStoreBinding(binding, output = 'retriever') {
    if (binding?.nodeName !== 'memoryVectorStore' || !['retriever', 'vectorStore'].includes(output)) return false
    const upstream = binding.upstream || {}
    const documents = Array.isArray(upstream.document) ? upstream.document : [upstream.document]
    const hasCredential = (node) => node?.credential != null && node.credential !== ''
    if (!documents.length || documents.length > 64 || hasCredential(binding) || hasCredential(upstream.embeddings)) return false
    if (documents.some((document) => typeof document?.inputs?.text !== 'string' || !document.inputs.text.length)) return false
    if (documents.reduce((size, document) => size + Buffer.byteLength(document.inputs.text), 0) > 1024 * 1024) return false
    const integerInput = (value, fallback) =>
        value == null || value === ''
            ? fallback
            : typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))
            ? Number(value)
            : NaN
    const topK = integerInput(binding.inputs?.topK, 4)
    const dimensions = integerInput(upstream.embeddings?.inputs?.dimensions, 384)
    if (!Number.isSafeInteger(topK) || topK <= 0 || topK > 64 || !Number.isSafeInteger(dimensions) || dimensions < 8 || dimensions > 4096)
        return false
    const shape = {
        output,
        inputs: ['topK'],
        upstream: {
            document: {
                type: 'plainText',
                output: 'document',
                inputs: ['text', 'metadata', 'omitMetadataKeys', 'textSplitter'],
                empty: ['textSplitter']
            },
            embeddings: { type: 'localHashEmbeddings', inputs: ['dimensions'] }
        }
    }
    return documents.every(
        (document) =>
            !hasCredential(document) &&
            plainDocumentMetadata(document.inputs) &&
            matches({ ...binding, upstream: { ...upstream, document } }, shape)
    )
}

const inheritedMetadataKeys = new Set(
    [Object, Array, String, Number, Boolean].flatMap((type) => Object.getOwnPropertyNames(type.prototype)).concat('prototype')
)
// Array and string lengths are ordinary data properties.
inheritedMetadataKeys.delete('length')

function boundedRetrieverFormat(format, store) {
    if (typeof format !== 'string' || Buffer.byteLength(format) > 4096) return false
    const contextSlots = format.split('{{context}}').length - 1
    const formatBytes = Buffer.byteLength(format)
    let remaining = 2 * 1024 * 1024
    const documents = [store.upstream.document].flat()
    for (const { inputs } of documents) {
        const text = inputs.text
        // The released node uses text as a JS replacement string. $&, dollar-backtick and dollar-quote
        // may copy parts of the format for each occurrence; bound that work before doing the replacement.
        const copies = contextSlots && (text.match(/\$[&`']/g) || []).length
        if (formatBytes + contextSlots * (Buffer.byteLength(text) + copies * Math.max(11, formatBytes)) > remaining) return false
        const expanded = format.replace(/{{context}}/g, text)
        remaining -= Buffer.byteLength(expanded)
        // The node substitutes metadata after inserting the document, including references in document text.
        const metadataBytes = Buffer.byteLength(
            typeof inputs.metadata === 'string' ? inputs.metadata : JSON.stringify(inputs.metadata || {})
        )
        for (const [, key] of expanded.matchAll(/{{metadata\.([\w.]+)}}/g)) {
            const parts = key.split('.')
            if (parts.length > 16 || parts.some((part) => !part || inheritedMetadataKeys.has(part))) return false
            remaining -= metadataBytes
            if (remaining < 0) return false
        }
    }
    return true
}

// All three released outputs share the same read-only local store. Only text and document render the saved format.
export function localCustomRetrieverBinding(binding) {
    if (
        binding?.nodeName !== 'customRetriever' ||
        binding.nodeData ||
        binding.credential ||
        !['text', 'document', 'retriever'].includes(binding.outputs?.output)
    )
        return false
    const inputs = binding.inputs || {}
    if (Object.keys(inputs).some((key) => !['query', 'resultFormat', 'topK'].includes(key))) return false
    if (inputs.query != null && (typeof inputs.query !== 'string' || inputs.query.length > 4096 || /{{|}}/.test(inputs.query))) return false
    const topK = inputs.topK
    if (topK != null && topK !== '') {
        if (!['number', 'string'].includes(typeof topK) || !/^[1-9][0-9]?$/.test(String(topK)) || Number(topK) > 64) return false
    }
    const store = binding.upstream?.vectorStore
    return (
        Object.keys(binding.upstream || {}).length === 1 &&
        localMemoryStoreBinding(store, 'vectorStore') &&
        (binding.outputs.output === 'retriever' || boundedRetrieverFormat(inputs.resultFormat, store))
    )
}

// This saved GET card selects a fixed public endpoint. Its released schema lets the model add query parameters.
function publicGetBinding(binding) {
    if (binding.credential || !matches(binding, supported.requestsGet)) return false
    const { requestsGetUrl: url, requestsGetMaxOutputLength: limit } = binding.inputs || {}
    if (typeof url !== 'string' || url.length > 4096 || !/^https?:\/\//.test(url) || /[\s<>\\{}]/.test(url)) return false
    const inputs = binding.inputs
    if ([inputs.requestsGetName, inputs.requestsGetDescription].some((value) => value != null && typeof value !== 'string')) return false
    if (
        limit != null &&
        limit !== '' &&
        (!['string', 'number'].includes(typeof limit) || !/^[1-9]\d*$/.test(String(limit)) || !Number.isSafeInteger(Number(limit)))
    )
        return false
    try {
        const parsed = new URL(url)
        return !parsed.username && !parsed.password && !parsed.port && !parsed.hash
    } catch {
        return false
    }
}

export function supportsNativeCanvasBinding(binding) {
    if (binding?.nodeName === 'requestsGet') return publicGetBinding(binding)
    if (binding?.nodeName === 'customRetriever') return localCustomRetrieverBinding(binding)
    if (binding?.nodeName === 'memoryVectorStore') return localMemoryStoreBinding(binding)
    return Object.hasOwn(supported, binding?.nodeName) && matches(binding, supported[binding.nodeName])
}

export function needsNativeCanvasCredential(binding) {
    return Boolean(supported[binding?.nodeName]?.credential && (typeof binding.credential !== 'string' || !binding.credential.trim()))
}

// Preserve the released missing-credential behavior only for the plain SerpAPI tool.
// Prepared bindings with an inline credential or custom upstream still require normal preflight.
export function unboundNativeSerp(binding) {
    if (binding?.nodeName !== 'serpAPI' || (binding.credential != null && binding.credential !== '')) return false
    const nested = binding.inputs?.FLOWISE_CREDENTIAL_ID
    return (nested == null || nested === '') && matches(binding, { ...supported.serpAPI, credential: false })
}
