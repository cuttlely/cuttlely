// A template preview is not an editor. The keyboard must not delete a card, and cards are not selectable.
export const templatePreviewProps = {
    deleteKeyCode: null,
    elementsSelectable: false
}

// Backspace and Delete leave the cards when the preview props are in force.
export function cardsAfterPreviewKey(nodes, key, props = templatePreviewProps) {
    const list = Array.isArray(nodes) ? nodes : []
    if (props.deleteKeyCode == null || props.elementsSelectable === false) return list
    const allowed = Array.isArray(props.deleteKeyCode) ? props.deleteKeyCode : [props.deleteKeyCode]
    if (!allowed.includes(key)) return list
    return list.filter((node) => !node.selected)
}
