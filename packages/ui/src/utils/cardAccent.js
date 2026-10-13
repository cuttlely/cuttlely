import PropTypes from 'prop-types'
import { alpha, darken, lighten } from '@mui/material/styles'

// A component colour wins. Otherwise the category picks a hue that sits with the violet theme.
// Similar kinds share a family: language cards are violet, documents are green, tools are warm.
export const NEUTRAL_CARD_ACCENT = '#6B6578'

export const CATEGORY_CARD_ACCENTS = {
    'Agent Flows': '#4DD0E1',
    Agents: '#9333EA',
    Analytic: '#6366F1',
    Cache: '#CA8A04',
    Chains: '#6D4AFF',
    'Chat Models': '#6A3DF2',
    'Document Loaders': '#0F766E',
    Embeddings: '#2563EB',
    ETL: '#0F9F6E',
    Graph: '#0284C7',
    Harness: '#5E43E0',
    LLMs: '#7C4DFF',
    Memory: '#C2410C',
    Moderation: '#F43F5E',
    'Multi Agents': '#A855F7',
    'Output Parsers': '#7A5AF8',
    Prompts: '#8B5CF6',
    'Record Manager': '#059669',
    Retrievers: '#0891B2',
    'Sequential Agents': '#9D4EDD',
    SpeechToText: '#0EA5E9',
    'Text Splitters': '#0D9488',
    Tools: '#EA580C',
    'Tools (MCP)': '#D97706',
    Utilities: '#64748B',
    'Vector Stores': '#3B82F6'
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

// Real node icons are pictures. A white disc inside the accent ring keeps them readable in both themes.
export function CardAccentIcon({ name, color, src, size = 40 }) {
    const inner = size - 6
    return (
        <div
            data-testid='card-accent-icon'
            data-accent={color}
            style={{
                width: size,
                height: size,
                borderRadius: '50%',
                backgroundColor: color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'grab',
                flexShrink: 0
            }}
        >
            <div
                style={{
                    width: inner,
                    height: inner,
                    borderRadius: '50%',
                    backgroundColor: '#ffffff',
                    overflow: 'hidden'
                }}
            >
                <img style={{ width: '100%', height: '100%', padding: 4, objectFit: 'contain' }} src={src} alt={name || 'Node'} />
            </div>
        </div>
    )
}

CardAccentIcon.propTypes = {
    name: PropTypes.string,
    color: PropTypes.string.isRequired,
    src: PropTypes.string.isRequired,
    size: PropTypes.number
}
