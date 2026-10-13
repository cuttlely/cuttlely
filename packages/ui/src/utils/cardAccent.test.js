import fs from 'fs'
import path from 'path'
import { alpha } from '@mui/material/styles'

import {
    CATEGORY_CARD_ACCENTS,
    NEUTRAL_CARD_ACCENT,
    cardAccentChrome,
    cardAccentColor,
    cardAccentSx,
    cardSecondaryText
} from './cardAccent'

const LIGHT_TEXT = '#616161'
const DARK_TEXT = '#FFFFFF'

function channel(value) {
    const scaled = value / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

function parseColor(value) {
    if (typeof value !== 'string') throw new Error(`colour was ${value}`)
    const hex = value.trim()
    if (hex.startsWith('#')) {
        const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
        return [1, 3, 5].map((index) => parseInt(full.slice(index, index + 2), 16))
    }
    const match = hex.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)/i)
    if (!match) throw new Error(`cannot read colour ${value}`)
    return [match[1], match[2], match[3], match[4]].filter((part) => part !== undefined).map(Number)
}

function luminance(value) {
    const [red, green, blue] = parseColor(value)
    return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

function contrast(foreground, background) {
    const lighter = Math.max(luminance(foreground), luminance(background))
    const darker = Math.min(luminance(foreground), luminance(background))
    return (lighter + 0.05) / (darker + 0.05)
}

function hue(value) {
    const [red, green, blue] = parseColor(value).map((part) => part / 255)
    const max = Math.max(red, green, blue)
    const min = Math.min(red, green, blue)
    const delta = max - min
    if (!delta) return 0
    let result
    if (max === red) result = ((green - blue) / delta) % 6
    else if (max === green) result = (blue - red) / delta + 2
    else result = (red - green) / delta + 4
    result *= 60
    return result < 0 ? result + 360 : result
}

function hueDistance(left, right) {
    const delta = Math.abs(hue(CATEGORY_CARD_ACCENTS[left]) - hue(CATEGORY_CARD_ACCENTS[right]))
    return Math.min(delta, 360 - delta)
}

function sourceCategories() {
    const root = path.resolve(__dirname, '../../../..')
    const found = new Set(['Output Parsers'])
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                walk(full)
                continue
            }
            if (!/\.(js|jsx|ts|tsx)$/.test(entry.name) || /\.test\.(js|jsx|ts|tsx)$/.test(entry.name)) continue
            const text = fs.readFileSync(full, 'utf8')
            for (const match of text.matchAll(/this\.category = '([^']+)'/g)) found.add(match[1])
        }
    }
    walk(path.join(root, 'packages'))
    return [...found].sort()
}

describe('card accent', () => {
    it('uses the component colour when one is set, including a short hex', () => {
        expect(cardAccentColor({ color: '#ff8fab', category: 'Chat Models' })).toBe('#FF8FAB')
        expect(cardAccentColor({ color: '  #abc  ', category: 'Tools' })).toBe('#AABBCC')
    })

    it('maps a category when the component has no colour, and uses a neutral fallback', () => {
        expect(cardAccentColor({ category: 'Chat Models' })).toBe(CATEGORY_CARD_ACCENTS['Chat Models'])
        expect(cardAccentColor({ color: '', category: 'Memory' })).toBe(CATEGORY_CARD_ACCENTS.Memory)
        expect(cardAccentColor({ color: 'not-a-colour', category: 'Prompts' })).toBe(CATEGORY_CARD_ACCENTS.Prompts)
        expect(cardAccentColor({ category: 'Something new' })).toBe(NEUTRAL_CARD_ACCENT)
        expect(cardAccentColor(undefined)).toBe(NEUTRAL_CARD_ACCENT)
    })

    it('covers every category the components declare', () => {
        const declared = sourceCategories()
        expect(declared.length).toBeGreaterThan(20)
        for (const category of declared) {
            expect(CATEGORY_CARD_ACCENTS[category]).toMatch(/^#[0-9A-F]{6}$/)
        }
    })

    it('gives neighbouring categories clearly different hues', () => {
        // Chat models and completion models share a violet. They are not placed next to each other.
        expect(hueDistance('Chat Models', 'LLMs')).toBeLessThanOrEqual(20)
        const apart = [
            ['Prompts', 'Chat Models', 60],
            ['Chat Models', 'Chains', 40],
            ['Prompts', 'Chains', 80],
            ['Memory', 'Tools', 80],
            ['Memory', 'Chains', 80],
            ['Tools', 'Agents', 40],
            ['Agents', 'Chat Models', 30],
            ['Agents', 'Prompts', 40],
            ['Agents', 'Memory', 40],
            ['Document Loaders', 'Text Splitters', 40],
            ['Text Splitters', 'Embeddings', 40],
            ['Embeddings', 'Vector Stores', 40],
            ['Vector Stores', 'Retrievers', 20],
            ['Retrievers', 'Chains', 8],
            ['Tools', 'Tools (MCP)', 12],
            ['Output Parsers', 'Memory', 20],
            ['Output Parsers', 'Chains', 60],
            ['Cache', 'Memory', 20]
        ]
        for (const [left, right, minimum] of apart) {
            expect(hueDistance(left, right)).toBeGreaterThanOrEqual(minimum)
        }
        const accents = new Set(Object.values(CATEGORY_CARD_ACCENTS))
        expect(accents.size).toBe(Object.keys(CATEGORY_CARD_ACCENTS).length)
    })

    it('uses the workflow border strengths and keeps title text at AA in both themes', () => {
        const color = CATEGORY_CARD_ACCENTS['Chat Models']
        const rest = cardAccentChrome(color, {})
        const hovered = cardAccentChrome(color, { hovered: true })
        const selected = cardAccentChrome(color, { selected: true, hovered: true })
        expect(rest.borderColor).toBe(alpha(color, 0.5))
        expect(hovered.borderColor).toBe(alpha(color, 0.8))
        expect(selected.borderColor).toBe(color)
        expect(selected.boxShadow).toBe(`0 0 0 1px ${color}`)
        expect(rest.boxShadow).toBe('none')

        const colours = [...Object.values(CATEGORY_CARD_ACCENTS), NEUTRAL_CARD_ACCENT]
        for (const accent of colours) {
            for (const dark of [false, true]) {
                for (const hoveredState of [false, true]) {
                    const chrome = cardAccentChrome(accent, { hovered: hoveredState, dark })
                    const ratio = contrast(dark ? DARK_TEXT : LIGHT_TEXT, chrome.backgroundColor)
                    expect(ratio).toBeGreaterThanOrEqual(4.5)
                }
            }
        }
        const graphHover = cardAccentChrome(CATEGORY_CARD_ACCENTS.Graph, { hovered: true })
        expect(contrast(LIGHT_TEXT, graphHover.backgroundColor)).toBeGreaterThanOrEqual(4.8)
    })

    it('keeps summary text at AA on every tint and lighter than the title in the light theme', () => {
        expect(luminance(cardSecondaryText(false))).toBeGreaterThan(luminance(LIGHT_TEXT))
        const colours = [...Object.values(CATEGORY_CARD_ACCENTS), NEUTRAL_CARD_ACCENT]
        for (const accent of colours) {
            for (const dark of [false, true]) {
                const ink = cardSecondaryText(dark)
                for (const hoveredState of [false, true]) {
                    const chrome = cardAccentChrome(accent, { hovered: hoveredState, dark })
                    expect(contrast(ink, chrome.backgroundColor)).toBeGreaterThanOrEqual(4.5)
                }
            }
        }
    })

    it('is what the chatflow, preview, and workflow cards paint with', () => {
        const root = path.resolve(__dirname, '..')
        const canvas = fs.readFileSync(path.join(root, 'views/canvas/CanvasNode.jsx'), 'utf8')
        const preview = fs.readFileSync(path.join(root, 'views/marketplaces/MarketplaceCanvasNode.jsx'), 'utf8')
        const workflow = fs.readFileSync(path.join(root, 'views/agentflowsv2/AgentFlowNode.jsx'), 'utf8')
        const note = fs.readFileSync(path.join(root, 'views/canvas/StickyNote.jsx'), 'utf8')
        for (const source of [canvas, preview]) {
            expect(source).toMatch(/cardAccentSx\(accent/)
            expect(source).toMatch(/CardAccentIcon/)
        }
        expect(fs.readFileSync(path.join(root, 'views/canvas/CompactCardBody.jsx'), 'utf8')).toMatch(/cardSecondaryText\(/)
        expect(canvas).toMatch(/cardSecondaryText\(/)
        expect(workflow).toMatch(/cardAccentColor\(data\)/)
        expect(workflow).toMatch(/cardAccentChrome\(/)
        expect(note).not.toMatch(/cardAccent/)
    })

    it('paints the hover state on the card without changing its width unless asked', () => {
        const sx = cardAccentSx('#6A3DF2', { hovered: true, dark: true, width: 260 })
        expect(sx.width).toBe(260)
        expect(sx['&&:hover'].backgroundColor).toBe(sx.backgroundColor)
        expect(cardAccentSx('#6A3DF2', {}).width).toBeUndefined()
    })
})
