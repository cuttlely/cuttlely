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

jest.mock('./production', () => ({
    applicationDataSource: () => ({}),
    applicationSql: () => ({}),
    identityStore: () => ({ findLocalSession, findSuperUser, localAccountOpen })
}))
jest.mock('./authenticationState', () => ({
    acknowledgeAuthenticationWarning: jest.fn(),
    hasRecentAuthentication: jest.fn(),
    initializeAuthenticationState: jest.fn(),
    readAuthenticationState,
    stageAuthenticationMethodSwitch,
    switchAuthenticationMethod,
    workosConfigurationFingerprint: () => 'fingerprint'
}))
jest.mock('./constants', () => ({
    LOCAL_SESSION_COOKIE: 'local-session',
    RECENT_AUTH_COOKIE: 'recent-auth',
    localAdminEnabled: () => true,
    localUsersSetting: () => true,
    workosEnvironmentConfigured: () => true
}))
jest.mock('./auditLog', () => ({ safeRecordAudit: jest.fn() }))

import { identityAuthenticationRouter } from './authenticationRoutes'

function app(cookie?: string) {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        req.user = {
            id: 'owner-1',
            activeOrganizationId: 'org-1',
            activeWorkspaceId: 'team-1',
            permissions: []
        }
        req.cookies = cookie ? { 'local-session': cookie } : {}
        next()
    })
    server.use('/api/v1/authentication', identityAuthenticationRouter)
    return server
}

describe('authentication settings routes', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: ['authentication:manage'] }) })
        readAuthenticationState.mockResolvedValue(state)
        findSuperUser.mockResolvedValue({ id: 'owner-1', credential: 'bcrypt' })
        localAccountOpen.mockResolvedValue(true)
        findLocalSession.mockResolvedValue({ issuedAt: new Date() })
        stageAuthenticationMethodSwitch.mockResolvedValue({ id: 'stage-1', version: 1, expiresAt: new Date('2026-11-01T00:00:00Z') })
        switchAuthenticationMethod.mockResolvedValue({
            activeMethod: 'workos',
            authenticationEpoch: 3,
            sessionsEnded: 2
        })
    })

    afterAll(() => setTeamPermissionLookup(null))

    it('refuses callers without authentication:manage', async () => {
        setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: [] }) })
        expect((await request(app('fresh')).get('/api/v1/authentication')).status).toBe(403)
        expect(readAuthenticationState).not.toHaveBeenCalled()
    })

    it('requires a fresh authentication before staging', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(Date.now() - 11 * 60 * 1000) })
        const response = await request(app('old')).post('/api/v1/authentication/stage').send({ method: 'workos', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body.code).toBe('REAUTH_REQUIRED')
        expect(stageAuthenticationMethodSwitch).not.toHaveBeenCalled()
    })

    it('stages successfully after a fresh local authentication', async () => {
        const response = await request(app('fresh')).post('/api/v1/authentication/stage').send({ method: 'workos', version: 4 })
        expect(response.status).toBe(200)
        expect(response.body).toMatchObject({ stage: 'stage-1', stageVersion: 1, method: 'workos', sessionsWillEnd: true })
        expect(stageAuthenticationMethodSwitch).toHaveBeenCalledWith(expect.anything(), 'owner-1', 'workos', 4)
    })

    it('keeps the WorkOS recovery gate ahead of recent-auth staging', async () => {
        localAccountOpen.mockResolvedValue(false)
        findLocalSession.mockResolvedValue({ issuedAt: new Date() })
        const response = await request(app('fresh')).post('/api/v1/authentication/stage').send({ method: 'workos', version: 4 })
        expect(response.status).toBe(409)
        expect(response.body.code).toBe('RECOVERY_REQUIRED')
        expect(stageAuthenticationMethodSwitch).not.toHaveBeenCalled()
    })

    it('validates stage and apply requests', async () => {
        expect((await request(app('fresh')).post('/api/v1/authentication/stage').send({ method: 'oidc', version: 4 })).status).toBe(400)
        expect(
            (
                await request(app('fresh')).post('/api/v1/authentication/apply').send({
                    stage: 'stage-1',
                    stageVersion: 1,
                    method: 'workos',
                    stateVersion: 4,
                    confirm: 'yes'
                })
            ).status
        ).toBe(400)
        expect((await request(app('fresh')).post('/api/v1/authentication/apply').send({ stage: 7 })).status).toBe(409)
        expect(switchAuthenticationMethod).not.toHaveBeenCalled()
    })

    it('requires a fresh authentication again when applying a staged change', async () => {
        findLocalSession.mockResolvedValue({ issuedAt: new Date(Date.now() - 11 * 60 * 1000) })
        const response = await request(app('old')).post('/api/v1/authentication/apply').send({
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
        const applied = await request(app('fresh')).post('/api/v1/authentication/apply').send(body)
        expect(applied.status).toBe(200)
        expect(applied.body).toEqual({
            applied: true,
            redirectTo: '/signin',
            activeMethod: 'workos',
            authenticationEpoch: 3,
            sessionsEnded: 2
        })

        switchAuthenticationMethod.mockRejectedValueOnce(new Error('AUTH_STATE_CHANGED'))
        const stale = await request(app('fresh')).post('/api/v1/authentication/apply').send(body)
        expect(stale.status).toBe(409)
        expect(stale.body.message).toContain('changed')
    })
})
