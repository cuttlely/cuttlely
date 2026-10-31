/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import express from 'express'
import request from 'supertest'
import { setTeamPermissionLookup } from './rbac'

const state = {
    activeMethod: 'local',
    providerKey: null,
    version: 4,
    authenticationEpoch: 2,
    warning: null
}
const findLocalSession = jest.fn()
const findSuperUser = jest.fn()
const localAccountOpen = jest.fn()
const readAuthenticationState = jest.fn()
const stageAuthenticationMethodSwitch = jest.fn()
const switchAuthenticationMethod = jest.fn()
const acknowledgeAuthenticationWarning = jest.fn()
const usableLocalOwnerReady = jest.fn()
const hasRecentAuthentication = jest.fn()
const readOidcConfiguration = jest.fn()
const providerLinkMigrationComplete = jest.fn()
const testedOidcDraftDiffersFromActive = jest.fn()
const oidcCallbackError = jest.fn()

jest.mock('./production', () => ({
    applicationDataSource: () => ({}),
    applicationSql: () => ({}),
    identityStore: () => ({ findLocalSession, findSuperUser, localAccountOpen })
}))
jest.mock('./authenticationState', () => ({
    acknowledgeAuthenticationWarning,
    hasRecentAuthentication,
    initializeAuthenticationState: jest.fn(),
    readAuthenticationState,
    stageAuthenticationMethodSwitch,
    switchAuthenticationMethod,
    usableLocalOwnerReady,
    workosConfigurationFingerprint: () => 'fingerprint'
}))
jest.mock('./constants', () => ({
    LOGIN_FAILURE_WINDOW_MS: 15 * 60 * 1000,
    LOCAL_SESSION_COOKIE: 'local-session',
    RECENT_AUTH_COOKIE: 'recent-auth',
    localAdminEnabled: jest.fn(),
    localUsersSetting: jest.fn(),
    workosEnvironmentConfigured: () => true
}))
jest.mock('./auditLog', () => ({ safeRecordAudit: jest.fn() }))
jest.mock('./oidcStore', () => {
    const actual = jest.requireActual('./oidcStore')
    return { ...actual, readOidcConfiguration, providerLinkMigrationComplete, testedOidcDraftDiffersFromActive }
})
jest.mock('./oidcProvider', () => ({ oidcCallbackError }))
jest.mock('./recovery', () => ({
    acknowledgeRecoveryAlert: jest.fn(),
    currentRecoveryAlert: jest.fn(async () => null)
}))

import {
    databaseSessionRecentlyAuthenticated,
    identityAuthenticationRouter,
    resetAuthenticationRouteLimitsForTests
} from './authenticationRoutes'
import { safeRecordAudit } from './auditLog'
import { localAdminEnabled, localUsersSetting } from './constants'

const mockLocalAdminEnabled = localAdminEnabled as jest.Mock
const mockLocalUsersSetting = localUsersSetting as jest.Mock

function app(cookieOrCookies: string | Record<string, string> = {}, recent?: string) {
    const cookies =
        typeof cookieOrCookies === 'string'
            ? { 'local-session': cookieOrCookies, ...(recent ? { 'recent-auth': recent } : {}) }
            : cookieOrCookies
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        req.user = {
            id: 'owner-1',
            activeOrganizationId: 'org-1',
            activeWorkspaceId: 'team-1',
            permissions: []
        }
        req.cookies = cookies
        next()
    })
    server.use('/api/v1/authentication', identityAuthenticationRouter)
    return server
}

describe('authentication settings routes', () => {
    beforeEach(async () => {
        await resetAuthenticationRouteLimitsForTests()
        jest.clearAllMocks()
        setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: ['authentication:manage'] }) })
        readAuthenticationState.mockResolvedValue(state)
        findSuperUser.mockResolvedValue({ id: 'owner-1', credential: 'bcrypt' })
        localAccountOpen.mockResolvedValue(true)
        usableLocalOwnerReady.mockResolvedValue(true)
        readOidcConfiguration.mockResolvedValue(null)
        providerLinkMigrationComplete.mockResolvedValue(true)
        testedOidcDraftDiffersFromActive.mockReturnValue(false)
        hasRecentAuthentication.mockResolvedValue(false)
        oidcCallbackError.mockReturnValue(null)
        mockLocalAdminEnabled.mockReturnValue(true)
        mockLocalUsersSetting.mockReturnValue(true)
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'local' })
        stageAuthenticationMethodSwitch.mockResolvedValue({ id: 'stage-1', version: 1, expiresAt: new Date('2026-11-01T00:00:00Z') })
        switchAuthenticationMethod.mockResolvedValue({
            activeMethod: 'workos',
            authenticationEpoch: 3,
            sessionsEnded: 2,
            change: 'method'
        })
        acknowledgeAuthenticationWarning.mockResolvedValue({ version: 5, authenticationEpoch: 3, sessionsEnded: 2 })
    })

    afterAll(() => setTeamPermissionLookup(null))

    it('counts only fresh local-password and owner-recovery sessions', async () => {
        const now = Date.parse('2026-10-31T12:00:00.000Z')
        const store = { findLocalSession }
        for (const method of ['local', 'recovery'] as const) {
            findLocalSession.mockResolvedValueOnce({ issuedAt: new Date(now), authenticationMethod: method })
            await expect(databaseSessionRecentlyAuthenticated(store, `${method}-session`, now)).resolves.toBe(true)
        }
        findLocalSession.mockResolvedValueOnce({ issuedAt: new Date(now), authenticationMethod: 'workos' })
        await expect(databaseSessionRecentlyAuthenticated(store, 'workos-session', now)).resolves.toBe(false)
        findLocalSession.mockResolvedValueOnce({ issuedAt: new Date(now - 11 * 60 * 1000), authenticationMethod: 'local' })
        await expect(databaseSessionRecentlyAuthenticated(store, 'old-local-session', now)).resolves.toBe(false)
        findLocalSession.mockResolvedValueOnce({ issuedAt: new Date(now + 1), authenticationMethod: 'recovery' })
        await expect(databaseSessionRecentlyAuthenticated(store, 'future-recovery-session', now)).resolves.toBe(false)
    })

    it('refuses callers without authentication:manage', async () => {
        setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: [] }) })
        expect((await request(app({ 'local-session': 'fresh' })).get('/api/v1/authentication')).status).toBe(403)
        expect(readAuthenticationState).not.toHaveBeenCalled()
    })

    it('reports owner-only Local login as configured but unavailable for switching', async () => {
        mockLocalUsersSetting.mockReturnValue(false)
        const response = await request(app({ 'local-session': 'fresh' })).get('/api/v1/authentication')
        expect(response.status).toBe(200)
        expect(response.body.methods.local).toEqual({ configured: true, selectable: false, scope: 'owner-only', label: 'Local login' })
    })

    it('refuses an owner-only WorkOS-to-Local stage', async () => {
        mockLocalUsersSetting.mockReturnValue(false)
        readAuthenticationState.mockResolvedValue({ ...state, activeMethod: 'workos' })
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'recovery' })
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication/stage')
            .send({ method: 'local', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body).toEqual({
            code: 'METHOD_NOT_READY',
            message: 'Set CUTTLELY_LOCAL_USERS=true before switching to Local.'
        })
        expect(stageAuthenticationMethodSwitch).not.toHaveBeenCalled()
    })

    it('stages a WorkOS-to-Local change with local users enabled', async () => {
        readAuthenticationState.mockResolvedValue({ ...state, activeMethod: 'workos' })
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'recovery' })
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication/stage')
            .send({ method: 'local', version: 4 })
        expect(response.status).toBe(200)
        expect(stageAuthenticationMethodSwitch).toHaveBeenCalledWith(expect.anything(), 'owner-1', 'local', 4)
    })

    it('requires a fresh authentication before staging', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(Date.now() - 11 * 60 * 1000) })
        const response = await request(app({ 'local-session': 'old' }))
            .post('/api/v1/authentication/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body.code).toBe('REAUTH_REQUIRED')
        expect(stageAuthenticationMethodSwitch).not.toHaveBeenCalled()
    })

    it('stages successfully after a fresh local authentication', async () => {
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(200)
        expect(response.body).toMatchObject({ stage: 'stage-1', stageVersion: 1, method: 'workos', sessionsWillEnd: true })
        expect(stageAuthenticationMethodSwitch).toHaveBeenCalledWith(expect.anything(), 'owner-1', 'workos', 4)
    })

    it('requires the recorded recent-auth time for an OIDC database session', async () => {
        readAuthenticationState.mockResolvedValue({ ...state, activeMethod: 'oidc', configurationFingerprint: 'oidc-fingerprint' })
        readOidcConfiguration.mockResolvedValue({
            health: 'ready',
            fingerprint: 'oidc-fingerprint',
            testedFingerprint: 'oidc-fingerprint',
            testResult: { identityAccepted: true }
        })
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'oidc' })
        const cookies = 'fresh'
        const refused = await request(app(cookies)).post('/api/v1/authentication/stage').send({ method: 'oidc', version: 4 })
        expect(refused.status).toBe(409)
        expect(refused.body.code).toBe('REAUTH_REQUIRED')

        hasRecentAuthentication.mockResolvedValue(true)
        const allowed = await request(app(cookies, 'recorded')).post('/api/v1/authentication/stage').send({ method: 'oidc', version: 4 })
        expect(allowed.status).toBe(200)
        expect(hasRecentAuthentication).toHaveBeenCalledWith(expect.anything(), 'owner-1', 'recorded')
    })

    it('does not treat a fresh WorkOS database session as recent authentication', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'workos' })
        const response = await request(app({ 'local-session': 'workos-session' }))
            .post('/api/v1/authentication/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body.code).toBe('REAUTH_REQUIRED')
        expect(hasRecentAuthentication).not.toHaveBeenCalled()
    })

    it('treats a fresh owner recovery database session as recent authentication', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'recovery' })
        const response = await request(app({ 'local-session': 'recovery-session' }))
            .post('/api/v1/authentication/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(200)
    })

    it('does not let a separate recent-auth cookie make a WorkOS session recent', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'workos' })
        const response = await request(app({ 'local-session': 'workos-session', 'recent-auth': 'old-cookie' }))
            .post('/api/v1/authentication/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body.code).toBe('REAUTH_REQUIRED')
        expect(hasRecentAuthentication).not.toHaveBeenCalled()
    })

    it('refuses a WorkOS-to-Local stage without an active owner password', async () => {
        readAuthenticationState.mockResolvedValue({ ...state, activeMethod: 'workos' })
        usableLocalOwnerReady.mockResolvedValue(false)
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication/stage')
            .send({ method: 'local', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body).toMatchObject({ code: 'LOCAL_OWNER_REQUIRED' })
        expect(stageAuthenticationMethodSwitch).not.toHaveBeenCalled()
    })

    it('keeps the WorkOS recovery gate ahead of recent-auth staging', async () => {
        usableLocalOwnerReady.mockResolvedValue(false)
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'local' })
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body.code).toBe('RECOVERY_REQUIRED')
        expect(stageAuthenticationMethodSwitch).not.toHaveBeenCalled()
    })

    it('requires a matching OIDC test and completed link migration before staging', async () => {
        readOidcConfiguration.mockResolvedValue({ health: 'ready', fingerprint: 'oidc-fingerprint', testedFingerprint: null })
        const untested = await request(app('fresh')).post('/api/v1/authentication/stage').send({ method: 'oidc', version: 4 })
        expect(untested.status).toBe(409)
        expect(untested.body.code).toBe('OIDC_TEST_REQUIRED')

        readOidcConfiguration.mockResolvedValue({
            health: 'ready',
            fingerprint: 'oidc-fingerprint',
            testedFingerprint: 'oidc-fingerprint'
        })
        const oldFalsePositive = await request(app('fresh')).post('/api/v1/authentication/stage').send({ method: 'oidc', version: 4 })
        expect(oldFalsePositive.status).toBe(409)
        expect(oldFalsePositive.body.code).toBe('OIDC_TEST_REQUIRED')

        readOidcConfiguration.mockResolvedValue({
            health: 'ready',
            fingerprint: 'oidc-fingerprint',
            testedFingerprint: 'oidc-fingerprint',
            testResult: { identityAccepted: true }
        })
        providerLinkMigrationComplete.mockResolvedValue(false)
        const migrating = await request(app('fresh')).post('/api/v1/authentication/stage').send({ method: 'oidc', version: 4 })
        expect(migrating.status).toBe(409)
        expect(migrating.body.code).toBe('LINK_MIGRATION_REQUIRED')

        providerLinkMigrationComplete.mockResolvedValue(true)
        const ready = await request(app('fresh')).post('/api/v1/authentication/stage').send({ method: 'oidc', version: 4 })
        expect(ready.status).toBe(200)
        expect(stageAuthenticationMethodSwitch).toHaveBeenCalledWith(expect.anything(), 'owner-1', 'oidc', 4, 'oidc-fingerprint')
    })

    it('refuses OIDC activation when APP_URL cannot produce an HTTPS callback', async () => {
        readOidcConfiguration.mockResolvedValue({
            health: 'ready',
            fingerprint: 'oidc-fingerprint',
            testedFingerprint: 'oidc-fingerprint',
            testResult: { identityAccepted: true }
        })
        oidcCallbackError.mockReturnValue('Set APP_URL to the public HTTPS address before activating OIDC.')
        const response = await request(app('fresh')).post('/api/v1/authentication/stage').send({ method: 'oidc', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body).toEqual({
            code: 'OIDC_HTTPS_REQUIRED',
            message: 'Set APP_URL to the public HTTPS address before activating OIDC.'
        })
        expect(stageAuthenticationMethodSwitch).not.toHaveBeenCalled()
    })

    it('validates stage and apply requests', async () => {
        expect((await request(app('fresh')).post('/api/v1/authentication/stage').send({ method: 'oidc', version: 4 })).status).toBe(409)
        expect(
            (
                await request(app({ 'local-session': 'fresh' }))
                    .post('/api/v1/authentication/apply')
                    .send({
                        stage: 'stage-1',
                        stageVersion: 1,
                        method: 'workos',
                        stateVersion: 4,
                        confirm: 'yes'
                    })
            ).status
        ).toBe(400)
        expect(
            (
                await request(app({ 'local-session': 'fresh' }))
                    .post('/api/v1/authentication/apply')
                    .send({ stage: 7 })
            ).status
        ).toBe(409)
        expect(switchAuthenticationMethod).not.toHaveBeenCalled()
    })

    it('requires a fresh authentication again when applying a staged change', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(Date.now() - 11 * 60 * 1000) })
        const response = await request(app({ 'local-session': 'old' }))
            .post('/api/v1/authentication/apply')
            .send({
                stage: 'stage-1',
                stageVersion: 1,
                method: 'workos',
                stateVersion: 4,
                confirm: 'END SESSIONS'
            })
        expect(response.status).toBe(409)
        expect(response.body.code).toBe('REAUTH_REQUIRED')
        expect(switchAuthenticationMethod).not.toHaveBeenCalled()
    })

    it('applies a staged change and reports stale state', async () => {
        const body = {
            stage: 'stage-1',
            stageVersion: 1,
            method: 'workos',
            stateVersion: 4,
            confirm: 'END SESSIONS'
        }
        const applied = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication/apply')
            .send(body)
        expect(applied.status).toBe(200)
        expect(applied.body).toEqual({
            applied: true,
            refreshed: false,
            redirectTo: '/signin',
            activeMethod: 'workos',
            authenticationEpoch: 3,
            sessionsEnded: 2
        })

        switchAuthenticationMethod.mockRejectedValueOnce(new Error('AUTH_STATE_CHANGED'))
        const stale = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication/apply')
            .send(body)
        expect(stale.status).toBe(409)
        expect(stale.body.message).toContain('changed')
    })

    it('applies a same-fingerprint OIDC refresh without a session-ending confirmation', async () => {
        readAuthenticationState.mockResolvedValue({ ...state, activeMethod: 'oidc', configurationFingerprint: 'oidc-fingerprint' })
        readOidcConfiguration.mockResolvedValue({
            health: 'ready',
            fingerprint: 'oidc-fingerprint',
            testedFingerprint: 'oidc-fingerprint',
            testResult: { identityAccepted: true }
        })
        hasRecentAuthentication.mockResolvedValue(true)
        testedOidcDraftDiffersFromActive.mockReturnValue(true)
        switchAuthenticationMethod.mockResolvedValue({
            activeMethod: 'oidc',
            authenticationEpoch: 2,
            sessionsEnded: 7,
            change: 'oidc_refresh'
        })
        const staged = await request(app('session', 'recorded')).post('/api/v1/authentication/stage').send({ method: 'oidc', version: 4 })
        expect(staged.status).toBe(200)
        expect(staged.body).toMatchObject({ action: 'oidc_refresh', sessionsWillEnd: false })

        const applied = await request(app('session', 'recorded')).post('/api/v1/authentication/apply').send({
            stage: 'stage-1',
            stageVersion: 1,
            method: 'oidc',
            stateVersion: 4,
            confirm: 'APPLY SETTINGS'
        })
        expect(applied.status).toBe(200)
        expect(applied.body).toEqual({
            applied: true,
            refreshed: true,
            redirectTo: null,
            activeMethod: 'oidc',
            authenticationEpoch: 2,
            sessionsEnded: 0
        })
    })

    it('reports an owner-password refusal during apply', async () => {
        switchAuthenticationMethod.mockRejectedValueOnce(new Error('LOCAL_OWNER_REQUIRED'))
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication/apply')
            .send({
                stage: 'stage-1',
                stageVersion: 1,
                method: 'local',
                stateVersion: 4,
                confirm: 'END SESSIONS'
            })
        expect(response.status).toBe(409)
        expect(response.body.message).toContain('active owner')
    })

    it('records a failed apply as failed rather than refused', async () => {
        switchAuthenticationMethod.mockRejectedValueOnce(new Error('METHOD_NOT_READY'))
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication/apply')
            .send({
                stage: 'stage-1',
                stageVersion: 1,
                method: 'local',
                stateVersion: 4,
                confirm: 'END SESSIONS'
            })
        expect(response.status).toBe(409)
        expect(safeRecordAudit).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ summary: 'Sign-in method change failed', detail: expect.objectContaining({ outcome: 'failed' }) })
        )
        expect(response.body.message).toBe('Set CUTTLELY_LOCAL_USERS=true before switching to Local.')
    })

    it('reports the session-ending warning acknowledgment transition', async () => {
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication/acknowledge-warning')
            .send({ version: 4 })
        expect(response.status).toBe(200)
        expect(response.body).toEqual({
            acknowledged: true,
            redirectTo: '/signin',
            version: 5,
            authenticationEpoch: 3,
            sessionsEnded: 2
        })
        expect(acknowledgeAuthenticationWarning).toHaveBeenCalledWith(expect.anything(), 4, {
            organizationId: 'org-1',
            actorId: 'owner-1'
        })
    })

    it('limits repeated stage requests', async () => {
        let status = 0
        for (let attempt = 0; attempt < 12 && status !== 429; attempt++) {
            status = (
                await request(app({ 'local-session': 'fresh' }))
                    .post('/api/v1/authentication/stage')
                    .send({ method: 'workos', version: 4 })
            ).status
        }
        expect(status).toBe(429)
    })

    it('limits repeated apply requests', async () => {
        let status = 0
        for (let attempt = 0; attempt < 12 && status !== 429; attempt++) {
            status = (
                await request(app({ 'local-session': 'fresh' }))
                    .post('/api/v1/authentication/apply')
                    .send({
                        stage: 'stage-1',
                        stageVersion: 1,
                        method: 'workos',
                        stateVersion: 4,
                        confirm: 'END SESSIONS'
                    })
            ).status
        }
        expect(status).toBe(429)
    })
})
