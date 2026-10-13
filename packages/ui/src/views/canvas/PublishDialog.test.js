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
jest.mock('@/hooks/useConfirm', () => {
    const confirm = jest.fn()
    return { __esModule: true, default: () => ({ confirm }) }
})
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

const { confirm } = jest.requireMock('@/hooks/useConfirm').default()

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

    test('a form start with the gate already on says how to turn it off and does not offer a run', async () => {
        flowDraftsApi.getCheckSetup.mockImplementation(() => new Promise(() => {}))
        flowDraftsApi.getStatus.mockResolvedValue({
            data: { publishGate: { enabled: true, block: 'There is no result for this draft yet.' } }
        })
        const form = JSON.stringify({
            nodes: [{ id: 'start', data: { name: 'startAgentflow', inputs: { startInputType: 'formInput' } } }],
            edges: []
        })
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
                        chatflow: { id: 'flow-1', type: 'AGENTFLOW', name: 'Order form', flowData: form },
                        draftStatus: {
                            draft: { flowData: form },
                            publishGate: {
                                enabled: true,
                                block: 'Publish needs a passing test set at 100%. There is no result for this draft yet.'
                            }
                        },
                        isDirty: false,
                        onClose: () => {},
                        onDraftStatus: () => {},
                        onChatflowUpdated: () => {},
                        onApplyCanvas: () => {}
                    })
                )
            )
        })
        expect(document.body.textContent).toContain('starts with a form, so it cannot use a dataset.')
        expect(document.body.textContent).toContain('Turn off the passing test set before you publish.')
        expect(document.body.textContent).not.toContain('Run the test set')
        act(() => root.unmount())
    })
})

const graph = (label, path) =>
    JSON.stringify({
        nodes: [{ id: 'src', data: { label, inputs: { paths: path } } }],
        edges: []
    })

const clickButton = async (label) => {
    const button = [...document.body.querySelectorAll('button')].find((item) => item.textContent === label)
    expect(button).toBeTruthy()
    await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
}

const appliedCanvases = (onApplyCanvas) => onApplyCanvas.mock.calls.map((call) => call[0])

const expectOnlyReadableCanvases = (onApplyCanvas) => {
    for (const value of appliedCanvases(onApplyCanvas)) {
        expect(typeof value).toBe('string')
        expect(value.trim()).not.toBe('')
        const parsed = JSON.parse(value)
        expect(Array.isArray(parsed.nodes)).toBe(true)
        expect(Array.isArray(parsed.edges)).toBe(true)
    }
}

describe('Publish keeps Live on the stored flow', () => {
    afterEach(() => {
        flowDraftsApi.publish.mockReset()
        flowDraftsApi.discardDraft.mockReset()
        flowDraftsApi.getCheckSetup.mockReset()
        confirm.mockReset()
        document.body.innerHTML = ''
    })

    const open = async ({ type, flowData, draftFlowData }) => {
        flowDraftsApi.getCheckSetup.mockImplementation(() => new Promise(() => {}))
        const onChatflowUpdated = jest.fn()
        const onApplyCanvas = jest.fn()
        const onDraftStatus = jest.fn()
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        const chatflow = { id: 'flow-1', name: 'Upgrade catalog', type, flowData, chatbotConfig: '{}' }
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(PublishDialog, {
                        open: true,
                        chatflow,
                        draftStatus: { mode: 'draft', draft: { flowData: draftFlowData, stale: false } },
                        isDirty: false,
                        onClose: () => {},
                        onDraftStatus,
                        onChatflowUpdated,
                        onApplyCanvas
                    })
                )
            )
        })
        return { root, chatflow, onChatflowUpdated, onApplyCanvas, onDraftStatus }
    }

    test.each(['CHATFLOW', 'AGENTFLOW', 'ETL'])(
        'a %s publish stores the published canvas when the server summary omits flowData',
        async (type) => {
            const live = graph('Streaming Files', 'outdoor-catalog.csv')
            const draft = graph('Streaming Files', 'outdoor-catalog-2026.csv')
            const view = await open({ type, flowData: live, draftFlowData: draft })
            flowDraftsApi.publish.mockResolvedValue({
                data: {
                    chatflow: { id: 'flow-1', name: 'Upgrade catalog', type, updatedDate: '2026-10-13T00:00:00.000Z' },
                    status: { mode: 'draft', draft: null },
                    unchanged: false,
                    recorded: true
                }
            })
            await clickButton('Publish')
            expect(flowDraftsApi.publish).toHaveBeenCalledWith('flow-1', {})
            expect(view.onChatflowUpdated).toHaveBeenCalledTimes(1)
            const stored = view.onChatflowUpdated.mock.calls[0][0]
            expect(stored.flowData).toBe(draft)
            expect(stored.chatbotConfig).toBe('{}')
            expect(stored.type).toBe(type)
            expect(appliedCanvases(view.onApplyCanvas)).toEqual([draft])
            expectOnlyReadableCanvases(view.onApplyCanvas)
            act(() => view.root.unmount())
        }
    )

    test.each(['CHATFLOW', 'AGENTFLOW', 'ETL'])('a %s discard applies the Live canvas and never a blank one', async (type) => {
        const live = graph('Streaming Files', 'outdoor-catalog.csv')
        const draft = graph('Streaming Files', 'outdoor-catalog-2026.csv')
        confirm.mockResolvedValue(true)
        flowDraftsApi.discardDraft.mockResolvedValue({ data: { mode: 'draft', draft: null } })
        const view = await open({ type, flowData: live, draftFlowData: draft })
        await clickButton('Discard draft')
        expect(flowDraftsApi.discardDraft).toHaveBeenCalledWith('flow-1')
        expect(appliedCanvases(view.onApplyCanvas)).toEqual([live])
        expectOnlyReadableCanvases(view.onApplyCanvas)
        act(() => view.root.unmount())
    })

    test.each([
        ['missing', undefined],
        ['blank', ''],
        ['unreadable', 'not json']
    ])('discard does not apply a %s Live canvas', async (_label, flowData) => {
        confirm.mockResolvedValue(true)
        flowDraftsApi.discardDraft.mockResolvedValue({ data: { mode: 'draft', draft: null } })
        const view = await open({ type: 'ETL', flowData, draftFlowData: graph('Streaming Files', 'draft.csv') })
        await clickButton('Discard draft')
        expect(flowDraftsApi.discardDraft).toHaveBeenCalled()
        expect(view.onApplyCanvas).not.toHaveBeenCalled()
        act(() => view.root.unmount())
    })
})
