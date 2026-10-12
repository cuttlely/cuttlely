export const NODE_REF = /^\{\{.+\.data\.instance\}\}$/

export function parseFlow(flowData) {
    if (!flowData) return { nodes: [], edges: [] }
    if (typeof flowData === 'string') return JSON.parse(flowData)
    return flowData
}

export function plainInputs(inputs = {}) {
    const out = {}
    for (const [key, value] of Object.entries(inputs || {})) {
        if (typeof value === 'string' && NODE_REF.test(value)) continue
        if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string' && NODE_REF.test(item))) continue
        if (value === undefined) continue
        out[key] = value
    }
    return out
}

// Legacy handles end at the input name. Current handles append the anchor type.
export function inputNameFromHandle(edge) {
    const handle = String(edge?.targetHandle || '')
    const marker = `${edge?.target}-input-`
    if (!handle.startsWith(marker)) return ''
    return handle.slice(marker.length).split('-')[0]
}

export function chatModelEdge(edges, nodeId) {
    return (edges || []).find((edge) => edge?.target === nodeId && inputNameFromHandle(edge) === 'chatModel')
}

export function inputNameOf(edge, sourceNode) {
    const named = inputNameFromHandle(edge)
    if (named) return named
    const category = sourceNode?.data?.category
    if (category === 'Embeddings') return 'embeddings'
    if (category === 'Text Splitters') return 'textSplitter'
    if (category === 'Record Manager') return 'recordManager'
    return 'document'
}

export function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    if (value && typeof value === 'object') {
        return `{${Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',')}}`
    }
    return JSON.stringify(value ?? null)
}
