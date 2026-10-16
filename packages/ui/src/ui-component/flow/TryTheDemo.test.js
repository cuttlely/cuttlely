/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
let mockPermissions = []
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: (id) => mockPermissions.includes(id) }) }))
jest.mock('@/store/context/ErrorContext', () => ({ useError: () => ({ setError: jest.fn() }) }))
jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }))
jest.mock('@/views/credentials/CredentialListDialog', () => () => null)
jest.mock('@/views/credentials/AddEditCredentialDialog', () => () => null)
jest.mock('@/ui-component/button/RBACButtons', () => {
    const { createElement } = require('react')
    const plainButton = (props) => createElement('button', { disabled: props.disabled }, props.children)
    return { PermissionButton: plainButton, StyledPermissionButton: plainButton }
})
jest.mock('@/api/demo', () => ({
    __esModule: true,
    default: { getDemo: jest.fn(() => Promise.resolve({ data: { credentialNames: ['openAIApi'], demos: {} } })) }
}))
jest.mock('@/api/credentials', () => ({
    __esModule: true,
    default: {
        getAllCredentials: jest.fn(() => Promise.resolve({ data: [{ id: 'k1', name: 'Work OpenAI', credentialName: 'openAIApi' }] })),
        getAllComponentsCredentials: jest.fn(() => Promise.resolve({ data: [{ name: 'openAIApi', label: 'OpenAI API' }] }))
    }
}))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'

import credentialsApi from '@/api/credentials'
import TryTheDemo from './TryTheDemo'

global.IS_REACT_ACT_ENVIRONMENT = true

const render = async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(TryTheDemo, { show: true }))
    })
    return { container, unmount: () => act(() => root.unmount()) }
}

describe('Try the demo card', () => {
    beforeEach(() => {
        localStorage.clear()
        jest.clearAllMocks()
    })

    it('does not list saved keys for a role without credentials:view, and still shows the card', async () => {
        mockPermissions = ['chatflows:view']
        const { container, unmount } = await render()
        expect(credentialsApi.getAllCredentials).not.toHaveBeenCalled()
        expect(credentialsApi.getAllComponentsCredentials).toHaveBeenCalled()
        expect(container.textContent).toContain('Try the demo')
        expect(container.textContent).toContain('Add a model key')
        expect(container.textContent).not.toContain('Work OpenAI')
        await unmount()
    })

    it('lists saved keys for a role with credentials:view', async () => {
        mockPermissions = ['chatflows:view', 'chatflows:create', 'credentials:view']
        const { container, unmount } = await render()
        expect(credentialsApi.getAllCredentials).toHaveBeenCalledTimes(1)
        expect(container.textContent).toContain('Add another key')
        expect(container.querySelector('input').value).toBe('k1')
        await unmount()
    })
})
