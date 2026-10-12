// The same sentence packages/server/src/utils/nodePacks.ts returns for a prediction.
// The canvas shows it on the placeholder card. Keep the two copies the same.

export function missingNodeInfo(data, componentNodes) {
    if (!Array.isArray(componentNodes) || componentNodes.length === 0) return null
    if (!data || typeof data.name !== 'string' || !data.name) return null
    if (componentNodes.some((node) => node && node.name === data.name)) return null
    const label = typeof data.label === 'string' && data.label.trim() ? data.label : data.name
    const pack = typeof data.nodePack === 'string' ? data.nodePack.trim() : ''
    const message = pack ? `${label} is not installed. Install the ${pack} pack.` : `${label} is not installed.`
    return { label, pack, message }
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
