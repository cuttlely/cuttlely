import fs from 'fs'
import path from 'path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { cardActionNames, panelHeaderActions, showCardActions } from './cardActions'
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
