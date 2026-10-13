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

// The panel always has a close control. Duplicate and Delete match the card, and stay off when the canvas is read-only.
export function panelHeaderActions({ nodeName, readOnly = false } = {}) {
    return {
        duplicate: !readOnly && nodeName !== START_CARD_NAME,
        delete: !readOnly,
        close: true
    }
}
