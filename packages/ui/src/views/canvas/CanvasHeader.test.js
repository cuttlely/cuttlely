/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
const mockUpdateApi = { data: null, error: null, loading: false, request: jest.fn() }
const mockOtherApi = { data: null, error: null, loading: false, request: jest.fn() }
const mockDispatch = jest.fn()

jest.mock('@/store/constant', () => ({ uiBaseURL: 'http://localhost', baseURL: 'http://localhost' }))
jest.mock('@/hooks/useApi', () => (apiFunc) => apiFunc?.name === 'mockUpdateChatflow' ? mockUpdateApi : mockOtherApi)
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => true }) }))
jest.mock('@/hooks/useConfirm', () => {
    const confirm = jest.fn()
    return { __esModule: true, default: () => ({ confirm }) }
})
jest.mock('react-redux', () => ({
    useDispatch: () => mockDispatch,
    useSelector: (selector) => selector({ canvas: { isDirty: false, componentNodes: [] }, customization: { isDarkMode: false } })
}))
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }))
jest.mock('@mui/material/useMediaQuery', () => () => false)
jest.mock('@/api/chatflows', () => ({
    __esModule: true,
    default: {
        updateChatflow: function mockUpdateChatflow() {},
        getScheduleStatus: jest.fn(),
        toggleScheduleEnabled: jest.fn(),
        getSpecificChatflow: jest.fn()
    }
}))
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
        mockUpdateApi.data = null
        mockUpdateApi.error = null
        mockUpdateApi.request.mockReset()
        mockOtherApi.data = null
        mockOtherApi.error = null
        mockOtherApi.request.mockReset()
        mockDispatch.mockReset()
        document.body.innerHTML = ''
    })

    const open = async (flowData, type = 'ETL', headerProps = {}) => {
        const onApplyCanvas = jest.fn()
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        const render = async (chatflow = { id: 'flow-1', name: 'Upgrade catalog', type, flowData }) =>
            act(async () => {
                root.render(
                    createElement(
                        ThemeProvider,
                        { theme },
                        createElement(CanvasHeader, {
                            chatflow,
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
        await render()
        return { root, onApplyCanvas, render }
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

    it('ignores an inline name result after the header moves to another flow', async () => {
        const flowData = graph('Chat', 'input.txt')
        const view = await open(flowData, 'CHATFLOW')
        await act(async () =>
            document.querySelector('[title="Edit Name"]').firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        )
        const input = document.querySelector('input')
        input.value = 'Renamed A'
        await act(async () =>
            document.querySelector('[title="Save Name"]').firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        )
        expect(mockUpdateApi.request).toHaveBeenCalledWith('flow-1', { name: 'Renamed A' })

        await view.render({ id: 'flow-2', name: 'Flow B', type: 'CHATFLOW', flowData })
        mockUpdateApi.data = { id: 'flow-1', name: 'Renamed A', type: 'CHATFLOW', flowData }
        await view.render({ id: 'flow-2', name: 'Flow B', type: 'CHATFLOW', flowData })

        expect(mockDispatch.mock.calls.map(([action]) => action).filter((action) => action?.type === 'SET_CHATFLOW')).toEqual([])
        expect(document.body.textContent).toContain('Flow B')
        act(() => view.root.unmount())
    })

    it('keeps the inline name editor open while the next result is pending and after its failure', async () => {
        const flowData = graph('Chat', 'input.txt')
        const flow = { id: 'flow-1', name: 'Upgrade catalog', type: 'CHATFLOW', flowData }
        const view = await open(flowData, 'CHATFLOW')
        await act(async () =>
            document.querySelector('[title="Edit Name"]').firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        )
        document.querySelector('input').value = 'First name'
        await act(async () =>
            document.querySelector('[title="Save Name"]').firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        )
        mockUpdateApi.data = { ...flow, name: 'First name' }
        await view.render({ ...flow, name: 'First name' })

        await act(async () =>
            document.querySelector('[title="Edit Name"]').firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        )
        document.querySelector('input').value = 'Second name'
        await act(async () =>
            document.querySelector('[title="Save Name"]').firstElementChild.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        )
        mockUpdateApi.data = null
        await view.render({ ...flow, name: 'First name' })
        expect(document.querySelector('input').value).toBe('Second name')

        mockUpdateApi.error = new Error('write failed')
        await view.render({ ...flow, name: 'First name' })
        expect(document.querySelector('input').value).toBe('Second name')
        act(() => view.root.unmount())
    })
})
