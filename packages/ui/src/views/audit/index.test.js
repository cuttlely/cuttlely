/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('@/store/context/ErrorContext', () => ({
    useError: () => ({ setError: () => undefined, handleError: () => undefined })
}))

jest.mock('@/api/audit', () => ({
    __esModule: true,
    default: {
        getAudit: jest.fn(),
        fetchLoginActivity: jest.fn()
    }
}))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import auditApi from '@/api/audit'
import AuditLog from './index'

const page = {
    events: [
        {
            id: 'evt-1',
            type: 'invite',
            at: '2026-10-15T12:00:00.000Z',
            userId: 'user-1',
            summary: 'Invite issued',
            detail: null
        },
        {
            id: 'evt-2',
            type: 'setting_change',
            at: '2026-10-15T12:05:00.000Z',
            userId: null,
            summary: 'Settings changed',
            detail: {
                changes: [
                    { key: 'LOG_LEVEL', from: 'info', to: 'debug' },
                    { key: 'SMTP_PASSWORD', values: 'hidden' }
                ]
            }
        },
        ...['saved', 'saved_with_error', 'applied_to_active'].map((outcome, index) => ({
            id: `config-${index}`,
            type: 'auth_config_change',
            at: `2026-10-15T12:1${index}:00.000Z`,
            userId: 'admin-1',
            summary: 'OIDC configuration changed',
            detail: { outcome, configurationFingerprint: `fingerprint-${index}` }
        })),
        {
            id: 'oidc-signin',
            type: 'sign_in_success',
            at: '2026-10-15T12:20:00.000Z',
            userId: 'user-2',
            summary: 'OIDC sign-in succeeded',
            detail: {
                issuer: 'https://id.example',
                subject: 'subject-2',
                basis: 'email_verified',
                outcome: 'signed_in'
            }
        }
    ],
    nextCursor: null,
    limit: 50
}

describe('Audit log page', () => {
    beforeEach(() => {
        auditApi.getAudit.mockReset()
        auditApi.getAudit.mockResolvedValue({ data: page })
        document.body.innerHTML = ''
    })

    it('renders rows, including setting names with values hidden', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(AuditLog)))
        })
        expect(auditApi.getAudit).toHaveBeenCalled()
        expect(document.body.textContent).toContain('Invite issued')
        expect(document.body.textContent).toContain('user-1')
        expect(document.body.textContent).toContain('Settings changed')
        expect(document.body.textContent).toContain('LOG_LEVEL')
        expect(document.body.textContent).toContain('SMTP_PASSWORD (hidden)')
        expect(document.body.textContent).toContain('outcome: saved')
        expect(document.body.textContent).toContain('outcome: saved_with_error')
        expect(document.body.textContent).toContain('outcome: applied_to_active')
        expect(document.body.textContent).toContain('configuration fingerprint: fingerprint-2')
        expect(document.body.textContent).toContain('issuer: https://id.example')
        expect(document.body.textContent).toContain('subject: subject-2')
        expect(document.body.textContent).toContain('assurance basis: email_verified')
        expect(document.body.textContent).not.toContain('debug')
        expect(document.body.textContent).not.toContain('Oh snap!')
        act(() => root.unmount())
    })
})
