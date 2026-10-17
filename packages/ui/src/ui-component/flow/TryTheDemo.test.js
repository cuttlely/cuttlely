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
        mockPermissions = ['chatflows:view', 'credentials:create']
        const { container, unmount } = await render()
        expect(credentialsApi.getAllCredentials).not.toHaveBeenCalled()
        expect(credentialsApi.getAllComponentsCredentials).toHaveBeenCalled()
        expect(container.textContent).toContain('Try the demo')
        expect(container.textContent).toContain('Add a model key')
        expect(container.textContent).not.toContain('Work OpenAI')
        await unmount()
    })

    it('lists saved keys for a role with credentials:view', async () => {
        mockPermissions = ['chatflows:view', 'chatflows:create', 'credentials:view', 'credentials:create']
        const { container, unmount } = await render()
        expect(credentialsApi.getAllCredentials).toHaveBeenCalledTimes(1)
        expect(container.textContent).toContain('Add another key')
        expect(container.querySelector('input').value).toBe('k1')
        await unmount()
    })

    it('offers Add a model key to a role with credentials:create', async () => {
        mockPermissions = ['chatflows:view', 'chatflows:create', 'credentials:create']
        const { container, unmount } = await render()
        expect(container.textContent).toContain('Add a model key')
        await unmount()
    })

    it('hints Add a model key first on the demo buttons for a role with credentials:create and no key', async () => {
        mockPermissions = ['chatflows:view', 'chatflows:create', 'credentials:create']
        const { container, unmount } = await render()
        expect(container.querySelectorAll('[aria-label="Add a model key first"]')).toHaveLength(2)
        expect(container.querySelector('[aria-label="Ask an admin to add a model key"]')).toBeNull()
        await unmount()
    })

    it('asks a role without credentials:create to ask an admin instead of adding a key', async () => {
        mockPermissions = ['chatflows:view', 'chatflows:create']
        const { container, unmount } = await render()
        expect(container.querySelectorAll('[aria-label="Ask an admin to add a model key"]')).toHaveLength(2)
        expect(container.querySelector('[aria-label="Add a model key first"]')).toBeNull()
        await unmount()
    })

    it('hides Add a model key and Add another key from a role without credentials:create', async () => {
        mockPermissions = ['chatflows:view', 'chatflows:create']
        const { container, unmount } = await render()
        expect(container.textContent).toContain('Try the demo')
        expect(container.textContent).not.toContain('Add a model key')
        await unmount()

        mockPermissions = ['chatflows:view', 'chatflows:create', 'credentials:view']
        const withKeys = await render()
        expect(withKeys.container.querySelector('input').value).toBe('k1')
        expect(withKeys.container.textContent).not.toContain('Add another key')
        await withKeys.unmount()
    })
})
