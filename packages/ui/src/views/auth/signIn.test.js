/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
/* eslint-disable react/display-name, react/prop-types */
jest.mock('react-redux', () => ({
    useSelector: (select) =>
        select({
            auth: { isAuthenticated: true, user: { id: 'owner-1' } },
            customization: {}
        })
}))

const mockNavigate = jest.fn()
jest.mock('react-router-dom', () => ({
    Link: ({ children }) => children,
    Navigate: () => <div data-testid='automatic-redirect' />,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ search: '?reauth=1', state: { path: '/should-not-win' } })
}))

jest.mock('@/api/client', () => ({
    get: jest.fn(() => Promise.resolve({ data: { authKit: false, localAdmin: false, localUsers: true, mail: false } }))
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
})
