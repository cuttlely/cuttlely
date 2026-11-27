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

function plainSourceMetadata(value) {
    if (value === undefined || value === '') return true
    let metadata = value
    if (typeof metadata === 'string') {
        if (metadata.length > 512) return false
        try {
            metadata = JSON.parse(metadata)
        } catch {
            return false
        }
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
    return (
        Object.keys(metadata).length === 1 &&
        Object.hasOwn(metadata, 'source') &&
        typeof metadata.source === 'string' &&
        /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,127}$/u.test(metadata.source)
    )
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
            document: { type: 'plainText', output: 'document', inputs: ['text', 'metadata'] },
            embeddings: { type: 'localHashEmbeddings', inputs: ['dimensions'] }
        }
    }
    return documents.every(
        (document) =>
            !hasCredential(document) &&
            plainSourceMetadata(document.inputs.metadata) &&
            matches({ ...binding, upstream: { ...upstream, document } }, shape)
    )
}

// This saved retrieval card returns its own formatted text, including the document's source label.
export function localTextRetrieverBinding(binding) {
    if (binding?.nodeName !== 'customRetriever' || binding.nodeData || binding.credential || binding.outputs?.output !== 'text')
        return false
    const inputs = binding.inputs || {}
    if (Object.keys(inputs).some((key) => !['query', 'resultFormat', 'topK'].includes(key))) return false
    if (inputs.resultFormat !== '{{context}}\nSource: {{metadata.source}}') return false
    if (inputs.query != null && (typeof inputs.query !== 'string' || inputs.query.length > 4096 || /{{|}}/.test(inputs.query))) return false
    const topK = inputs.topK
    if (topK != null && topK !== '') {
        if (!['number', 'string'].includes(typeof topK) || !/^[1-9][0-9]?$/.test(String(topK)) || Number(topK) > 64) return false
    }
    return Object.keys(binding.upstream || {}).length === 1 && localMemoryStoreBinding(binding.upstream.vectorStore, 'vectorStore')
}

export function supportsNativeCanvasBinding(binding) {
    if (binding?.nodeName === 'customRetriever') return localTextRetrieverBinding(binding)
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
