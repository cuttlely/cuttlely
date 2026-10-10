jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: {
        publish: jest.fn(),
        discardDraft: jest.fn(),
        getCheckSetup: jest.fn(),
        startCheck: jest.fn(),
        getCheck: jest.fn(),
        stopCheck: jest.fn()
    }
}))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { PublishChangeList } from './PublishDialog'

describe('PublishChangeList', () => {
    const html = (lines) =>
        renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, createElement(PublishChangeList, { lines })))

    test('lists each change and the empty state', () => {
        const withChanges = html([
            { status: 'added', text: 'Added Calculator' },
            { status: 'changed', text: 'Changed Conversation Chain: system message prompt' }
        ])
        expect(withChanges).toContain('Added Calculator')
        expect(withChanges).toContain('Changed Conversation Chain: system message prompt')
        expect(withChanges).toContain('data-testid="publish-diff"')
        expect(html([])).toContain('No changes to publish.')
    })
})
