/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import express from 'express'
import request from 'supertest'

const completeOidcAuthorization = jest.fn()
const readAuthenticationState = jest.fn()
const safeRecordAudit = jest.fn()
const buildAuthContext = jest.fn()
const issueDatabaseSession = jest.fn()
const resolveOidcUser = jest.fn()
const organizationsForUser = jest.fn()

jest.mock('./production', () => ({
    applicationDataSource: () => ({}),
    applicationSql: () => ({}),
    buildAuthContext,
    identityStore: () => ({})
}))
jest.mock('./handlers', () => {
    const actual = jest.requireActual('./handlers')
    return { ...actual, issueDatabaseSession, establishSession: jest.fn() }
})
jest.mock('./authenticationRoutes', () => ({ recentlyAuthenticated: jest.fn() }))
jest.mock('./authenticationState', () => ({
    readAuthenticationState,
    recordRecentAuthentication: jest.fn()
}))
jest.mock('./auditLog', () => {
    const actual = jest.requireActual('./auditLog')
    return { ...actual, safeRecordAudit, organizationsForUser }
})
jest.mock('./oidcStore', () => {
    const actual = jest.requireActual('./oidcStore')
    return { ...actual, resolveOidcUser }
})
jest.mock('./oidcProvider', () => {
    const actual = jest.requireActual('./oidcProvider')
    return {
        ...actual,
        beginOidcAuthorization: jest.fn(),
        checkOidcConfiguration: jest.fn(),
        completeOidcAuthorization
    }
})

import { OidcError } from './oidcProvider'
import { oidcAuthRouter } from './oidcRoutes'

function app() {
    const server = express()
    server.set('trust proxy', true)
    server.use((req, _res, next) => {
        req.cookies = { 'cuttlely-oidc-browser': 'browser-value' }
        next()
    })
    server.use('/api/v1/auth/oidc', oidcAuthRouter)
    return server
}

describe('OIDC callback audit outcomes', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        readAuthenticationState.mockResolvedValue({ authenticationEpoch: 4, activeMethod: 'oidc' })
        organizationsForUser.mockResolvedValue(['org-1'])
    })

    it.each([
        ['provider_denied', new OidcError('denied', 'denied', 'provider_denied')],
        ['browser_binding_failed', new OidcError('transaction', 'browser', 'browser_binding_failed')],
        ['state_expired_or_unknown', new OidcError('transaction', 'state', 'state_expired_or_unknown')],
        ['token_validation_failed', new OidcError('response', 'token', 'token_validation_failed')],
        ['upstream_unavailable', new OidcError('upstream', 'upstream', 'upstream_unavailable')]
    ])('writes the %s outcome without callback values', async (outcome, failure) => {
        completeOidcAuthorization.mockRejectedValueOnce(failure)
        const response = await request(app()).get('/api/v1/auth/oidc/callback?state=callback-state&code=callback-code')
        expect(response.status).toBe(302)
        expect(safeRecordAudit).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                type: 'sign_in_failure',
                summary: 'OIDC callback failed',
                detail: { method: 'oidc', category: failure.category, outcome }
            })
        )
        const serialized = JSON.stringify(safeRecordAudit.mock.calls.at(-1)?.[1])
        expect(serialized).not.toContain('callback-state')
        expect(serialized).not.toContain('callback-code')
        expect(serialized).not.toContain('browser-value')
    })

    it.each([
        [
            'reauthentication_account_mismatch',
            {
                envelope: {
                    purpose: 'reauth',
                    initiatingUserId: 'user-1',
                    authEpoch: 4,
                    redirectTarget: '/authentication-settings'
                },
                linkedUser: 'user-2',
                sessionResult: null
            }
        ],
        [
            'session_creation_failed',
            {
                envelope: { purpose: 'signin', initiatingUserId: null, authEpoch: 4, redirectTarget: '/' },
                linkedUser: 'user-1',
                sessionResult: { type: 'json', status: 500, body: {} }
            }
        ]
    ])('records %s separately', async (outcome, scenario) => {
        completeOidcAuthorization.mockResolvedValueOnce({
            envelope: scenario.envelope,
            config: { trustMissingEmailVerification: false },
            identity: {
                providerKey: 'provider-1',
                subject: 'subject-1',
                issuer: 'https://issuer.example',
                email: 'ada@example.com',
                emailVerified: true,
                emailVerificationPresent: true
            }
        })
        resolveOidcUser.mockResolvedValueOnce({ ok: true, user: { id: scenario.linkedUser }, basis: 'email_verified' })
        buildAuthContext.mockResolvedValueOnce({})
        if (scenario.sessionResult) issueDatabaseSession.mockResolvedValueOnce(scenario.sessionResult)

        const response = await request(app()).get('/api/v1/auth/oidc/callback?state=callback-state&code=callback-code')
        expect(response.status).toBe(302)
        expect(safeRecordAudit).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                type: 'sign_in_failure',
                summary: 'OIDC callback failed',
                detail: expect.objectContaining({ method: 'oidc', outcome })
            })
        )
        if (outcome === 'reauthentication_account_mismatch') {
            expect(safeRecordAudit).toHaveBeenCalledTimes(1)
            expect(safeRecordAudit).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'sign_in_success' }))
        }
    })

    it('throttles the callback after repeated identity link refusals', async () => {
        completeOidcAuthorization.mockResolvedValue({
            envelope: { purpose: 'signin', initiatingUserId: null, authEpoch: 4, redirectTarget: '/' },
            config: { trustMissingEmailVerification: false },
            identity: {
                providerKey: 'provider-1',
                subject: 'subject-1',
                issuer: 'https://issuer.example',
                email: 'ada@example.com',
                emailVerified: true,
                emailVerificationPresent: true
            }
        })
        resolveOidcUser.mockResolvedValue({ ok: false, reason: 'unlinked', basis: null })
        const client = request(app())
        const callback = () =>
            client.get('/api/v1/auth/oidc/callback?state=callback-state&code=callback-code').set('x-forwarded-for', '192.0.2.88')

        for (let attempt = 0; attempt < 20; attempt += 1) {
            const response = await callback()
            const error = new URL(response.headers.location, 'http://localhost').searchParams.get('error')
            expect(JSON.parse(error || '{}')).toEqual({ message: 'This identity cannot sign in.' })
        }

        const throttled = await callback()
        expect(throttled.status).toBe(302)
        const error = new URL(throttled.headers.location, 'http://localhost').searchParams.get('error')
        expect(JSON.parse(error || '{}')).toEqual({ message: 'Too many attempts. Try again later.' })
        expect(completeOidcAuthorization).toHaveBeenCalledTimes(20)
    })
})
