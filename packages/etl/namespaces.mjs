// Pinecone namespace names (docs: identifier limits). Empty means the default namespace, which ETL does not
// treat as a namespace a retriever can select. "__default__" is the API's name for that same namespace.

const RESERVED = '__default__'

export function namespaceName(value) {
    return String(value ?? '').trim()
}

// '' when the name is empty (default namespace) or valid. Otherwise the reason it cannot be created.
export function namespaceProblem(value) {
    const name = namespaceName(value)
    if (!name) return ''
    if (name === RESERVED) return 'Leave Namespace empty to use the default namespace. "__default__" is reserved.'
    if (name.length > 512 || /[^\x01-\x7F]/.test(name)) return 'A namespace name is 1–512 ASCII characters and cannot contain a NUL.'
    return ''
}

// The named namespace a saved store spec writes, or '' when the store has none (local collections, the Pinecone default).
export function storeNamespace(spec) {
    if (!spec || spec.nodeName !== 'pinecone') return ''
    return namespaceName(spec.inputs?.pineconeNamespace)
}
