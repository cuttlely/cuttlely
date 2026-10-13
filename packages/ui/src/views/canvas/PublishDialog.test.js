jest.mock('@/api/dataset', () => ({ __esModule: true, default: { getAllDatasets: jest.fn() } }))
jest.mock('@/api/evaluators', () => ({ __esModule: true, default: { getAllEvaluators: jest.fn() } }))
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => false }) }))
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

import { PublishChangeList, PublishGateNotice } from './PublishDialog'

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

describe('PublishGateNotice', () => {
    const html = (gate) =>
        renderToStaticMarkup(
            createElement(
                ThemeProvider,
                { theme: createTheme() },
                createElement(PublishGateNotice, { gate, busy: false, runAnyway: false, onRunAnyway: () => {}, onRun: () => {} })
            )
        )

    test('hides when the gate is off, and shows the block and the run button when it is on', () => {
        expect(html({ enabled: false, block: 'nope' })).toBe('')
        const blocked = html({
            enabled: true,
            block: 'Publish needs a passing test set at 100%. There is no result for this draft yet.',
            result: null
        })
        expect(blocked).toContain('Publish needs a passing test set at 100%.')
        expect(blocked).toContain('There is no result for this draft yet.')
        expect(blocked).toContain('data-testid="publish-gate-run"')
        expect(blocked).toContain('Run the test set')
        const passed = html({
            enabled: true,
            block: null,
            result: { passRate: 100, verdict: 'passed', passed: 2, failed: 0, errored: 0 }
        })
        expect(passed).toContain('This draft passed the test set.')
        expect(passed).toContain('Last result: 100% and passed')
    })
})
