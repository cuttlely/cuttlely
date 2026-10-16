import { REMOVED_NODE_NAMES } from './removedNodes.mjs'

// The same sentence packages/server/src/utils/nodePacks.ts returns for a prediction.
// The canvas shows it on the placeholder card. Keep the two copies the same.
// A removed configuration card gets its own sentence; the server runs the flow without it.

export function packFromIndex(packIndex, name, label) {
    const rows = Array.isArray(packIndex) ? packIndex : Array.isArray(packIndex?.nodes) ? packIndex.nodes : []
    const byName = rows.find((row) => row && row.name === name && typeof row.pack === 'string' && row.pack.trim())
    if (byName) return byName.pack.trim()
    const trimmed = typeof label === 'string' ? label.trim() : ''
    if (!trimmed) return ''
    const byLabel = rows.filter((row) => row && row.label === trimmed && typeof row.pack === 'string' && row.pack.trim())
    return byLabel.length === 1 ? byLabel[0].pack.trim() : ''
}

export function missingNodeInfo(data, componentNodes, packIndex) {
    if (!Array.isArray(componentNodes) || componentNodes.length === 0) return null
    if (!data || typeof data.name !== 'string' || !data.name) return null
    if (componentNodes.some((node) => node && node.name === data.name)) return null
    const label = typeof data.label === 'string' && data.label.trim() ? data.label : data.name
    if (REMOVED_NODE_NAMES.has(data.name)) {
        return { label, pack: '', message: `${label} was removed from Cuttlely and no longer runs. You can delete this card.` }
    }
    const saved = typeof data.nodePack === 'string' ? data.nodePack.trim() : ''
    const pack = saved || packFromIndex(packIndex, data.name, label)
    const message = pack ? `${label} is not installed. Install the ${pack} pack.` : `${label} is not installed.`
    return { label, pack, message }
}

function rememberHandle(ids, value) {
    if (typeof value === 'string' && value) ids.add(value)
}

// Target handles on the left, source handles on the right. Every saved anchor id is included, and so is any
// handle id an edge already uses, so a line into this card stays attached when something else on the canvas is saved.
export function placeholderHandles(data, edges) {
    const nodeId = data?.id
    const targets = new Set()
    const sources = new Set()
    for (const anchor of Array.isArray(data?.inputAnchors) ? data.inputAnchors : []) rememberHandle(targets, anchor?.id)
    for (const anchor of Array.isArray(data?.outputAnchors) ? data.outputAnchors : []) {
        rememberHandle(sources, anchor?.id)
        for (const option of Array.isArray(anchor?.options) ? anchor.options : []) rememberHandle(sources, option?.id)
    }
    for (const edge of Array.isArray(edges) ? edges : []) {
        if (!edge) continue
        if (edge.target === nodeId) rememberHandle(targets, edge.targetHandle)
        if (edge.source === nodeId) rememberHandle(sources, edge.sourceHandle)
    }
    return { targets: [...targets], sources: [...sources] }
}

// Empty until the node list has loaded, so an export does not treat every node as missing.
export function exportKnownNodeNames(componentNodes) {
    if (!Array.isArray(componentNodes) || componentNodes.length === 0) return undefined
    const names = []
    for (const node of componentNodes) {
        if (node && typeof node.name === 'string' && node.name) names.push(node.name)
    }
    return names.length ? names : undefined
}
