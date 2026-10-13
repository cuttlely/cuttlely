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
        stopCheck: jest.fn()
    }
}))
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
import PublishDialog, { PublishChangeList } from './PublishDialog'

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
})
