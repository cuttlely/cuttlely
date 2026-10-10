const parseJson = (value) => {
    if (typeof value !== 'string') return value
    try {
        return JSON.parse(value)
    } catch {
        return null
    }
}

/** Canvas JSON the gear menu already loads: `{ nodes, edges }`, or a saved chatflow whose `flowData` holds that. */
export const flowiseCanvasJson = (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (Array.isArray(parsed.nodes)) {
        return JSON.stringify({ nodes: parsed.nodes, edges: Array.isArray(parsed.edges) ? parsed.edges : [] })
    }
    const inner = parseJson(parsed.flowData)
    if (inner && typeof inner === 'object' && Array.isArray(inner.nodes)) {
        return JSON.stringify({ nodes: inner.nodes, edges: Array.isArray(inner.edges) ? inner.edges : [] })
    }
    return null
}
