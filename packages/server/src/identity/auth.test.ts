/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * The WorkOS SDK is mocked.
 */
import { LOGIN_FAILURE_WINDOW_MS, OPEN_SOURCE_FEATURES, cookiePasswordOk, signOutReturnTo } from './constants'
import { runUserCli } from './cli'
import {
    AuthContext,
    establishSession,
    handleCallback,
    handleInviteStart,
    handleLoginGet,
    handleLoginPost,
    handleLogout,
    handleRefresh,
    handlePasswordRecoveryGone,
    handleRegister,
    handleResolve,
    SETUP_LINK_NEEDED
} from './handlers'
import { LoginRateLimit } from './rateLimit'
import { hashPassword, hashSessionToken, passwordErrors } from './password'
import { cookieMutationAllowed } from './sessionGuard'
import { announceFirstRunSetup, firstRunSetupLink, resetFirstRunSetupCode } from './setupCode'
import { resolveTrustProxy } from '../utils/trustProxy'
import { AuthKitSwitchApply, AuthKitSwitchState, switchedSessions } from './authKitSwitch'
import { IdentityStore } from './store'
import { addIdentityLoginGuards, addIdentitySignIn, removeIdentityLoginGuards } from './schemaMigration'
import { CreateOwnerInput, HandlerResult, InviteSignIn, LocalSession, NotEmptyError, SessionUser, UserRow, WorkosPort } from './types'

const GOOD = 'Sup3r-Secret!'
const NOW = Date.parse('2026-10-06T00:00:00.000Z')

class MemoryStore implements IdentityStore {
    users: UserRow[] = []
    ownerId: string | null = null
    sessions = new Map<string, SessionUser>()
    local = new Map<string, LocalSession>()
    touched: string[] = []
    switchState: AuthKitSwitchState | null = null

    async countUsers(): Promise<number> {
        return this.users.length
    }

    async listEmails(): Promise<string[]> {
        return this.users.map((user) => user.email)
    }

    async findUserByExternalId(externalId: string): Promise<UserRow | null> {
        return this.users.find((user) => user.externalId === externalId) || null
    }

    async findUsersByEmail(email: string): Promise<UserRow[]> {
        const needle = email.trim().toLowerCase()
        return this.users.filter((user) => user.email.trim().toLowerCase() === needle)
    }

    async setExternalId(userId: string, externalId: string): Promise<'linked' | 'rebind' | 'missing'> {
        const user = this.users.find((row) => row.id === userId)
        if (!user) return 'missing'
        if (user.externalId && user.externalId !== externalId) return 'rebind'
        user.externalId = externalId
        return 'linked'
    }

    private queue: Promise<void> = Promise.resolve()

    async findSuperUser(): Promise<UserRow | null> {
        const user = this.users.find((row) => row.id === this.ownerId) || null
        if (!user || user.status.toLowerCase() !== 'active') return null
        return user
    }

    async setCredential(userId: string, credential: string): Promise<void> {
        const user = this.users.find((row) => row.id === userId)
        if (!user) throw new Error('missing')
        user.credential = credential
    }

    invites = new Map<string, { userId: string; expiresAt: number; used: boolean }>()
    inviteCalls: InviteSignIn[] = []

    async acceptInvite(input: InviteSignIn): Promise<'accepted' | 'invalid'> {
        this.inviteCalls.push(input)
        const invite = this.invites.get(input.token)
        const user = this.users.find((row) => row.id === input.userId)
        if (!invite || invite.used || invite.expiresAt <= input.now || invite.userId !== input.userId) return 'invalid'
        if (!user || user.status !== 'invited' || user.email.trim().toLowerCase() !== input.email.trim().toLowerCase()) return 'invalid'
        invite.used = true
        user.status = 'active'
        user.externalId = input.externalId
        const session = this.sessions.get(user.id)
        if (session) session.status = user.status
        return 'accepted'
    }

    async createOwner(input: CreateOwnerInput): Promise<UserRow> {
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const previous = this.queue
        this.queue = gate
        await previous
        try {
            return this.insertOwner(input)
        } finally {
            release()
        }
    }

    private insertOwner(input: CreateOwnerInput): UserRow {
        if (this.users.length) throw new NotEmptyError()
        const user: UserRow = {
            id: `user-${this.users.length + 1}`,
            email: input.email,
            name: input.name,
            status: 'active',
            externalId: input.externalId,
            credential: input.credential
        }
        this.users.push(user)
        this.ownerId = user.id
        this.sessions.set(user.id, sessionFor(user, true))
        return user
    }

    async sessionFor(userId: string, _preferredWorkspaceId?: string | null): Promise<SessionUser | null> {
        return this.sessions.get(userId) || null
    }

    async touchLastLogin(userId: string, _workspaceId: string | null, _at: Date): Promise<void> {
        this.touched.push(userId)
    }

    async insertLocalSession(row: LocalSession): Promise<void> {
        this.local.set(row.token, row)
    }

    async findLocalSession(token: string): Promise<LocalSession | null> {
        return this.local.get(token) || null
    }

    async slideLocalSession(token: string, idleExpires: Date, lastSeenAt?: Date): Promise<void> {
        const row = this.local.get(token)
        if (!row) return
        row.idleExpires = idleExpires
        if (lastSeenAt) row.lastSeenAt = lastSeenAt
    }

    async deleteLocalSession(token: string): Promise<void> {
        this.local.delete(token)
    }

    async deleteLocalSessionsForUser(userId: string): Promise<void> {
        for (const [key, row] of this.local) {
            if (row.userId === userId) this.local.delete(key)
        }
    }

    async localAccountOpen(userId: string): Promise<boolean> {
        const user = this.users.find((row) => row.id === userId)
        if (!user || user.status.toLowerCase() !== 'active') return false
        return !this.disabled.has(userId)
    }

    async readAuthKitSwitch(): Promise<AuthKitSwitchState | null> {
        return this.switchState
    }

    async applyAuthKitSwitch(configured: boolean, at: Date, options?: AuthKitSwitchApply): Promise<AuthKitSwitchState> {
        this.switchState = switchedSessions(this.switchState, configured, at, this.local, options)
        return this.switchState
    }

    disabled = new Set<string>()

    add(user: UserRow, owner = false): void {
        this.users.push(user)
        if (owner) this.ownerId = user.id
        this.sessions.set(user.id, sessionFor(user, owner))
    }
}

function sessionFor(user: UserRow, owner: boolean): SessionUser {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status,
        role: owner ? 'owner' : 'member',
        isSSO: false,
        activeOrganizationId: 'org-1',
        activeOrganizationSubscriptionId: null,
        activeOrganizationCustomerId: null,
        activeOrganizationProductId: null,
        activeWorkspaceId: 'ws-1',
        activeWorkspace: 'Default Workspace',
        lastLogin: null,
        isOrganizationAdmin: owner,
        assignedWorkspaces: [{ id: 'ws-1', name: 'Default Workspace' }],
        permissions: owner ? [] : ['chatflows:view'],
        features: OPEN_SOURCE_FEATURES
    }
}

function workos(overrides: Partial<WorkosPort> = {}): WorkosPort & { externalIds: { workosUserId: string; ourUserId: string }[] } {
    const externalIds: { workosUserId: string; ourUserId: string }[] = []
    return {
        externalIds,
        authorizationUrl: (redirectUri: string) =>
            `https://authkit.example/authorize?redirect=${encodeURIComponent(redirectUri)}&provider=authkit`,
        authenticate: async () => ({
            user: { id: 'wos-1', email: 'owner@example.com', emailVerified: true, name: 'Owner' },
            sealedSession: 'sealed-1'
        }),
        authenticateSession: async () => ({ authenticated: false, reason: 'invalid_jwt' }),
        refresh: async () => ({
            authenticated: true,
            sealedSession: 'sealed-2',
            user: { id: 'wos-1', email: 'owner@example.com', emailVerified: true, name: 'Owner' }
        }),
        logoutUrl: async () => 'https://authkit.example/logout',
        setExternalId: async (workosUserId: string, ourUserId: string) => {
            externalIds.push({ workosUserId, ourUserId })
        },
        ...overrides
    }
}

function ctx(partial: Partial<AuthContext> = {}): AuthContext {
    return {
        workosConfigured: false,
        localAdmin: false,
        localUsers: false,
        cookiePasswordOk: true,
        redirectUri: 'http://127.0.0.1:43117/api/v1/auth/callback',
        secure: false,
        now: NOW,
        ip: '203.0.113.5',
        internal: false,
        body: {},
        cookies: {},
        store: partial.store || new MemoryStore(),
        workos: partial.workos || workos(),
        rateLimit: partial.rateLimit || new LoginRateLimit(),
        ...partial
    }
}

function json(result: HandlerResult): {
    status: number
    body: Record<string, unknown>
    cookies?: { name: string; value: string; options: { httpOnly: boolean; sameSite: string; path: string; secure: boolean } }[]
    clearCookies?: string[]
    secure?: boolean
} {
    if (result.type !== 'json') throw new Error(`expected json, got ${result.type}`)
    return {
        status: result.status,
        secure: result.secure,
        body: result.body as Record<string, unknown>,
        cookies: result.cookies,
        clearCookies: result.clearCookies
    }
}

describe('identity auth', () => {
    it('accepts a 44 character cookie password and rejects a short one', () => {
        expect(cookiePasswordOk('a'.repeat(44))).toBe(true)
        expect(cookiePasswordOk('a'.repeat(31))).toBe(false)
        expect(cookiePasswordOk(undefined)).toBe(false)
    })

    it('GET /auth/login redirects to AuthKit and does not render the local form', async () => {
        const result = await handleLoginGet(ctx({ workosConfigured: true }))
        expect(result).toMatchObject({ type: 'redirect', status: 302 })
        if (result.type === 'redirect') expect(result.url).toContain('provider=authkit')
    })

    it('GET /auth/login is 404 when WorkOS is unset', async () => {
        const result = await handleLoginGet(ctx())
        expect(result).toMatchObject({ type: 'json', status: 404 })
    })

    it('GET /auth/login is 404 when only the local admin flag is on', async () => {
        const result = await handleLoginGet(ctx({ localAdmin: true }))
        expect(result).toMatchObject({ type: 'json', status: 404 })
    })

    it('callback without a code is 400', async () => {
        const result = await handleCallback(ctx({ workosConfigured: true }))
        expect(json(result).status).toBe(400)
        expect(json(result).body.message).toBe('No code provided')
    })

    it('callback refuses an unverified email and does not create a user', async () => {
        const store = new MemoryStore()
        const result = await handleCallback(
            ctx({
                workosConfigured: true,
                code: 'code',
                store,
                workos: workos({
                    authenticate: async () => ({
                        user: { id: 'wos-1', email: 'new@example.com', emailVerified: false, name: 'New' },
                        sealedSession: 'sealed'
                    })
                })
            })
        )
        expect(result).toMatchObject({ type: 'redirect', status: 302 })
        if (result.type === 'redirect') expect(decodeURIComponent(result.url)).toContain('not verified')
        expect(store.users).toHaveLength(0)
    })

    it('callback links a verified email and sets the sealed cookie', async () => {
        const store = new MemoryStore()
        store.add(
            { id: 'user-9', email: 'Owner@Example.com', name: 'Owner', status: 'active', externalId: null, credential: 'old-hash' },
            true
        )
        const port = workos()
        const result = await handleCallback(ctx({ workosConfigured: true, code: 'code', store, workos: port }))
        expect(result).toMatchObject({
            type: 'redirect',
            status: 302,
            url: '/',
            clearCookies: ['cuttlely-local-session']
        })
        if (result.type !== 'redirect') return
        expect(result.cookies?.[0]).toMatchObject({
            name: 'wos-session',
            value: 'sealed-1',
            options: { httpOnly: true, sameSite: 'lax', path: '/', secure: false }
        })
        expect(store.users[0].externalId).toBe('wos-1')
        expect(store.users[0].credential).toBe('old-hash')
        expect(port.externalIds).toEqual([{ workosUserId: 'wos-1', ourUserId: 'user-9' }])
    })

    it('callback uses the existing external id and does not rebind a different one', async () => {
        const store = new MemoryStore()
        store.add(
            { id: 'user-1', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: 'wos-1', credential: null },
            true
        )
        const linked = await handleCallback(ctx({ workosConfigured: true, code: 'code', store }))
        expect(linked).toMatchObject({ type: 'redirect', url: '/' })

        store.users[0].externalId = 'someone-else'
        const refused = await handleCallback(ctx({ workosConfigured: true, code: 'code', store }))
        expect(refused).toMatchObject({ type: 'redirect', status: 302 })
        if (refused.type === 'redirect') expect(decodeURIComponent(refused.url)).toContain('different sign-in')
        expect(store.users[0].externalId).toBe('someone-else')
    })

    it('callback bootstraps the first verified user on an empty database', async () => {
        const store = new MemoryStore()
        const result = await handleCallback(
            ctx({
                workosConfigured: true,
                code: 'code',
                store,
                bootstrapEmail: 'first@example.com',
                workos: workos({
                    authenticate: async () => ({
                        user: { id: 'wos-first', email: 'first@example.com', emailVerified: true, name: 'First Person' },
                        sealedSession: 'sealed-first'
                    })
                })
            })
        )
        expect(result).toMatchObject({ type: 'redirect', url: '/' })
        expect(store.users).toEqual([
            expect.objectContaining({ email: 'first@example.com', externalId: 'wos-first', status: 'active', credential: null })
        ])
        expect(store.sessions.get(store.users[0].id)?.isOrganizationAdmin).toBe(true)
        expect(store.sessions.get(store.users[0].id)?.role).toBe('owner')
    })

    it('callback does not create a user for an unknown email once anyone exists', async () => {
        const store = new MemoryStore()
        store.add(
            { id: 'user-1', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: 'wos-owner', credential: null },
            true
        )
        const result = await handleCallback(
            ctx({
                workosConfigured: true,
                code: 'code',
                store,
                workos: workos({
                    authenticate: async () => ({
                        user: { id: 'wos-new', email: 'stranger@example.com', emailVerified: true, name: 'Stranger' },
                        sealedSession: 'sealed'
                    })
                })
            })
        )
        if (result.type === 'redirect') expect(decodeURIComponent(result.url)).toContain('No account')
        expect(store.users).toHaveLength(1)
    })

    it('callback leaves a pending invite pending on a verified email match without the invite link', async () => {
        const store = new MemoryStore()
        store.add({ id: 'user-2', email: 'owner@example.com', name: 'Owner', status: 'invited', externalId: null, credential: null })
        const port = workos()
        const result = await handleCallback(ctx({ workosConfigured: true, code: 'code', store, workos: port }))
        expect(result.type).toBe('redirect')
        if (result.type !== 'redirect') return
        expect(JSON.parse(new URL(result.url, 'http://x').searchParams.get('error') || '{}')).toEqual({
            message: 'You have a pending invite. Open the invite link from your email to join.'
        })
        expect(result.cookies).toBeUndefined()
        expect(store.users[0]).toMatchObject({ status: 'invited', externalId: null })
        expect(store.touched).toEqual([])
        expect(store.inviteCalls).toEqual([])
        expect(port.externalIds).toEqual([])
    })

    it('callback activates a pending invite with its invite link and binds the sign-in the first time', async () => {
        const store = new MemoryStore()
        store.add({ id: 'user-2', email: 'Owner@Example.com', name: 'Owner', status: 'invited', externalId: null, credential: null })
        store.invites.set('invite-token', { userId: 'user-2', expiresAt: NOW + 60_000, used: false })
        const port = workos()
        const result = await handleCallback(
            ctx({ workosConfigured: true, code: 'code', store, workos: port, cookies: { 'cuttlely-invite': 'invite-token' } })
        )
        expect(result).toMatchObject({ type: 'redirect', url: '/', clearCookies: ['cuttlely-local-session'] })
        if (result.type === 'redirect') {
            expect(result.cookies?.[0]).toMatchObject({ name: 'wos-session', value: 'sealed-1' })
            expect(result.cookies?.[1]).toEqual({
                name: 'cuttlely-invite',
                value: '',
                options: { httpOnly: true, sameSite: 'lax', path: '/api/v1/auth/callback', secure: false, maxAge: 0 }
            })
        }
        expect(store.users[0]).toMatchObject({ status: 'active', externalId: 'wos-1', credential: null })
        expect(store.inviteCalls).toEqual([
            { token: 'invite-token', userId: 'user-2', email: 'owner@example.com', externalId: 'wos-1', now: NOW }
        ])
        expect(port.externalIds).toEqual([{ workosUserId: 'wos-1', ourUserId: 'user-2' }])

        const again = await handleCallback(ctx({ workosConfigured: true, code: 'code', store, workos: port }))
        expect(again).toMatchObject({ type: 'redirect', url: '/' })
        expect(store.inviteCalls).toHaveLength(1)
    })

    it('callback refuses a pending invite whose link the store does not accept, and clears the invite cookie', async () => {
        const store = new MemoryStore()
        store.add({ id: 'user-2', email: 'owner@example.com', name: 'Owner', status: 'invited', externalId: null, credential: null })
        store.invites.set('old-token', { userId: 'user-2', expiresAt: NOW - 1, used: false })
        const result = await handleCallback(
            ctx({ workosConfigured: true, code: 'code', store, cookies: { 'cuttlely-invite': 'old-token' } })
        )
        expect(result.type).toBe('redirect')
        if (result.type === 'redirect') {
            expect(decodeURIComponent(result.url)).toContain('This invite link is not valid. Ask for a new invite.')
            expect(result.cookies).toEqual([
                {
                    name: 'cuttlely-invite',
                    value: '',
                    options: { httpOnly: true, sameSite: 'lax', path: '/api/v1/auth/callback', secure: false, maxAge: 0 }
                }
            ])
        }
        expect(store.users[0]).toMatchObject({ status: 'invited', externalId: null })
    })

    it('callback signs an already active user in normally and ignores a stray invite cookie', async () => {
        const store = new MemoryStore()
        store.add(
            { id: 'user-1', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: 'wos-1', credential: null },
            true
        )
        const result = await handleCallback(ctx({ workosConfigured: true, code: 'code', store, cookies: { 'cuttlely-invite': 'stray' } }))
        expect(result).toMatchObject({ type: 'redirect', url: '/', clearCookies: ['cuttlely-local-session'] })
        if (result.type === 'redirect')
            expect(result.cookies?.[1]).toEqual({
                name: 'cuttlely-invite',
                value: '',
                options: { httpOnly: true, sameSite: 'lax', path: '/api/v1/auth/callback', secure: false, maxAge: 0 }
            })
        expect(store.inviteCalls).toEqual([])
        expect(store.touched).toEqual(['user-1'])
    })

    it('invite start holds the token in a short-lived httpOnly cookie and sends the browser to AuthKit', async () => {
        expect(json(await handleInviteStart(ctx({ internal: true, body: { token: 't' } }))).status).toBe(404)
        expect(json(await handleInviteStart(ctx({ workosConfigured: true, body: { token: 't' } }))).status).toBe(401)
        expect(json(await handleInviteStart(ctx({ workosConfigured: true, internal: true, body: {} }))).status).toBe(400)
        const tooLong = await handleInviteStart(ctx({ workosConfigured: true, internal: true, body: { token: 'x'.repeat(257) } }))
        expect(json(tooLong).status).toBe(400)
        const started = json(
            await handleInviteStart(ctx({ workosConfigured: true, internal: true, secure: true, body: { token: 'raw-token' } }))
        )
        expect(started.status).toBe(200)
        expect(started.body).toEqual({ url: '/api/v1/auth/login' })
        expect(started.cookies).toEqual([
            {
                name: 'cuttlely-invite',
                value: 'raw-token',
                options: { httpOnly: true, sameSite: 'lax', path: '/api/v1/auth/callback', secure: true, maxAge: 15 * 60 * 1000 }
            }
        ])
    })

    it('callback still refuses a deleted email-only user', async () => {
        const store = new MemoryStore()
        store.add({ id: 'user-2', email: 'owner@example.com', name: 'Owner', status: 'deleted', externalId: null, credential: null })
        const result = await handleCallback(ctx({ workosConfigured: true, code: 'code', store }))
        if (result.type === 'redirect') expect(decodeURIComponent(result.url)).toContain('not active')
        expect(store.users[0].externalId).toBeNull()
        expect(store.users[0].status).toBe('deleted')
    })

    it('callback returns a plain error when WorkOS is down', async () => {
        const result = await handleCallback(
            ctx({
                workosConfigured: true,
                code: 'code',
                workos: workos({
                    authenticate: async () => {
                        const { WorkosUnavailableError } = await import('./types')
                        throw new WorkosUnavailableError()
                    }
                })
            })
        )
        expect(result).toMatchObject({ type: 'text', status: 503 })
        if (result.type === 'text') {
            expect(result.body).toContain('href="/signin"')
            expect(result.body.toLowerCase()).not.toContain('password')
        }
    })

    it('uses a secure cookie when the redirect URI is https', async () => {
        const store = new MemoryStore()
        const result = await handleCallback(
            ctx({ workosConfigured: true, code: 'code', store, secure: true, redirectUri: 'https://cuttlely.example/api/v1/auth/callback' })
        )
        if (result.type === 'redirect') expect(result.cookies?.[0].options.secure).toBe(true)
    })

    it('clears the break-glass cookie with the request secure flag in production', async () => {
        const previous = process.env.NODE_ENV
        process.env.NODE_ENV = 'production'
        try {
            const store = new MemoryStore()
            const credential = await hashPassword(GOOD)
            store.add({ id: 'owner', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential }, true)
            const ok = json(
                await handleLoginPost(
                    ctx({
                        localAdmin: true,
                        localUsers: false,
                        internal: true,
                        secure: false,
                        store,
                        body: { email: 'owner@example.com', password: GOOD }
                    })
                )
            )
            expect(ok.status).toBe(200)
            expect(ok.cookies?.[0].options.secure).toBe(false)
            const token = ok.cookies?.[0].value || ''
            const out = json(
                await handleLogout(
                    ctx({
                        localAdmin: true,
                        localUsers: false,
                        internal: true,
                        secure: false,
                        store,
                        cookies: { 'cuttlely-local-session': token }
                    })
                )
            )
            expect(out.clearCookies).toContain('cuttlely-local-session')
            expect(out.secure).toBe(false)
            const stale = await establishSession(
                ctx({
                    localAdmin: true,
                    localUsers: false,
                    secure: true,
                    store,
                    cookies: { 'cuttlely-local-session': 'missing' }
                })
            )
            expect(stale.clearCookies).toContain('cuttlely-local-session')
            expect(stale.secure).toBe(true)
        } finally {
            if (previous === undefined) delete process.env.NODE_ENV
            else process.env.NODE_ENV = previous
        }
    })

    it('break-glass login is not mounted when the flag is off', async () => {
        await expect(handleLoginPost(ctx({ workosConfigured: true, internal: true }))).resolves.toMatchObject({
            type: 'json',
            status: 404
        })
    })

    it('break-glass login allows only the super user and sets the local cookie', async () => {
        const store = new MemoryStore()
        const credential = await hashPassword(GOOD)
        store.add({ id: 'owner', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential }, true)
        store.add({ id: 'member', email: 'member@example.com', name: 'Member', status: 'active', externalId: null, credential })
        const base = { localAdmin: true, internal: true, store, rateLimit: new LoginRateLimit() }
        const other = json(await handleLoginPost(ctx({ ...base, body: { email: 'member@example.com', password: GOOD } })))
        expect(other.status).toBe(401)
        const bad = json(await handleLoginPost(ctx({ ...base, body: { email: 'owner@example.com', password: 'nope-Nope1!' } })))
        expect(bad.status).toBe(401)
        expect(bad.body.message).not.toContain(GOOD)
        const missing = json(await handleLoginPost(ctx({ ...base, internal: false, body: { email: 'owner@example.com', password: GOOD } })))
        expect(missing.status).toBe(401)
        const ok = json(await handleLoginPost(ctx({ ...base, body: { email: 'owner@example.com', password: GOOD } })))
        expect(ok.status).toBe(200)
        expect(ok.body.id).toBe('owner')
        expect(ok.body.isOrganizationAdmin).toBe(true)
        expect(ok.cookies?.[0].name).toBe('cuttlely-local-session')
        expect(ok.cookies?.[0].options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' })
        expect(ok.clearCookies).toContain('wos-session')
        expect(ok.secure).toBe(false)
        expect(ok.cookies?.[0].options.secure).toBe(false)
        const raw = ok.cookies?.[0].value || ''
        expect(raw).not.toBe(hashSessionToken(raw))
        expect(store.local.get(hashSessionToken(raw))?.token).toBe(hashSessionToken(raw))
        expect(JSON.stringify(ok.body)).not.toContain(GOOD)
    })

    it('rate limits failed break-glass attempts without clearing the window on success', async () => {
        const savedSecret = process.env.TOKEN_HASH_SECRET
        process.env.TOKEN_HASH_SECRET = 'test-login-lock-secret'
        try {
            const store = new MemoryStore()
            const credential = await hashPassword(GOOD)
            store.add({ id: 'owner', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential }, true)
            const rateLimit = new LoginRateLimit()
            const attempt = (password: string, ip = '203.0.113.5') =>
                handleLoginPost(
                    ctx({ localAdmin: true, internal: true, store, rateLimit, ip, body: { email: 'owner@example.com', password } })
                )
            for (let i = 0; i < 9; i++) expect(json(await attempt('bad-Bad1!')).status).toBe(401)
            expect(json(await attempt(GOOD)).status).toBe(200)
            expect(json(await attempt('bad-Bad1!')).status).toBe(401)
            expect(json(await attempt(GOOD)).status).toBe(429)
            expect(json(await attempt('bad-Bad1!', '203.0.113.9')).status).toBe(429)
            expect(json(await attempt('bad-Bad1!', '203.0.113.10')).status).toBe(429)
            const other = new LoginRateLimit()
            expect(
                json(
                    await handleLoginPost(
                        ctx({
                            localAdmin: true,
                            internal: true,
                            store,
                            rateLimit: other,
                            ip: '198.51.100.8',
                            body: { email: 'someone-else@example.com', password: 'bad-Bad1!' }
                        })
                    )
                ).status
            ).toBe(401)
        } finally {
            if (savedSecret === undefined) delete process.env.TOKEN_HASH_SECRET
            else process.env.TOKEN_HASH_SECRET = savedSecret
        }
    })

    it('does not trust X-Forwarded-For unless TRUST_PROXY is set, and drops old failures', async () => {
        expect(resolveTrustProxy(undefined)).toBe(false)
        expect(resolveTrustProxy('')).toBe(false)
        expect(resolveTrustProxy('1')).toBe(1)
        expect(resolveTrustProxy('false')).toBe(false)
        const limit = new LoginRateLimit()
        const stale = NOW - LOGIN_FAILURE_WINDOW_MS - 1
        for (let i = 0; i < 10; i++) await limit.recordFailure('203.0.113.5', 'owner@example.com', stale)
        expect(await limit.blocked('203.0.113.5', 'owner@example.com', NOW)).toBe(false)
        expect(limit.retained()).toBe(0)
    })

    it('refreshes a sealed session and returns id', async () => {
        const store = new MemoryStore()
        store.add(
            { id: 'user-1', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: 'wos-1', credential: null },
            true
        )
        const ok = json(await handleRefresh(ctx({ workosConfigured: true, store, cookies: { 'wos-session': 'sealed-1' } })))
        expect(ok.status).toBe(200)
        expect(ok.body.id).toBe('user-1')
        expect(ok.body).not.toHaveProperty('retry')
        expect(ok.cookies?.[0]).toMatchObject({ name: 'wos-session', value: 'sealed-2' })

        const expired = json(
            await handleRefresh(
                ctx({
                    workosConfigured: true,
                    store,
                    cookies: { 'wos-session': 'sealed-1' },
                    workos: workos({ refresh: async () => ({ authenticated: false, reason: 'invalid_grant' }) })
                })
            )
        )
        expect(expired.status).toBe(401)
        expect(expired.body).toEqual({ message: 'Refresh Token Expired' })
        expect(expired.clearCookies).toContain('wos-session')
    })

    it('slides the local session idle timer and rejects an absolute expiry', async () => {
        const store = new MemoryStore()
        store.add({ id: 'owner', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential: null }, true)
        const token = 'local-token'
        const digest = hashSessionToken(token)
        await store.insertLocalSession({
            id: 'sess-1',
            userId: 'owner',
            token: digest,
            idleExpires: new Date(NOW + 60_000),
            absoluteExpires: new Date(NOW + 86_400_000)
        })
        const ok = json(await handleRefresh(ctx({ localAdmin: true, store, cookies: { 'cuttlely-local-session': token } })))
        expect(ok.status).toBe(200)
        expect(ok.body.id).toBe('owner')
        expect(store.local.get(digest)?.idleExpires.getTime()).toBeGreaterThan(NOW + 60_000)

        store.local.set(digest, {
            id: 'sess-1',
            userId: 'owner',
            token: digest,
            idleExpires: new Date(NOW + 60_000),
            absoluteExpires: new Date(NOW - 1)
        })
        const expired = json(await handleRefresh(ctx({ localAdmin: true, store, cookies: { 'cuttlely-local-session': token } })))
        expect(expired.body).toEqual({ message: 'Refresh Token Expired' })
    })

    it('passes WORKOS_REDIRECT_URI through unchanged and logs out to that origin plus /signin', async () => {
        const hosted = 'https://cuttlely.example.com/api/v1/auth/callback'
        const local = 'http://127.0.0.1:43117/api/v1/auth/callback/'
        expect(signOutReturnTo(hosted)).toBe('https://cuttlely.example.com/signin')
        expect(signOutReturnTo(local)).toBe('http://127.0.0.1:43117/signin')

        const seen: string[] = []
        const port = workos({
            authorizationUrl: (redirectUri: string) => {
                seen.push(redirectUri)
                return 'https://authkit.example/authorize'
            },
            logoutUrl: async (_sealed: string, returnTo?: string) => {
                seen.push(returnTo || '')
                return 'https://authkit.example/logout?return_to=' + encodeURIComponent(returnTo || '')
            }
        })
        await handleLoginGet(ctx({ workosConfigured: true, redirectUri: hosted, workos: port }))
        await handleLoginGet(ctx({ workosConfigured: true, redirectUri: local, workos: port }))
        const logged = json(
            await handleLogout(
                ctx({ workosConfigured: true, internal: true, redirectUri: hosted, cookies: { 'wos-session': 'sealed' }, workos: port })
            )
        )
        expect(seen).toEqual([hosted, local, 'https://cuttlely.example.com/signin'])
        expect(logged.body.redirectTo).toContain(encodeURIComponent('https://cuttlely.example.com/signin'))
    })

    it('logout returns the AuthKit URL for a sealed session and /signin for the local session', async () => {
        const sealed = json(await handleLogout(ctx({ workosConfigured: true, internal: true, cookies: { 'wos-session': 'sealed-1' } })))
        expect(sealed.status).toBe(200)
        expect(sealed.body).toEqual({ message: 'logged_out', redirectTo: 'https://authkit.example/logout' })
        expect(sealed.clearCookies).toContain('wos-session')

        const store = new MemoryStore()
        await store.insertLocalSession({
            id: 'sess',
            userId: 'owner',
            token: hashSessionToken('local-token'),
            idleExpires: new Date(NOW + 1000),
            absoluteExpires: new Date(NOW + 1000)
        })
        const local = json(
            await handleLogout(ctx({ localAdmin: true, internal: true, store, cookies: { 'cuttlely-local-session': 'local-token' } }))
        )
        expect(local.body).toEqual({ message: 'logged_out', redirectTo: '/signin' })
        expect(store.local.has(hashSessionToken('local-token'))).toBe(false)
        await expect(
            handleLogout(ctx({ workosConfigured: true, internal: false, cookies: { 'wos-session': 'sealed-1' } }))
        ).resolves.toMatchObject({
            type: 'json',
            status: 401
        })
        await expect(handleLogout(ctx())).resolves.toMatchObject({
            type: 'json',
            status: 200,
            body: { message: 'logged_out', redirectTo: '/signin' }
        })
    })

    it('resolve follows WorkOS, break-glass, and existing users', async () => {
        const empty = new MemoryStore()
        expect(json(await handleResolve(ctx({ workosConfigured: true, store: empty }))).body).toEqual({ redirectUrl: '/signin' })
        expect(json(await handleResolve(ctx({ localAdmin: true, store: empty }))).body).toEqual({ redirectUrl: '/organization-setup' })
        const populated = new MemoryStore()
        populated.add(
            { id: 'user-1', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential: null },
            true
        )
        expect(json(await handleResolve(ctx({ workosConfigured: true, localAdmin: true, store: populated }))).body).toEqual({
            redirectUrl: '/signin'
        })
        await expect(handleResolve(ctx({ store: populated }))).resolves.toMatchObject({ type: 'json', status: 404 })
    })

    it('register creates the local super user only when the flag is on and the table is empty', async () => {
        const store = new MemoryStore()
        await expect(
            handleRegister(ctx({ store, body: { user: { name: 'A', email: 'a@example.com', credential: GOOD } } }))
        ).resolves.toMatchObject({
            type: 'json',
            status: 404
        })
        expect(json(await handlePasswordRecoveryGone()).status).toBe(404)
        const created = json(
            await handleRegister(
                ctx({
                    localAdmin: true,
                    ip: '127.0.0.1',
                    store,
                    body: { user: { name: 'Owner', email: 'owner@example.com', credential: GOOD } }
                })
            )
        )
        expect(created.status).toBe(200)
        expect(created.body.id).toBe('user-1')
        expect(JSON.stringify(created.body)).not.toContain(GOOD)
        expect(await store.findSuperUser()).toEqual(expect.objectContaining({ email: 'owner@example.com' }))
        expect(
            json(
                await handleRegister(
                    ctx({
                        localAdmin: true,
                        ip: '127.0.0.1',
                        store,
                        body: { user: { name: 'Other', email: 'other@example.com', credential: GOOD } }
                    })
                )
            ).status
        ).toBe(404)
        const weak = json(
            await handleRegister(
                ctx({
                    localAdmin: true,
                    ip: '127.0.0.1',
                    store: new MemoryStore(),
                    body: { user: { name: 'Owner', email: 'owner@example.com', credential: 'short' } }
                })
            )
        )
        expect(weak.status).toBe(400)
        expect(String(weak.body.message)).not.toContain('short')
    })

    it('refreshes a rejected sealed session on later requests and clears it when refresh fails', async () => {
        const store = new MemoryStore()
        store.add(
            { id: 'user-1', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: 'wos-1', credential: null },
            true
        )
        const ok = await establishSession(ctx({ workosConfigured: true, store, cookies: { 'wos-session': 'old' } }))
        expect(ok.user?.id).toBe('user-1')
        expect(ok.cookies?.[0].value).toBe('sealed-2')

        const cleared = await establishSession(
            ctx({
                workosConfigured: true,
                store,
                cookies: { 'wos-session': 'old' },
                workos: workos({
                    authenticateSession: async () => ({ authenticated: false, reason: 'invalid_jwt' }),
                    refresh: async () => ({ authenticated: false, reason: 'invalid_grant' })
                })
            })
        )
        expect(cleared.user).toBeNull()
        expect(cleared.clearCookies).toContain('wos-session')
    })

    it('pnpm user lists emails, resets only the super user when the flag is off, and bootstraps when it is on', async () => {
        const store = new MemoryStore()
        store.add({ id: 'owner', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential: null }, true)
        store.add({ id: 'member', email: 'member@example.com', name: 'Member', status: 'active', externalId: null, credential: null })
        const listed = await runUserCli(store, { localAdmin: false })
        expect(listed.ok).toBe(true)
        expect(listed.lines.join('\n')).toContain('Email count: 2')
        expect(listed.lines.join('\n')).not.toContain(GOOD)

        const refused = await runUserCli(store, { localAdmin: false, email: 'member@example.com', password: GOOD })
        expect(refused.ok).toBe(false)
        expect(refused.lines.join(' ')).not.toContain(GOOD)
        expect(store.users.find((user) => user.id === 'member')?.credential).toBeNull()

        const updated = await runUserCli(store, { localAdmin: false, email: 'owner@example.com', password: GOOD })
        expect(updated.ok).toBe(true)
        expect(updated.lines.join(' ')).not.toContain(GOOD)
        expect(store.users[0].credential).toContain('scrypt')

        const empty = new MemoryStore()
        const blocked = await runUserCli(empty, { localAdmin: false, email: 'owner@example.com', password: GOOD })
        expect(blocked.ok).toBe(false)
        expect(empty.users).toHaveLength(0)
        const created = await runUserCli(empty, { localAdmin: true, email: 'owner@example.com', password: GOOD })
        expect(created.ok).toBe(true)
        expect(empty.ownerId).toBe(empty.users[0].id)
        expect(passwordErrors('nope')).toEqual(expect.arrayContaining([expect.stringContaining('uppercase')]))
    })

    it('refuses the first AuthKit user unless CUTTLELY_BOOTSTRAP_EMAIL matches', async () => {
        const unset = await handleCallback(
            ctx({
                workosConfigured: true,
                code: 'code',
                workos: workos({
                    authenticate: async () => ({
                        user: { id: 'wos-first', email: 'first@example.com', emailVerified: true, name: 'First' },
                        sealedSession: 'sealed'
                    })
                })
            })
        )
        expect(unset).toMatchObject({ type: 'text', status: 403 })
        if (unset.type === 'text') {
            expect(unset.log).toContain('CUTTLELY_BOOTSTRAP_EMAIL is unset')
            expect(unset.body).toContain('href="/signin"')
            expect(unset.body.toLowerCase()).not.toContain('password')
        }
        const denied = await handleCallback(
            ctx({
                workosConfigured: true,
                code: 'code',
                bootstrapEmail: 'other@example.com',
                workos: workos({
                    authenticate: async () => ({
                        user: { id: 'wos-first', email: 'first@example.com', emailVerified: true, name: 'First' },
                        sealedSession: 'sealed'
                    })
                })
            })
        )
        expect(denied).toMatchObject({ type: 'text', status: 403 })
        if (denied.type === 'text') expect(denied.log).toContain('did not match')
    })

    it('accepts first-run register from another address only with the setup code from the server log', async () => {
        resetFirstRunSetupCode()
        const store = new MemoryStore()
        const user = { name: 'Owner', email: 'owner@example.com', credential: GOOD }
        const remote = (body: Record<string, unknown>) => handleRegister(ctx({ localAdmin: true, ip: '172.18.0.1', store, body }))

        const noCode = json(await remote({ user }))
        // 400, not 403: the app sends a 403 to its no-permission page, and this message has to reach the form.
        expect(noCode).toMatchObject({ status: 400, body: { message: SETUP_LINK_NEEDED } })
        // No code has been made yet, so nothing matches, not even an empty string.
        expect(json(await remote({ user, setupCode: '' })).status).toBe(400)

        const link = firstRunSetupLink(43117)
        const code = new URL(link).searchParams.get('code') as string
        expect(link.startsWith('http://localhost:43117/organization-setup?code=')).toBe(true)
        expect(code.length).toBeGreaterThanOrEqual(16)
        expect(json(await remote({ user, setupCode: code.slice(1) })).status).toBe(400)
        expect(json(await remote({ user, setupCode: ['x'] })).status).toBe(400)

        const created = json(await remote({ user, setupCode: code }))
        expect(created.status).toBe(200)
        expect(await store.findSuperUser()).toEqual(expect.objectContaining({ email: 'owner@example.com' }))
        // Once an account exists the code opens nothing, and the route looks absent again.
        expect(json(await remote({ user: { ...user, email: 'other@example.com' }, setupCode: code })).status).toBe(404)
        resetFirstRunSetupCode()
    })

    it('does not accept register from a public address once an account exists, or with the flag off', async () => {
        const populated = new MemoryStore()
        populated.add(
            { id: 'user-1', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential: null },
            true
        )
        const body = { user: { name: 'Other', email: 'other@example.com', credential: GOOD } }
        await expect(handleRegister(ctx({ localAdmin: true, ip: '203.0.113.5', store: populated, body }))).resolves.toMatchObject({
            type: 'json',
            status: 404
        })
        await expect(handleRegister(ctx({ ip: '203.0.113.5', body }))).resolves.toMatchObject({ type: 'json', status: 404 })
    })

    it('announces the setup link only on a fresh install with the local account on', async () => {
        resetFirstRunSetupCode()
        const lines: string[] = []
        const log = (line: string) => lines.push(line)
        const authKitOn = {
            WORKOS_API_KEY: 'sk_test_obviously_fake_0000',
            WORKOS_CLIENT_ID: 'client_obviously_fake_0000',
            WORKOS_COOKIE_PASSWORD: 'x'.repeat(40)
        } as NodeJS.ProcessEnv
        expect(await announceFirstRunSetup(43117, async () => 0, log, false, authKitOn)).toBe(false)
        expect(await announceFirstRunSetup(43117, async () => 1, log, true)).toBe(false)
        expect(lines).toEqual([])
        expect(await announceFirstRunSetup(43117, async () => 0, log, true)).toBe(true)
        expect(lines).toEqual([expect.stringContaining(firstRunSetupLink(43117))])
        resetFirstRunSetupCode()
    })

    it('says how to turn a sign-in method back on when accounts exist but nobody can sign in', async () => {
        resetFirstRunSetupCode()
        const lines: string[] = []
        expect(
            await announceFirstRunSetup(
                43117,
                async () => 1,
                (line) => lines.push(line),
                false,
                {} as NodeJS.ProcessEnv
            )
        ).toBe(true)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('nobody can sign in')
        expect(lines[0]).toContain('CUTTLELY_LOCAL_ADMIN=true')
        expect(lines[0]).not.toContain('code=')
        resetFirstRunSetupCode()
    })

    it('requires x-request-from: internal for cookie writes and not for reads', () => {
        expect(cookieMutationAllowed('POST', false)).toBe(false)
        expect(cookieMutationAllowed('DELETE', false)).toBe(false)
        expect(cookieMutationAllowed('POST', true)).toBe(true)
        expect(cookieMutationAllowed('GET', false)).toBe(true)
        expect(cookieMutationAllowed('HEAD', false)).toBe(true)
        expect(cookieMutationAllowed('OPTIONS', false)).toBe(true)
    })

    it('does not treat an inactive owner as the break-glass account', async () => {
        const store = new MemoryStore()
        store.add(
            {
                id: 'owner',
                email: 'owner@example.com',
                name: 'Owner',
                status: 'inactive',
                externalId: null,
                credential: await hashPassword(GOOD)
            },
            true
        )
        expect(await store.findSuperUser()).toBeNull()
        const result = json(
            await handleLoginPost(
                ctx({
                    localAdmin: true,
                    internal: true,
                    store,
                    body: { email: 'owner@example.com', password: GOOD }
                })
            )
        )
        expect(result.status).toBe(401)
    })

    it('lets only one of two concurrent first-user creates succeed', async () => {
        const store = new MemoryStore()
        const input = { email: 'owner@example.com', name: 'Owner', credential: null, externalId: 'wos' }
        const results = await Promise.allSettled([store.createOwner(input), store.createOwner({ ...input, email: 'other@example.com' })])
        const ok = results.filter((item) => item.status === 'fulfilled')
        const rejected = results.filter((item) => item.status === 'rejected')
        expect(ok).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(store.users).toHaveLength(1)
    })

    it('migration adds externalId and the break-glass session table', async () => {
        const sql: string[] = []
        const runner = {
            connection: { options: { type: 'sqlite' } },
            async query(text: string) {
                sql.push(text)
                if (text.includes('PRAGMA table_info')) return [{ name: 'id' }]
                if (text.includes('sqlite_master')) return []
                return []
            }
        }
        await addIdentitySignIn(runner as never)
        expect(sql.some((line) => line.includes('externalId'))).toBe(true)
        expect(sql.some((line) => line.includes('identity_local_session'))).toBe(true)
        expect(sql.some((line) => line.includes('login_sessions'))).toBe(false)
        expect(sql.some((line) => line.includes('IDX_user_externalId'))).toBe(true)
        expect(sql.some((line) => line.includes('identity_bootstrap'))).toBe(false)
        expect(sql.some((line) => line.includes('identity_login_failure'))).toBe(false)
    })

    it('login-guard migration creates and drops both tables on every dialect', async () => {
        for (const type of ['sqlite', 'postgres', 'mysql', 'mariadb']) {
            const sql: string[] = []
            const runner = {
                connection: { options: { type } },
                async query(text: string) {
                    sql.push(text)
                    return []
                }
            }
            await addIdentityLoginGuards(runner as never)
            expect(sql.some((line) => line.includes('CREATE TABLE') && line.includes('identity_bootstrap'))).toBe(true)
            expect(sql.some((line) => line.includes('CREATE TABLE') && line.includes('identity_login_failure'))).toBe(true)
            sql.length = 0
            await removeIdentityLoginGuards(runner as never)
            expect(sql.some((line) => line.includes('DROP TABLE IF EXISTS') && line.includes('identity_bootstrap'))).toBe(true)
            expect(sql.some((line) => line.includes('DROP TABLE IF EXISTS') && line.includes('identity_login_failure'))).toBe(true)
        }
    })

    it('links a verified local mailbox ignoring case and surrounding spaces', async () => {
        const store = new MemoryStore()
        store.add({ id: 'user-9', email: 'Ada@Example.com', name: 'Ada', status: 'active', externalId: null, credential: 'hash' }, false)
        const result = await handleCallback(
            ctx({
                workosConfigured: true,
                code: 'code',
                store,
                workos: workos({
                    authenticate: async () => ({
                        user: { id: 'wos-ada', email: '  ada@example.com  ', emailVerified: true, name: 'Ada' },
                        sealedSession: 'sealed-ada'
                    })
                })
            })
        )
        expect(result).toMatchObject({ type: 'redirect', url: '/' })
        expect(store.users[0]).toMatchObject({ externalId: 'wos-ada', credential: 'hash', email: 'Ada@Example.com' })
    })

    it('refuses an unverified email that matches an existing local user', async () => {
        const store = new MemoryStore()
        store.add({ id: 'user-9', email: 'ada@example.com', name: 'Ada', status: 'active', externalId: null, credential: 'hash' })
        const result = await handleCallback(
            ctx({
                workosConfigured: true,
                code: 'code',
                store,
                workos: workos({
                    authenticate: async () => ({
                        user: { id: 'wos-ada', email: 'ada@example.com', emailVerified: false, name: 'Ada' },
                        sealedSession: 'sealed'
                    })
                })
            })
        )
        if (result.type === 'redirect') expect(decodeURIComponent(result.url)).toContain('not verified')
        expect(store.users[0].externalId).toBeNull()
        expect(store.users[0].credential).toBe('hash')
    })

    it('refuses a duplicate mailbox instead of choosing one team', async () => {
        const store = new MemoryStore()
        store.add({ id: 'team-a', email: 'Ada@Example.com', name: 'Ada A', status: 'active', externalId: null, credential: 'hash' })
        store.add({ id: 'team-b', email: 'ada@example.com', name: 'Ada B', status: 'active', externalId: 'wos-other', credential: null })
        const result = await handleCallback(
            ctx({
                workosConfigured: true,
                code: 'code',
                store,
                workos: workos({
                    authenticate: async () => ({
                        user: { id: 'wos-ada', email: 'ada@example.com', emailVerified: true, name: 'Ada' },
                        sealedSession: 'sealed'
                    })
                })
            })
        )
        if (result.type === 'redirect') expect(decodeURIComponent(result.url)).toContain('more than one account')
        expect(store.users.map((user) => user.externalId)).toEqual([null, 'wos-other'])
    })

    it('does not link a plus tag or a different domain', async () => {
        const store = new MemoryStore()
        store.add({ id: 'user-9', email: 'ada@example.com', name: 'Ada', status: 'active', externalId: null, credential: 'hash' })
        for (const email of ['ada+notes@example.com', 'ada@example.org']) {
            const result = await handleCallback(
                ctx({
                    workosConfigured: true,
                    code: 'code',
                    store,
                    workos: workos({
                        authenticate: async () => ({
                            user: { id: 'wos-near', email, emailVerified: true, name: 'Ada' },
                            sealedSession: 'sealed'
                        })
                    })
                })
            )
            if (result.type === 'redirect') expect(decodeURIComponent(result.url)).toContain('No account')
        }
        expect(store.users[0].externalId).toBeNull()
    })
})
