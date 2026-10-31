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
                    recovery: { available: true, alert: null },
                    scim: {
                        available: true,
                        basePath: '/api/v1/scim/v2',
                        status: 'none',
                        lastUsedAt: null,
                        operations: {
                            lastSuccessfulRequestAt: '2026-10-31T12:00:00.000Z',
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
            })
        ),
        stage: jest.fn(),
        apply: jest.fn(),
        acknowledgeWarning: jest.fn(),
        acknowledgeRecoveryAlert: jest.fn(),
        createScimToken: jest.fn(),
        rotateScimToken: jest.fn(),
        endScimOverlap: jest.fn(),
        revokeScimToken: jest.fn(),
        createScimMapping: jest.fn(),
        previewScimMappingRemoval: jest.fn(),
        removeScimMapping: jest.fn()
    }
}))
jest.mock('@/ui-component/cards/MainCard', () => ({ children }) => <div>{children}</div>)

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import api from '@/api/authenticationSettings'
import AuthenticationSettings from './index'

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
            recovery: { available: true, alert: null },
            scim: { available: true, basePath: '/api/v1/scim/v2', status: 'none', lastUsedAt: null }
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

it('shows mapping and operations state and confirms removal from a preview', async () => {
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
    expect(container.querySelector('[data-testid="scim-operations-view"]')?.textContent).toContain('mapping_conflict')
    expect(container.querySelector('[data-testid="scim-mappings-view"]')?.textContent).toContain('Engineering → Product')

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
