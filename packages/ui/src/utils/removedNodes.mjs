// Keep this list the same as REMOVED_NODE_NAMES in packages/server/src/utils/nodePacks.ts.
// These configuration-only cards had no anchors, so a saved flow can only hold them as loose cards.
export const REMOVED_NODE_NAMES = new Set(['arize', 'langFuse', 'langSmith', 'LangWatch', 'lunary', 'opik', 'phoenix', 'assemblyAI'])

export const isRemovedNode = (node) => REMOVED_NODE_NAMES.has(node?.data?.name ?? '')

export function withoutRemovedNodes(nodes, edges) {
    const list = Array.isArray(nodes) ? nodes : []
    const links = Array.isArray(edges) ? edges : []
    const removed = new Set(list.filter(isRemovedNode).map((node) => node.id))
    if (!removed.size) return { nodes: list, edges: links }
    return {
        nodes: list.filter((node) => !removed.has(node.id)),
        edges: links.filter((edge) => !removed.has(edge?.source) && !removed.has(edge?.target))
    }
}
