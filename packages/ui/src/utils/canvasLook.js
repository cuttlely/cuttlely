// Canvas look: a personal choice kept in this browser. 'panel' is the new look, the default: compact cards that show
// their connections and a short summary, and a side panel on the right that opens a card's settings when you click
// the card. 'classic' keeps every setting on the card. The server can make classic the default for people who have not
// chosen (CANVAS_CARD_LOOK=classic, sent by /api/v1/settings).
export const CANVAS_LOOK_KEY = 'cuttlely.canvasLook'
export const CANVAS_LOOK_EVENT = 'cuttlely:canvas-look'
export const CANVAS_LOOKS = ['classic', 'panel']
export const DEFAULT_CANVAS_LOOK = 'panel'

function browserStorage() {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null
    } catch {
        return null
    }
}

// The look a person gets before choosing one, from the server's CANVAS_CARD_LOOK setting.
export function serverDefaultLook(settings) {
    return settings?.CANVAS_CARD_LOOK === 'classic' ? 'classic' : DEFAULT_CANVAS_LOOK
}

export function readCanvasLook(storage = browserStorage(), fallback = DEFAULT_CANVAS_LOOK) {
    const otherwise = CANVAS_LOOKS.includes(fallback) ? fallback : DEFAULT_CANVAS_LOOK
    try {
        const saved = storage?.getItem(CANVAS_LOOK_KEY)
        return CANVAS_LOOKS.includes(saved) ? saved : otherwise
    } catch {
        return otherwise
    }
}

export function writeCanvasLook(look, storage = browserStorage(), target = typeof window !== 'undefined' ? window : null) {
    const next = CANVAS_LOOKS.includes(look) ? look : DEFAULT_CANVAS_LOOK
    try {
        storage?.setItem(CANVAS_LOOK_KEY, next)
    } catch {
        // Private mode or a full storage: the choice lasts until the page reloads.
    }
    target?.dispatchEvent?.(new CustomEvent(CANVAS_LOOK_EVENT, { detail: next }))
    return next
}

const shown = (param) => !param.hidden && param.display !== false

// The settings the side panel shows for a card: the ones the card shows, then the ones behind Additional Parameters.
export function panelSections(data) {
    const params = Array.isArray(data?.inputParams) ? data.inputParams.filter(shown) : []
    return {
        main: params.filter((param) => !param.additionalParams),
        more: params.filter((param) => param.additionalParams)
    }
}

// Settings that also take a connection keep their plug point on the card while the panel holds the field.
export function cardPlugParams(data) {
    return panelSections(data).main.filter((param) => param.acceptVariable)
}

// The card the panel is showing, or null when there is none to show (closed, deleted, or a sticky note).
export function panelNode(nodes, nodeId) {
    if (!nodeId || !Array.isArray(nodes)) return null
    const node = nodes.find((nd) => nd.id === nodeId)
    if (!node || node.type === 'stickyNote' || !node.data) return null
    return node
}

// How far to pan so a card stays in view when the side panel narrows the canvas. Returns null when it already fits.
// box is the card in flow coordinates ({ x, y, width, height }), viewport is React Flow's { x, y, zoom }, width is the canvas width in pixels.
export function panToKeepInView(box, viewport, width, margin = 40) {
    if (!box || !viewport || !(width > 0)) return null
    const zoom = viewport.zoom || 1
    const left = box.x * zoom + viewport.x
    const right = left + (box.width || 0) * zoom
    if (right <= width - margin) return null
    const shift = Math.min(right - (width - margin), Math.max(left - margin, 0))
    if (shift <= 0) return null
    return { ...viewport, x: viewport.x - shift }
}

export const isNewLook = (look) => look === 'panel'

// Row padding on compact cards (connection rows and outputs).
export const DENSE_ROW_PADDING = '6px 16px'

const SUMMARY_TYPES = new Set(['options', 'asyncOptions', 'string', 'number'])
const SUMMARY_LENGTH = 48

const summaryValue = (param, value) => {
    if (value === undefined || value === null || value === '' || typeof value === 'object') return ''
    if (param.type === 'options' && Array.isArray(param.options)) {
        const option = param.options.find((opt) => opt?.name === value)
        if (option?.label) return String(option.label)
    }
    const text = String(value).replace(/\s+/g, ' ').trim()
    return text.length > SUMMARY_LENGTH ? `${text.slice(0, SUMMARY_LENGTH - 1)}\u2026` : text
}

// What a compact card says it is set to: up to `limit` of its card fields that hold a short value, as label and value.
// Passwords, credentials, files, code and lists are never summarized.
export function cardSummary(data, limit = 3) {
    const inputs = data?.inputs || {}
    const lines = []
    for (const param of panelSections(data).main) {
        if (lines.length >= limit) break
        if (!SUMMARY_TYPES.has(param.type)) continue
        const value = summaryValue(param, inputs[param.name])
        if (value) lines.push({ name: param.name, label: param.label || param.name, value })
    }
    return lines
}
