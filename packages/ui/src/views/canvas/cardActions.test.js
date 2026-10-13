import fs from 'fs'
import path from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { actionBarSide, cardActionNames, panelHeaderActions, panelStateWhenNodesChange, showCardActions } from './cardActions'
import NodePanelHeader from './NodePanelHeader'

const theme = createTheme({
    palette: {
        text: { primary: '#ffffff' },
        background: { paper: '#1b1913', default: '#14120b' },
        divider: '#2b2923'
    }
})

describe('card action visibility', () => {
    test('shows the toolbar on hover and on the selected card, and not when the canvas is read-only', () => {
        expect(showCardActions({ hovered: true })).toBe(true)
        expect(showCardActions({ selected: true })).toBe(true)
        expect(showCardActions({ hovered: false, selected: false })).toBe(false)
        expect(showCardActions({ hovered: true, selected: true, readOnly: true })).toBe(false)
    })

    test('every card except the start card can be duplicated, and read-only canvases have no destructive actions', () => {
        expect(cardActionNames({ nodeName: 'directReplyAgentflow' })).toEqual(['duplicate', 'delete', 'info'])
        expect(cardActionNames({ nodeName: 'startAgentflow' })).toEqual(['delete', 'info'])
        expect(cardActionNames({ nodeName: 'stickyNote', includeInfo: false })).toEqual(['duplicate', 'delete'])
        expect(cardActionNames({ nodeName: 'promptTemplate', readOnly: true })).toEqual([])
    })

    test('the settings header has Duplicate, Delete, and Close, and a read-only panel keeps only Close', () => {
        expect(panelHeaderActions({ nodeName: 'promptTemplate' })).toEqual({ duplicate: true, delete: true, close: true })
        expect(panelHeaderActions({ nodeName: 'startAgentflow' })).toEqual({ duplicate: false, delete: true, close: true })
        expect(panelHeaderActions({ nodeName: 'promptTemplate', readOnly: true })).toEqual({
            duplicate: false,
            delete: false,
            close: true
        })
    })
})

describe('action bar side', () => {
    const card = { left: 400, top: 200, width: 200, right: 600, bottom: 280 }
    const bar = { width: 96, height: 32 }
    const canvas = { left: 0, top: 70, right: 1440, bottom: 900 }

    test('stays above the card when that place is on the canvas and clear of floating buttons', () => {
        expect(actionBarSide({ card, bar, canvas, overlays: [{ left: 1200, top: 90, right: 1280, bottom: 130 }] })).toBe('above')
    })

    test('moves below the card when the top of the canvas would clip it', () => {
        expect(actionBarSide({ card: { ...card, top: 74, bottom: 150 }, bar, canvas })).toBe('below')
    })

    test('moves below the card when a floating button would cover it', () => {
        const lower = { left: 500, top: 140, width: 180, right: 680, bottom: 220 }
        const button = { left: 540, top: 100, right: 620, bottom: 140 }
        expect(actionBarSide({ card: lower, bar, canvas, overlays: [button] })).toBe('below')
    })
})

describe('panel id after a card is deleted', () => {
    test('clears the open panel when its card is gone, so a reused id does not show the deleted settings', () => {
        const settings = { template: 'Hello from the deleted card' }
        const open = {
            panelNodeId: 'promptTemplate_0',
            panelProps: { data: { id: 'promptTemplate_0', inputs: settings } },
            nodes: [{ id: 'promptTemplate_0', data: { inputs: settings } }]
        }
        const deleted = panelStateWhenNodesChange({ ...open, nodes: [] })
        expect(deleted).toEqual({ panelNodeId: null, panelProps: {} })
        const reused = panelStateWhenNodesChange({
            ...deleted,
            nodes: [{ id: 'promptTemplate_0', data: { inputs: { template: '' } } }]
        })
        expect(reused.panelNodeId).toBe(null)
        expect(reused.panelProps).toEqual({})
        expect(JSON.stringify(reused)).not.toContain('Hello from the deleted card')
    })

    test('keeps the panel while its card is still on the canvas', () => {
        const state = panelStateWhenNodesChange({
            panelNodeId: 'promptTemplate_0',
            panelProps: { data: { id: 'promptTemplate_0' } },
            nodes: [{ id: 'promptTemplate_0' }]
        })
        expect(state.panelNodeId).toBe('promptTemplate_0')
    })
})

describe('settings panel header', () => {
    const header = (props) =>
        renderToStaticMarkup(createElement(ThemeProvider, { theme }, createElement(NodePanelHeader, { label: 'Reply', ...props })))

    test('renders Duplicate, Delete, and a close button that uses the theme text color', () => {
        const html = header({
            onDuplicate: () => {},
            onDelete: () => {},
            onClose: () => {}
        })
        expect(html).toContain('aria-label="Duplicate"')
        expect(html).toContain('aria-label="Delete"')
        expect(html).toContain('aria-label="Close settings"')
        expect(html).toContain('data-testid="close-settings"')
        const source = fs.readFileSync(path.join(__dirname, 'NodePanelHeader.jsx'), 'utf8')
        expect(source).toMatch(/color: 'text\.primary'/)
    })

    test('a read-only header has the close button and no Duplicate or Delete', () => {
        const html = header({ readOnly: true, nodeName: 'promptTemplate', onClose: () => {} })
        expect(html).not.toContain('aria-label="Duplicate"')
        expect(html).not.toContain('aria-label="Delete"')
        expect(html).toContain('aria-label="Close settings"')
    })

    test('the start card header has Delete and Close, and no Duplicate', () => {
        const html = header({ nodeName: 'startAgentflow', onDelete: () => {}, onClose: () => {} })
        expect(html).not.toContain('aria-label="Duplicate"')
        expect(html).toContain('aria-label="Delete"')
        expect(html).toContain('aria-label="Close settings"')
    })
})
