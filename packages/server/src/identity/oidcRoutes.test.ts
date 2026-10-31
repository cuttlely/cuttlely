/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import express from 'express'
import request from 'supertest'

const completeOidcAuthorization = jest.fn()
const readAuthenticationState = jest.fn()
const safeRecordAudit = jest.fn()
const buildAuthContext = jest.fn()
const issueDatabaseSession = jest.fn()
const establishSession = jest.fn()
const resolveOidcUser = jest.fn()
const recordOidcTestFailure = jest.fn()
const recordOidcTestResult = jest.fn()
const organizationsForUser = jest.fn()
const recentlyAuthenticated = jest.fn()
const readOidcConfiguration = jest.fn()
const providerLinkMigrationStatus = jest.fn()
const migrateLegacyProviderLinks = jest.fn()
const saveOidcDraft = jest.fn()
const checkOidcConfiguration = jest.fn()

jest.mock('./production', () => ({
    applicationDataSource: () => ({}),
    applicationSql: () => ({}),
    buildAuthContext,
    identityStore: () => ({})
}))
jest.mock('./handlers', () => {
    const actual = jest.requireActual('./handlers')
    return { ...actual, issueDatabaseSession, establishSession }
})
jest.mock('./authenticationRoutes', () => ({ recentlyAuthenticated }))
jest.mock('./rbac', () => ({ requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() }))
jest.mock('./authenticationState', () => ({
    readAuthenticationState
}))
jest.mock('./auditLog', () => {
    const actual = jest.requireActual('./auditLog')
    return { ...actual, safeRecordAudit, organizationsForUser }
})
jest.mock('./oidcStore', () => {
    const actual = jest.requireActual('./oidcStore')
    return {
        ...actual,
        resolveOidcUser,
        recordOidcTestFailure,
        recordOidcTestResult,
        readOidcConfiguration,
        providerLinkMigrationStatus,
        migrateLegacyProviderLinks,
        saveOidcDraft
    }
})
jest.mock('./oidcProvider', () => {
    const actual = jest.requireActual('./oidcProvider')
    return {
        ...actual,
        beginOidcAuthorization: jest.fn(),
        checkOidcConfiguration,
        completeOidcAuthorization
    }
})

import { oidcCallbackUrl } from './cookies'
import { OidcError } from './oidcProvider'
import { oidcProviderKey } from './oidcStore'
import { oidcAdminRouter, oidcAuthRouter } from './oidcRoutes'

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

function adminApp() {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        req.user = { id: 'admin-1', activeOrganizationId: 'org-1' } as Express.User
        next()
    })
    server.use('/api/v1/authentication-settings/oidc', oidcAdminRouter)
    return server
}

function oidcConfig(slot: 'draft' | 'active', issuer: string, clientId: string, fingerprint: string) {
    return {
        slot,
        issuer,
        clientId,
        clientSecretEnvVar: 'CUTTLELY_OIDC_CLIENT_SECRET',
        trustMissingEmailVerification: false,
        privateIssuerHosts: [],
        fingerprint,
        discovery: {},
        health: 'ready',
        healthError: null,
        checkedAt: '2026-10-31T12:00:00.000Z',
        testedFingerprint: fingerprint,
        testedAt: '2026-10-31T12:00:00.000Z',
        testResult: { identityAccepted: true },
        version: 1
    }
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

    it.each([
        ['unknown', 'This identity cannot sign in.'],
        ['invite_required', 'You have a pending invite. Open the invite link from your email to join.'],
        ['invite_invalid', 'This invite link is not valid. Ask for a new invite.']
    ])('returns the sign-in guidance for %s without auditing the provider subject', async (reason, message) => {
        completeOidcAuthorization.mockResolvedValueOnce({
            envelope: { purpose: 'signin', initiatingUserId: null, authEpoch: 4, redirectTarget: '/' },
            config: { trustMissingEmailVerification: false },
            identity: {
                providerKey: 'provider-1',
                subject: 'provider-subject',
                issuer: 'https://issuer.example',
                email: 'ada@example.com',
                emailVerified: true,
                emailVerificationPresent: true
            }
        })
        resolveOidcUser.mockResolvedValueOnce({ ok: false, reason, basis: null })

        const response = await request(app())
            .get('/api/v1/auth/oidc/callback?state=callback-state&code=callback-code')
            .set('x-forwarded-for', `192.0.2.${reason.length + 100}`)

        const error = new URL(response.headers.location, 'http://localhost').searchParams.get('error')
        expect(JSON.parse(error || '{}')).toEqual({ message })
        expect(safeRecordAudit).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                type: 'sign_in_failure',
                detail: expect.objectContaining({ subject: null, matchedUser: null, outcome: reason })
            })
        )
        expect(JSON.stringify(safeRecordAudit.mock.calls.at(-1)?.[1])).not.toContain('provider-subject')
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

describe('OIDC administrator test callback', () => {
    const completion = {
        envelope: { purpose: 'test', initiatingUserId: 'admin-1', authEpoch: 4, redirectTarget: '/authentication-settings' },
        config: { fingerprint: 'draft-fingerprint', trustMissingEmailVerification: false },
        identity: {
            providerKey: 'provider-1',
            subject: 'subject-1',
            issuer: 'https://issuer.example',
            email: 'ada@example.com',
            emailVerified: true,
            emailVerificationPresent: true
        }
    }

    beforeEach(() => {
        jest.clearAllMocks()
        readAuthenticationState.mockResolvedValue({ authenticationEpoch: 4, activeMethod: 'local' })
        establishSession.mockResolvedValue({ user: { id: 'admin-1' } })
        completeOidcAuthorization.mockResolvedValue(completion)
    })

    it('passes only after the identity is accepted by ordinary sign-in rules', async () => {
        resolveOidcUser.mockResolvedValue({ ok: true, user: { id: 'user-1' }, basis: 'email_verified' })

        const response = await request(app()).get('/api/v1/auth/oidc/callback?state=callback-state&code=callback-code')

        expect(response.status).toBe(302)
        expect(response.headers.location).toBe('/authentication-settings?oidcTest=passed')
        expect(resolveOidcUser).toHaveBeenCalledWith(expect.anything(), expect.anything(), completion.identity, {
            trustMissing: false,
            bootstrapEmail: process.env.CUTTLELY_BOOTSTRAP_EMAIL,
            linkIdentity: false
        })
        expect(recordOidcTestResult).toHaveBeenCalledWith(
            expect.anything(),
            'draft-fingerprint',
            expect.objectContaining({ passed: true, identityAccepted: true, assuranceBasis: 'email_verified' })
        )
        expect(recordOidcTestFailure).not.toHaveBeenCalled()
    })

    it.each([
        [
            'a missing email',
            { email: undefined },
            'email_required',
            'The provider did not return an email address, and this identity has no existing subject link.'
        ],
        [
            'an email without assurance',
            { emailVerified: false },
            'email_not_assured',
            'The provider did not assure the returned email address.'
        ],
        ['an email with no matching user', {}, 'unknown', 'No Cuttlely user matches the returned email address.']
    ])('fails for %s without recording a tested fingerprint', async (_name, identityPatch, reason, message) => {
        const identity = { ...completion.identity, ...identityPatch }
        completeOidcAuthorization.mockResolvedValueOnce({ ...completion, identity })
        resolveOidcUser.mockResolvedValue({ ok: false, reason })

        const response = await request(app()).get('/api/v1/auth/oidc/callback?state=callback-state&code=callback-code')

        expect(response.status).toBe(302)
        expect(response.headers.location).toBe('/authentication-settings?oidcTest=failed')
        expect(recordOidcTestFailure).toHaveBeenCalledWith(expect.anything(), 'draft-fingerprint', {
            passed: false,
            steps: ['discovery', 'authorization', 'token', 'signature', 'claims', 'identity'],
            email: identity.email || null,
            reason: message
        })
        expect(recordOidcTestResult).not.toHaveBeenCalled()
    })
})

describe('OIDC administrator callback URLs', () => {
    const originalAppUrl = process.env.APP_URL
    const state = { installationId: 'installation-1', authenticationEpoch: 4, activeMethod: 'oidc' }
    const draft = oidcConfig('draft', 'https://new-id.example', 'new-client', 'draft-fingerprint')
    const active = oidcConfig('active', 'https://old-id.example', 'old-client', 'active-fingerprint')

    beforeEach(() => {
        jest.clearAllMocks()
        process.env.APP_URL = 'https://app.example'
        readAuthenticationState.mockResolvedValue(state)
        migrateLegacyProviderLinks.mockResolvedValue(undefined)
        providerLinkMigrationStatus.mockResolvedValue({ complete: true, migrated: 0, inert: 0, error: null })
        readOidcConfiguration.mockImplementation(async (_dataSource, slot) => (slot === 'draft' ? draft : active))
        recentlyAuthenticated.mockResolvedValue(true)
        checkOidcConfiguration.mockResolvedValue({ issuer: draft.issuer })
        saveOidcDraft.mockResolvedValue(draft)
    })

    afterAll(() => {
        if (originalAppUrl === undefined) delete process.env.APP_URL
        else process.env.APP_URL = originalAppUrl
    })

    it('returns distinct draft and active callback URLs during provider rotation', async () => {
        const response = await request(adminApp()).get('/api/v1/authentication-settings/oidc')
        expect(response.status).toBe(200)
        expect(response.body.callbackUrl).toBe(oidcCallbackUrl(oidcProviderKey(state.installationId, draft.issuer, draft.clientId)))
        expect(response.body.activeCallbackUrl).toBe(oidcCallbackUrl(oidcProviderKey(state.installationId, active.issuer, active.clientId)))
        expect(response.body.callbackUrl).not.toBe(response.body.activeCallbackUrl)
        expect(response.body.testedDraftDiffersFromActive).toBe(true)
    })

    it('reports a tested same-fingerprint discovery refresh', async () => {
        const refreshed = oidcConfig('draft', active.issuer, active.clientId, active.fingerprint)
        refreshed.discovery = { authorization_endpoint: 'https://active-id.example/new-authorize' }
        readOidcConfiguration.mockImplementation(async (_dataSource, slot) => (slot === 'draft' ? refreshed : active))
        const response = await request(adminApp()).get('/api/v1/authentication-settings/oidc')
        expect(response.status).toBe(200)
        expect(response.body.testedDraftDiffersFromActive).toBe(true)
    })

    it('returns the active callback URL when there is no draft', async () => {
        readOidcConfiguration.mockImplementation(async (_dataSource, slot) => (slot === 'draft' ? null : active))
        const response = await request(adminApp()).get('/api/v1/authentication-settings/oidc')
        expect(response.status).toBe(200)
        expect(response.body.callbackUrl).toBeNull()
        expect(response.body.activeCallbackUrl).toBe(oidcCallbackUrl(oidcProviderKey(state.installationId, active.issuer, active.clientId)))
    })

    it('returns both callback URLs after saving a rotating draft', async () => {
        readOidcConfiguration.mockResolvedValue(active)
        const response = await request(adminApp()).put('/api/v1/authentication-settings/oidc').send({
            issuer: draft.issuer,
            clientId: draft.clientId,
            clientSecretEnvVar: draft.clientSecretEnvVar,
            trustMissingEmailVerification: false,
            privateIssuerHosts: [],
            version: 0
        })
        expect(response.status).toBe(200)
        expect(response.body.callbackUrl).toBe(oidcCallbackUrl(oidcProviderKey(state.installationId, draft.issuer, draft.clientId)))
        expect(response.body.activeCallbackUrl).toBe(oidcCallbackUrl(oidcProviderKey(state.installationId, active.issuer, active.clientId)))
    })
})
