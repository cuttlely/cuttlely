import { alpha, darken, lighten } from '@mui/material/styles'

// A component colour wins. Otherwise the category picks a hue.
// Categories that commonly sit on one canvas get different hues, at a vividness close to the workflow cards,
// so a prompt, a chat model and a chain do not all read as the same violet.
export const NEUTRAL_CARD_ACCENT = '#90A4AE'

export const CATEGORY_CARD_ACCENTS = {
    'Agent Flows': '#4DD0E1',
    Agents: '#AB47BC',
    Analytic: '#EC407A',
    Cache: '#FDD835',
    Chains: '#1E88E5',
    'Chat Models': '#7C4DFF',
    'Document Loaders': '#43A047',
    Embeddings: '#5C6BC0',
    ETL: '#8BC34A',
    Graph: '#009688',
    Harness: '#E040FB',
    LLMs: '#9575CD',
    Memory: '#FF6E40',
    Moderation: '#FF8A80',
    'Multi Agents': '#7E57C2',
    'Output Parsers': '#FFB300',
    Prompts: '#FF4081',
    'Record Manager': '#A1887F',
    Retrievers: '#29B6F6',
    'Sequential Agents': '#CE93D8',
    SpeechToText: '#0277BD',
    'Text Splitters': '#C0CA33',
    Tools: '#00BCD4',
    'Tools (MCP)': '#00897B',
    Utilities: '#78909C',
    'Vector Stores': '#26A69A'
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function expandHex(value) {
    const hex = typeof value === 'string' ? value.trim() : ''
    if (!HEX.test(hex)) return ''
    if (hex.length === 4) {
        return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toUpperCase()
    }
    return hex.toUpperCase()
}

// Light-theme summary lines sit on the tint. #9e9e9e falls under 4.5:1 there.
// #626262 stays lighter than the title (#616161) and clears 4.5:1 on every tint, including hover.
// Dark theme summary text is already white, which clears 4.5:1 on the dark tints.
export const CARD_SECONDARY_TEXT_LIGHT = '#626262'
export const CARD_SECONDARY_TEXT_DARK = '#FFFFFF'

export function cardSecondaryText(dark) {
    return dark ? CARD_SECONDARY_TEXT_DARK : CARD_SECONDARY_TEXT_LIGHT
}

export function cardAccentColor(node) {
    const own = expandHex(node?.color)
    if (own) return own
    const category = typeof node?.category === 'string' ? node.category : ''
    return CATEGORY_CARD_ACCENTS[category] || NEUTRAL_CARD_ACCENT
}

// Same strengths as the workflow cards: half the colour at rest, 80% on hover, solid when selected.
// Light theme tints toward white (0.9 at rest, 0.8 on hover). Dark theme tints toward black (0.8 at rest, 0.7 on hover).
export function cardAccentChrome(color, { selected = false, hovered = false, dark = false } = {}) {
    const borderColor = selected ? color : alpha(color, hovered ? 0.8 : 0.5)
    const backgroundColor = dark ? darken(color, hovered ? 0.7 : 0.8) : lighten(color, hovered ? 0.8 : 0.9)
    return {
        borderColor,
        backgroundColor,
        boxShadow: selected ? `0 0 0 1px ${borderColor}` : 'none'
    }
}

export function cardAccentSx(color, { selected = false, hovered = false, dark = false, width } = {}) {
    const current = cardAccentChrome(color, { selected, hovered, dark })
    const hot = cardAccentChrome(color, { selected, hovered: true, dark })
    return {
        padding: 0,
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: current.borderColor,
        background: current.backgroundColor,
        backgroundColor: current.backgroundColor,
        boxShadow: current.boxShadow,
        ...(width ? { width } : {}),
        '&&:hover': {
            borderColor: hot.borderColor,
            background: hot.backgroundColor,
            backgroundColor: hot.backgroundColor,
            boxShadow: hot.boxShadow
        }
    }
}
