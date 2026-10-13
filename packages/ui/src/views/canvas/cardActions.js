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

// The panel always has a close control. Duplicate and Delete match the card, and stay off when the canvas is read-only.
export function panelHeaderActions({ nodeName, readOnly = false } = {}) {
    return {
        duplicate: !readOnly && nodeName !== START_CARD_NAME,
        delete: !readOnly,
        close: true
    }
}
