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
                    callbackUrl: 'https://app.example/api/v1/auth/oidc/callback',
                    postLogoutUrl: 'https://app.example/signin',
                    linkMigrationComplete: true,
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
    expect(container.querySelector('input[value="https://app.example/api/v1/auth/oidc/callback"]')).not.toBeNull()
    expect(container.querySelector('input[value="https://app.example/signin"]')).not.toBeNull()
    expect(container.querySelector('input[value="openid email profile"]')).not.toBeNull()
    expect(container.textContent).not.toContain('client-secret-value')
    const activate = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Activate')
    expect(activate?.disabled).toBe(false)
    act(() => root.unmount())
})
