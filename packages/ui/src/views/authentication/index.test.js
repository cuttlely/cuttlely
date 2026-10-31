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
                    activeMethod: 'local',
                    version: 4,
                    warning: null,
                    methods: { local: { configured: true }, workos: { configured: false }, oidc: { configured: true } },
                    recovery: { available: true }
                }
            })
        ),
        getOidc: jest.fn(() =>
            Promise.resolve({
                data: {
                    callbackUrl: 'https://app.example/api/v1/auth/oidc/callback?provider=provider-1',
                    activeCallbackUrl: 'https://app.example/api/v1/auth/oidc/callback?provider=provider-active',
                    postLogoutUrl: 'https://app.example/signin',
                    linkMigrationComplete: true,
                    linkMigration: { complete: true, migrated: 0, inert: 2, error: null },
                    draft: {
                        configured: true,
                        issuer: 'https://id.example',
                        clientId: 'client-id',
                        clientSecretEnvVar: 'OIDC_CLIENT_SECRET',
                        clientSecretPresent: true,
                        trustMissingEmailVerification: false,
                        privateIssuerHosts: [],
                        health: 'ready',
                        checkedAt: '2026-10-30T12:00:00.000Z',
                        tested: true,
                        testResult: {
                            steps: ['discovery', 'authorization', 'token', 'signature', 'claims'],
                            email: 'ada@example.com',
                            assuranceBasis: 'email_verified'
                        },
                        version: 2
                    },
                    active: {
                        configured: true,
                        issuer: 'https://active-id.example',
                        clientId: 'active-client-id',
                        fingerprint: 'active-fingerprint'
                    }
                }
            })
        ),
        stage: jest.fn(),
        apply: jest.fn(),
        saveOidc: jest.fn(),
        testOidc: jest.fn(),
        acknowledgeWarning: jest.fn()
    }
}))
jest.mock('@/ui-component/cards/MainCard', () => ({ children }) => <div>{children}</div>)

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import api from '@/api/authenticationSettings'
import AuthenticationSettings from './index'

it('shows the OIDC setup status and derived URLs without a secret value', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(AuthenticationSettings)))
        await Promise.resolve()
        await Promise.resolve()
    })
    expect(container.textContent).toContain('Generic OIDC setup')
    expect(container.textContent).toContain('Discovery and keys ready')
    expect(container.textContent).toContain('Value is set on this server.')
    expect(container.textContent).toContain('Steps: discovery, authorization, token, signature, claims.')
    expect(container.textContent).toContain('Returned email: ada@example.com. Assurance: email_verified.')
    expect(container.textContent).toContain('2 legacy WorkOS subject links could not be attributed')
    expect(container.textContent).toContain('They remain inert and will not match this OIDC provider.')
    expect(container.textContent).toContain('Draft callback URL')
    expect(container.querySelector('input[value="https://app.example/api/v1/auth/oidc/callback?provider=provider-1"]')).not.toBeNull()
    expect(container.textContent).toContain('Save the draft, then register this exact URL before Test sign-in.')
    expect(container.textContent).toContain('Active callback URL')
    expect(container.querySelector('input[value="https://app.example/api/v1/auth/oidc/callback?provider=provider-active"]')).not.toBeNull()
    expect(container.textContent).toContain('Keep this exact URL registered while this provider is active.')
    expect(container.querySelector('input[value="https://app.example/signin"]')).not.toBeNull()
    expect(container.querySelector('input[value="openid email profile"]')).not.toBeNull()
    expect(container.textContent).not.toContain('client-secret-value')
    const activate = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Activate')
    expect(activate?.disabled).toBe(false)
    act(() => root.unmount())
})

it('shows the active callback URL when there is no draft', async () => {
    const oidc = (await api.getOidc()).data
    api.getOidc.mockResolvedValueOnce({
        data: {
            ...oidc,
            callbackUrl: null,
            draft: { configured: false, version: 0 }
        }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(AuthenticationSettings)))
        await Promise.resolve()
        await Promise.resolve()
    })
    expect(container.textContent).toContain('Active callback URL')
    expect(container.querySelector('input[value="https://app.example/api/v1/auth/oidc/callback?provider=provider-active"]')).not.toBeNull()
    act(() => root.unmount())
})

it('labels and disables activation when the tested draft is already active', async () => {
    const auth = (await api.get()).data
    const oidc = (await api.getOidc()).data
    api.get.mockResolvedValueOnce({ data: { ...auth, activeMethod: 'oidc' } })
    api.getOidc.mockResolvedValueOnce({
        data: {
            ...oidc,
            draft: { ...oidc.draft, fingerprint: 'same-fingerprint' },
            active: { configured: true, fingerprint: 'same-fingerprint' }
        }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(AuthenticationSettings)))
        await Promise.resolve()
        await Promise.resolve()
    })
    const active = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Already active')
    expect(active?.disabled).toBe(true)
    act(() => root.unmount())
})
