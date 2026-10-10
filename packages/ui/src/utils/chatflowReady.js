// Keep this sentence identical to the ending-node error in packages/server/src/utils/index.ts.
export const CHATFLOW_NEEDS_ENDING_NODE = 'This chatflow cannot chat yet. Add a Chain, Agent, or Engine, connect the model to it, and save.'

const ENDING_CATEGORIES = new Set(['Chains', 'Agents', 'Engine', 'Multi Agents', 'Sequential Agents', 'Harness'])

// Mirrors getEndingNodes: a chatflow can chat when at least one ending node is a Chain, Agent, or Engine.
export function chatflowCanChat(flowData) {
    let flow = flowData
    if (!flow) return false
    if (typeof flow === 'string') {
        try {
            flow = JSON.parse(flow)
        } catch {
            return true
        }
    }
    const nodes = Array.isArray(flow.nodes) ? flow.nodes : []
    const edges = Array.isArray(flow.edges) ? flow.edges : []
    if (!nodes.length) return false

    const outgoing = {}
    const incoming = {}
    for (const node of nodes) {
        outgoing[node.id] = 0
        incoming[node.id] = 0
    }
    for (const edge of edges) {
        if (outgoing[edge.source] !== undefined) outgoing[edge.source] += 1
        if (incoming[edge.target] !== undefined) incoming[edge.target] += 1
    }

    const endingIds = []
    if (nodes.length === 1) endingIds.push(nodes[0].id)
    else {
        for (const node of nodes) {
            if (!outgoing[node.id] && incoming[node.id] > 0) endingIds.push(node.id)
        }
    }
    if (!endingIds.length) return false

    return endingIds.some((id) => {
        const data = nodes.find((node) => node.id === id)?.data
        if (!data) return false
        if (data.outputs?.output === 'EndingNode') return true
        return ENDING_CATEGORIES.has(data.category)
    })
}

export function isUnchatableChatflow(chatflow) {
    if (!chatflow) return false
    if (chatflow.type && chatflow.type !== 'CHATFLOW') return false
    return !chatflowCanChat(chatflow.flowData)
}
