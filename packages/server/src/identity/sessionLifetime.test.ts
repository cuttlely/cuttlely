/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { ABSOLUTE_MS, IDLE_MS, OPEN_SOURCE_FEATURES } from './constants'
import { AuthContext, establishSession, handleRefresh } from './handlers'
import { hashSessionToken } from './password'
import { localSessionBlock } from './sessionLifetime'
import { IdentityStore } from './store'
import { LocalSession, SessionUser } from './types'
import { resetRuntimeLimitsForTests } from '../settings/runtime'

const NOW = 1_700_000_000_000

function row(partial: Partial<LocalSession> = {}): LocalSession {
    return {
        id: 'sess-1',
        userId: 'user-a',
        token: 'digest',
        idleExpires: new Date(NOW + IDLE_MS),
        absoluteExpires: new Date(NOW + ABSOLUTE_MS),
        ...partial
    }
}

afterEach(() => {
    resetRuntimeLimitsForTests()
    delete process.env.CUTTLELY_SESSION_IDLE_MINUTES
    delete process.env.CUTTLELY_SESSION_ABSOLUTE_HOURS
})

describe('shorter lifetimes apply to sessions already issued', () => {
    it('ends a session that has been idle longer than the new limit, before the stored expiry', () => {
        const session = row()
        expect(localSessionBlock(session, NOW + 10 * 60 * 1000)).toBeNull()
        process.env.CUTTLELY_SESSION_IDLE_MINUTES = '15'
        expect(localSessionBlock(session, NOW + 20 * 60 * 1000)).toBe('idle')
        expect(NOW + 20 * 60 * 1000).toBeLessThan(session.idleExpires.getTime())
    })

    it('ends a session older than the new absolute lifetime, before the stored expiry', () => {
        const session = row({ lastSeenAt: new Date(NOW + 2 * 60 * 60 * 1000) })
        process.env.CUTTLELY_SESSION_ABSOLUTE_HOURS = '1'
        expect(localSessionBlock(session, NOW + 2 * 60 * 60 * 1000)).toBe('absolute')
        expect(NOW + 2 * 60 * 60 * 1000).toBeLessThan(session.absoluteExpires.getTime())
    })

    it('keeps a session that is still inside the shorter limits', () => {
        process.env.CUTTLELY_SESSION_IDLE_MINUTES = '15'
        process.env.CUTTLELY_SESSION_ABSOLUTE_HOURS = '2'
        const session = row({ issuedAt: new Date(NOW), lastSeenAt: new Date(NOW + 5 * 60 * 1000) })
        expect(localSessionBlock(session, NOW + 10 * 60 * 1000)).toBeNull()
    })
})

describe('authenticated requests enforce the current lifetime', () => {
    it('drops an existing cookie after the idle limit is reduced', async () => {
        const raw = 'cookie-value-made-up'
        const digest = hashSessionToken(raw)
        const sessions = new Map<string, LocalSession>()
        sessions.set(
            digest,
            row({
                token: digest,
                issuedAt: new Date(NOW - 30 * 60 * 1000),
                lastSeenAt: new Date(NOW - 30 * 60 * 1000),
                idleExpires: new Date(NOW + IDLE_MS)
            })
        )
        const store = fakeStore(sessions)
        process.env.CUTTLELY_SESSION_IDLE_MINUTES = '15'
        const ended = await establishSession(ctx(store, { 'cuttlely-local-session': raw }))
        expect(ended.user).toBeNull()
        expect(ended.clearCookies).toEqual(['cuttlely-local-session'])
        expect(sessions.has(digest)).toBe(false)
        delete process.env.CUTTLELY_SESSION_IDLE_MINUTES
        const again = row({
            token: digest,
            issuedAt: new Date(NOW),
            lastSeenAt: new Date(NOW),
            idleExpires: new Date(NOW + IDLE_MS)
        })
        sessions.set(digest, again)
        const kept = await establishSession(ctx(store, { 'cuttlely-local-session': raw }))
        expect(kept.user?.id).toBe('user-a')
        process.env.CUTTLELY_SESSION_ABSOLUTE_HOURS = '1'
        again.issuedAt = new Date(NOW - 2 * 60 * 60 * 1000)
        const refreshed = await handleRefresh(ctx(store, { 'cuttlely-local-session': raw }))
        expect(refreshed.type).toBe('json')
        if (refreshed.type === 'json') expect(refreshed.status).toBe(401)
        expect(sessions.has(digest)).toBe(false)
    })
})

function ctx(store: IdentityStore, cookies: Record<string, string>): AuthContext {
    return {
        workosConfigured: false,
        localAdmin: false,
        localUsers: true,
        cookiePasswordOk: true,
        secure: false,
        now: NOW,
        ip: '198.51.100.8',
        internal: true,
        body: {},
        cookies,
        store,
        workos: {
            authorizationUrl: () => '',
            authenticate: async () => {
                throw new Error('unused')
            },
            authenticateSession: async () => ({ authenticated: false, reason: 'invalid_jwt' }),
            refresh: async () => ({ authenticated: false, reason: 'invalid_grant' }),
            logoutUrl: async () => '',
            setExternalId: async () => undefined
        },
        rateLimit: { blocked: async () => false, recordFailure: async () => undefined }
    }
}

function fakeStore(sessions: Map<string, LocalSession>): IdentityStore {
    const user: SessionUser = {
        id: 'user-a',
        email: 'ada@example.com',
        name: 'Ada',
        status: 'active',
        role: 'member',
        isSSO: false,
        activeOrganizationId: 'org-1',
        activeOrganizationSubscriptionId: null,
        activeOrganizationCustomerId: null,
        activeOrganizationProductId: null,
        activeWorkspaceId: 'team-a',
        activeWorkspace: 'Team',
        lastLogin: null,
        isOrganizationAdmin: false,
        assignedWorkspaces: [{ id: 'team-a', name: 'Team' }],
        permissions: ['chatflows:view'],
        features: OPEN_SOURCE_FEATURES
    }
    return {
        countUsers: async () => 1,
        listEmails: async () => ['ada@example.com'],
        findUserByExternalId: async () => null,
        findUsersByEmail: async () => [],
        setExternalId: async () => 'missing',
        findSuperUser: async () => null,
        setCredential: async () => undefined,
        createOwner: async () => {
            throw new Error('unused')
        },
        activateUser: async () => null,
        sessionFor: async () => user,
        touchLastLogin: async () => undefined,
        insertLocalSession: async (row) => {
            sessions.set(row.token, row)
        },
        findLocalSession: async (token) => sessions.get(token) || null,
        slideLocalSession: async (token, idleExpires, lastSeenAt) => {
            const found = sessions.get(token)
            if (!found) return
            found.idleExpires = idleExpires
            if (lastSeenAt) found.lastSeenAt = lastSeenAt
        },
        deleteLocalSession: async (token) => {
            sessions.delete(token)
        },
        deleteLocalSessionsForUser: async () => undefined,
        localAccountOpen: async () => true
    }
}
