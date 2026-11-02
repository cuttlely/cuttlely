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
    recovery: { available: true, alert: null },
    scim: {
        available: true,
        basePath: '/api/v1/scim/v2',
        status: 'none',
        lastUsedAt: null,
        operations: {
            lastSuccessfulRequestAt: '2026-10-31T12:00:00.000Z',
            lastFailedRequestAt: '2026-10-31T12:01:00.000Z',
            lastCompletedRequestAt: '2026-10-31T12:00:00.000Z',
            lastFailedRequestCategory: 'mapping_conflict',
            counts: { usersCreated: 2, groupOperations: 3, membershipOperations: 4 },
            recentErrors: [],
            retentionDays: 30
        },
        mapping: {
            mappings: [
                {
                    id: 'mapping-1',
                    groupName: 'Engineering',
                    workspaceName: 'Product',
                    roleName: 'viewer',
                    ownedAssignments: 2
                }
            ],
            groups: [{ id: 'group-1', displayName: 'Engineering' }],
            workspaces: [{ id: 'team-1', name: 'Product' }],
            roles: [{ id: 'role-1', name: 'viewer' }]
        }
    }
}

const oidcResponse = {
    callbackUrl: 'https://app.example/api/v1/auth/oidc/callback/provider-1',
    activeCallbackUrl: 'https://app.example/api/v1/auth/oidc/callback/provider-active',
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
            passed: true,
            identityAccepted: true,
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
        acknowledgeRecoveryAlert: jest.fn(),
        createScimToken: jest.fn(),
        rotateScimToken: jest.fn(),
        endScimOverlap: jest.fn(),
        revokeScimToken: jest.fn(),
        previewScimMappingCreation: jest.fn(),
        confirmScimMappingCreation: jest.fn(),
        previewScimMappingRemoval: jest.fn(),
        removeScimMapping: jest.fn()
    }
}))
jest.mock('@/ui-component/cards/MainCard', () => ({ children }) => <div>{children}</div>)

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
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
    expect(container.querySelector('input[value="https://app.example/api/v1/auth/oidc/callback/provider-1"]')).not.toBeNull()
    expect(container.querySelector('input[value="https://app.example/api/v1/auth/oidc/callback/provider-active"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Post-logout URL')
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

it('shows the reason an OIDC identity test failed and keeps activation disabled', async () => {
    api.getOidc.mockResolvedValueOnce({
        data: {
            ...oidcResponse,
            draft: {
                ...oidcResponse.draft,
                tested: false,
                testResult: {
                    passed: false,
                    reason: 'No Cuttlely user matches the returned email address.'
                }
            }
        }
    })
    const { container, root } = await renderSettings()
    expect(container.textContent).toContain('Test failed. No Cuttlely user matches the returned email address.')
    expect(container.textContent).not.toContain('Test passed.')
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'Activate')?.disabled).toBe(true)
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

it('creates a SCIM credential and shows its clear value once', async () => {
    const generatedValue = ['temporary', Date.now()].join('-')
    api.createScimToken.mockResolvedValueOnce({
        data: {
            clear: generatedValue,
            state: { status: 'active', displayPrefix: 'cuttlely_scim_exam…', createdAt: '2026-10-31T12:00:00.000Z', lastUsedAt: null }
        }
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(AuthenticationSettings)))
        await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="scim-settings-card"]')).not.toBeNull()
    const create = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Create')
    await act(async () => {
        create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
    })
    expect(api.createScimToken).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="scim-clear-value"]')?.textContent).toContain('It will not be shown again')
    act(() => root.unmount())
})

it('previews and confirms mapping creation, then confirms removal from a preview', async () => {
    api.previewScimMappingCreation.mockResolvedValueOnce({
        data: {
            mapping: {
                groupId: 'group-1',
                groupName: 'Engineering',
                workspaceId: 'team-1',
                workspaceName: 'Product',
                roleId: 'role-1',
                roleName: 'viewer'
            },
            assignments: [{ userId: 'user-2', userName: 'Lin', workspaceId: 'team-1', workspaceName: 'Product', roleName: 'viewer' }],
            manualMemberships: [],
            conflicts: [],
            fingerprint: 'creation-preview'
        }
    })
    api.confirmScimMappingCreation.mockResolvedValueOnce({ data: { id: 'mapping-2' } })
    api.previewScimMappingRemoval.mockResolvedValueOnce({
        data: {
            mapping: { id: 'mapping-1', groupName: 'Engineering', workspaceName: 'Product' },
            assignments: [{ userId: 'user-1', userName: 'Ada', workspaceId: 'team-1', workspaceName: 'Product', roleName: 'viewer' }],
            fingerprint: 'preview-fingerprint'
        }
    })
    api.removeScimMapping.mockResolvedValueOnce({ data: null })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(AuthenticationSettings)))
        await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="scim-operations-view"]')?.textContent).toContain('Users created 2')
    expect(container.querySelector('[data-testid="scim-operations-view"]')?.textContent).toContain('Last failed request:')
    expect(container.querySelector('[data-testid="scim-operations-view"]')?.textContent).toContain('mapping_conflict')
    expect(container.querySelector('[data-testid="scim-mappings-view"]')?.textContent).toContain('Engineering → Product')

    const choose = async (label, value) => {
        const labeled = container.querySelector(`[aria-label="${label}"]`)
        await act(async () => {
            fireEvent.change(labeled.querySelector('input'), { target: { value } })
            await Promise.resolve()
        })
    }
    await choose('SCIM group', 'group-1')
    await choose('Mapped team', 'team-1')
    await choose('Mapped role', 'role-1')
    const createMapping = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Create mapping')
    await act(async () => {
        createMapping.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
    })
    expect(api.confirmScimMappingCreation).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Assignments to add:')
    expect(document.body.textContent).toContain('Lin · Product · viewer')
    const confirmCreation = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Confirm creation')
    await act(async () => {
        confirmCreation.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
    })
    expect(api.confirmScimMappingCreation).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'group-1' }), 'creation-preview')

    const remove = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Remove')
    await act(async () => {
        remove.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Ada · Product · viewer')
    const confirmRemoval = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === 'Confirm removal')
    await act(async () => {
        confirmRemoval.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
    })
    expect(api.removeScimMapping).toHaveBeenCalledWith('mapping-1', 'preview-fingerprint')
    act(() => root.unmount())
})
