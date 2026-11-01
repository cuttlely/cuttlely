/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
/* eslint-disable react/display-name, react/prop-types */
let mockAuth = { isAuthenticated: true, user: { id: 'owner-1' } }
jest.mock('react-redux', () => ({
    useSelector: (select) =>
        select({
            auth: mockAuth,
            customization: {}
        })
}))

const mockNavigate = jest.fn()
let mockSignInOptions = { authKit: false, localAdmin: false, localUsers: true, mail: false }
let mockLocationSearch = '?reauth=1'
jest.mock('react-router-dom', () => ({
    Link: ({ children }) => children,
    Navigate: () => <div data-testid='automatic-redirect' />,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ search: mockLocationSearch, state: { path: '/should-not-win' } })
}))

jest.mock('@/api/client', () => ({
    get: jest.fn(() => Promise.resolve({ data: mockSignInOptions }))
}))
jest.mock('@/api/auth', () => ({
    __esModule: true,
    default: { login: jest.fn(), localLogin: jest.fn() }
}))
jest.mock('@/hooks/useApi', () => ({
    __esModule: true,
    default: jest.fn()
}))
jest.mock('@/utils/useNotifier', () => () => undefined)
jest.mock('@/store/context/ErrorContext', () => ({ useError: () => ({ authRateLimitError: null, setAuthRateLimitError: jest.fn() }) }))
jest.mock('@/store', () => ({ store: { dispatch: jest.fn() } }))
jest.mock('@/ui-component/cards/MainCard', () => ({ children }) => <div>{children}</div>)
jest.mock('@/ui-component/extended/Logo', () => () => <div />)
jest.mock('@/ui-component/input/Input', () => ({ Input: () => <input /> }))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import authApi from '@/api/auth'
import useApi from '@/hooks/useApi'
import SignInPage from './signIn'

describe('local reauthentication', () => {
    beforeEach(() => {
        mockNavigate.mockClear()
        mockAuth = { isAuthenticated: true, user: { id: 'owner-1' } }
        mockSignInOptions = { authKit: false, localAdmin: false, localUsers: true, mail: false }
        mockLocationSearch = '?reauth=1'
    })

    it('shows the form to an authenticated user and returns to Auth / SSO after a successful sign-in', async () => {
        useApi.mockImplementation((operation) => ({
            data: operation === authApi.localLogin ? { user: { id: 'owner-1' } } : null,
            error: null,
            request: jest.fn()
        }))

        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(SignInPage)))
            await Promise.resolve()
        })

        expect(container.querySelector('#local-users-form')).not.toBeNull()
        expect(container.querySelector('[data-testid="automatic-redirect"]')).toBeNull()
        expect(mockNavigate).toHaveBeenCalledWith('/authentication-settings')
        act(() => root.unmount())
    })

    it('shows the owner password form for owner-only Local sign-in', async () => {
        mockSignInOptions = { authKit: false, localAdmin: true, localUsers: false, mail: false }
        useApi.mockReturnValue({ data: null, error: null, request: jest.fn() })

        const container = document.createElement('div')
        const root = createRoot(container)
        await act(async () => {
            root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(SignInPage)))
            await Promise.resolve()
        })

        expect(container.querySelector('#owner-password-form')).not.toBeNull()
        expect(container.querySelector('#workos-sign-in')).toBeNull()
        expect(container.textContent).toContain('Owner recovery')
        act(() => root.unmount())
    })

    it('does not show an owner password form while WorkOS is active', async () => {
        mockSignInOptions = { authKit: true, localAdmin: false, localUsers: false, mail: false }
        useApi.mockReturnValue({ data: null, error: null, request: jest.fn() })

        const container = document.createElement('div')
        const root = createRoot(container)
        await act(async () => {
            root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(SignInPage)))
            await Promise.resolve()
        })

        expect(container.querySelector('#workos-sign-in')).not.toBeNull()
        expect(container.querySelector('#owner-password-form')).toBeNull()
        expect(container.querySelector('#local-users-form')).toBeNull()
        expect(container.textContent).toContain('Owner recovery')
        act(() => root.unmount())
    })

    it.each([
        'You have a pending invite. Open the invite link from your email to join.',
        'This invite link is not valid. Ask for a new invite.'
    ])('shows OIDC invitation guidance from the callback: %s', async (message) => {
        mockAuth = { isAuthenticated: false, user: null }
        mockSignInOptions = { authKit: false, localAdmin: false, localUsers: false, oidc: true, mail: false }
        mockLocationSearch = `?error=${encodeURIComponent(JSON.stringify({ message }))}`
        useApi.mockReturnValue({ data: null, error: null, request: jest.fn() })

        const container = document.createElement('div')
        const root = createRoot(container)
        await act(async () => {
            root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(SignInPage)))
            await Promise.resolve()
        })

        expect(container.textContent).toContain(message)
        act(() => root.unmount())
    })
})
