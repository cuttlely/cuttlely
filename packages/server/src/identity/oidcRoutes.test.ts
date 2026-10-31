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
const beginOidcAuthorization = jest.fn()
const ensureProviderLink = jest.fn()
const liveInviteUser = jest.fn()

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
        ensureProviderLink,
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
        beginOidcAuthorization,
        checkOidcConfiguration,
        completeOidcAuthorization
    }
})
jest.mock('./actionLink', () => ({ liveInviteUser }))

import { oidcCallbackUrl } from './cookies'
import { OidcError } from './oidcProvider'
import { oidcProviderKey } from './oidcStore'
import { countsTowardCallbackFailureLimit, oidcAdminRouter, oidcAuthRouter, oidcInviteStartUrl } from './oidcRoutes'

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

function successfulSignInCompletion() {
    return {
        envelope: { purpose: 'signin', initiatingUserId: null, authEpoch: 4, redirectTarget: '/signed-in' },
        config: { trustMissingEmailVerification: false },
        identity: {
            providerKey: 'provider-made-up',
            subject: 'subject-made-up',
            issuer: 'https://login.example.test',
            email: 'person@example.test',
            emailVerified: true,
            emailVerificationPresent: true
        }
    }
}

describe('OIDC callback failure-limit classification', () => {
    it.each([
        ['a token endpoint outage', new OidcError('upstream', 'status 503', 'upstream_unavailable'), false],
        ['a token endpoint invalid_grant response', new OidcError('upstream', 'invalid grant', 'token_validation_failed'), true],
        ['a provider denial', new OidcError('denied', 'denied', 'provider_denied'), false],
        ['an invalid authorization response', new OidcError('response', 'invalid response', 'authorization_response_invalid'), true]
    ])('classifies %s', (_name, error, expected) => {
        expect(countsTowardCallbackFailureLimit(error)).toBe(expected)
    })
})

describe('OIDC callback audit outcomes', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        readAuthenticationState.mockResolvedValue({ authenticationEpoch: 4, activeMethod: 'oidc' })
        organizationsForUser.mockResolvedValue(['org-1'])
        ensureProviderLink.mockResolvedValue('existing')
    })

    it.each([
        ['provider_denied', new OidcError('denied', 'denied', 'provider_denied')],
        ['browser_binding_failed', new OidcError('transaction', 'browser', 'browser_binding_failed')],
        ['state_expired_or_unknown', new OidcError('transaction', 'state', 'state_expired_or_unknown')],
        ['token_validation_failed', new OidcError('response', 'token', 'token_validation_failed')],
        ['upstream_unavailable', new OidcError('upstream', 'upstream', 'upstream_unavailable')]
    ])('writes the %s outcome without callback values', async (outcome, failure) => {
        completeOidcAuthorization.mockRejectedValueOnce(failure)
        const response = await request(app()).get('/api/v1/auth/oidc/callback/provider-1?state=callback-state&code=callback-code')
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

        const response = await request(app()).get('/api/v1/auth/oidc/callback/provider-1?state=callback-state&code=callback-code')
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
            expect(resolveOidcUser).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.anything(),
                expect.objectContaining({ linkIdentity: false })
            )
            expect(ensureProviderLink).not.toHaveBeenCalled()
        }
    })

    it.each(['test', 'reauth'])('scopes a known %s callback failure to the initiating user', async (purpose) => {
        completeOidcAuthorization.mockImplementationOnce(async (input: any) => {
            input.onEnvelope?.({
                purpose,
                initiatingUserId: 'admin-1',
                configFingerprint: 'draft-fingerprint'
            })
            input.onBrowserBound?.({ purpose, initiatingUserId: 'admin-1' })
            throw new OidcError('denied', 'denied', 'provider_denied')
        })

        await request(app())
            .get('/api/v1/auth/oidc/callback/provider-1?state=callback-state&error=access_denied')
            .set('x-forwarded-for', `192.0.2.${purpose === 'test' ? 61 : 62}`)

        expect(organizationsForUser).toHaveBeenCalledWith(expect.anything(), 'admin-1')
        expect(safeRecordAudit).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ organizationId: 'org-1', userId: 'admin-1', actorId: 'admin-1' })
        )
    })

    it('does not charge unknown states to the browser-bound callback allowance', async () => {
        const unknown = new OidcError('transaction', 'state', 'state_expired_or_unknown')
        completeOidcAuthorization.mockRejectedValue(unknown)
        const client = request(app())
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const response = await client
                .get(`/api/v1/auth/oidc/callback/provider-1?state=unknown-${attempt}&code=code`)
                .set('x-forwarded-for', '192.0.2.63')
            expect(response.headers.location).not.toContain('Too%20many')
        }
        const next = await client
            .get('/api/v1/auth/oidc/callback/provider-1?state=unknown-next&code=code')
            .set('x-forwarded-for', '192.0.2.63')
        expect(next.headers.location).not.toContain('Too%20many')
        expect(completeOidcAuthorization).toHaveBeenCalledTimes(21)
    })

    it('creates a reauthentication link only after the initiating account matches', async () => {
        completeOidcAuthorization.mockResolvedValueOnce({
            envelope: { purpose: 'reauth', initiatingUserId: 'user-1', authEpoch: 4, redirectTarget: '/authentication-settings' },
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
        resolveOidcUser.mockResolvedValueOnce({
            ok: true,
            user: { id: 'user-1' },
            basis: 'email_verified',
            linkCreated: false
        })
        ensureProviderLink.mockResolvedValueOnce('linked')
        buildAuthContext.mockResolvedValueOnce({})
        issueDatabaseSession.mockResolvedValueOnce({ type: 'json', status: 200, body: {}, cookies: [], clearCookies: [] })

        const response = await request(app()).get('/api/v1/auth/oidc/callback/provider-1?state=callback-state&code=callback-code')

        expect(response.status).toBe(302)
        expect(ensureProviderLink).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: 'user-1', providerKey: 'provider-1', subject: 'subject-1' })
        )
        expect(safeRecordAudit).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'sign_in_success', summary: 'OIDC identity linked' })
        )
    })

    it.each([
        ['unknown', null, 'This identity cannot sign in.'],
        ['invite_required', 'user-1', 'You have a pending invite. Open the invite link from your email to join.'],
        ['invite_invalid', 'user-1', 'This invite link is not valid. Ask for a new invite.']
    ])('returns the sign-in guidance for %s and scopes a known user', async (reason, matchedUserId, message) => {
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
        resolveOidcUser.mockResolvedValueOnce({ ok: false, reason, basis: null, ...(matchedUserId ? { matchedUserId } : {}) })

        const response = await request(app())
            .get('/api/v1/auth/oidc/callback/provider-1?state=callback-state&code=callback-code')
            .set('x-forwarded-for', `192.0.2.${reason.length + 100}`)

        const error = new URL(response.headers.location, 'http://localhost').searchParams.get('error')
        expect(JSON.parse(error || '{}')).toEqual({ message })
        expect(safeRecordAudit).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                type: 'sign_in_failure',
                organizationId: matchedUserId ? 'org-1' : '',
                userId: matchedUserId,
                detail: expect.objectContaining({
                    subject: matchedUserId ? 'provider-subject' : null,
                    matchedUser: matchedUserId,
                    outcome: reason
                })
            })
        )
        if (!matchedUserId) expect(JSON.stringify(safeRecordAudit.mock.calls.at(-1)?.[1])).not.toContain('provider-subject')
    })

    it.each([
        [false, 'OIDC sign-in succeeded', 'signed_in'],
        [true, 'OIDC identity linked', 'linked']
    ])('audits a successful sign-in with linkCreated=%s', async (linkCreated, summary, outcome) => {
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
        resolveOidcUser.mockResolvedValueOnce({
            ok: true,
            user: { id: 'user-1' },
            basis: 'email_verified',
            linkCreated
        })
        buildAuthContext.mockResolvedValueOnce({})
        issueDatabaseSession.mockResolvedValueOnce({ type: 'json', status: 200, body: {}, cookies: [], clearCookies: [] })

        const response = await request(app()).get('/api/v1/auth/oidc/callback/provider-1?state=callback-state&code=callback-code')

        expect(response.status).toBe(302)
        expect(safeRecordAudit).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                type: 'sign_in_success',
                organizationId: 'org-1',
                userId: 'user-1',
                summary,
                detail: expect.objectContaining({ matchedUser: 'user-1', subject: 'provider-subject', outcome })
            })
        )
    })

    it('does not throttle a valid callback after repeated bound provider denials', async () => {
        const completion = successfulSignInCompletion()
        let completionAttempt = 0
        completeOidcAuthorization.mockImplementation(async (input: any) => {
            completionAttempt += 1
            if (completionAttempt <= 21) {
                input.onEnvelope?.(completion.envelope)
                input.onBrowserBound?.(completion.envelope)
                throw new OidcError('denied', 'denied', 'provider_denied')
            }
            return completion
        })
        resolveOidcUser.mockResolvedValue({ ok: true, user: { id: 'user-made-up' }, basis: 'email_verified', linkCreated: false })
        buildAuthContext.mockResolvedValue({})
        issueDatabaseSession.mockResolvedValue({ type: 'json', status: 200, body: {}, cookies: [], clearCookies: [] })
        const client = request(app())
        const callback = () =>
            client
                .get('/api/v1/auth/oidc/callback/provider-made-up?state=callback-state&error=access_denied')
                .set('x-forwarded-for', '192.0.2.89')

        for (let attempt = 0; attempt < 21; attempt += 1) {
            const response = await callback()
            expect(response.headers.location).not.toContain('Too%20many')
        }

        const valid = await client
            .get('/api/v1/auth/oidc/callback/provider-made-up?state=valid-state&code=valid-code')
            .set('x-forwarded-for', '192.0.2.89')
        expect(valid.status).toBe(302)
        expect(valid.headers.location).toBe('/signed-in')
        expect(completeOidcAuthorization).toHaveBeenCalledTimes(22)
    })

    it('does not throttle a valid callback after repeated unprovisioned identity refusals', async () => {
        const completion = successfulSignInCompletion()
        let resolutionAttempt = 0
        completeOidcAuthorization.mockResolvedValue(completion)
        resolveOidcUser.mockImplementation(async () => {
            resolutionAttempt += 1
            if (resolutionAttempt <= 21) return { ok: false, reason: 'unknown', basis: null }
            return { ok: true, user: { id: 'user-made-up' }, basis: 'email_verified', linkCreated: false }
        })
        buildAuthContext.mockResolvedValue({})
        issueDatabaseSession.mockResolvedValue({ type: 'json', status: 200, body: {}, cookies: [], clearCookies: [] })
        const client = request(app())
        const callback = () =>
            client
                .get('/api/v1/auth/oidc/callback/provider-made-up?state=callback-state&code=callback-code')
                .set('x-forwarded-for', '192.0.2.90')

        for (let attempt = 0; attempt < 21; attempt += 1) {
            const response = await callback()
            const error = new URL(response.headers.location, 'http://localhost').searchParams.get('error')
            expect(JSON.parse(error || '{}')).toEqual({ message: 'This identity cannot sign in.' })
        }

        const valid = await callback()
        expect(valid.status).toBe(302)
        expect(valid.headers.location).toBe('/signed-in')
        expect(completeOidcAuthorization).toHaveBeenCalledTimes(22)
    })

    it('throttles the next callback after twenty bound token-validation failures', async () => {
        const completion = successfulSignInCompletion()
        completeOidcAuthorization.mockImplementation(async (input: any) => {
            input.onEnvelope?.(completion.envelope)
            input.onBrowserBound?.(completion.envelope)
            throw new OidcError('response', 'nonce mismatch', 'token_validation_failed')
        })
        const client = request(app())
        const callback = () =>
            client
                .get('/api/v1/auth/oidc/callback/provider-made-up?state=callback-state&code=callback-code')
                .set('x-forwarded-for', '192.0.2.91')

        for (let attempt = 0; attempt < 20; attempt += 1) {
            const response = await callback()
            expect(response.headers.location).not.toContain('Too%20many')
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
        envelope: {
            purpose: 'test',
            initiatingUserId: 'admin-1',
            authEpoch: 4,
            redirectTarget: '/authentication-settings',
            configFingerprint: 'draft-fingerprint'
        },
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

        const response = await request(app()).get('/api/v1/auth/oidc/callback/provider-1?state=callback-state&code=callback-code')

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

        const response = await request(app()).get('/api/v1/auth/oidc/callback/provider-1?state=callback-state&code=callback-code')

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

    it.each([
        ['provider denial', new OidcError('denied', 'denied', 'provider_denied'), 'provider_denied'],
        ['token response failure', new OidcError('response', 'token', 'token_validation_failed'), 'token_validation_failed'],
        ['provider response failure', new OidcError('response', 'profile', 'userinfo_invalid'), 'userinfo_invalid'],
        ['provider connection failure', new OidcError('upstream', 'offline', 'upstream_unavailable'), 'upstream_unavailable']
    ])('clears an earlier pass after %s', async (_name, failure, outcome) => {
        completeOidcAuthorization.mockImplementationOnce(async (input: any) => {
            input.onEnvelope?.(completion.envelope)
            throw failure
        })

        const response = await request(app()).get('/api/v1/auth/oidc/callback/provider-1?state=callback-state&code=callback-code')

        expect(response.status).toBe(302)
        expect(response.headers.location).toBe('/authentication-settings?oidcTest=failed')
        expect(recordOidcTestFailure).toHaveBeenCalledWith(
            expect.anything(),
            'draft-fingerprint',
            expect.objectContaining({ passed: false, email: null, outcome })
        )
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
        expect(new URL(response.body.callbackUrl).search).toBe('')
        expect(new URL(response.body.callbackUrl).pathname).toMatch(/\/callback\/[a-f0-9]{64}$/)
        expect(response.body).not.toHaveProperty('postLogoutUrl')
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

describe('OIDC invitation starts', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        readAuthenticationState.mockResolvedValue({ installationId: 'installation-1', authenticationEpoch: 4, activeMethod: 'oidc' })
        beginOidcAuthorization.mockResolvedValue({ url: 'https://id.example/authorize', browserNonce: 'browser-nonce' })
    })

    it('checks the pending invitation before creating an authorization transaction', async () => {
        liveInviteUser.mockResolvedValueOnce(null)
        await expect(oidcInviteStartUrl({ ip: '192.0.2.71' } as any, 'invalid-token')).rejects.toThrow('This invite link is not valid.')
        expect(beginOidcAuthorization).not.toHaveBeenCalled()

        liveInviteUser.mockResolvedValueOnce('user-1')
        await expect(oidcInviteStartUrl({ ip: '192.0.2.72' } as any, 'valid-token')).resolves.toEqual({
            url: 'https://id.example/authorize',
            browserNonce: 'browser-nonce'
        })
        expect(beginOidcAuthorization).toHaveBeenCalledTimes(1)
    })

    it('counts invalid invitation starts in the shared failure allowance', async () => {
        liveInviteUser.mockResolvedValue(null)
        const req = { ip: '192.0.2.73' } as any
        for (let attempt = 0; attempt < 20; attempt += 1) {
            await expect(oidcInviteStartUrl(req, `invalid-token-${attempt}`)).rejects.toThrow('This invite link is not valid.')
        }
        await expect(oidcInviteStartUrl(req, 'invalid-token-limited')).rejects.toThrow('Too many attempts.')
        expect(liveInviteUser).toHaveBeenCalledTimes(20)
        expect(beginOidcAuthorization).not.toHaveBeenCalled()
    })
})
