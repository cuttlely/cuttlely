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
    it('accepts the database session cookie while OIDC is active', async () => {
        const raw = 'oidc-session-cookie'
        const digest = hashSessionToken(raw)
        const sessions = new Map<string, LocalSession>([
            [
                digest,
                row({
                    token: digest,
                    issuedAt: new Date(NOW),
                    lastSeenAt: new Date(NOW)
                })
            ]
        ])
        const store = fakeStore(sessions)
        store.localAccountOpen = jest.fn(async () => false)
        const established = await establishSession({
            ...ctx(store, { 'cuttlely-local-session': raw }),
            localAdmin: false,
            localUsers: false,
            oidcActive: true
        })
        expect(established.user?.id).toBe('user-a')
        expect(store.localAccountOpen).not.toHaveBeenCalled()
    })

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

    it('advances last activity on use, at most once a minute, so an active session stays inside the idle limit', async () => {
        const raw = 'cookie-value-made-up'
        const digest = hashSessionToken(raw)
        const sessions = new Map<string, LocalSession>()
        const session = row({
            token: digest,
            issuedAt: new Date(NOW),
            lastSeenAt: new Date(NOW),
            idleExpires: new Date(NOW + 15 * 60 * 1000)
        })
        sessions.set(digest, session)
        const store = fakeStore(sessions)
        process.env.CUTTLELY_SESSION_IDLE_MINUTES = '15'
        const soon = await establishSession({ ...ctx(store, { 'cuttlely-local-session': raw }), now: NOW + 30 * 1000 })
        expect(soon.user?.id).toBe('user-a')
        expect(session.lastSeenAt?.getTime()).toBe(NOW)
        expect(soon.cookies).toBeUndefined()
        const active = await establishSession({ ...ctx(store, { 'cuttlely-local-session': raw }), now: NOW + 10 * 60 * 1000 })
        expect(active.user?.id).toBe('user-a')
        expect(session.lastSeenAt?.getTime()).toBe(NOW + 10 * 60 * 1000)
        expect(active.cookies?.[0]).toMatchObject({
            name: 'cuttlely-local-session',
            value: raw,
            options: { maxAge: 15 * 60 * 1000 }
        })
        const later = await establishSession({ ...ctx(store, { 'cuttlely-local-session': raw }), now: NOW + 20 * 60 * 1000 })
        expect(later.user?.id).toBe('user-a')
        expect(sessions.has(digest)).toBe(true)
    })

    it('applies idle and absolute limits to an AuthKit session', async () => {
        const sessions = new Map<string, LocalSession>()
        const store = fakeStore(sessions)
        store.findUserByExternalId = async () => ({
            id: 'user-a',
            email: 'ada@example.com',
            name: 'Ada',
            status: 'active',
            externalId: 'wos-1',
            credential: null
        })
        process.env.CUTTLELY_SESSION_IDLE_MINUTES = '15'
        process.env.CUTTLELY_SESSION_ABSOLUTE_HOURS = '1'
        const workos = {
            authorizationUrl: () => '',
            authenticate: async () => {
                throw new Error('unused')
            },
            authenticateSession: async () => ({
                authenticated: true as const,
                sessionId: 'session-1',
                user: { id: 'wos-1', email: 'ada@example.com', emailVerified: true, name: 'Ada' }
            }),
            refresh: async () => ({ authenticated: false as const, reason: 'invalid_grant' }),
            logoutUrl: async () => '',
            setExternalId: async () => undefined
        }
        const call = (now: number) =>
            establishSession({
                ...ctx(store, { 'wos-session': 'sealed' }),
                now,
                workosConfigured: true,
                localUsers: false,
                workos
            })
        const first = await call(NOW)
        expect(first.user?.id).toBe('user-a')
        expect(sessions.size).toBe(1)
        const active = await call(NOW + 10 * 60 * 1000)
        expect(active.user?.id).toBe('user-a')
        const still = await call(NOW + 20 * 60 * 1000)
        expect(still.user?.id).toBe('user-a')
        const ended = await call(NOW + 2 * 60 * 60 * 1000)
        expect(ended.user).toBeNull()
        expect(ended.clearCookies).toEqual(['wos-session'])
        expect(sessions.size).toBe(1)
        expect([...sessions.values()][0].idleExpires.getTime()).toBe(0)
        const retry = await call(NOW + 2 * 60 * 60 * 1000 + 1000)
        expect(retry.user).toBeNull()
        const [left, right] = await Promise.all([call(NOW + 3 * 60 * 60 * 1000), call(NOW + 3 * 60 * 60 * 1000)])
        expect(left.user).toBeNull()
        expect(right.user).toBeNull()
        expect(sessions.size).toBe(1)
        expect([...sessions.values()][0].lastSeenAt?.getTime()).toBe(0)
    })

    it('keeps one clock when the first requests for one AuthKit session arrive together', async () => {
        const sessions = new Map<string, LocalSession>()
        const store = fakeStore(sessions)
        store.findUserByExternalId = async () => ({
            id: 'user-a',
            email: 'ada@example.com',
            name: 'Ada',
            status: 'active',
            externalId: 'wos-1',
            credential: null
        })
        let release: () => void = () => undefined
        const hold = new Promise<void>((resolve) => {
            release = resolve
        })
        let entered = 0
        const insert = store.insertLocalSession.bind(store)
        store.insertLocalSession = async (row) => {
            entered += 1
            if (entered === 1) {
                await hold
                await insert(row)
                return
            }
            release()
            await new Promise((resolve) => setTimeout(resolve, 20))
            if (sessions.has(row.token)) throw new Error('UNIQUE constraint failed: identity_local_session.token')
            await insert(row)
        }
        const workos = {
            authorizationUrl: () => '',
            authenticate: async () => {
                throw new Error('unused')
            },
            authenticateSession: async () => ({
                authenticated: true as const,
                sessionId: 'session-burst',
                user: { id: 'wos-1', email: 'ada@example.com', emailVerified: true, name: 'Ada' }
            }),
            refresh: async () => ({ authenticated: false as const, reason: 'invalid_grant' }),
            logoutUrl: async () => '',
            setExternalId: async () => undefined
        }
        const call = () =>
            establishSession({
                ...ctx(store, { 'wos-session': 'sealed' }),
                now: NOW,
                workosConfigured: true,
                localUsers: false,
                workos
            })
        const [left, right] = await Promise.all([call(), call()])
        expect(left.user?.id).toBe('user-a')
        expect(right.user?.id).toBe('user-a')
        expect(sessions.size).toBe(1)
        expect([...sessions.values()][0].issuedAt?.getTime()).toBe(NOW)
    })

    it('enforces idle and absolute limits when AuthKit omits the session id', async () => {
        const warnings: string[] = []
        const original = console.warn
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(' '))
        }
        const sessions = new Map<string, LocalSession>()
        const store = fakeStore(sessions)
        store.findUserByExternalId = async () => ({
            id: 'user-a',
            email: 'ada@example.com',
            name: 'Ada',
            status: 'active',
            externalId: 'wos-1',
            credential: null
        })
        process.env.CUTTLELY_SESSION_IDLE_MINUTES = '15'
        process.env.CUTTLELY_SESSION_ABSOLUTE_HOURS = '1'
        const user = { id: 'wos-1', email: 'ada@example.com', emailVerified: true, name: 'Ada' }
        const workos = {
            authorizationUrl: () => '',
            authenticate: async () => {
                throw new Error('unused')
            },
            authenticateSession: async () => ({ authenticated: true as const, user }),
            refresh: async () => ({ authenticated: false as const, reason: 'invalid_grant' }),
            logoutUrl: async () => '',
            setExternalId: async () => undefined
        }
        const call = (now: number) =>
            establishSession({
                ...ctx(store, { 'wos-session': 'sealed' }),
                now,
                workosConfigured: true,
                localUsers: false,
                workos
            })
        try {
            const first = await call(NOW)
            expect(first.user?.id).toBe('user-a')
            expect(sessions.size).toBe(1)
            expect(warnings.some((line) => line.includes('no session id'))).toBe(true)
            const warned = warnings.length
            const active = await call(NOW + 10 * 60 * 1000)
            expect(active.user?.id).toBe('user-a')
            expect(warnings).toHaveLength(warned)
            const ended = await call(NOW + 2 * 60 * 60 * 1000)
            expect(ended.user).toBeNull()
            expect(ended.clearCookies).toEqual(['wos-session'])
            expect([...sessions.values()][0].idleExpires.getTime()).toBe(0)

            sessions.clear()
            const refreshWorkos = {
                ...workos,
                authenticateSession: async () => ({ authenticated: false as const, reason: 'invalid_jwt' }),
                refresh: async () => ({
                    authenticated: true as const,
                    sealedSession: 'sealed-again',
                    user
                })
            }
            const refreshed = await establishSession({
                ...ctx(store, { 'wos-session': 'sealed' }),
                now: NOW,
                workosConfigured: true,
                localUsers: false,
                workos: refreshWorkos
            })
            expect(refreshed.user?.id).toBe('user-a')
            expect(sessions.size).toBe(1)
            const refreshEnded = await handleRefresh({
                ...ctx(store, { 'wos-session': 'sealed' }),
                now: NOW + 2 * 60 * 60 * 1000,
                workosConfigured: true,
                localUsers: false,
                workos: refreshWorkos
            })
            expect(refreshEnded.type).toBe('json')
            if (refreshEnded.type !== 'json') return
            expect(refreshEnded.status).toBe(401)
            expect(refreshEnded.clearCookies).toEqual(['wos-session'])
            expect(refreshEnded.body).toEqual({ message: 'Token Expired' })
        } finally {
            console.warn = original
        }
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
        socketAddress: '198.51.100.8',
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
        replaceCredential: async () => false,
        hasBcryptCredential: async () => false,
        createOwner: async () => {
            throw new Error('unused')
        },
        acceptInvite: async () => 'invalid',
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
        localAccountOpen: async () => true,
        readAuthKitSwitch: async () => null,
        applyAuthKitSwitch: async () => ({ configured: false, sessionsEnded: 0, switchedAt: null })
    }
}
