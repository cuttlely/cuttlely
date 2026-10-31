/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
/* eslint-disable react/display-name, react/prop-types */
jest.mock('@/api/authenticationSettings', () => ({
    __esModule: true,
    default: {
        get: jest.fn(() =>
            Promise.resolve({
                data: {
                    activeMethod: 'workos',
                    version: 4,
                    changedAt: '2026-10-30T12:00:00.000Z',
                    sessionsEnded: 7,
                    warning: null,
                    methods: { local: { configured: true }, workos: { configured: true } },
                    recovery: { available: true, alert: null }
                }
            })
        ),
        stage: jest.fn(),
        apply: jest.fn(),
        acknowledgeWarning: jest.fn(),
        acknowledgeRecoveryAlert: jest.fn()
    }
}))
jest.mock('@/ui-component/cards/MainCard', () => ({ children }) => <div>{children}</div>)

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import api from '@/api/authenticationSettings'
import AuthenticationSettings, { reauthenticationTarget } from './index'

it('directs WorkOS step-up to owner recovery', () => {
    expect(reauthenticationTarget('workos')).toBe('/owner-recovery')
    expect(reauthenticationTarget('local')).toBe('/signin?reauth=1')
})

it('shows the last method change and the number of sessions ended', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(AuthenticationSettings)))
        await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="authentication-last-change"]')?.textContent).toContain('Last change:')
    expect(container.querySelector('[data-testid="authentication-last-change"]')?.textContent).not.toContain('No method change recorded')
    expect(container.querySelector('[data-testid="authentication-sessions-ended"]')?.textContent).toContain('7')
    expect(container.textContent).toContain('A WorkOS sign-in never counts as recent authentication.')
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Use Owner recovery')).toBe(true)
    act(() => root.unmount())
})

it('requires confirmation that acknowledging the client identity warning ends all sessions', async () => {
    api.get.mockResolvedValueOnce({
        data: {
            activeMethod: 'workos',
            version: 5,
            changedAt: null,
            sessionsEnded: 0,
            warning: 'The WorkOS client identity differs from the saved installation.',
            warningKind: 'workos-client-mismatch',
            methods: { local: { configured: true }, workos: { configured: true } },
            recovery: { available: true, alert: null }
        }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(AuthenticationSettings)))
        await Promise.resolve()
    })

    const acknowledge = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Acknowledge')
    expect(acknowledge).toBeTruthy()
    await act(async () => {
        acknowledge.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Acknowledge and end all interactive sessions?')
    expect(document.body.textContent).toContain('Everyone, including you, must sign in again.')
    expect(api.acknowledgeWarning).not.toHaveBeenCalled()
    act(() => root.unmount())
})
