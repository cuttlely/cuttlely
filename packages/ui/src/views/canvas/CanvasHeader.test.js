/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/store/constant', () => ({ uiBaseURL: 'http://localhost', baseURL: 'http://localhost' }))
jest.mock('@/hooks/useApi', () => () => ({ data: null, error: null, loading: false, request: jest.fn() }))
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => true }) }))
jest.mock('@/hooks/useConfirm', () => {
    const confirm = jest.fn()
    return { __esModule: true, default: () => ({ confirm }) }
})
jest.mock('react-redux', () => ({
    useDispatch: () => jest.fn(),
    useSelector: (selector) => selector({ canvas: { isDirty: false, componentNodes: [] }, customization: { isDarkMode: false } })
}))
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }))
jest.mock('@mui/material/useMediaQuery', () => () => false)
jest.mock('@/api/chatflows', () => ({ __esModule: true, default: {} }))
jest.mock('@/api/flowVersions', () => ({
    __esModule: true,
    default: {
        getStatus: jest.fn(() => Promise.resolve({ data: { enabled: false } })),
        listVersions: jest.fn(() => Promise.resolve({ data: { versions: [] } }))
    }
}))
jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { discardDraft: jest.fn(), publish: jest.fn() }
}))
jest.mock('@/views/settings', () => () => null)
jest.mock('@/ui-component/flow/FlowiseMigrationWizard', () => jest.fn(() => null))
jest.mock('@/views/canvas/ImportVerifyDialog', () => {
    const React = require('react')
    return function mockDialog(props) {
        return React.createElement(
            'button',
            {
                type: 'button',
                'data-testid': 'import-verify-canvas',
                onClick: () => {
                    const deliver = props.onImported
                    if (deliver) deliver('{"nodes":[{"id":"imported"}],"edges":[]}')
                }
            },
            'import'
        )
    }
})
jest.mock('@/ui-component/dialog/SaveChatflowDialog', () => () => null)
jest.mock('@/views/chatflows/APICodeDialog', () => () => null)
jest.mock('@/ui-component/dialog/ViewMessagesDialog', () => () => null)
jest.mock('@/ui-component/dialog/ViewLeadsDialog', () => () => null)
jest.mock('@/ui-component/dialog/ExportAsTemplateDialog', () => () => null)
jest.mock('@/views/vectorstore/UpsertHistoryDialog', () => () => null)
jest.mock('@/ui-component/dialog/ChatflowConfigurationDialog', () => () => null)
jest.mock('@/views/canvas/VersionHistoryDrawer', () => () => null)
jest.mock('@/views/canvas/PublishDialog', () => () => null)

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import flowDraftsApi from '@/api/flowDrafts'
import FlowiseMigrationWizard from '@/ui-component/flow/FlowiseMigrationWizard'
import CanvasHeader from './CanvasHeader'

const { confirm } = jest.requireMock('@/hooks/useConfirm').default()

const theme = createTheme({
    palette: {
        canvasHeader: {
            deployLight: '#eee',
            deployDark: '#111',
            saveLight: '#eee',
            saveDark: '#111',
            settingsLight: '#eee',
            settingsDark: '#111'
        }
    }
})

const graph = (label, path) =>
    JSON.stringify({
        nodes: [{ id: 'src', data: { label, inputs: { paths: path } } }],
        edges: []
    })

const appliedCanvases = (onApplyCanvas) => onApplyCanvas.mock.calls.map((call) => call[0])

describe('Canvas header discard', () => {
    afterEach(() => {
        flowDraftsApi.discardDraft.mockReset()
        confirm.mockReset()
        document.body.innerHTML = ''
    })

    const open = async (flowData, type = 'ETL', headerProps = {}) => {
        const onApplyCanvas = jest.fn()
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme },
                    createElement(CanvasHeader, {
                        chatflow: { id: 'flow-1', name: 'Upgrade catalog', type, flowData },
                        isAgentCanvas: type === 'AGENTFLOW',
                        isAgentflowV2: type === 'AGENTFLOW',
                        isEtlCanvas: type === 'ETL',
                        handleSaveFlow: () => {},
                        handleDeleteFlow: () => {},
                        handleLoadFlow: () => {},
                        draftStatus: {
                            mode: 'draft',
                            draft: { flowData: graph('Streaming Files', 'draft.csv'), stale: true }
                        },
                        onApplyCanvas,
                        ...headerProps
                    })
                )
            )
        })
        return { root, onApplyCanvas }
    }

    const discard = async () => {
        const button = [...document.body.querySelectorAll('button')].find((item) => item.textContent === 'Discard draft')
        expect(button).toBeTruthy()
        await act(async () => {
            button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })
    }

    test.each(['CHATFLOW', 'AGENTFLOW', 'ETL'])('a %s discard applies the Live canvas', async (type) => {
        const live = graph(type, 'outdoor-catalog.csv')
        confirm.mockResolvedValue(true)
        flowDraftsApi.discardDraft.mockResolvedValue({ data: { mode: 'draft', draft: null } })
        const view = await open(live, type)
        await discard()
        expect(appliedCanvases(view.onApplyCanvas)).toEqual([live])
        for (const value of appliedCanvases(view.onApplyCanvas)) {
            const parsed = JSON.parse(value)
            expect(Array.isArray(parsed.nodes)).toBe(true)
            expect(Array.isArray(parsed.edges)).toBe(true)
        }
        act(() => view.root.unmount())
    })

    test.each([
        ['missing', undefined],
        ['blank', ''],
        ['unreadable', 'not json']
    ])('discard does not apply a %s Live canvas', async (_label, flowData) => {
        confirm.mockResolvedValue(true)
        flowDraftsApi.discardDraft.mockResolvedValue({ data: { mode: 'draft', draft: null } })
        const view = await open(flowData)
        await discard()
        expect(flowDraftsApi.discardDraft).toHaveBeenCalledWith('flow-1')
        expect(view.onApplyCanvas).not.toHaveBeenCalled()
        act(() => view.root.unmount())
    })

    it('passes a catalog failure and retry action to the wizard', async () => {
        const retry = jest.fn()
        const view = await open(graph('Chat', 'input.txt'), 'CHATFLOW', {
            catalogLoading: false,
            catalogError: new Error('catalog unavailable'),
            onRetryCatalog: retry
        })
        const props = FlowiseMigrationWizard.mock.calls.at(-1)[0]
        expect(props.catalogPending).toBe(false)
        expect(props.catalogFailed).toBe(true)
        expect(props.onRetryCatalog).toBe(retry)
        act(() => view.root.unmount())
    })

    test('blocks name and publish writes while a canvas save is active', async () => {
        const view = await open(graph('Chat', 'input.txt'), 'CHATFLOW', { saveQueueBusy: true })
        const publish = document.body.querySelector('[data-testid="publish-button"]')
        expect(publish.disabled).toBe(true)
        expect(publish.getAttribute('title')).toBe('Save your changes first')

        const edit = document.body.querySelector('[title="Edit Name"]')
        await act(async () => edit.firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true })))
        const saveName = document.body.querySelector('[title="Saving…"]')
        expect(saveName.disabled).toBe(true)
        act(() => view.root.unmount())
    })

    test('sends an inline name through the shared lane and gives Save the current name', async () => {
        const handleSaveFlowName = jest.fn()
        const handleSaveFlow = jest.fn()
        const onChatflowUpdated = jest.fn()
        const view = await open(graph('Chat', 'input.txt'), 'CHATFLOW', { handleSaveFlowName, handleSaveFlow, onChatflowUpdated })
        const edit = document.body.querySelector('[title="Edit Name"]')
        await act(async () => edit.firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true })))
        const input = document.body.querySelector('input')
        input.value = 'Current name'
        const saveName = document.body.querySelector('[title="Save Name"]')
        await act(async () => saveName.dispatchEvent(new MouseEvent('click', { bubbles: true })))

        expect(handleSaveFlowName).toHaveBeenCalledWith('Current name', expect.objectContaining({ onAck: expect.any(Function) }))
        const saveCanvas = document.body.querySelector('[title="Save Chatflow"]')
        await act(async () => saveCanvas.firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true })))
        expect(handleSaveFlow).toHaveBeenCalledWith('Current name')
        await act(async () => handleSaveFlowName.mock.calls[0][1].onAck({ id: 'flow-1', name: 'Current name' }))
        expect(onChatflowUpdated).toHaveBeenCalledWith(expect.objectContaining({ name: 'Current name' }))
        act(() => view.root.unmount())
    })

    test('keeps an unanswered inline name for the next canvas Save', async () => {
        const handleSaveFlowName = jest.fn()
        const handleSaveFlow = jest.fn()
        const onDirty = jest.fn()
        const view = await open(graph('Chat', 'input.txt'), 'CHATFLOW', { handleSaveFlowName, handleSaveFlow, onDirty })
        const edit = document.body.querySelector('[title="Edit Name"]')
        await act(async () => edit.firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true })))
        const input = document.body.querySelector('input')
        input.value = 'Name still here'
        await act(async () => document.body.querySelector('[title="Save Name"]').dispatchEvent(new MouseEvent('click', { bubbles: true })))
        await act(async () => handleSaveFlowName.mock.calls[0][1].onError(Object.assign(new Error('No answer'), { saveAgain: true })))
        expect(onDirty).toHaveBeenCalledTimes(1)
        await act(async () =>
            document.body
                .querySelector('[title="Save Chatflow"]')
                .firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        )
        expect(handleSaveFlow).toHaveBeenCalledWith('Name still here')
        act(() => view.root.unmount())
    })
})

describe('Canvas header import', () => {
    afterEach(() => {
        document.body.innerHTML = ''
    })

    test('an imported draft replaces the visible canvas', async () => {
        const onApplyCanvas = jest.fn()
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme },
                    createElement(CanvasHeader, {
                        chatflow: { id: 'flow-1', name: 'Upgrade catalog', type: 'CHATFLOW', flowData: graph('Old', '') },
                        handleSaveFlow: () => {},
                        handleDeleteFlow: () => {},
                        handleLoadFlow: () => {},
                        onApplyCanvas
                    })
                )
            )
        })
        const apply = document.body.querySelector('[data-testid="import-verify-canvas"]')
        await act(async () => apply.dispatchEvent(new MouseEvent('click', { bubbles: true })))
        expect(onApplyCanvas).toHaveBeenCalledWith('{"nodes":[{"id":"imported"}],"edges":[]}')
        act(() => root.unmount())
    })
})
