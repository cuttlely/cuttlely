// Which card actions are on screen. The settings panel must not hide them: people open a card and
// then look for Duplicate and Delete. A read-only canvas (a template preview, a saved version) has none.

export const START_CARD_NAME = 'startAgentflow'

export function showCardActions({ hovered = false, selected = false, readOnly = false } = {}) {
    if (readOnly) return false
    return Boolean(hovered || selected)
}

// The start card cannot be copied. Info is optional: notes have no info dialog.
export function cardActionNames({ nodeName, readOnly = false, includeInfo = true } = {}) {
    if (readOnly) return []
    const names = []
    if (nodeName !== START_CARD_NAME) names.push('duplicate')
    names.push('delete')
    if (includeInfo) names.push('info')
    return names
}

export function rectsOverlap(a, b) {
    if (!a || !b) return false
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

// Above the card, unless that place is past the top of the visible canvas or under a floating button.
// bar is the measured button row; it is centered on the card either way.
export function actionBarSide({ card, bar, canvas, overlays = [], gap = 4 } = {}) {
    if (!card || !bar || !canvas || !(bar.height > 0)) return 'above'
    const left = card.left + (card.width - bar.width) / 2
    const above = { left, right: left + bar.width, top: card.top - gap - bar.height, bottom: card.top - gap }
    const topClipped = above.top < canvas.top
    const covered = overlays.some((box) => rectsOverlap(above, box))
    if (topClipped || covered) return 'below'
    return 'above'
}

// Split a React Flow change list. Remove ids are deleted together. Every other change still goes through as itself.
export function partitionCanvasChanges(changes) {
    const removeIds = []
    const rest = []
    for (const change of changes || []) {
        if (change && change.type === 'remove') {
            if (change.id != null) removeIds.push(change.id)
        } else if (change) rest.push(change)
    }
    return { removeIds, rest }
}

// A parent and its loop children. Walk from the requested ids so a child listed first is still included.
export function collectRemovedNodeIds(nodes, nodeIds) {
    const ids = new Set((nodeIds || []).filter((id) => id != null))
    const children = new Map()
    for (const node of nodes || []) {
        if (!node?.parentNode) continue
        const list = children.get(node.parentNode) || []
        list.push(node.id)
        children.set(node.parentNode, list)
    }
    const stack = [...ids]
    while (stack.length) {
        const id = stack.pop()
        for (const child of children.get(id) || []) {
            if (ids.has(child)) continue
            ids.add(child)
            stack.push(child)
        }
    }
    return ids
}

// One next list of cards and one next list of lines. Callers must pass these arrays to setNodes and setEdges
// once. A second read of the store still has the pre-delete cards.
export function canvasAfterDelete({ nodes, edges, nodeIds = [], edgeIds = [] } = {}) {
    const nodeList = Array.isArray(nodes) ? nodes : []
    const edgeList = Array.isArray(edges) ? edges : []
    const removeNodes = collectRemovedNodeIds(nodeList, nodeIds)
    const removeEdges = new Set((edgeIds || []).filter((id) => id != null))
    let nextNodes = nodeList
    for (const id of removeNodes) nextNodes = nodesAfterConnectedDelete(nextNodes, edgeList, id, 'node')
    for (const id of removeEdges) nextNodes = nodesAfterConnectedDelete(nextNodes, edgeList, id, 'edge')
    nextNodes = nextNodes.filter((node) => node && !removeNodes.has(node.id))
    const nextEdges = edgeList.filter(
        (edge) => edge && !removeEdges.has(edge.id) && !removeNodes.has(edge.source) && !removeNodes.has(edge.target)
    )
    return { nodes: nextNodes, edges: nextEdges }
}

// Node removes and edge removes arrive in two calls. Hold them and delete once, after both have been seen.
export function createCanvasDeleteQueue(deleteBatch) {
    const applying = { current: false }
    let nodeIds = []
    let edgeIds = []
    let scheduled = false
    const flush = () => {
        scheduled = false
        const batch = { nodeIds, edgeIds }
        nodeIds = []
        edgeIds = []
        if (!batch.nodeIds.length && !batch.edgeIds.length) return
        applying.current = true
        try {
            deleteBatch(batch)
        } finally {
            applying.current = false
        }
    }
    const accept = (kind, changes, apply) => {
        if (applying.current) {
            apply?.(changes)
            return
        }
        const { removeIds, rest } = partitionCanvasChanges(changes)
        if (removeIds.length) {
            if (kind === 'node') nodeIds.push(...removeIds)
            else edgeIds.push(...removeIds)
            if (!scheduled) {
                scheduled = true
                queueMicrotask(flush)
            }
        }
        if (rest.length) apply?.(rest)
    }
    return {
        applying,
        nodes: (changes, apply) => accept('node', changes, apply),
        edges: (changes, apply) => accept('edge', changes, apply),
        flush
    }
}

// Drop {{sourceId.data.instance}} (and a list entry that names that id) from the cards a removed node or edge fed.
export function nodesAfterConnectedDelete(nodes, edges, id, type) {
    const list = Array.isArray(nodes) ? nodes : []
    const allEdges = Array.isArray(edges) ? edges : []
    const connected =
        type === 'node' ? allEdges.filter((edge) => edge && edge.source === id) : allEdges.filter((edge) => edge && edge.id === id)
    if (!connected.length) return list
    let next = list
    for (const edge of connected) {
        const targetInput = String(edge.targetHandle || '').split('-')[2]
        const sourceNodeId = edge.source
        next = next.map((node) => {
            if (!node || node.id !== edge.target) return node
            const inputAnchor = (node.data?.inputAnchors || []).find((anchor) => anchor.name === targetInput)
            const inputParam = (node.data?.inputParams || []).find((param) => param.name === targetInput)
            let value
            if (inputAnchor && inputAnchor.list) {
                const values = node.data.inputs?.[targetInput] || []
                value = values.filter((item) => !item.includes(sourceNodeId))
            } else if (inputParam && inputParam.acceptVariable) {
                value = node.data.inputs[targetInput].replace(`{{${sourceNodeId}.data.instance}}`, '') || ''
            } else {
                value = ''
            }
            return {
                ...node,
                data: {
                    ...node.data,
                    inputs: {
                        ...(node.data?.inputs || {}),
                        [targetInput]: value
                    }
                }
            }
        })
    }
    return next
}

// The open panel must not survive its card. A new card can reuse that id, and would otherwise open on the deleted settings.
export function panelStateWhenNodesChange({ panelNodeId = null, panelProps = {}, nodes } = {}) {
    if (!panelNodeId) return { panelNodeId: null, panelProps: panelProps || {} }
    const present = Array.isArray(nodes) && nodes.some((node) => node && node.id === panelNodeId)
    if (present) return { panelNodeId, panelProps: panelProps || {} }
    return { panelNodeId: null, panelProps: {} }
}

// The panel always has a close control. Duplicate and Delete match the card, and stay off when the canvas is read-only.
export function panelHeaderActions({ nodeName, readOnly = false } = {}) {
    return {
        duplicate: !readOnly && nodeName !== START_CARD_NAME,
        delete: !readOnly,
        close: true
    }
}
