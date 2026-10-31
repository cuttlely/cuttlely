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
const createMapping = jest.fn()
const previewMappingCreation = jest.fn()

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
    localAdminEnabled: () => true,
    localUsersSetting: () => true,
    workosEnvironmentConfigured: () => true
}))
jest.mock('./auditLog', () => ({ safeRecordAudit: jest.fn() }))
jest.mock('./scimGroups', () => ({
    createMapping,
    mappingOptions: jest.fn(async () => ({ mappings: [], groups: [], workspaces: [], roles: [] })),
    previewMappingCreation,
    previewMappingRemoval: jest.fn(),
    readScimOperations: jest.fn(async () => ({ counts: {}, recentErrors: [], retentionDays: 30 })),
    removeMapping: jest.fn()
}))
jest.mock('./recovery', () => ({
    acknowledgeRecoveryAlert: jest.fn(),
    currentRecoveryAlert: jest.fn(async () => null)
}))

import { identityAuthenticationRouter } from './authenticationRoutes'
import { safeRecordAudit } from './auditLog'

function app(cookies: Record<string, string> = {}) {
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
    server.use('/api/v1/authentication-settings', identityAuthenticationRouter)
    return server
}

describe('authentication settings routes', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: ['authentication:manage'] }) })
        readAuthenticationState.mockResolvedValue(state)
        findSuperUser.mockResolvedValue({ id: 'owner-1', credential: 'bcrypt' })
        localAccountOpen.mockResolvedValue(true)
        usableLocalOwnerReady.mockResolvedValue(true)
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'local' })
        hasRecentAuthentication.mockResolvedValue(false)
        stageAuthenticationMethodSwitch.mockResolvedValue({ id: 'stage-1', version: 1, expiresAt: new Date('2026-11-01T00:00:00Z') })
        switchAuthenticationMethod.mockResolvedValue({
            activeMethod: 'workos',
            authenticationEpoch: 3,
            sessionsEnded: 2
        })
        acknowledgeAuthenticationWarning.mockResolvedValue({ version: 5, authenticationEpoch: 3, sessionsEnded: 2 })
        previewMappingCreation.mockResolvedValue({
            mapping: { groupId: 'group-1', workspaceId: 'team-1', roleId: 'role-1' },
            assignments: [],
            conflicts: [],
            fingerprint: 'preview-1'
        })
        createMapping.mockResolvedValue({ id: 'mapping-1' })
    })

    afterAll(() => setTeamPermissionLookup(null))

    it('refuses callers without authentication:manage', async () => {
        setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: [] }) })
        expect((await request(app({ 'local-session': 'fresh' })).get('/api/v1/authentication-settings')).status).toBe(403)
        expect(readAuthenticationState).not.toHaveBeenCalled()
    })

    it('requires a fresh authentication before staging', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(Date.now() - 11 * 60 * 1000) })
        const response = await request(app({ 'local-session': 'old' }))
            .post('/api/v1/authentication-settings/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body.code).toBe('REAUTH_REQUIRED')
        expect(stageAuthenticationMethodSwitch).not.toHaveBeenCalled()
    })

    it('stages successfully after a fresh local authentication', async () => {
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication-settings/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(200)
        expect(response.body).toMatchObject({ stage: 'stage-1', stageVersion: 1, method: 'workos', sessionsWillEnd: true })
        expect(stageAuthenticationMethodSwitch).toHaveBeenCalledWith(expect.anything(), 'owner-1', 'workos', 4)
    })

    it('does not treat a fresh WorkOS database session as recent authentication', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'workos' })
        const response = await request(app({ 'local-session': 'workos-session' }))
            .post('/api/v1/authentication-settings/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body.code).toBe('REAUTH_REQUIRED')
        expect(hasRecentAuthentication).not.toHaveBeenCalled()
    })

    it('treats a fresh owner recovery database session as recent authentication', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'recovery' })
        const response = await request(app({ 'local-session': 'recovery-session' }))
            .post('/api/v1/authentication-settings/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(200)
    })

    it('accepts signed recent-auth evidence for a WorkOS session with proven auth_time', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'workos' })
        hasRecentAuthentication.mockResolvedValue(true)
        const response = await request(app({ 'local-session': 'workos-session', 'recent-auth': 'proven-auth-time' }))
            .post('/api/v1/authentication-settings/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(200)
        expect(hasRecentAuthentication).toHaveBeenCalledWith(expect.anything(), 'owner-1', 'proven-auth-time')
    })

    it('previews mapping creation without changing state and requires fresh authentication to confirm it', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(Date.now() - 11 * 60 * 1000), authenticationMethod: 'local' })
        const body = { groupId: 'group-1', workspaceId: 'team-1', roleId: 'role-1' }
        const preview = await request(app({ 'local-session': 'old' }))
            .post('/api/v1/authentication-settings/scim-mappings/preview')
            .send(body)
        expect(preview.status).toBe(200)
        expect(preview.body.fingerprint).toBe('preview-1')
        expect(previewMappingCreation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'owner-1' }), body)
        expect(createMapping).not.toHaveBeenCalled()

        const refused = await request(app({ 'local-session': 'old' }))
            .post('/api/v1/authentication-settings/scim-mappings/confirm')
            .send({ ...body, fingerprint: 'preview-1' })
        expect(refused.status).toBe(409)
        expect(createMapping).not.toHaveBeenCalled()

        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'local' })
        const confirmed = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication-settings/scim-mappings/confirm')
            .send({ ...body, fingerprint: 'preview-1' })
        expect(confirmed.status).toBe(201)
        expect(createMapping).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ id: 'owner-1' }),
            expect.anything(),
            'preview-1'
        )
    })

    it('refuses a WorkOS-to-Local stage without an active owner password', async () => {
        readAuthenticationState.mockResolvedValue({ ...state, activeMethod: 'workos' })
        usableLocalOwnerReady.mockResolvedValue(false)
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication-settings/stage')
            .send({ method: 'local', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body).toMatchObject({ code: 'LOCAL_OWNER_REQUIRED' })
        expect(stageAuthenticationMethodSwitch).not.toHaveBeenCalled()
    })

    it('keeps the WorkOS recovery gate ahead of recent-auth staging', async () => {
        usableLocalOwnerReady.mockResolvedValue(false)
        findLocalSession.mockResolvedValue({ issuedAt: new Date(), authenticationMethod: 'local' })
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication-settings/stage')
            .send({ method: 'workos', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body.code).toBe('RECOVERY_REQUIRED')
        expect(stageAuthenticationMethodSwitch).not.toHaveBeenCalled()
    })

    it('validates stage and apply requests', async () => {
        expect(
            (
                await request(app({ 'local-session': 'fresh' }))
                    .post('/api/v1/authentication-settings/stage')
                    .send({ method: 'oidc', version: 4 })
            ).status
        ).toBe(400)
        expect(
            (
                await request(app({ 'local-session': 'fresh' }))
                    .post('/api/v1/authentication-settings/apply')
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
                    .post('/api/v1/authentication-settings/apply')
                    .send({ stage: 7 })
            ).status
        ).toBe(409)
        expect(switchAuthenticationMethod).not.toHaveBeenCalled()
    })

    it('requires a fresh authentication again when applying a staged change', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(Date.now() - 11 * 60 * 1000) })
        const response = await request(app({ 'local-session': 'old' }))
            .post('/api/v1/authentication-settings/apply')
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
            .post('/api/v1/authentication-settings/apply')
            .send(body)
        expect(applied.status).toBe(200)
        expect(applied.body).toEqual({
            applied: true,
            redirectTo: '/signin',
            activeMethod: 'workos',
            authenticationEpoch: 3,
            sessionsEnded: 2
        })

        switchAuthenticationMethod.mockRejectedValueOnce(new Error('AUTH_STATE_CHANGED'))
        const stale = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication-settings/apply')
            .send(body)
        expect(stale.status).toBe(409)
        expect(stale.body.message).toContain('changed')
    })

    it('reports an owner-password refusal during apply', async () => {
        switchAuthenticationMethod.mockRejectedValueOnce(new Error('LOCAL_OWNER_REQUIRED'))
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication-settings/apply')
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
            .post('/api/v1/authentication-settings/apply')
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
    })

    it('reports the session-ending warning acknowledgment transition', async () => {
        const response = await request(app({ 'local-session': 'fresh' }))
            .post('/api/v1/authentication-settings/acknowledge-warning')
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
                    .post('/api/v1/authentication-settings/stage')
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
                    .post('/api/v1/authentication-settings/apply')
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
