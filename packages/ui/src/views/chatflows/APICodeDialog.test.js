/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
jest.mock('@/store/constant', () => ({ baseURL: 'http://localhost' }))
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }))
jest.mock('react-redux', () => ({
    useDispatch: () => jest.fn(),
    useSelector: (select) => select({ canvas: { chatflow: { type: mockType, flowData: '{"nodes":[],"edges":[]}' } } })
}))
jest.mock('@/api/apikey', () => ({
    __esModule: true,
    default: { getAllAPIKeys: jest.fn(), options: jest.fn(() => Promise.resolve({ data: { rollout: mockMode } })) }
}))
jest.mock('@/api/chatflows', () => ({ __esModule: true, default: { updateChatflow: jest.fn(), getIsChatflowStreaming: jest.fn() } }))
jest.mock('@/api/config', () => ({ __esModule: true, default: { getConfig: jest.fn() } }))
jest.mock('@/api/variables', () => ({ __esModule: true, default: { getAllVariables: jest.fn() } }))
jest.mock('@/hooks/useApi', () => ({
    __esModule: true,
    default: (fn) => ({
        data: fn === require('@/api/apikey').default.getAllAPIKeys ? mockKeys : null,
        request: fn,
        loading: false,
        error: null
    })
}))
jest.mock('@/ui-component/rbac/available', () => ({ Available: ({ children }) => children }))
jest.mock('@/ui-component/dropdown/Dropdown', () => ({
    Dropdown: ({ name, options, onSelect, value, disabled }) =>
        require('react').createElement(
            'select',
            { name, value, disabled, onChange: (event) => onSelect(event.target.value) },
            options.map((option) =>
                require('react').createElement('option', { key: option.name, value: option.name, disabled: option.disabled }, option.label)
            )
        )
}))
jest.mock('react-code-blocks', () => ({ CopyBlock: () => null, atomOneDark: {} }))
jest.mock('./ShareChatbot', () => () => null)
jest.mock('./EmbedChat', () => () => null)
jest.mock('@/ui-component/checkbox/Checkbox', () => ({ CheckboxInput: () => null }))
jest.mock('@/ui-component/table/Table', () => ({ TableViewOnly: () => null }))
jest.mock('@/utils/genericHelper', () => ({
    unshiftFiles: () => [],
    getConfigExamplesForJS: () => '',
    getConfigExamplesForPython: () => '',
    getConfigExamplesForCurl: () => ''
}))

import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import chatflowsApi from '@/api/chatflows'
import APICodeDialog from './APICodeDialog'

let mockMode = 'off'
let mockType = 'ASSISTANT'
const mockKeys = ['old', 'replacement'].map((id) => ({ id, keyName: id, accessPolicy: { legacy: true }, resources: [] }))
const theme = createTheme()
let host, portal, root
beforeEach(() => {
    jest.clearAllMocks()
    host = document.createElement('div')
    portal = document.createElement('div')
    portal.id = 'portal'
    document.body.append(host, portal)
    root = createRoot(host)
})
afterEach(() => {
    act(() => root.unmount())
    host.remove()
    portal.remove()
})

for (const mode of ['off', 'shadow'])
    for (const fixture of ['unbound assistant', 'bound assistant', 'CHATFLOW control']) {
        it('round11 actual API dialog binding choices: ' + mode + ' ' + fixture, async () => {
            mockMode = mode
            mockType = fixture === 'CHATFLOW control' ? 'CHATFLOW' : 'ASSISTANT'
            const bound = fixture === 'bound assistant'
            await act(async () =>
                root.render(
                    <ThemeProvider theme={theme}>
                        <APICodeDialog
                            show
                            dialogProps={{
                                title: 'API Endpoint',
                                chatflowid: 'fixture-flow',
                                apiAccessMode: bound ? 'private' : 'public',
                                chatflowApiKeyId: bound ? 'old' : ''
                            }}
                            onCancel={() => {}}
                        />
                    </ThemeProvider>
                )
            )
            const select = document.querySelector('select[name="SelectKey"]')
            expect(select).not.toBeNull()
            expect(select.disabled).toBe(false)
            const replacement = [...select.options].find((option) => option.value === 'replacement' && !option.disabled)
            console.log('round11 dialog choice', mode, fixture, 'replacement selectable=', !!replacement)
            if (fixture === 'CHATFLOW control') {
                expect(replacement).toBeDefined()
                act(() => {
                    select.value = 'replacement'
                    select.dispatchEvent(new Event('change', { bubbles: true }))
                })
                expect(chatflowsApi.updateChatflow).toHaveBeenCalledWith('fixture-flow', {
                    apikeyid: 'replacement',
                    apiAccessMode: 'private'
                })
            } else {
                // An unavailable binding must not be advertised or submitted by the real dialog.
                expect(replacement).toBeUndefined()
                expect(chatflowsApi.updateChatflow).not.toHaveBeenCalled()
                expect(document.body.textContent).toMatch(/legacy binding.*unavailable/i)
                if (bound) expect(select.value).toBe('old')
            }
        })
    }
