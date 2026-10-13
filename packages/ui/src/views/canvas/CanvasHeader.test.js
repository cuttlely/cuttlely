/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/store/constant', () => ({ uiBaseURL: 'http://localhost', baseURL: 'http://localhost' }))
jest.mock('@/hooks/useApi', () => () => ({ data: null, error: null, loading: false, request: jest.fn() }))
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => true }) }))
jest.mock('@/hooks/useConfirm', () => {
    const confirm = jest.fn()
    return { __esModule: true, confirm, default: () => ({ confirm }) }
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
jest.mock('@/ui-component/flow/FlowiseMigrationWizard', () => () => null)
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
import { confirm } from '@/hooks/useConfirm'
import CanvasHeader from './CanvasHeader'

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

    const open = async (flowData, type = 'ETL') => {
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
                        onApplyCanvas
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
})
