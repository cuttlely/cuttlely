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

// A keyboard Delete or Backspace arrives as React Flow remove changes. Those must go through deleteNode and
// deleteEdge. Applying the remove change itself only updates the canvas list.
export function applyCanvasChanges(changes, { remove, apply } = {}) {
    const rest = []
    for (const change of changes || []) {
        if (change && change.type === 'remove') {
            if (change.id != null) remove?.(change.id)
        } else if (change) rest.push(change)
    }
    if (rest.length) apply?.(rest)
    return rest
}

// deleteNode and deleteEdge call back into this handler. Changes from that call update the list. They must not
// call delete again.
export function dispatchCanvasChanges(changes, { applying, remove, apply } = {}) {
    if (applying?.current) {
        apply?.(changes)
        return
    }
    applyCanvasChanges(changes, {
        remove: (id) => {
            if (applying) applying.current = true
            try {
                remove?.(id)
            } finally {
                if (applying) applying.current = false
            }
        },
        apply
    })
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
