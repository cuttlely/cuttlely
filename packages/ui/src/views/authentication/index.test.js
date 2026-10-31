/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
/* eslint-disable react/display-name, react/prop-types */
const authResponse = {
    activeMethod: 'workos',
    version: 4,
    changedAt: '2026-10-30T12:00:00.000Z',
    sessionsEnded: 7,
    warning: null,
    methods: {
        local: { configured: true, selectable: true, scope: 'local-users' },
        workos: { configured: true },
        oidc: { configured: true }
    },
    recovery: { available: true, alert: null }
}

const oidcResponse = {
    callbackUrl: 'https://app.example/api/v1/auth/oidc/callback?provider=provider-1',
    activeCallbackUrl: 'https://app.example/api/v1/auth/oidc/callback?provider=provider-active',
    postLogoutUrl: 'https://app.example/signin',
    testedDraftDiffersFromActive: false,
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
            email: 'person@example.test',
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

jest.mock('@/api/authenticationSettings', () => ({
    __esModule: true,
    default: {
        get: jest.fn(() => Promise.resolve({ data: authResponse })),
        getOidc: jest.fn(() => Promise.resolve({ data: oidcResponse })),
        stage: jest.fn(),
        apply: jest.fn(),
        saveOidc: jest.fn(),
        testOidc: jest.fn(),
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

async function renderSettings() {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(AuthenticationSettings)))
        await Promise.resolve()
        await Promise.resolve()
    })
    return { container, root }
}

beforeEach(() => {
    jest.clearAllMocks()
    api.get.mockResolvedValue({ data: authResponse })
    api.getOidc.mockResolvedValue({ data: oidcResponse })
})

it('directs each active method to its supported step-up route', () => {
    expect(reauthenticationTarget('workos')).toBe('/owner-recovery')
    expect(reauthenticationTarget('oidc')).toBe('/api/v1/auth/oidc/reauthenticate')
    expect(reauthenticationTarget('local')).toBe('/signin?reauth=1')
})

it('shows session convergence details, owner recovery, and OIDC setup together', async () => {
    const { container, root } = await renderSettings()
    expect(container.querySelector('[data-testid="authentication-last-change"]')?.textContent).toContain('Last change:')
    expect(container.querySelector('[data-testid="authentication-sessions-ended"]')?.textContent).toContain('7')
    expect(container.textContent).toContain('A WorkOS sign-in never counts as recent authentication.')
    expect(container.textContent).toContain('Generic OIDC setup')
    expect(container.textContent).toContain('Discovery and keys ready')
    expect(container.textContent).toContain('Returned email: person@example.test. Assurance: email_verified.')
    expect(container.textContent).toContain('2 legacy WorkOS subject links could not be attributed')
    expect(container.querySelector('input[value="https://app.example/api/v1/auth/oidc/callback?provider=provider-1"]')).not.toBeNull()
    expect(container.querySelector('input[value="https://app.example/api/v1/auth/oidc/callback?provider=provider-active"]')).not.toBeNull()
    expect(container.textContent).not.toContain('client-secret-value')
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Activate')?.disabled).toBe(false)
    act(() => root.unmount())
})

it('shows owner-only Local login but disables its method control', async () => {
    api.get.mockResolvedValueOnce({
        data: {
            ...authResponse,
            methods: {
                ...authResponse.methods,
                local: { configured: true, selectable: false, scope: 'owner-only' }
            }
        }
    })
    const { container, root } = await renderSettings()
    expect(container.textContent).toContain('Local login — owner only')
    expect(container.querySelector('input[value="local"]')?.disabled).toBe(true)
    act(() => root.unmount())
})

it('requires confirmation before acknowledging the client identity warning', async () => {
    api.get.mockResolvedValueOnce({
        data: {
            ...authResponse,
            warning: 'The WorkOS client identity differs from the saved installation.',
            warningKind: 'workos-client-mismatch'
        }
    })
    const { container, root } = await renderSettings()
    const acknowledge = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Acknowledge')
    await act(async () => {
        acknowledge.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Acknowledge and end all interactive sessions?')
    expect(api.acknowledgeWarning).not.toHaveBeenCalled()
    act(() => root.unmount())
})

it('offers a non-session-ending apply for refreshed tested OIDC settings', async () => {
    api.get.mockResolvedValueOnce({ data: { ...authResponse, activeMethod: 'oidc', configurationFingerprint: 'same-fingerprint' } })
    api.getOidc.mockResolvedValueOnce({
        data: {
            ...oidcResponse,
            testedDraftDiffersFromActive: true,
            draft: { ...oidcResponse.draft, fingerprint: 'same-fingerprint' },
            active: { configured: true, fingerprint: 'same-fingerprint' }
        }
    })
    api.stage.mockResolvedValueOnce({
        data: { stage: 'stage-refresh', stageVersion: 1, method: 'oidc', action: 'oidc_refresh', sessionsWillEnd: false }
    })
    const { container, root } = await renderSettings()
    const refresh = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Apply refreshed provider settings')
    await act(async () => {
        refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
    })
    expect(api.stage).toHaveBeenCalledWith('oidc', 4)
    expect(document.body.textContent).toContain('Existing sessions stay signed in.')
    expect(document.body.textContent).not.toContain('Type END SESSIONS')
    act(() => root.unmount())
})
