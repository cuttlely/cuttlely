/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('react-redux', () => ({
    useSelector: (select) => select({ auth: { permissions: ['authentication:manage'], isGlobal: false } })
}))
jest.mock('@/api/authenticationSettings', () => ({
    __esModule: true,
    default: { get: jest.fn() }
}))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import api from '@/api/authenticationSettings'
import RecoveryWarningBanner from './RecoveryWarningBanner'

it('shows administrators the owner recovery warning and settings link', async () => {
    api.get.mockResolvedValueOnce({ data: { recovery: { available: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            createElement(MemoryRouter, null, createElement(ThemeProvider, { theme: createTheme() }, createElement(RecoveryWarningBanner)))
        )
        await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="owner-recovery-warning"]')).not.toBeNull()
    expect(container.textContent).toContain('Owner recovery is not ready')
    expect(container.querySelector('a[href="/authentication-settings"]')).not.toBeNull()
    expect(
        container.querySelector('a[href="https://github.com/cuttlely/cuttlely/blob/main/docs/how-to/auth-sso.md#change-the-method"]')
    ).not.toBeNull()
    act(() => root.unmount())
})

it('shows a successful owner recovery alert until it is acknowledged', async () => {
    api.get.mockResolvedValueOnce({
        data: { recovery: { available: true, alert: { id: 'alert-1', occurredAt: '2026-10-30T12:00:00.000Z' } } }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            createElement(MemoryRouter, null, createElement(ThemeProvider, { theme: createTheme() }, createElement(RecoveryWarningBanner)))
        )
        await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="owner-recovery-alert"]')).not.toBeNull()
    expect(container.textContent).toContain('An owner recovery sign-in occurred')
    act(() => root.unmount())
})
