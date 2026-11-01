// Width of the card settings panel. The saved value is a display preference only; nothing about the flow changes.
export const PANEL_WIDTH_KEY = 'cuttlely.nodePanelWidth'
export const PANEL_DEFAULT_WIDTH = 480
export const PANEL_MIN_WIDTH = 360
export const PANEL_MAX_WIDTH = 1100
// Room left for the canvas when the panel is dragged wide or expanded.
export const CANVAS_MIN_WIDTH = 240
export const PANEL_KEY_STEP = 32

export function panelWidthKey(userId) {
    const id = typeof userId === 'string' || typeof userId === 'number' ? String(userId).trim() : ''
    return id ? `${PANEL_WIDTH_KEY}:${id}` : PANEL_WIDTH_KEY
}

// The widest the panel can be in a window this wide, never below the minimum.
export function panelMaxFor(viewportWidth) {
    const room = Number(viewportWidth)
    if (!Number.isFinite(room) || room <= 0) return PANEL_MAX_WIDTH
    return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.floor(room - CANVAS_MIN_WIDTH)))
}

export function clampPanelWidth(value, viewportWidth) {
    const width = Number(value)
    if (!Number.isFinite(width)) return Math.min(PANEL_DEFAULT_WIDTH, panelMaxFor(viewportWidth))
    return Math.round(Math.min(Math.max(width, PANEL_MIN_WIDTH), panelMaxFor(viewportWidth)))
}

// A missing, unreadable, or nonsense value falls back to the default width.
export function readPanelWidth(storage, key = PANEL_WIDTH_KEY) {
    let raw = null
    try {
        raw = storage?.getItem?.(key) ?? null
    } catch {
        return PANEL_DEFAULT_WIDTH
    }
    if (typeof raw !== 'string' || !/^\s*\d{1,5}(\.\d+)?\s*$/.test(raw)) return PANEL_DEFAULT_WIDTH
    const width = Number(raw)
    if (!Number.isFinite(width) || width <= 0) return PANEL_DEFAULT_WIDTH
    return Math.round(Math.min(Math.max(width, PANEL_MIN_WIDTH), PANEL_MAX_WIDTH))
}

export function savePanelWidth(storage, width, key = PANEL_WIDTH_KEY) {
    const value = Number(width)
    if (!Number.isFinite(value)) return
    try {
        storage?.setItem?.(key, String(Math.round(Math.min(Math.max(value, PANEL_MIN_WIDTH), PANEL_MAX_WIDTH))))
    } catch {
        // Private windows and full storage still resize; the width is just not remembered.
    }
}

// Dragging the left edge to the left makes the panel wider.
export function widthAfterDrag(startWidth, startX, currentX, viewportWidth) {
    return clampPanelWidth(Number(startWidth) + (Number(startX) - Number(currentX)), viewportWidth)
}

export function widthAfterKey(width, key, viewportWidth) {
    if (key === 'ArrowLeft') return clampPanelWidth(width + PANEL_KEY_STEP, viewportWidth)
    if (key === 'ArrowRight') return clampPanelWidth(width - PANEL_KEY_STEP, viewportWidth)
    if (key === 'Home') return clampPanelWidth(PANEL_MIN_WIDTH, viewportWidth)
    if (key === 'End') return panelMaxFor(viewportWidth)
    return null
}
