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
// once. A second read of the store still has the pre-delete cards. A cleanup failure must not skip the removal.
export function canvasAfterDelete({ nodes, edges, nodeIds = [], edgeIds = [] } = {}) {
    const nodeList = Array.isArray(nodes) ? nodes : []
    const edgeList = Array.isArray(edges) ? edges : []
    const removeNodes = collectRemovedNodeIds(nodeList, nodeIds)
    const removeEdges = new Set((edgeIds || []).filter((id) => id != null))
    const mentionIds = new Set(removeNodes)
    for (const edge of edgeList) {
        if (edge && removeEdges.has(edge.id) && edge.source) mentionIds.add(edge.source)
    }
    let nextNodes = nodeList
    try {
        nextNodes = stripMentions(nodeList, mentionIds)
    } catch {
        nextNodes = nodeList
    }
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

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// {{id}} and {{id.<anything>}}, including {{id.data.instance}}. A longer id such as promptTemplate_10 does not match.
function mentionsRemovedId(label, id) {
    if (typeof label !== 'string' || !id) return false
    return label === id || label.startsWith(`${id}.`)
}

function stripTokens(text, ids) {
    if (typeof text !== 'string') return text
    let next = text
    for (const id of ids) {
        if (!id) continue
        const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(id)}(?:\\.[^{}]*)?\\s*\\}\\}`, 'g')
        next = next.replace(pattern, '')
    }
    return next
}

function isRemovedMention(value, ids) {
    if (!value || typeof value !== 'object' || value.type !== 'mention') return false
    const label = value.attrs?.id ?? value.attrs?.label
    return [...ids].some((id) => mentionsRemovedId(String(label ?? ''), id))
}

// Strings, lists, and nested rich-text JSON. Never throws, and never creates an "undefined" field.
function stripValue(value, ids) {
    if (typeof value === 'string') {
        const trimmed = value.trim()
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                const parsed = JSON.parse(value)
                if (parsed && typeof parsed === 'object') return JSON.stringify(stripValue(parsed, ids))
            } catch {
                // The text is not JSON. Fall through to the token replace.
            }
        }
        return stripTokens(value, ids)
    }
    if (Array.isArray(value)) {
        const next = []
        for (const item of value) {
            if (isRemovedMention(item, ids)) continue
            const cleaned = stripValue(item, ids)
            if (typeof item === 'string' && typeof cleaned === 'string' && cleaned === '' && item !== '') continue
            next.push(cleaned)
        }
        return next
    }
    if (!value || typeof value !== 'object') return value
    if (isRemovedMention(value, ids)) return undefined
    const next = {}
    for (const [key, child] of Object.entries(value)) {
        if (key === 'undefined') continue
        try {
            const cleaned = stripValue(child, ids)
            if (cleaned === undefined && isRemovedMention(child, ids)) continue
            next[key] = cleaned
        } catch {
            next[key] = child
        }
    }
    return next
}

function stripMentions(nodes, ids) {
    const idList = [...ids].filter((id) => id != null && id !== '')
    if (!idList.length) return nodes
    return (nodes || []).map((node) => {
        if (!node?.data || !node.data.inputs || typeof node.data.inputs !== 'object') return node
        try {
            return { ...node, data: { ...node.data, inputs: stripValue(node.data.inputs, idList) } }
        } catch {
            return node
        }
    })
}

// Drop every whole mention of a removed card from every remaining card. Workflow lines use the node id as the
// handle, and the text is {{nodeId}} or {{nodeId.output...}}. Chatflow, harness, and pipeline text is
// {{nodeId.data.instance}}. The field is never taken from split('-')[2].
export function nodesAfterConnectedDelete(nodes, edges, id, type) {
    const list = Array.isArray(nodes) ? nodes : []
    const ids = new Set()
    if (type === 'node' && id != null) ids.add(id)
    else {
        for (const edge of edges || []) {
            if (edge && edge.id === id && edge.source) ids.add(edge.source)
        }
    }
    try {
        return stripMentions(list, ids)
    } catch {
        return list
    }
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
