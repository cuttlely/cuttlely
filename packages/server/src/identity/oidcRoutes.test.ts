/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import express from 'express'
import request from 'supertest'

const completeOidcAuthorization = jest.fn()
const readAuthenticationState = jest.fn()
const safeRecordAudit = jest.fn()

jest.mock('./production', () => ({
    applicationDataSource: () => ({}),
    applicationSql: () => ({}),
    buildAuthContext: jest.fn(),
    identityStore: () => ({})
}))
jest.mock('./authenticationRoutes', () => ({ recentlyAuthenticated: jest.fn() }))
jest.mock('./authenticationState', () => ({
    readAuthenticationState,
    recordRecentAuthentication: jest.fn()
}))
jest.mock('./auditLog', () => {
    const actual = jest.requireActual('./auditLog')
    return { ...actual, safeRecordAudit, organizationsForUser: jest.fn() }
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
})
