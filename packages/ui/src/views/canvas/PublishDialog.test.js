/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: {
        publish: jest.fn(),
        discardDraft: jest.fn(),
        getCheckSetup: jest.fn(),
        startCheck: jest.fn(),
        getCheck: jest.fn(),
        stopCheck: jest.fn(),
        getStatus: jest.fn()
    }
}))
jest.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ hasPermission: () => false })
}))
jest.mock('@/api/dataset', () => ({ __esModule: true, default: { getAllDatasets: jest.fn() } }))
jest.mock('@/api/evaluators', () => ({ __esModule: true, default: { getAllEvaluators: jest.fn() } }))
jest.mock('@/hooks/useConfirm', () => ({
    __esModule: true,
    default: () => ({ confirm: jest.fn() })
}))
jest.mock('react-redux', () => ({
    useDispatch: () => jest.fn()
}))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import flowDraftsApi from '@/api/flowDrafts'
import PublishDialog, { PublishChangeList, PublishGateNotice } from './PublishDialog'

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

const canvas = (startInputType, reply) =>
    JSON.stringify({
        nodes: [
            {
                id: 'startAgentflow_0',
                data: { name: 'startAgentflow', label: 'Start', inputs: { startInputType } }
            },
            {
                id: 'directReplyAgentflow_0',
                data: { name: 'directReplyAgentflow', label: reply, inputs: { directReplyMessage: 'The rye is in the oven.' } }
            }
        ],
        edges: []
    })

describe('PublishDialog while the check setup is still pending', () => {
    afterEach(() => {
        flowDraftsApi.getCheckSetup.mockReset()
        flowDraftsApi.getStatus.mockReset()
        document.body.innerHTML = ''
    })

    const open = async (start) => {
        flowDraftsApi.getCheckSetup.mockImplementation(() => new Promise(() => {}))
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(PublishDialog, {
                        open: true,
                        chatflow: { id: 'flow-1', type: 'AGENTFLOW', name: 'Order webhook', flowData: canvas(start, 'Reply') },
                        draftStatus: { draft: { flowData: canvas(start, 'Oven reply') } },
                        isDirty: false,
                        onClose: () => {},
                        onDraftStatus: () => {},
                        onChatflowUpdated: () => {},
                        onApplyCanvas: () => {}
                    })
                )
            )
        })
        return root
    }

    test('a webhook canvas says runs before setup returns', async () => {
        const root = await open('webhookTrigger')
        expect(flowDraftsApi.getCheckSetup).toHaveBeenCalledWith('flow-1')
        expect(document.body.textContent).toContain('Check recent runs')
        expect(document.body.textContent).toContain('Loading recent runs…')
        expect(document.body.textContent).not.toContain('Check recent questions')
        expect(document.body.textContent).not.toContain('Loading recent questions…')
        act(() => root.unmount())
    })

    test('a chat canvas says questions before setup returns', async () => {
        const root = await open('chatInput')
        expect(flowDraftsApi.getCheckSetup).toHaveBeenCalledWith('flow-1')
        expect(document.body.textContent).toContain('Check recent questions')
        expect(document.body.textContent).toContain('Loading recent questions…')
        expect(document.body.textContent).not.toContain('Check recent runs')
        expect(document.body.textContent).not.toContain('Loading recent runs…')
        act(() => root.unmount())
    })

    test('opening the dialog loads the draft, including a gate block', async () => {
        const reason = 'The test set has changed since that check.'
        const onDraftStatus = jest.fn()
        flowDraftsApi.getStatus.mockResolvedValue({
            data: {
                publishGate: {
                    enabled: true,
                    block: reason,
                    result: { passRate: 100, verdict: 'passed', passed: 1, failed: 0, errored: 0 }
                }
            }
        })
        flowDraftsApi.getCheckSetup.mockImplementation(() => new Promise(() => {}))
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(PublishDialog, {
                        open: true,
                        chatflow: { id: 'flow-1', type: 'CHATFLOW', name: 'Bakery helper', flowData: canvas('chatInput', 'Reply') },
                        draftStatus: {
                            draft: { flowData: canvas('chatInput', 'Oven reply') },
                            publishGate: { enabled: true, block: null }
                        },
                        isDirty: false,
                        onClose: () => {},
                        onDraftStatus,
                        onChatflowUpdated: () => {},
                        onApplyCanvas: () => {}
                    })
                )
            )
        })
        expect(flowDraftsApi.getStatus).toHaveBeenCalledWith('flow-1')
        expect(onDraftStatus).toHaveBeenCalledWith(expect.objectContaining({ publishGate: expect.objectContaining({ block: reason }) }))
        act(() => root.unmount())
    })
})
