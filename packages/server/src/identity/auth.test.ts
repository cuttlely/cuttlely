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
    handleLocalLogin,
    handleLoginGet,
    handleReauthenticationGet,
    handleLoginPost,
    handleLogout,
    handleRefresh,
    handlePasswordRecoveryGone,
    handleRegister,
    handleResolve,
    SETUP_CODE_REJECTED,
    SETUP_LINK_NEEDED
} from './handlers'
import { LoginRateLimit } from './rateLimit'
import { hashPassword, hashSessionToken, isBcryptHash, passwordErrors } from './password'
import { applyDocumentFrameHeaders, applySetupHeaders, cookieMutationAllowed, isSetupDocumentPath } from './sessionGuard'
import {
    announceFirstRunSetup,
    bindSetupCodeStore,
    createStartupPrinter,
    consumeSetupCode,
    firstRunSetupCode,
    firstRunSetupLink,
    forgetIssuedSetupCode,
    issuedSetupHmac,
    noteSetupFailure,
    reissueExpiredSetupCode,
    reissueExpiredSetupIfOpen,
    reissueFirstRunSetupCode,
    resetFirstRunSetupCode,
    retireOpenSetupCode,
    runSetupCodeWatch,
    serverSetupLink,
    SETUP_CODE_TTL_MS,
    SETUP_CODE_WATCH_MS,
    setupCodeHmac,
    setupCodeMatches,
    setupCodeReady,
    setupCodeVerdict,
    setupCodeWatchActive,
    setupCodeWatchUnrefd,
    simulateOtherSetupCopy,
    simulateSetupRestart
} from './setupCode'
import { SETUP_GLOBAL_WINDOW_MS, setupFailureLimited, socketAddress } from './setupLimit'
import { linkWorkosUser } from './link'
import { resetAuthSecretsForTests } from './authSecrets'
import { resolveTrustProxy } from '../utils/trustProxy'
import { AuthKitSwitchApply, AuthKitSwitchState, switchedSessions } from './authKitSwitch'
import { IdentityStore } from './store'
import { addIdentityLoginGuards, addIdentitySignIn, removeIdentityLoginGuards } from './schemaMigration'
import {
    CreateOwnerInput,
    CreateOwnerOptions,
    HandlerResult,
    InviteSignIn,
    LocalSession,
    NotEmptyError,
    SessionUser,
    SetupCodeRejected,
    UserRow,
    WorkosPort
} from './types'
import { createHmac } from 'crypto'
import type { DataSource } from 'typeorm'
import * as authenticationState from './authenticationState'
import { signedReauthenticationState, workosEpochCookie } from './cookies'
import { workosPort } from './workosAdapter'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'

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

    async replaceCredential(userId: string, expected: string, next: string): Promise<boolean> {
        const user = this.users.find((row) => row.id === userId)
        if (!user || user.credential !== expected) return false
        user.credential = next
        return true
    }

    async hasBcryptCredential(): Promise<boolean> {
        return this.users.some((user) => Boolean(user.credential && isBcryptHash(user.credential)))
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

    async createOwner(input: CreateOwnerInput, options?: CreateOwnerOptions): Promise<UserRow> {
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const previous = this.queue
        this.queue = gate
        await previous
        try {
            return await this.insertOwner(input, options)
        } finally {
            release()
        }
    }

    private async insertOwner(input: CreateOwnerInput, options?: CreateOwnerOptions): Promise<UserRow> {
        if (this.users.length) throw new NotEmptyError()
        if (options?.consumeSetupHmac) {
            const consumed = await consumeSetupCode(options.consumeSetupHmac, options.now ?? Date.now())
            if (!consumed) throw new SetupCodeRejected()
        } else {
            // An open first-run code is retired in this same createOwner transaction.
            await retireOpenSetupCode(options?.now ?? Date.now())
        }
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
        reauthorizationUrl: (redirectUri: string, state: string) =>
            `https://authkit.example/authorize?redirect=${encodeURIComponent(
                redirectUri
            )}&provider=authkit&max_age=0&prompt=login&state=${state}`,
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
        cookiePassword: 'p'.repeat(44),
        epochBindingSecret: 'e'.repeat(44),
        reauthenticationStateSecret: 'p'.repeat(44),
        redirectUri: 'http://127.0.0.1:43117/api/v1/auth/callback',
        secure: false,
        now: NOW,
        ip: '203.0.113.5',
        socketAddress: '203.0.113.5',
        internal: false,
        body: {},
        cookies: {},
        store: partial.store || new MemoryStore(),
        workos: partial.workos || workos(),
        rateLimit: partial.rateLimit || new LoginRateLimit(),
        ...partial
    }
}

function loopbackSocket(remote: string): boolean {
    const host = remote
        .trim()
        .toLowerCase()
        .replace(/^::ffff:/, '')
    return host === '127.0.0.1' || host === '::1'
}

function registerApp(trust: boolean | number, store: MemoryStore, seen?: { socket: string; ip: string; ips: string[] }) {
    const app = express()
    app.set('trust proxy', trust)
    app.use(express.json())
    app.post('/api/v1/account/register', (req, res) => {
        applySetupHeaders(res)
        if (seen) {
            seen.socket = req.socket.remoteAddress || ''
            seen.ip = req.ip || ''
            seen.ips = [...req.ips]
        }
        const context = ctx({
            localAdmin: true,
            internal: req.headers['x-request-from'] === 'internal',
            ip: req.ip || '',
            socketAddress: socketAddress(req.socket.remoteAddress),
            store,
            now: NOW,
            body: req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
        })
        void handleRegister(context).then((result) => {
            if (result.type !== 'json') {
                res.status(500).end()
                return
            }
            res.status(result.status).json(result.body)
        })
    })
    app.get(['/setup', '/organization-setup', '/server-setup', '/owner-recovery'], (req, res) => {
        if (isSetupDocumentPath(req.path)) applySetupHeaders(res)
        res.status(200).type('html').send('<!doctype html><title>setup</title>')
    })
    app.get('/signin', (_req, res) => {
        res.status(200).type('html').send('<!doctype html><title>sign in</title>')
    })
    return app
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

    it('GET /auth/reauthenticate requests active authentication and binds callback state in a cookie', async () => {
        const result = await handleReauthenticationGet(ctx({ workosConfigured: true }))
        expect(result).toMatchObject({ type: 'redirect', status: 302 })
        if (result.type !== 'redirect') return
        expect(result.url).toContain('max_age=0')
        expect(result.url).toContain('prompt=login')
        const state = new URL(result.url).searchParams.get('state')
        expect(state).toBeTruthy()
        expect(result.cookies?.[0]).toMatchObject({
            name: 'cuttlely-reauth-state',
            value: state,
            options: { httpOnly: true, sameSite: 'lax', path: '/api/v1/auth/callback', maxAge: 600000 }
        })
    })

    it('WorkOS adapter adds fresh-authentication options only to reauthentication', () => {
        const apiKey = process.env.WORKOS_API_KEY
        const clientId = process.env.WORKOS_CLIENT_ID
        process.env.WORKOS_API_KEY = 'test_value'
        process.env.WORKOS_CLIENT_ID = 'client_test'
        try {
            const redirectUri = 'https://app.example/api/v1/auth/callback'
            const ordinary = new URL(workosPort.authorizationUrl(redirectUri))
            const reauthentication = new URL(workosPort.reauthorizationUrl!(redirectUri, 'bound-state'))
            expect(ordinary.searchParams.has('max_age')).toBe(false)
            expect(ordinary.searchParams.has('prompt')).toBe(false)
            expect(reauthentication.searchParams.get('max_age')).toBe('0')
            expect(reauthentication.searchParams.get('prompt')).toBe('login')
            expect(reauthentication.searchParams.get('state')).toBe('bound-state')
        } finally {
            if (apiKey === undefined) delete process.env.WORKOS_API_KEY
            else process.env.WORKOS_API_KEY = apiKey
            if (clientId === undefined) delete process.env.WORKOS_CLIENT_ID
            else process.env.WORKOS_CLIENT_ID = clientId
        }
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

    it('callback links a verified email and sets the application session cookie', async () => {
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
            clearCookies: ['wos-session', 'cuttlely-workos-epoch']
        })
        if (result.type !== 'redirect') return
        expect(result.cookies?.[0]).toMatchObject({
            name: 'cuttlely-local-session',
            options: { httpOnly: true, sameSite: 'lax', path: '/', secure: false }
        })
        const token = result.cookies?.[0].value || ''
        expect(store.local.get(hashSessionToken(token))).toMatchObject({
            userId: 'user-9',
            authenticationMethod: 'workos',
            recoveryUse: false
        })
        expect(store.users[0].externalId).toBe('wos-1')
        expect(store.users[0].credential).toBe('old-hash')
        expect(port.externalIds).toEqual([{ workosUserId: 'wos-1', ourUserId: 'user-9' }])
    })

    it('uses one database-session cookie shape for local, WorkOS, and owner recovery sign-in', async () => {
        const credential = await hashPassword(GOOD)
        const signIn = async (method: 'local' | 'workos' | 'recovery') => {
            const store = new MemoryStore()
            store.add({ id: 'owner', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential }, true)
            const result =
                method === 'workos'
                    ? await handleCallback(ctx({ workosConfigured: true, code: 'code', store }))
                    : method === 'local'
                    ? await handleLocalLogin(
                          ctx({ localUsers: true, internal: true, store, body: { email: 'owner@example.com', password: GOOD } })
                      )
                    : await handleLoginPost(ctx({ internal: true, store, body: { email: 'owner@example.com', password: GOOD } }))
            const cookies = result.type === 'json' || result.type === 'redirect' ? result.cookies : undefined
            const cookie = cookies?.find((item) => item.name === 'cuttlely-local-session')
            const session = cookie ? store.local.get(hashSessionToken(cookie.value)) : undefined
            return { cookie, session }
        }
        const local = await signIn('local')
        const workosSession = await signIn('workos')
        const recovery = await signIn('recovery')
        for (const result of [local, workosSession, recovery]) {
            expect(result.cookie).toMatchObject({
                name: 'cuttlely-local-session',
                options: { httpOnly: true, sameSite: 'lax', path: '/', secure: false }
            })
            expect(result.session).toMatchObject({ userId: 'owner', token: expect.any(String), idleExpires: expect.any(Date) })
        }
        expect([
            local.session?.authenticationMethod,
            workosSession.session?.authenticationMethod,
            recovery.session?.authenticationMethod
        ]).toEqual(['local', 'workos', 'recovery'])
    })

    it('ordinary callback records no recent-authentication evidence', async () => {
        const store = new MemoryStore()
        store.add({ id: 'user-9', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential: null }, true)
        const recordRecentAuthentication = jest.fn()
        await handleCallback(ctx({ workosConfigured: true, code: 'code', store, recordRecentAuthentication }))
        expect(recordRecentAuthentication).not.toHaveBeenCalled()
    })

    it.each([
        ['without auth_time', undefined, false],
        ['with auth_time before the request', NOW / 1000 - 1, false],
        ['with auth_time at the request', NOW / 1000, true]
    ])('state-bound reauthentication callback %s', async (_name, authTime, expected) => {
        const store = new MemoryStore()
        store.add({ id: 'user-9', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential: null }, true)
        const recordRecentAuthentication = jest.fn(async () => ({
            name: 'cuttlely-recent-auth',
            value: 'recent',
            options: { httpOnly: true as const, sameSite: 'lax' as const, path: '/', secure: false }
        }))
        const state = signedReauthenticationState(NOW, 'reauth-state', 'p'.repeat(44))
        const result = await handleCallback(
            ctx({
                workosConfigured: true,
                code: 'code',
                state,
                cookies: { 'cuttlely-reauth-state': state },
                store,
                workos: workos({
                    authenticate: async () => ({
                        user: { id: 'wos-1', email: 'owner@example.com', emailVerified: true, name: 'Owner' },
                        sealedSession: 'sealed-1',
                        authTime
                    })
                }),
                recordRecentAuthentication
            })
        )
        expect(recordRecentAuthentication).toHaveBeenCalledTimes(expected ? 1 : 0)
        if (result.type === 'redirect') expect(result.cookies?.some((cookie) => cookie.name === 'cuttlely-recent-auth')).toBe(expected)
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
        expect(result).toMatchObject({ type: 'redirect', url: '/', clearCookies: ['wos-session', 'cuttlely-workos-epoch'] })
        if (result.type === 'redirect') {
            expect(result.cookies?.[0]).toMatchObject({ name: 'cuttlely-local-session' })
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
        expect(result).toMatchObject({ type: 'redirect', url: '/', clearCookies: ['wos-session', 'cuttlely-workos-epoch'] })
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

    it('removes an owner session that was inserted after a concurrent method switch', async () => {
        const store = new MemoryStore()
        const credential = await hashPassword(GOOD)
        store.add({ id: 'owner', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential }, true)
        jest.spyOn(authenticationState, 'refreshAuthenticationState').mockResolvedValue(null)
        jest.spyOn(authenticationState, 'selectedAuthenticationEpoch').mockReturnValueOnce(4).mockReturnValue(5)
        const result = json(
            await handleLoginPost(
                ctx({
                    dataSource: {} as DataSource,
                    authenticationEpoch: 4,
                    localAdmin: true,
                    localUsers: false,
                    internal: true,
                    store,
                    body: { email: 'owner@example.com', password: GOOD }
                })
            )
        )
        expect(result.status).toBe(409)
        expect(store.local.size).toBe(0)
        jest.restoreAllMocks()
    })

    it.each([
        { name: 'epoch and method', cachedEpoch: 4, sessionEpoch: 5 },
        { name: 'method', cachedEpoch: 5, sessionEpoch: 5 }
    ])('keeps a fresh cross-process session when the cached $name is behind', async ({ cachedEpoch, sessionEpoch }) => {
        const store = new MemoryStore()
        store.add({ id: 'owner', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: 'wos-1', credential: null }, true)
        const raw = 'fresh-cross-process-session'
        const digest = hashSessionToken(raw)
        await store.insertLocalSession({
            id: 'fresh-session',
            userId: 'owner',
            token: digest,
            idleExpires: new Date(NOW + 60_000),
            absoluteExpires: new Date(NOW + 120_000),
            authenticationMethod: 'workos',
            authenticationEpoch: sessionEpoch
        })
        const refreshed = jest.spyOn(authenticationState, 'refreshAuthenticationState').mockResolvedValue({
            activeMethod: 'workos',
            authenticationEpoch: 5
        } as authenticationState.AuthenticationState)
        const result = await establishSession(
            ctx({
                dataSource: {} as DataSource,
                authenticationEpoch: cachedEpoch,
                activeAuthenticationMethod: 'local',
                store,
                cookies: { 'cuttlely-local-session': raw }
            })
        )
        expect(result.user?.id).toBe('owner')
        expect(store.local.has(digest)).toBe(true)
        expect(refreshed).toHaveBeenCalledWith(expect.anything(), true)
        jest.restoreAllMocks()
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

    it('owner recovery remains available when the compatibility flag is off', async () => {
        await expect(handleLoginPost(ctx({ workosConfigured: true, internal: true }))).resolves.toMatchObject({
            type: 'json',
            status: 401
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
        const unknown = json(await handleLoginPost(ctx({ ...base, body: { email: 'unknown@example.com', password: GOOD } })))
        expect(unknown).toMatchObject({ status: other.status, body: other.body })
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
        expect(store.local.get(hashSessionToken(raw))).toMatchObject({ authenticationMethod: 'recovery', recoveryUse: true })
        expect(JSON.stringify(ok.body)).not.toContain(GOOD)
    })

    it('records every owner recovery outcome and raises the required alert on success', async () => {
        const store = new MemoryStore()
        const credential = await hashPassword(GOOD)
        store.add({ id: 'owner', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential }, true)
        const noteRecoveryAttempt = jest.fn(async () => undefined)
        const raiseRecoveryAlert = jest.fn(async () => undefined)
        const recordRecentAuthentication = jest.fn(async () => ({
            name: 'cuttlely-recent-auth',
            value: 'recent',
            options: { httpOnly: true as const, sameSite: 'lax' as const, path: '/', secure: false }
        }))
        const recoveryRateLimit = new LoginRateLimit(1)
        const base = { internal: true, store, recoveryRateLimit, noteRecoveryAttempt, raiseRecoveryAlert, recordRecentAuthentication }

        expect(json(await handleLoginPost(ctx({ ...base, body: { email: 'owner@example.com', password: 'Wrong-Pass1!' } }))).status).toBe(
            401
        )
        expect(json(await handleLoginPost(ctx({ ...base, body: { email: 'owner@example.com', password: GOOD } }))).status).toBe(429)
        expect(noteRecoveryAttempt).toHaveBeenNthCalledWith(1, 'wrong_credential', null)
        expect(noteRecoveryAttempt).toHaveBeenNthCalledWith(2, 'throttled', null)

        const successLimiter = new LoginRateLimit(1)
        const success = json(
            await handleLoginPost(
                ctx({
                    ...base,
                    recoveryRateLimit: successLimiter,
                    ip: '198.51.100.7',
                    body: { email: 'owner@example.com', password: GOOD }
                })
            )
        )
        expect(success.status).toBe(200)
        expect(noteRecoveryAttempt).toHaveBeenLastCalledWith('success', 'owner')
        expect(raiseRecoveryAlert).toHaveBeenCalledWith('owner')
        expect(recordRecentAuthentication).toHaveBeenCalledWith('owner')
        expect(success.cookies?.some((cookie) => cookie.name === 'cuttlely-recent-auth')).toBe(true)
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

    it('clears a sealed cookie after convergence without exchanging it', async () => {
        const refresh = jest.fn()
        const context = ctx({
            workosConfigured: true,
            sealedWorkosSessionsAccepted: false,
            cookies: { 'wos-session': 'old-sealed' },
            workos: workos({ refresh })
        })
        const refreshed = json(await handleRefresh(context))
        expect(refreshed.status).toBe(401)
        expect(refreshed.clearCookies).toEqual(expect.arrayContaining(['wos-session', 'cuttlely-workos-epoch']))
        expect(refresh).not.toHaveBeenCalled()

        const established = await establishSession(context)
        expect(established.user).toBeNull()
        expect(established.clearCookies).toEqual(expect.arrayContaining(['wos-session', 'cuttlely-workos-epoch']))
        expect(refresh).not.toHaveBeenCalled()
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

    it('deletes the application session before remote logout and keeps local logout successful on remote failure', async () => {
        const order: string[] = []
        const store = new MemoryStore()
        const token = 'application-token'
        await store.insertLocalSession({
            id: 'session',
            userId: 'owner',
            token: hashSessionToken(token),
            idleExpires: new Date(NOW + 1000),
            absoluteExpires: new Date(NOW + 1000)
        })
        const originalDelete = store.deleteLocalSession.bind(store)
        store.deleteLocalSession = async (digest) => {
            order.push('local')
            await originalDelete(digest)
        }
        const result = json(
            await handleLogout(
                ctx({
                    workosConfigured: true,
                    internal: true,
                    store,
                    cookies: { 'cuttlely-local-session': token, 'wos-session': 'old-sealed' },
                    workos: workos({
                        logoutUrl: async () => {
                            order.push('remote')
                            throw new Error('provider unavailable')
                        }
                    })
                })
            )
        )
        expect(order[0]).toBe('local')
        expect(order.slice(1)).toEqual(['remote', 'remote'])
        expect(result.status).toBe(200)
        expect(result.body.redirectTo).toMatch(/\/signin$/)
        expect(result.clearCookies).toEqual(
            expect.arrayContaining(['cuttlely-local-session', 'wos-session', 'cuttlely-workos-epoch', 'cuttlely-recent-auth'])
        )
    })

    it('resolve follows WorkOS, break-glass, and existing users', async () => {
        const empty = new MemoryStore()
        expect(json(await handleResolve(ctx({ workosConfigured: true, store: empty }))).body).toEqual({ redirectUrl: '/signin' })
        expect(json(await handleResolve(ctx({ localAdmin: true, store: empty }))).body).toEqual({ redirectUrl: '/setup' })
        expect(json(await handleResolve(ctx({ store: new MemoryStore() }))).body).toEqual({ redirectUrl: '/setup' })
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
        resetFirstRunSetupCode()
        const setupCode = firstRunSetupCode(NOW)
        const created = json(
            await handleRegister(
                ctx({
                    localAdmin: true,
                    internal: true,
                    ip: '127.0.0.1',
                    socketAddress: '127.0.0.1',
                    store,
                    now: NOW,
                    body: { user: { name: 'Owner', email: 'owner@example.com', credential: GOOD }, setupCode }
                })
            )
        )
        expect(created.status).toBe(200)
        expect(created.body.id).toBe('user-1')
        expect(created.body.email).toBe('owner@example.com')
        expect(created.cookies?.[0]).toMatchObject({ name: 'cuttlely-local-session', options: { httpOnly: true } })
        expect(JSON.stringify(created.body)).not.toContain(GOOD)
        expect(await store.findSuperUser()).toEqual(expect.objectContaining({ email: 'owner@example.com' }))
        expect(
            json(
                await handleRegister(
                    ctx({
                        localAdmin: true,
                        internal: true,
                        ip: '127.0.0.1',
                        socketAddress: '127.0.0.1',
                        store,
                        now: NOW,
                        body: { user: { name: 'Other', email: 'other@example.com', credential: GOOD }, setupCode }
                    })
                )
            ).status
        ).toBe(404)
        const weak = json(
            await handleRegister(
                ctx({
                    localAdmin: true,
                    internal: true,
                    ip: '127.0.0.1',
                    socketAddress: '127.0.0.1',
                    store: new MemoryStore(),
                    now: NOW,
                    body: { user: { name: 'Owner', email: 'owner@example.com', credential: 'short' }, setupCode }
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

    it('binds an epoch-less sealed session only before the first method switch', async () => {
        const store = new MemoryStore()
        store.add(
            { id: 'user-1', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: 'wos-1', credential: null },
            true
        )
        const sealed = 'legacy-sealed'
        const password = 'p'.repeat(44)
        const authenticateSession = jest.fn(async () => ({
            authenticated: true as const,
            sessionId: 'session-1',
            user: { id: 'wos-1', email: 'owner@example.com', emailVerified: true, name: 'Owner' }
        }))
        jest.spyOn(authenticationState, 'refreshAuthenticationState').mockResolvedValue(null)
        jest.spyOn(authenticationState, 'selectedAuthenticationBaselineEpoch').mockReturnValue(4)
        const current = jest.spyOn(authenticationState, 'selectedAuthenticationEpoch').mockReturnValue(4)
        const bindingSecret = 'e'.repeat(44)
        const base = {
            dataSource: {} as DataSource,
            authenticationEpoch: 4,
            workosConfigured: true,
            cookiePassword: password,
            epochBindingSecret: bindingSecret,
            store,
            workos: workos({ authenticateSession })
        }

        const accepted = await establishSession(ctx({ ...base, cookies: { 'wos-session': sealed } }))
        expect(accepted.user?.id).toBe('user-1')
        expect(accepted.cookies).toEqual([
            expect.objectContaining({ name: 'cuttlely-workos-epoch', value: workosEpochCookie(sealed, 4, bindingSecret, false).value })
        ])

        current.mockReturnValue(5)
        const afterSwitch = await establishSession(
            ctx({ ...base, authenticationEpoch: 5, cookies: { 'wos-session': sealed }, workos: workos({ authenticateSession }) })
        )
        expect(afterSwitch.user).toBeNull()
        expect(afterSwitch.clearCookies).toEqual(['wos-session', 'cuttlely-workos-epoch'])

        const stale = workosEpochCookie(sealed, 4, bindingSecret, false).value
        const staleBound = await establishSession(
            ctx({
                ...base,
                authenticationEpoch: 5,
                cookies: { 'wos-session': sealed, 'cuttlely-workos-epoch': stale },
                workos: workos({ authenticateSession })
            })
        )
        expect(staleBound.user).toBeNull()
        expect(staleBound.clearCookies).toEqual(['wos-session', 'cuttlely-workos-epoch'])
        expect(authenticateSession).toHaveBeenCalledTimes(1)
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
        const remote = (body: Record<string, unknown>) =>
            handleRegister(ctx({ localAdmin: true, internal: true, ip: '172.18.0.1', socketAddress: '172.18.0.1', now: NOW, store, body }))

        const noCode = json(await remote({ user }))
        // 400, not 403: the app sends a 403 to its no-permission page, and this message has to reach the form.
        expect(noCode).toMatchObject({ status: 400, body: { message: SETUP_LINK_NEEDED } })
        // No code has been made yet, so nothing matches, not even an empty string.
        expect(json(await remote({ user, setupCode: '' })).status).toBe(400)

        const link = firstRunSetupLink(43117, {})
        const code = new URL(link).hash.slice('#code='.length)
        expect(link.startsWith('http://localhost:43117/setup#code=')).toBe(true)
        expect(link.includes('?code=')).toBe(false)
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
        await expect(
            handleRegister(
                ctx({ localAdmin: true, internal: true, ip: '203.0.113.5', socketAddress: '203.0.113.5', store: populated, body })
            )
        ).resolves.toMatchObject({
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
        expect(await announceFirstRunSetup(43117, async () => 0, log, false, authKitOn)).toBe('none')
        expect(await announceFirstRunSetup(43117, async () => 1, log, true)).toBe('none')
        expect(lines).toEqual([])
        expect(await announceFirstRunSetup(43117, async () => 0, log, true, {})).toBe('setup')
        expect(lines.join('\n')).toContain(firstRunSetupLink(43117, {}))
        expect(lines.join('\n')).toContain('works once')
        expect(lines.join('\n')).toContain('/setup#code=')
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
        ).toBe('recover')
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

    it('rejects an expired setup code and issues a new one on demand and after a restart', async () => {
        resetFirstRunSetupCode()
        const lines: string[] = []
        expect(
            await announceFirstRunSetup(
                43117,
                async () => 1,
                (line) => lines.push(line),
                true
            )
        ).toBe('none')
        const code = firstRunSetupCode(NOW)
        expect(await setupCodeMatches(code, NOW + SETUP_CODE_TTL_MS - 1)).toBe(true)
        expect(await setupCodeMatches(code, NOW + SETUP_CODE_TTL_MS)).toBe(false)
        const fresh = firstRunSetupCode(NOW + SETUP_CODE_TTL_MS)
        await setupCodeReady()
        expect(fresh).not.toBe(code)
        expect(lines.some((line) => line.includes('A new setup link is ready') && line.includes(`#code=${fresh}`))).toBe(true)
        expect(await setupCodeMatches(fresh, NOW + SETUP_CODE_TTL_MS)).toBe(true)
        expect(await setupCodeMatches(code, NOW + SETUP_CODE_TTL_MS)).toBe(false)
        const rotated = reissueFirstRunSetupCode(NOW + SETUP_CODE_TTL_MS)
        await setupCodeReady()
        expect(rotated).not.toBe(fresh)
        expect(await setupCodeMatches(rotated, NOW + SETUP_CODE_TTL_MS)).toBe(true)
        forgetIssuedSetupCode()
        lines.length = 0
        const other = firstRunSetupCode(NOW + SETUP_CODE_TTL_MS)
        await setupCodeReady()
        expect(other).not.toBe(rotated)
        expect(await setupCodeMatches(other, NOW + SETUP_CODE_TTL_MS)).toBe(false)
        expect(await setupCodeMatches(rotated, NOW + SETUP_CODE_TTL_MS)).toBe(true)
        expect(issuedSetupHmac()).toBeNull()
        expect(lines.some((line) => line.includes('#code='))).toBe(false)
        const renewed = firstRunSetupCode(NOW + 2 * SETUP_CODE_TTL_MS)
        await setupCodeReady()
        expect(await setupCodeMatches(renewed, NOW + 2 * SETUP_CODE_TTL_MS)).toBe(true)
        expect(await setupCodeMatches(rotated, NOW + 2 * SETUP_CODE_TTL_MS)).toBe(false)
        resetFirstRunSetupCode()
    })

    it('refuses an expired setup code from register, prints a new one, and accepts the new one', async () => {
        const base = Date.parse('2026-10-20T15:00:00.000Z')
        const later = base + SETUP_CODE_TTL_MS + 60_000
        const spy = jest.spyOn(Date, 'now').mockReturnValue(base)
        resetFirstRunSetupCode()
        const lines: string[] = []
        expect(
            await announceFirstRunSetup(
                43117,
                async () => 0,
                (line) => lines.push(line),
                true
            )
        ).toBe('setup')
        await setupCodeReady()
        const code = firstRunSetupCode()
        spy.mockReturnValue(later)
        lines.length = 0
        const store = new MemoryStore()
        const user = { name: 'Owner', email: 'owner@example.com', credential: GOOD }
        const refused = json(
            await handleRegister(
                ctx({
                    localAdmin: true,
                    internal: true,
                    socketAddress: '192.0.2.40',
                    store,
                    now: later,
                    body: { user, setupCode: code }
                })
            )
        )
        expect(refused.status).toBe(400)
        expect(refused.body).toEqual({
            code: 'CODE_EXPIRED',
            reason: 'expired',
            message: 'This setup code has expired. A new code was printed in the server log.'
        })
        expect(JSON.stringify(refused.body)).not.toContain(code)
        await setupCodeReady()
        const printed = lines.find((line) => line.includes('A new setup link is ready'))
        expect(printed).toBeTruthy()
        const fresh = printed!.slice(printed!.indexOf('#code=') + '#code='.length)
        expect(fresh).not.toBe(code)
        expect(JSON.stringify(refused.body)).not.toContain(fresh)
        expect(await setupCodeMatches(code, later)).toBe(false)
        expect(await setupCodeMatches(fresh, later)).toBe(true)
        const created = json(
            await handleRegister(
                ctx({
                    localAdmin: true,
                    internal: true,
                    socketAddress: '192.0.2.40',
                    store,
                    now: later,
                    body: { user, setupCode: fresh }
                })
            )
        )
        expect(created.status).toBe(200)
        expect(store.users).toHaveLength(1)
        spy.mockRestore()
        resetFirstRunSetupCode()
    })

    it('says the previous code expired on register after a setup reissue, and a used code is not expired', async () => {
        const base = Date.parse('2026-10-20T16:00:00.000Z')
        const later = base + SETUP_CODE_TTL_MS + 60_000
        const spy = jest.spyOn(Date, 'now').mockReturnValue(base)
        resetFirstRunSetupCode()
        const lines: string[] = []
        try {
            expect(
                await announceFirstRunSetup(
                    43117,
                    async () => 0,
                    (line) => lines.push(line),
                    true
                )
            ).toBe('setup')
            await setupCodeReady()
            const code = firstRunSetupCode()
            spy.mockReturnValue(later)
            lines.length = 0
            await reissueExpiredSetupIfOpen(async () => 0, true, process.env, later)
            await setupCodeReady()
            const printed = lines.find((line) => line.includes('A new setup link is ready'))
            expect(printed).toBeTruthy()
            const fresh = printed!.slice(printed!.indexOf('#code=') + '#code='.length)
            const store = new MemoryStore()
            const user = { name: 'Owner', email: 'owner@example.com', credential: GOOD }
            const register = async (setupCode: string, socketAddress: string, target = store) =>
                json(
                    await handleRegister(
                        ctx({
                            localAdmin: true,
                            internal: true,
                            socketAddress,
                            store: target,
                            now: later,
                            body: { user, setupCode }
                        })
                    )
                )
            const refused = await register(code, '192.0.2.41')
            expect(refused.status).toBe(400)
            expect(refused.body).toEqual({
                code: 'CODE_EXPIRED',
                reason: 'expired',
                message: 'This setup code has expired. A new code was printed in the server log.'
            })
            const unrelated = await register('not-the-code', '192.0.2.42')
            expect(unrelated.status).toBe(400)
            expect(unrelated.body).toEqual({ message: SETUP_CODE_REJECTED })
            expect(unrelated.body.code).toBeUndefined()
            const created = await register(fresh, '192.0.2.43')
            expect(created.status).toBe(200)
            expect(store.users).toHaveLength(1)
            expect(await setupCodeMatches(code, later)).toBe(false)

            resetFirstRunSetupCode()
            spy.mockReturnValue(base)
            await announceFirstRunSetup(
                43117,
                async () => 0,
                () => undefined,
                true
            )
            await setupCodeReady()
            const used = firstRunSetupCode()
            const hmac = issuedSetupHmac()
            expect(hmac).toBeTruthy()
            expect(await consumeSetupCode(hmac as string, base + 1000)).toBe(true)
            spy.mockReturnValue(later)
            expect(await setupCodeVerdict(used, later)).toBe('rejected')
            const afterUse = await register(used, '192.0.2.44', new MemoryStore())
            expect(afterUse.status).toBe(400)
            expect(afterUse.body.code).not.toBe('CODE_EXPIRED')
            expect(afterUse.body.message).toBe(SETUP_CODE_REJECTED)
        } finally {
            spy.mockRestore()
            resetFirstRunSetupCode()
        }
    })

    it('sends a reissued line to the real logger after the startup flush', async () => {
        const direct: string[] = []
        const startupOnly = createStartupPrinter((line) => direct.push(line))
        startupOnly.log('buffered')
        expect(direct).toEqual([])
        startupOnly.flush()
        expect(direct).toEqual(['buffered'])
        startupOnly.log('live')
        startupOnly.flush()
        expect(direct).toEqual(['buffered', 'live'])

        resetFirstRunSetupCode()
        const logged: string[] = []
        const startup = createStartupPrinter((line) => logged.push(line))
        try {
            expect(await announceFirstRunSetup(43117, async () => 0, startup.log, true)).toBe('setup')
            await setupCodeReady()
            expect(logged).toEqual([])
            startup.flush()
            expect(logged.some((line) => line.includes('Setup code'))).toBe(true)
            const afterReady = logged.length
            const later = Date.now() + SETUP_CODE_TTL_MS + 60_000
            await reissueExpiredSetupCode(later)
            const reissued = logged.slice(afterReady)
            expect(reissued.some((line) => line.includes('A new setup link is ready'))).toBe(true)
            const afterReissue = logged.length
            reissueFirstRunSetupCode(later + SETUP_CODE_TTL_MS)
            await setupCodeReady()
            expect(logged.slice(afterReissue).some((line) => line.includes('A new setup link is ready'))).toBe(true)

            const indexSource = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8')
            const announceAt = indexSource.indexOf('announceFirstRunSetup(')
            const flushAt = indexSource.indexOf('startupLog.flush()')
            expect(announceAt).toBeGreaterThan(-1)
            expect(flushAt).toBeGreaterThan(announceAt)
            expect(indexSource).toContain('createStartupPrinter((line) => logger.info(line))')
            expect(indexSource).not.toContain('(line) => lines.push(line)')
        } finally {
            resetFirstRunSetupCode()
        }
    })

    it('checks once a minute while setup is open, and stops once an account exists', async () => {
        const base = Date.parse('2026-10-20T15:00:00.000Z')
        const later = base + SETUP_CODE_TTL_MS + 60_000
        const spy = jest.spyOn(Date, 'now').mockReturnValue(base)
        resetFirstRunSetupCode()
        const lines: string[] = []
        let users = 0
        expect(
            await announceFirstRunSetup(
                43117,
                async () => users,
                (line) => lines.push(line),
                true
            )
        ).toBe('setup')
        await setupCodeReady()
        expect(SETUP_CODE_WATCH_MS).toBe(60_000)
        expect(setupCodeWatchActive()).toBe(true)
        expect(setupCodeWatchUnrefd()).toBe(true)
        const code = firstRunSetupCode()
        spy.mockReturnValue(later)
        lines.length = 0
        await runSetupCodeWatch(later)
        await setupCodeReady()
        const printed = lines.find((line) => line.includes('A new setup link is ready'))
        expect(printed).toBeTruthy()
        const fresh = printed!.slice(printed!.indexOf('#code=') + '#code='.length)
        expect(await setupCodeMatches(code, later)).toBe(false)
        expect(await setupCodeMatches(fresh, later)).toBe(true)
        users = 1
        await runSetupCodeWatch(later)
        expect(setupCodeWatchActive()).toBe(false)
        spy.mockRestore()
        resetFirstRunSetupCode()
    })

    it('replaces an expired code for a setup document while setup is open, and stops once an account exists', async () => {
        const base = Date.parse('2026-10-20T15:00:00.000Z')
        const later = base + SETUP_CODE_TTL_MS + 60_000
        const spy = jest.spyOn(Date, 'now').mockReturnValue(base)
        resetFirstRunSetupCode()
        const lines: string[] = []
        await announceFirstRunSetup(
            43117,
            async () => 0,
            (line) => lines.push(line),
            true
        )
        await setupCodeReady()
        const code = firstRunSetupCode()
        spy.mockReturnValue(later)
        lines.length = 0
        await reissueExpiredSetupIfOpen(async () => 0, true, process.env, later)
        await setupCodeReady()
        const printed = lines.find((line) => line.includes('A new setup link is ready'))
        expect(printed).toBeTruthy()
        const fresh = printed!.slice(printed!.indexOf('#code=') + '#code='.length)
        expect(await setupCodeMatches(code, later)).toBe(false)
        expect(await setupCodeMatches(fresh, later)).toBe(true)
        lines.length = 0
        await reissueExpiredSetupIfOpen(async () => 1, true, process.env, later + SETUP_CODE_TTL_MS)
        await setupCodeReady()
        expect(lines.some((line) => line.includes('A new setup link is ready'))).toBe(false)
        expect(await setupCodeMatches(fresh, later)).toBe(true)
        spy.mockRestore()
        resetFirstRunSetupCode()
    })

    it('does not print a new code when another copy already stored a fresh one', async () => {
        resetFirstRunSetupCode()
        const lines: string[] = []
        await announceFirstRunSetup(
            43117,
            async () => 1,
            (line) => lines.push(line),
            true
        )
        bindSetupCodeStore({
            async read() {
                return { codeHmac: 'ab'.repeat(32), issuedAt: NOW, expiresAt: NOW, consumedAt: null }
            },
            async save() {
                return 'kept'
            },
            async consume() {
                return false
            }
        })
        lines.length = 0
        await reissueExpiredSetupCode(NOW + 1)
        expect(lines.some((line) => line.includes('#code='))).toBe(false)
        expect(issuedSetupHmac()).toBeNull()
        resetFirstRunSetupCode()
    })

    it('says the setup code from the last start is still valid after a restart of this install', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-setup-issuer-'))
        const previousPath = process.env.SECRETKEY_PATH
        try {
            process.env.SECRETKEY_PATH = dir
            resetFirstRunSetupCode()
            const lines: string[] = []
            expect(
                await announceFirstRunSetup(
                    43117,
                    async () => 0,
                    (line) => lines.push(line),
                    true
                )
            ).toBe('setup')
            await setupCodeReady()
            const code = firstRunSetupCode()
            await simulateSetupRestart()
            lines.length = 0
            expect(
                await announceFirstRunSetup(
                    43117,
                    async () => 0,
                    (line) => lines.push(line),
                    true
                )
            ).toBe('setup')
            expect(lines).toHaveLength(1)
            expect(lines[0]).toContain('The setup code from the last start is still valid')
            expect(lines[0]).not.toContain('another copy')
            expect(lines[0]).not.toMatch(/#code=/)
            expect(await setupCodeMatches(code)).toBe(true)
            const marks = JSON.parse(fs.readFileSync(path.join(dir, 'setup-issuer.json'), 'utf8')) as {
                instanceId: string
                starts: Record<string, { pid: number; expiresAt?: number }>
            }
            expect(marks.instanceId.length).toBeGreaterThan(8)
            const expiry = Object.values(marks.starts).find((mark) => mark.pid === 0)?.expiresAt
            expect(expiry).toEqual(expect.any(Number))
            expect(lines[0]).toContain(new Date(expiry as number).toISOString())
            lines.length = 0
            await simulateOtherSetupCopy()
            expect(
                await announceFirstRunSetup(
                    43117,
                    async () => 0,
                    (line) => lines.push(line),
                    true
                )
            ).toBe('setup')
            expect(lines[0]).toContain('another copy')
            expect(lines[0]).not.toContain('last start')
            expect(await setupCodeMatches(code)).toBe(true)
        } finally {
            if (previousPath === undefined) delete process.env.SECRETKEY_PATH
            else process.env.SECRETKEY_PATH = previousPath
            resetFirstRunSetupCode()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('prints the setup link with the code in the fragment', () => {
        resetFirstRunSetupCode()
        const link = firstRunSetupLink(43117)
        const url = new URL(link)
        expect(url.searchParams.get('code')).toBeNull()
        expect(url.hash.startsWith('#code=')).toBe(true)
        expect(url.hash.slice('#code='.length).length).toBeGreaterThanOrEqual(16)
        const server = serverSetupLink(3000, { APP_URL: 'https://rosas-bakery.example/x' })
        expect(server.startsWith('https://rosas-bakery.example/setup#code=')).toBe(true)
        expect(server.includes('?code=')).toBe(false)
        resetFirstRunSetupCode()
    })

    it('rejects a wrong, long, or non-string setup code', async () => {
        resetFirstRunSetupCode()
        const code = firstRunSetupCode(NOW)
        expect(await setupCodeMatches(code, NOW)).toBe(true)
        expect(await setupCodeMatches('TESTCODE-wrong', NOW)).toBe(false)
        expect(await setupCodeMatches('T'.repeat(65), NOW)).toBe(false)
        expect(await setupCodeMatches('TESTCODE', NOW)).toBe(false)
        expect(await setupCodeMatches(12, NOW)).toBe(false)
        expect(await setupCodeMatches(null, NOW)).toBe(false)
        expect(await setupCodeMatches('', NOW)).toBe(false)
        resetFirstRunSetupCode()
    })

    it('creates exactly one owner when two registers use one setup code', async () => {
        resetFirstRunSetupCode()
        const code = firstRunSetupCode(NOW)
        const store = new MemoryStore()
        const bodyFor = (email: string) => ({
            user: { name: 'Owner', email, credential: GOOD },
            setupCode: code
        })
        const results = await Promise.all([
            handleRegister(
                ctx({
                    localAdmin: true,
                    internal: true,
                    socketAddress: '127.0.0.1',
                    store,
                    now: NOW,
                    body: bodyFor('owner@example.com')
                })
            ),
            handleRegister(
                ctx({
                    localAdmin: true,
                    internal: true,
                    socketAddress: '127.0.0.1',
                    store,
                    now: NOW,
                    body: bodyFor('other@example.com')
                })
            )
        ])
        const created = results.filter((result) => result.type === 'json' && result.status === 200)
        expect(created).toHaveLength(1)
        expect(store.users).toHaveLength(1)
        expect(await setupCodeMatches(code, NOW)).toBe(false)
        resetFirstRunSetupCode()
    })

    it('rejects a used setup code from a second process through the stored marker', async () => {
        resetFirstRunSetupCode()
        const code = firstRunSetupCode(NOW)
        const store = new MemoryStore()
        const body = { user: { name: 'Owner', email: 'owner@example.com', credential: GOOD }, setupCode: code }
        const created = json(
            await handleRegister(ctx({ localAdmin: true, internal: true, socketAddress: '127.0.0.1', store, now: NOW, body }))
        )
        expect(created.status).toBe(200)
        forgetIssuedSetupCode()
        expect(await setupCodeMatches(code, NOW)).toBe(false)
        const other = new MemoryStore()
        const again = json(
            await handleRegister(
                ctx({
                    localAdmin: true,
                    internal: true,
                    socketAddress: '192.0.2.40',
                    store: other,
                    now: NOW,
                    body: { user: { name: 'Other', email: 'other@example.com', credential: GOOD }, setupCode: code }
                })
            )
        )
        expect(again.status).toBe(400)
        expect(again.body.message).toBe(SETUP_CODE_REJECTED)
        expect(String(again.body.message)).not.toContain('setup link')
        expect(other.users).toHaveLength(0)
        resetFirstRunSetupCode()
    })

    it('requires x-request-from: internal on register and rejects a missing code from loopback', async () => {
        resetFirstRunSetupCode()
        const store = new MemoryStore()
        const user = { name: 'Owner', email: 'owner@example.com', credential: GOOD }
        const missingHeader = json(
            await handleRegister(
                ctx({
                    localAdmin: true,
                    internal: false,
                    ip: '127.0.0.1',
                    socketAddress: '127.0.0.1',
                    store,
                    now: NOW,
                    body: { user }
                })
            )
        )
        expect(missingHeader.status).toBe(401)
        expect(missingHeader.body.message).toBe('Unauthorized')
        expect(setupFailureLimited('127.0.0.1', NOW)).toBe(false)

        const seen = { socket: '', ip: '', ips: [] as string[] }
        for (const trust of [true, 1] as const) {
            const app = registerApp(trust, store, seen)
            const res = await request(app)
                .post('/api/v1/account/register')
                .set('x-request-from', 'internal')
                .set('X-Forwarded-For', '127.0.0.1')
                .send({ user })
            expect(loopbackSocket(seen.socket)).toBe(true)
            expect(seen.ips).toContain('127.0.0.1')
            expect(res.status).toBe(400)
            expect(res.body.message).toBe(SETUP_LINK_NEEDED)
            expect(res.headers['referrer-policy']).toBe('no-referrer')
            expect(res.headers['cache-control']).toBe('no-store')
            expect(res.headers['x-frame-options']).toBe('DENY')
            expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'")
            const wrong = await request(app)
                .post('/api/v1/account/register')
                .set('x-request-from', 'internal')
                .set('X-Forwarded-For', '127.0.0.1')
                .send({ user, setupCode: 'TESTCODE-wrong' })
            expect(loopbackSocket(seen.socket)).toBe(true)
            expect(wrong.status).toBe(400)
            expect(wrong.body.message).toBe(SETUP_CODE_REJECTED)
            expect(String(wrong.body.message)).not.toContain('setup link')
        }
        expect(store.users).toHaveLength(0)

        for (const pagePath of ['/setup', '/organization-setup', '/server-setup', '/owner-recovery']) {
            const page = await request(registerApp(false, store)).get(pagePath)
            expect(page.status).toBe(200)
            expect(page.headers['referrer-policy']).toBe('no-referrer')
            expect(page.headers['cache-control']).toBe('no-store')
            expect(page.headers['x-frame-options']).toBe('DENY')
            expect(page.headers['content-security-policy']).toBe("frame-ancestors 'none'")
        }
        const signin = await request(registerApp(false, store)).get('/signin')
        expect(signin.headers['content-security-policy']).toBeUndefined()
        expect(signin.headers['x-frame-options']).toBeUndefined()
        expect(isSetupDocumentPath('/setup')).toBe(true)
        expect(isSetupDocumentPath('/setup/')).toBe(true)
        expect(isSetupDocumentPath('/setup?code=made-up')).toBe(true)
        expect(isSetupDocumentPath('/server-setup')).toBe(true)
        expect(isSetupDocumentPath('/owner-recovery')).toBe(true)
        expect(isSetupDocumentPath('/signin')).toBe(false)

        const code = firstRunSetupCode(NOW)
        const created = await request(registerApp(1, store, seen))
            .post('/api/v1/account/register')
            .set('x-request-from', 'internal')
            .set('X-Forwarded-For', '127.0.0.1')
            .send({ user, setupCode: code })
        expect(loopbackSocket(seen.socket)).toBe(true)
        expect(seen.ips).toContain('127.0.0.1')
        expect(created.status).toBe(200)
        expect(store.users).toHaveLength(1)
        resetFirstRunSetupCode()
    })

    it('limits setup failures by socket address and ignores a rotating forwarded address', async () => {
        resetFirstRunSetupCode()
        const store = new MemoryStore()
        const app = registerApp(true, store)
        const user = { name: 'Owner', email: 'owner@example.com', credential: GOOD }
        for (let i = 0; i < 10; i++) {
            const res = await request(app)
                .post('/api/v1/account/register')
                .set('x-request-from', 'internal')
                .set('X-Forwarded-For', `198.51.100.${i}`)
                .send({ user, setupCode: 'TESTCODE-wrong' })
            expect(res.status).toBe(400)
            if (i === 0) {
                expect(res.body.message).toBe(SETUP_CODE_REJECTED)
                expect(String(res.body.message)).not.toContain('setup link')
            }
        }
        const blocked = await request(app)
            .post('/api/v1/account/register')
            .set('x-request-from', 'internal')
            .set('X-Forwarded-For', '203.0.113.50')
            .send({ user, setupCode: 'TESTCODE-wrong' })
        expect(blocked.status).toBe(429)
        const still = await request(app)
            .post('/api/v1/account/register')
            .set('x-request-from', 'internal')
            .set('X-Forwarded-For', '192.0.2.8')
            .send({ user, setupCode: firstRunSetupCode(NOW) })
        expect(still.status).toBe(200)
        expect(store.users).toHaveLength(1)

        resetFirstRunSetupCode()
        const lines: string[] = []
        await announceFirstRunSetup(
            43117,
            async () => 0,
            (line) => lines.push(line),
            true
        )
        const issuedUrl = lines.join('\n').match(/https?:\/\/\S+\/setup#code=[A-Za-z0-9_-]+/)
        expect(issuedUrl).not.toBeNull()
        const issued = new URL(issuedUrl?.[0] || '').hash.slice('#code='.length)
        for (let i = 0; i < 100; i++) noteSetupFailure(`192.0.2.${i % 20}`, NOW)
        await setupCodeReady()
        const freshLines = () => lines.filter((line) => line.includes('A new setup link is ready'))
        expect(freshLines()).toHaveLength(1)
        expect(setupFailureLimited('198.51.100.20', NOW)).toBe(true)
        expect(await setupCodeMatches(issued, NOW)).toBe(false)
        expect(freshLines()[0].includes(issued)).toBe(false)
        for (let i = 0; i < 100; i++) noteSetupFailure(`192.0.2.${i % 20}`, NOW)
        await setupCodeReady()
        expect(freshLines()).toHaveLength(1)
        for (let i = 0; i < 100; i++) noteSetupFailure(`192.0.2.${i % 20}`, NOW + SETUP_GLOBAL_WINDOW_MS)
        await setupCodeReady()
        expect(freshLines()).toHaveLength(2)
        resetFirstRunSetupCode()
    })

    it('counts concurrent failures once each and still accepts the right code', async () => {
        resetFirstRunSetupCode()
        const store = new MemoryStore()
        const code = firstRunSetupCode(NOW)
        const user = { name: 'Owner', email: 'owner@example.com', credential: GOOD }
        const bad = await Promise.all(
            Array.from({ length: 15 }, () =>
                handleRegister(
                    ctx({
                        localAdmin: true,
                        internal: true,
                        socketAddress: '192.0.2.9',
                        store,
                        now: NOW,
                        body: { user, setupCode: 'TESTCODE-wrong' }
                    })
                )
            )
        )
        const statuses = bad.map((result) => (result.type === 'json' ? result.status : 0))
        expect(statuses.filter((status) => status === 400)).toHaveLength(10)
        expect(statuses.filter((status) => status === 429)).toHaveLength(5)
        expect(store.users).toHaveLength(0)
        const ok = json(
            await handleRegister(
                ctx({
                    localAdmin: true,
                    internal: true,
                    socketAddress: '192.0.2.9',
                    store,
                    now: NOW,
                    body: { user, setupCode: code }
                })
            )
        )
        expect(ok.status).toBe(200)
        expect(store.users).toHaveLength(1)
        resetFirstRunSetupCode()
    })

    it('does not count a field error toward the setup limit', async () => {
        resetFirstRunSetupCode()
        const store = new MemoryStore()
        const code = firstRunSetupCode(NOW)
        for (let i = 0; i < 12; i++) {
            const res = json(
                await handleRegister(
                    ctx({
                        localAdmin: true,
                        internal: true,
                        socketAddress: '192.0.2.15',
                        store,
                        now: NOW,
                        body: { user: { name: 'Owner', email: 'owner@example.com', credential: 'short' }, setupCode: code }
                    })
                )
            )
            expect(res.status).toBe(400)
        }
        expect(setupFailureLimited('192.0.2.15', NOW)).toBe(false)
        expect(store.users).toHaveLength(0)
        resetFirstRunSetupCode()
    })

    it('does not print a different code when another copy already stored one', async () => {
        resetFirstRunSetupCode()
        const live = {
            codeHmac: 'ab'.repeat(32),
            issuedAt: NOW,
            expiresAt: NOW + SETUP_CODE_TTL_MS,
            consumedAt: null
        }
        bindSetupCodeStore({
            async read() {
                return { ...live }
            },
            async save() {
                return 'kept'
            },
            async consume() {
                return false
            }
        })
        const lines: string[] = []
        expect(
            await announceFirstRunSetup(
                43117,
                async () => 0,
                (line) => lines.push(line),
                true
            )
        ).toBe('setup')
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('another copy')
        expect(lines[0]).not.toMatch(/#code=|[?&]code=/)
        expect(issuedSetupHmac()).toBeNull()
        resetFirstRunSetupCode()
    })

    it('uses the persisted instance secret when TOKEN_HASH_SECRET is unset', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-setup-secret-'))
        const previousPath = process.env.SECRETKEY_PATH
        const previousHash = process.env.TOKEN_HASH_SECRET
        try {
            process.env.SECRETKEY_PATH = dir
            delete process.env.TOKEN_HASH_SECRET
            resetAuthSecretsForTests()
            resetFirstRunSetupCode()
            const code = 'TESTCODE-example'
            const hmac = setupCodeHmac(code)
            const file = fs.readFileSync(path.join(dir, 'token-hash.secret'), 'utf8')
            expect(file.trim().length).toBeGreaterThan(16)
            expect(file.includes('setup-code-compare')).toBe(false)
            expect(hmac).toBe(createHmac('sha256', file).update(code).digest('hex'))
            expect(hmac).not.toBe(createHmac('sha256', 'setup-code-compare').update(code).digest('hex'))
            resetAuthSecretsForTests()
            expect(setupCodeHmac(code)).toBe(hmac)
        } finally {
            if (previousPath === undefined) delete process.env.SECRETKEY_PATH
            else process.env.SECRETKEY_PATH = previousPath
            if (previousHash === undefined) delete process.env.TOKEN_HASH_SECRET
            else process.env.TOKEN_HASH_SECRET = previousHash
            resetAuthSecretsForTests()
            resetFirstRunSetupCode()
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    it('retires an open setup code when the operator command creates the owner', async () => {
        resetFirstRunSetupCode()
        const code = firstRunSetupCode(NOW)
        const store = new MemoryStore()
        const result = await runUserCli(store, { email: 'owner@example.com', password: GOOD, localAdmin: true })
        expect(result.ok).toBe(true)
        expect(store.users).toHaveLength(1)
        expect(await setupCodeMatches(code, NOW)).toBe(false)
        resetFirstRunSetupCode()
        const empty = new MemoryStore()
        const again = await runUserCli(empty, { email: 'owner@example.com', password: GOOD, localAdmin: true })
        expect(again.ok).toBe(true)
        expect(empty.users).toHaveLength(1)
        resetFirstRunSetupCode()
    }, 20000)

    it('retires an open setup code when the first AuthKit account is created', async () => {
        resetFirstRunSetupCode()
        const code = firstRunSetupCode(NOW)
        const store = new MemoryStore()
        const identity = {
            id: 'user_fake_1',
            email: 'rosa@rosas-bakery.example',
            emailVerified: true,
            name: 'Rosa'
        }
        const linked = await linkWorkosUser(store, identity, { bootstrapEmail: 'rosa@rosas-bakery.example' })
        expect(linked.ok).toBe(true)
        if (linked.ok) expect(linked.bootstrapped).toBe(true)
        expect(store.users).toHaveLength(1)
        expect(await setupCodeMatches(code, NOW)).toBe(false)
        resetFirstRunSetupCode()
        const empty = new MemoryStore()
        const plain = await linkWorkosUser(empty, identity, { bootstrapEmail: 'rosa@rosas-bakery.example' })
        expect(plain.ok).toBe(true)
        expect(empty.users).toHaveLength(1)
        resetFirstRunSetupCode()
    })

    it('sends frame-ancestors none on setup documents only', () => {
        const headers = new Map<string, string>()
        const res = { setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value) }
        for (const pagePath of ['/setup', '/organization-setup', '/server-setup', '/owner-recovery']) {
            headers.clear()
            applyDocumentFrameHeaders(pagePath, res, {
                'Content-Security-Policy': "frame-ancestors 'self'",
                'X-Frame-Options': 'SAMEORIGIN'
            })
            expect(headers.get('referrer-policy')).toBe('no-referrer')
            expect(headers.get('cache-control')).toBe('no-store')
            expect(headers.get('x-frame-options')).toBe('DENY')
            expect(headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
        }
        headers.clear()
        applyDocumentFrameHeaders('/signin', res, {
            'Content-Security-Policy': "frame-ancestors 'self'",
            'X-Frame-Options': 'SAMEORIGIN'
        })
        expect(headers.get('content-security-policy')).toBe("frame-ancestors 'self'")
        expect(headers.get('x-frame-options')).toBe('SAMEORIGIN')
        expect(headers.get('referrer-policy')).toBeUndefined()
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
