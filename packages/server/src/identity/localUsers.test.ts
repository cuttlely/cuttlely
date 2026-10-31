/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import cookieParser from 'cookie-parser'
import express, { Request } from 'express'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import bcrypt from 'bcryptjs'
import { ABSOLUTE_MS, IDLE_MS, LOGIN_FAILURE_WINDOW_MS, OPEN_SOURCE_FEATURES, localAdminEnabled, localUsersMode } from './constants'
import { apiV1Auth } from './apiGate'
import { identityAuthRouter } from './http'
import { attachIdentitySession } from './middleware'
import {
    UNKNOWN_LOCAL_ACCOUNT_ID,
    AuthContext,
    establishSession,
    handleLocalLogin,
    handleLocalLogout,
    handleLocalPassword,
    handleLoginPost,
    handleLogout,
    handleRefresh
} from './handlers'
import { DUMMY_BCRYPT_HASH, hashPassword, hashSessionToken, isBcryptHash } from './password'
import { LoginRateLimit, accountLockKey } from './rateLimit'
import { addIdentityLoginGuards } from './schemaMigration'
import { requireOwner, requirePermission, setTeamPermissionLookup } from './rbac'
import { AuthKitSwitchApply, AuthKitSwitchState, switchedSessions } from './authKitSwitch'
import { enabledSignInMethods } from './signInOptions'
import { IdentityStore } from './store'
import { SqlLoginRateLimit, teamAccess } from './sqlStore'
import { HandlerResult, LocalSession, SessionUser, UserRow } from './types'

const mockRouteStore: { current: IdentityStore | null } = { current: null }
const mockRefreshView = jest.fn(async (): Promise<void> => undefined)

jest.mock('./production', () => {
    const { cookiePasswordOk, localAdminEnabled, localUsersMode, workosConfigured } = jest.requireActual(
        './constants'
    ) as typeof import('./constants')
    const { cookieSecure } = jest.requireActual('./cookies') as typeof import('./cookies')
    const { LoginRateLimit } = jest.requireActual('./rateLimit') as typeof import('./rateLimit')
    return {
        refreshAuthenticationView: () => mockRefreshView(),
        buildAuthContext: (req: Request) => {
            const redirectUri = process.env.WORKOS_REDIRECT_URI
            return {
                workosConfigured: workosConfigured(),
                localAdmin: localAdminEnabled(),
                localUsers: localUsersMode(),
                cookiePasswordOk: cookiePasswordOk(process.env.WORKOS_COOKIE_PASSWORD),
                redirectUri,
                secure: cookieSecure(redirectUri, Boolean(req.secure) || req.protocol === 'https'),
                now: Date.parse('2026-10-14T00:00:00.000Z'),
                ip: req.ip || '203.0.113.8',
                internal: req.headers['x-request-from'] === 'internal',
                body: req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {},
                cookies: (req.cookies || {}) as Record<string, string | undefined>,
                store: mockRouteStore.current,
                workos: {
                    authorizationUrl: () => 'https://authkit.example/authorize',
                    authenticate: async () => {
                        throw new Error('unused')
                    },
                    authenticateSession: async () => ({ authenticated: false, reason: 'invalid_jwt' }),
                    refresh: async () => ({ authenticated: false, reason: 'invalid_grant' }),
                    logoutUrl: async () => 'https://authkit.example/logout',
                    setExternalId: async () => undefined
                },
                rateLimit: new LoginRateLimit(),
                recoveryRateLimit: new LoginRateLimit(5),
                noteRecoveryAttempt: async () => undefined
            }
        }
    }
})

/** The public route list, read as text so this test does not import the inherited constants module. */
function whitelistUrls(): string[] {
    const text = readFileSync(join(__dirname, '../utils/constants.ts'), 'utf8')
    const start = text.indexOf('export const WHITELIST_URLS')
    const end = text.indexOf('export const API_KEY_BLACKLIST_URLS')
    return [...text.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1])
}

function localRouteApp(router = identityAuthRouter) {
    const server = express()
    server.use(cookieParser())
    server.use(express.json())
    server.use(
        apiV1Auth({
            whitelistURLs: whitelistUrls(),
            apiKeyBlacklistURLs: [],
            licenseRequired: () => false,
            dataSource: { getRepository: () => ({ findOne: async () => null }) } as unknown as DataSource,
            validateAPIKey: async () => ({ isValid: false }),
            attachIdentitySession
        })
    )
    server.use('/api/v1/auth', router)
    return server
}

jest.setTimeout(120000)

const GOOD = 'Sup3r-Secret!'
const OTHER = 'An0ther-Secret!'
const NOW = Date.parse('2026-10-14T00:00:00.000Z')
const INVALID = { message: 'Invalid email or password.' }
const LOCKED = { message: 'Too many sign-in attempts. Try again later.' }

class MemoryStore implements IdentityStore {
    users: UserRow[] = []
    ownerId: string | null = null
    sessions = new Map<string, SessionUser>()
    local = new Map<string, LocalSession>()
    disabled = new Set<string>()
    switchState: AuthKitSwitchState | null = null
    workspaces = new Map<string, string>()

    async countUsers(): Promise<number> {
        return this.users.length
    }
    async listEmails(): Promise<string[]> {
        return this.users.map((user) => user.email)
    }
    async findUserByExternalId(): Promise<UserRow | null> {
        return null
    }
    async findUsersByEmail(email: string): Promise<UserRow[]> {
        const needle = email.trim().toLowerCase()
        return this.users.filter((user) => user.email.toLowerCase() === needle)
    }
    async setExternalId(): Promise<'linked' | 'rebind' | 'missing'> {
        return 'missing'
    }
    async findSuperUser(): Promise<UserRow | null> {
        const user = this.users.find((row) => row.id === this.ownerId) || null
        if (!user || user.status.toLowerCase() !== 'active') return null
        return user
    }

    async isActiveOwner(userId: string): Promise<boolean> {
        const user = this.users.find((row) => row.id === userId)
        return Boolean(user && user.id === this.ownerId && user.status.toLowerCase() === 'active' && !this.disabled.has(userId))
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
    async acceptInvite(): Promise<'accepted' | 'invalid'> {
        return 'invalid'
    }
    async createOwner(): Promise<UserRow> {
        throw new Error('unused')
    }
    async sessionFor(userId: string): Promise<SessionUser | null> {
        return this.sessions.get(userId) || null
    }
    async touchLastLogin(): Promise<void> {}
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

    add(user: UserRow, owner = false, workspaceId = 'ws-1'): void {
        this.users.push(user)
        if (owner) this.ownerId = user.id
        this.workspaces.set(user.id, workspaceId)
        this.sessions.set(user.id, {
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
            activeWorkspaceId: workspaceId,
            activeWorkspace: owner ? 'Default Workspace' : 'Other team',
            lastLogin: null,
            isOrganizationAdmin: owner,
            assignedWorkspaces: [{ id: workspaceId, name: owner ? 'Default Workspace' : 'Other team' }],
            permissions: owner ? [] : ['chatflows:view'],
            features: OPEN_SOURCE_FEATURES
        })
    }
}

function signed(partial: Partial<AuthContext> = {}): AuthContext {
    return ctx({ internal: true, ...partial })
}

function ctx(partial: Partial<AuthContext> = {}): AuthContext {
    return {
        workosConfigured: false,
        localAdmin: false,
        localUsers: true,
        cookiePasswordOk: true,
        redirectUri: 'http://127.0.0.1:43117/api/v1/auth/callback',
        secure: false,
        now: NOW,
        ip: '203.0.113.8',
        socketAddress: '203.0.113.8',
        internal: false,
        body: {},
        cookies: {},
        store: partial.store || new MemoryStore(),
        workos: {
            authorizationUrl: () => 'https://authkit.example/authorize',
            authenticate: async () => {
                throw new Error('unused')
            },
            authenticateSession: async () => ({ authenticated: false, reason: 'invalid_jwt' }),
            refresh: async () => ({ authenticated: false, reason: 'invalid_grant' }),
            logoutUrl: async () => 'https://authkit.example/logout',
            setExternalId: async () => undefined
        },
        rateLimit: partial.rateLimit || new LoginRateLimit(),
        ...partial
    }
}

function json(result: HandlerResult): {
    status: number
    body: Record<string, unknown>
    cookies?: {
        name: string
        value: string
        options: { httpOnly: boolean; sameSite: string; path: string; secure: boolean; maxAge?: number }
    }[]
    clearCookies?: string[]
    secure?: boolean
} {
    if (result.type !== 'json') throw new Error(`expected json, got ${result.type}`)
    return {
        status: result.status,
        body: result.body as Record<string, unknown>,
        cookies: result.cookies,
        clearCookies: result.clearCookies,
        secure: result.secure
    }
}

async function seed(): Promise<{ store: MemoryStore; ownerHash: string; memberHash: string }> {
    const store = new MemoryStore()
    const ownerHash = await hashPassword(GOOD)
    const memberHash = await hashPassword(OTHER)
    store.add(
        { id: 'owner', email: 'owner@example.com', name: 'Owner', status: 'active', externalId: null, credential: ownerHash },
        true,
        'ws-owner'
    )
    store.add(
        { id: 'user-a', email: 'ada@example.com', name: 'Ada', status: 'active', externalId: null, credential: memberHash },
        false,
        'ws-a'
    )
    store.add(
        { id: 'user-b', email: 'bea@example.com', name: 'Bea', status: 'active', externalId: null, credential: memberHash },
        false,
        'ws-b'
    )
    store.add({ id: 'invited', email: 'invited@example.com', name: 'Invited', status: 'invited', externalId: null, credential: null })
    store.add(
        { id: 'disabled', email: 'disabled@example.com', name: 'Disabled', status: 'active', externalId: null, credential: memberHash },
        false,
        'ws-a'
    )
    store.disabled.add('disabled')
    return { store, ownerHash, memberHash }
}

function envFor(admin: boolean, users: boolean, authKit: boolean): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    if (admin) env.CUTTLELY_LOCAL_ADMIN = 'true'
    if (users) env.CUTTLELY_LOCAL_USERS = 'true'
    if (authKit) {
        env.WORKOS_API_KEY = 'key'
        env.WORKOS_CLIENT_ID = 'client'
    }
    return env
}

describe('local users mode', () => {
    const savedLockSecret = process.env.TOKEN_HASH_SECRET

    beforeAll(() => {
        process.env.TOKEN_HASH_SECRET = 'test-login-lock-secret'
    })

    afterAll(() => {
        if (savedLockSecret === undefined) delete process.env.TOKEN_HASH_SECRET
        else process.env.TOKEN_HASH_SECRET = savedLockSecret
    })

    afterEach(() => {
        setTeamPermissionLookup(null)
    })

    it('sets strict headers on every owner recovery login response', async () => {
        const response = await request(localRouteApp()).post('/api/v1/auth/recovery/login').send({})
        expect(response.status).toBe(401)
        expect(response.headers['cache-control']).toBe('no-store')
        expect(response.headers['referrer-policy']).toBe('no-referrer')
        expect(response.headers['x-frame-options']).toBe('DENY')
        expect(response.headers['content-security-policy']).toBe("frame-ancestors 'none'")
    })

    it('states each combination of the owner flag, local users, and AuthKit', async () => {
        const rows: { admin: boolean; users: boolean; authKit: boolean; methods: string[]; local: boolean; owner: boolean }[] = [
            { admin: false, users: false, authKit: false, methods: [], local: false, owner: false },
            { admin: true, users: false, authKit: false, methods: ['localAdmin'], local: false, owner: true },
            { admin: false, users: true, authKit: false, methods: ['localUsers'], local: true, owner: false },
            { admin: true, users: true, authKit: false, methods: ['localAdmin', 'localUsers'], local: true, owner: true },
            { admin: false, users: false, authKit: true, methods: ['authKit'], local: false, owner: false },
            { admin: true, users: false, authKit: true, methods: ['authKit', 'localAdmin'], local: false, owner: true },
            { admin: false, users: true, authKit: true, methods: ['authKit'], local: false, owner: false },
            { admin: true, users: true, authKit: true, methods: ['authKit', 'localAdmin'], local: false, owner: true }
        ]
        const { store } = await seed()
        for (const row of rows) {
            const env = envFor(row.admin, row.users, row.authKit)
            expect(localUsersMode(env)).toBe(row.local)
            expect(localAdminEnabled(env)).toBe(row.owner)
            expect(enabledSignInMethods(env)).toEqual({ methods: row.methods })
            const local = json(
                await handleLocalLogin(
                    signed({
                        store,
                        localUsers: row.local,
                        localAdmin: row.owner,
                        workosConfigured: row.authKit,
                        body: { email: 'ada@example.com', password: OTHER }
                    })
                )
            )
            expect(local.status).toBe(row.local ? 200 : 404)
            const owner = json(
                await handleLoginPost(
                    ctx({
                        store,
                        localUsers: row.local,
                        localAdmin: row.owner,
                        internal: true,
                        body: { email: 'owner@example.com', password: GOOD }
                    })
                )
            )
            expect(owner.status).toBe(200)
        }
    })

    it('signs in an active user and does not treat that session as the owner', async () => {
        const { store } = await seed()
        const ok = json(await handleLocalLogin(signed({ store, body: { email: '  Ada@Example.com  ', password: OTHER } })))
        expect(ok.status).toBe(200)
        expect(ok.body.id).toBe('user-a')
        expect(ok.body.role).toBe('member')
        expect(ok.body.isOrganizationAdmin).toBe(false)
        expect(ok.body.activeWorkspaceId).toBe('ws-a')
        expect(ok.cookies?.[0]).toMatchObject({
            name: 'cuttlely-local-session',
            options: { httpOnly: true, sameSite: 'lax', path: '/', secure: false, maxAge: IDLE_MS }
        })
        const raw = ok.cookies?.[0].value || ''
        const row = store.local.get(hashSessionToken(raw))
        expect(row?.userId).toBe('user-a')
        expect(row).toMatchObject({ authenticationMethod: 'local', recoveryUse: false })
        expect(row?.idleExpires.getTime()).toBe(NOW + IDLE_MS)
        expect(row?.absoluteExpires.getTime()).toBe(NOW + ABSOLUTE_MS)
        expect(JSON.stringify(ok.body)).not.toContain(OTHER)
        expect(JSON.stringify(ok.body)).not.toContain('scrypt$')
    })

    it('follows the request for the local cookie, including plain HTTP in production', async () => {
        const { store } = await seed()
        const https = json(await handleLocalLogin(signed({ store, secure: true, body: { email: 'ada@example.com', password: OTHER } })))
        expect(https.cookies?.[0].options.secure).toBe(true)
        const httpsOut = json(
            await handleLocalLogout(
                ctx({ store, internal: true, secure: true, cookies: { 'cuttlely-local-session': https.cookies?.[0].value } })
            )
        )
        expect(httpsOut.secure).toBe(true)
        const previous = process.env.NODE_ENV
        process.env.NODE_ENV = 'production'
        try {
            const produced = json(
                await handleLocalLogin(signed({ store, secure: false, body: { email: 'ada@example.com', password: OTHER } }))
            )
            expect(produced.status).toBe(200)
            expect(produced.cookies?.[0].options.secure).toBe(false)
            expect(produced.cookies?.[0].options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' })
            const token = produced.cookies?.[0].value || ''
            const slid = json(await handleRefresh(ctx({ store, secure: false, cookies: { 'cuttlely-local-session': token } })))
            expect(slid.status).toBe(200)
            expect(slid.cookies?.[0].options.secure).toBe(false)
            const cleared = json(
                await handleLocalLogout(ctx({ store, internal: true, secure: false, cookies: { 'cuttlely-local-session': token } }))
            )
            expect(cleared.secure).toBe(false)
            const dropped = await establishSession(ctx({ store, secure: false, cookies: { 'cuttlely-local-session': 'missing-token' } }))
            expect(dropped.clearCookies).toEqual(['cuttlely-local-session'])
            expect(dropped.secure).toBe(false)
        } finally {
            if (previous === undefined) delete process.env.NODE_ENV
            else process.env.NODE_ENV = previous
        }
    })

    it('rotates the cookie on each sign-in and keeps the idle and absolute limits', async () => {
        const { store } = await seed()
        const first = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        const second = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        expect(first.cookies?.[0].value).not.toBe(second.cookies?.[0].value)
        expect(store.local.size).toBe(2)
        const old = await establishSession(ctx({ store, cookies: { 'cuttlely-local-session': first.cookies?.[0].value } }))
        expect(old.user?.id).toBe('user-a')
        const digest = hashSessionToken(second.cookies?.[0].value || '')
        const slid = json(
            await handleRefresh(ctx({ store, now: NOW + 1000, cookies: { 'cuttlely-local-session': second.cookies?.[0].value } }))
        )
        expect(slid.status).toBe(200)
        expect(store.local.get(digest)?.idleExpires.getTime()).toBeGreaterThan(NOW + IDLE_MS)
        store.local.set(digest, {
            id: 'sess',
            userId: 'user-a',
            token: digest,
            idleExpires: new Date(NOW + 1000),
            absoluteExpires: new Date(NOW + ABSOLUTE_MS)
        })
        const idle = json(
            await handleRefresh(ctx({ store, now: NOW + 2000, cookies: { 'cuttlely-local-session': second.cookies?.[0].value } }))
        )
        expect(idle.body).toEqual({ message: 'Token Expired' })
        expect(store.local.has(digest)).toBe(false)
        const again = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        const absoluteDigest = hashSessionToken(again.cookies?.[0].value || '')
        const kept = store.local.get(absoluteDigest)
        if (!kept) throw new Error('missing session')
        kept.idleExpires = new Date(NOW + ABSOLUTE_MS)
        kept.absoluteExpires = new Date(NOW - 1)
        const absolute = json(await handleRefresh(ctx({ store, cookies: { 'cuttlely-local-session': again.cookies?.[0].value } })))
        expect(absolute.body).toEqual({ message: 'Refresh Token Expired' })
        expect(store.local.has(absoluteDigest)).toBe(false)
    })

    it('returns one 401 body for an unknown email, a wrong password, a null credential, and a disabled user', async () => {
        const { store } = await seed()
        store.add({ id: 'blank', email: 'blank@example.com', name: 'Blank', status: 'active', externalId: null, credential: null })
        const bodies = []
        for (const email of ['nobody@example.com', 'ada@example.com', 'invited@example.com', 'blank@example.com', 'disabled@example.com']) {
            const password = email === 'ada@example.com' ? 'Wrong-Pass1!' : OTHER
            const result = json(await handleLocalLogin(signed({ store, body: { email, password } })))
            expect(result.status).toBe(401)
            bodies.push(result.body)
            expect(JSON.stringify(result.body)).not.toContain(email)
            expect(JSON.stringify(result.body)).not.toContain(password)
        }
        expect(new Set(bodies.map((body) => JSON.stringify(body)))).toEqual(new Set([JSON.stringify(INVALID)]))
        expect(store.local.size).toBe(0)
    })

    it('ends a disabled user session and rejects the old cookie', async () => {
        const { store } = await seed()
        store.disabled.delete('disabled')
        const ok = json(await handleLocalLogin(signed({ store, body: { email: 'disabled@example.com', password: OTHER } })))
        const raw = ok.cookies?.[0].value || ''
        store.disabled.add('disabled')
        const again = await establishSession(ctx({ store, cookies: { 'cuttlely-local-session': raw } }))
        expect(again.user).toBeNull()
        expect(again.clearCookies).toContain('cuttlely-local-session')
        expect(store.local.size).toBe(0)
        const reused = json(await handleRefresh(ctx({ store, cookies: { 'cuttlely-local-session': raw } })))
        expect(reused.status).toBe(401)
        expect(reused.body).toEqual({ message: 'Token Expired' })
    })

    it('locks out with one 429 body for every account state and does not store unknown emails', async () => {
        const { store } = await seed()
        const rateLimit = new LoginRateLimit()
        const attempt = (email: string, password: string, ip = '203.0.113.8') =>
            handleLocalLogin(signed({ store, rateLimit, ip, body: { email, password } }))
        for (let i = 0; i < 10; i++) {
            expect(json(await attempt(`missing-${i}@example.com`, 'Wrong-Pass1!')).status).toBe(401)
        }
        expect(rateLimit.retained()).toBe(20)
        expect(JSON.stringify(rateLimit)).not.toContain('missing-0@example.com')
        const lockedUnknown = json(await attempt('another-missing@example.com', OTHER))
        expect(lockedUnknown.status).toBe(429)
        expect(lockedUnknown.body).toEqual(LOCKED)

        const account = new LoginRateLimit()
        for (let i = 0; i < 10; i++) {
            expect(
                json(
                    await handleLocalLogin(
                        signed({
                            store,
                            rateLimit: account,
                            ip: `203.0.113.${i}`,
                            body: { email: 'Disabled@Example.com', password: OTHER }
                        })
                    )
                ).status
            ).toBe(401)
        }
        const lockedDisabled = json(
            await handleLocalLogin(
                signed({ store, rateLimit: account, ip: '198.51.100.9', body: { email: 'disabled@example.com', password: OTHER } })
            )
        )
        const lockedInvited = json(
            await handleLocalLogin(
                signed({
                    store,
                    rateLimit: account,
                    ip: '198.51.100.10',
                    body: { email: 'invited@example.com', password: OTHER }
                })
            )
        )
        expect(lockedDisabled.status).toBe(429)
        expect(lockedInvited.status).toBe(401)
        expect(lockedDisabled.body).toEqual(LOCKED)
        const wrong = new LoginRateLimit()
        for (let i = 0; i < 10; i++) {
            await handleLocalLogin(
                signed({ store, rateLimit: wrong, ip: `198.51.100.${i}`, body: { email: 'ada@example.com', password: 'Wrong-Pass1!' } })
            )
        }
        const lockedWrong = json(
            await handleLocalLogin(
                signed({ store, rateLimit: wrong, ip: '192.0.2.8', body: { email: 'ada@example.com', password: OTHER } })
            )
        )
        expect(lockedWrong.body).toEqual(lockedDisabled.body)
    })

    it('rejects an over-long email or password before lookup', async () => {
        const { store } = await seed()
        const rateLimit = new LoginRateLimit()
        const longEmail = json(
            await handleLocalLogin(signed({ store, rateLimit, body: { email: `${'a'.repeat(250)}@example.com`, password: OTHER } }))
        )
        const longPassword = json(
            await handleLocalLogin(signed({ store, rateLimit, body: { email: 'ada@example.com', password: 'A'.repeat(257) } }))
        )
        expect(longEmail.status).toBe(400)
        expect(longPassword.status).toBe(400)
        expect(rateLimit.retained()).toBe(0)
        expect(store.users.find((user) => user.id === 'user-a')?.credential).not.toBeNull()
    })

    it('accepts a migrated bcrypt password on local login and rehashes to scrypt after success', async () => {
        const { store } = await seed()
        const bcryptHash = bcrypt.hashSync(OTHER, 10)
        const target = store.users.find((u) => u.id === 'user-a')
        if (!target) throw new Error('missing user-a')
        target.credential = bcryptHash
        const before = target.credential
        const ok = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        expect(ok.status).toBe(200)
        const after = store.users.find((u) => u.id === 'user-a')?.credential || ''
        expect(after).toMatch(/^scrypt\$/)
        expect(after).not.toBe(before)
        // Wrong password still fails
        const wrong = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: 'Wrong-Pass1!' } })))
        expect(wrong.status).toBe(401)
    })

    it('accepts a migrated bcrypt owner password and rehashes to scrypt on success', async () => {
        const { store } = await seed()
        const bcryptHash = bcrypt.hashSync(GOOD, 10)
        const owner = store.users.find((u) => u.id === 'owner')
        if (!owner) throw new Error('missing owner')
        owner.credential = bcryptHash
        const before = owner.credential
        const out = json(
            await handleLoginPost(ctx({ store, localAdmin: true, internal: true, body: { email: 'owner@example.com', password: GOOD } }))
        )
        expect(out.status).toBe(200)
        const after = store.users.find((u) => u.id === 'owner')?.credential || ''
        expect(after).toMatch(/^scrypt\$/)
        expect(after).not.toBe(before)
    })

    it('rejects a wrong password while the stored hash is still bcrypt, for a member and the owner', async () => {
        const { store } = await seed()
        const memberHash = bcrypt.hashSync(OTHER, 10)
        const ownerHash = bcrypt.hashSync(GOOD, 10)
        const member = store.users.find((u) => u.id === 'user-a')
        const owner = store.users.find((u) => u.id === 'owner')
        if (!member || !owner) throw new Error('missing users')
        member.credential = memberHash
        owner.credential = ownerHash
        const memberLimit = new LoginRateLimit()
        const ownerLimit = new LoginRateLimit()
        const memberOut = json(
            await handleLocalLogin(signed({ store, rateLimit: memberLimit, body: { email: 'ada@example.com', password: GOOD } }))
        )
        const ownerOut = json(
            await handleLoginPost(
                ctx({
                    store,
                    localAdmin: true,
                    internal: true,
                    rateLimit: ownerLimit,
                    body: { email: 'owner@example.com', password: OTHER }
                })
            )
        )
        expect(memberOut.status).toBe(401)
        expect(ownerOut.status).toBe(401)
        expect(memberOut.body).toEqual(INVALID)
        expect(ownerOut.body).toEqual(INVALID)
        expect(member.credential).toBe(memberHash)
        expect(owner.credential).toBe(ownerHash)
        expect(memberLimit.retained()).toBe(2)
        expect(ownerLimit.retained()).toBe(2)
    })

    it('rejects a malformed or empty bcrypt hash on local login', async () => {
        const { store } = await seed()
        const member = store.users.find((u) => u.id === 'user-a')
        if (!member) throw new Error('missing user-a')
        const cases = ['$2a$10$abc', `$2a$10${'$'}${'A'.repeat(54)}`, '']
        for (const credential of cases) {
            member.credential = credential
            const rateLimit = new LoginRateLimit()
            const out = json(await handleLocalLogin(signed({ store, rateLimit, body: { email: 'ada@example.com', password: OTHER } })))
            expect(out.status).toBe(401)
            expect(out.body).toEqual(INVALID)
            expect(member.credential).toBe(credential)
            expect(rateLimit.retained()).toBe(2)
        }
    })

    it('accepts $2b$ and $2y$ member hashes and rehashes them to scrypt', async () => {
        const { store } = await seed()
        const hashed = bcrypt.hashSync(OTHER, 10)
        const body = hashed.replace(/^\$2[aby]\$/, '')
        const member = store.users.find((u) => u.id === 'user-a')
        if (!member) throw new Error('missing user-a')
        for (const prefix of ['$2b$', '$2y$'] as const) {
            member.credential = `${prefix}${body}`
            const out = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
            expect(out.status).toBe(200)
            expect(member.credential).toMatch(/^scrypt\$/)
        }
    })

    it('rejects a cost-31 bcrypt hash quickly and leaves it in place', async () => {
        const { store } = await seed()
        const costly = `$2a$31${'$'}${'A'.repeat(53)}`
        const member = store.users.find((u) => u.id === 'user-a')
        if (!member) throw new Error('missing user-a')
        member.credential = costly
        const rateLimit = new LoginRateLimit()
        const started = Date.now()
        const out = json(await handleLocalLogin(signed({ store, rateLimit, body: { email: 'ada@example.com', password: OTHER } })))
        const elapsed = Date.now() - started
        expect(out.status).toBe(401)
        expect(out.body).toEqual(INVALID)
        expect(member.credential).toBe(costly)
        expect(rateLimit.retained()).toBe(2)
        expect(elapsed).toBeLessThan(200)
    })

    it('still signs in when rehash replaceCredential fails and leaves the bcrypt hash in place', async () => {
        const { store } = await seed()
        const bcryptHash = bcrypt.hashSync(OTHER, 10)
        const member = store.users.find((u) => u.id === 'user-a')
        if (!member) throw new Error('missing user-a')
        member.credential = bcryptHash
        store.replaceCredential = async () => {
            throw new Error('write failed')
        }
        const out = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        expect(out.status).toBe(200)
        expect(member.credential).toBe(bcryptHash)
    })

    it('still signs in when rehash CAS matches zero rows and does not overwrite', async () => {
        const { store } = await seed()
        const bcryptHash = bcrypt.hashSync(OTHER, 10)
        const member = store.users.find((u) => u.id === 'user-a')
        if (!member) throw new Error('missing user-a')
        member.credential = bcryptHash
        const kept = 'scrypt$already-written-by-other$key'
        const original = store.replaceCredential.bind(store)
        store.replaceCredential = async (userId, expected, next) => {
            member.credential = kept
            return original(userId, expected, next)
        }
        const out = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        expect(out.status).toBe(200)
        expect(member.credential).toBe(kept)
    })

    it('returns 401 and counts a bcrypt compare failure toward lockout', async () => {
        const { store } = await seed()
        const bcryptHash = bcrypt.hashSync(OTHER, 10)
        const member = store.users.find((u) => u.id === 'user-a')
        if (!member) throw new Error('missing user-a')
        member.credential = bcryptHash
        const rateLimit = new LoginRateLimit()
        const compare = jest.spyOn(bcrypt, 'compare').mockImplementationOnce(() => Promise.reject(new Error('bcrypt failed')))
        const out = json(await handleLocalLogin(signed({ store, rateLimit, body: { email: 'ada@example.com', password: OTHER } })))
        compare.mockRestore()
        expect(out.status).toBe(401)
        expect(out.body).toEqual(INVALID)
        expect(member.credential).toBe(bcryptHash)
        expect(rateLimit.retained()).toBe(2)
    })

    it('runs dummy bcrypt on an owner email mismatch when the stored hash is bcrypt', async () => {
        const { store } = await seed()
        const owner = store.users.find((u) => u.id === 'owner')
        if (!owner) throw new Error('missing owner')
        owner.credential = bcrypt.hashSync(GOOD, 10)
        const compare = jest.spyOn(bcrypt, 'compare')
        const out = json(
            await handleLoginPost(ctx({ store, localAdmin: true, internal: true, body: { email: 'wrong@example.com', password: GOOD } }))
        )
        expect(out.status).toBe(401)
        expect(compare).toHaveBeenCalled()
        expect(compare.mock.calls[0][1]).toBe(DUMMY_BCRYPT_HASH)
        expect(owner.credential).toMatch(/^\$2[aby]\$/)
        compare.mockRestore()
    })

    it('runs dummy bcrypt for an unknown or disabled member while any bcrypt hash remains', async () => {
        const { store } = await seed()
        const member = store.users.find((u) => u.id === 'user-a')
        if (!member) throw new Error('missing user-a')
        member.credential = bcrypt.hashSync(OTHER, 10)
        const compare = jest.spyOn(bcrypt, 'compare')
        const unknown = json(await handleLocalLogin(signed({ store, body: { email: 'nobody@example.com', password: OTHER } })))
        const disabled = json(await handleLocalLogin(signed({ store, body: { email: 'disabled@example.com', password: OTHER } })))
        expect(unknown.status).toBe(401)
        expect(disabled.status).toBe(401)
        expect(compare.mock.calls.length).toBeGreaterThanOrEqual(2)
        expect(compare.mock.calls.every((call) => call[1] === DUMMY_BCRYPT_HASH)).toBe(true)
        compare.mockRestore()
    })

    it('runs dummy bcrypt for an unknown or disabled owner while any bcrypt hash remains', async () => {
        const { store } = await seed()
        const owner = store.users.find((u) => u.id === 'owner')
        if (!owner) throw new Error('missing owner')
        owner.credential = bcrypt.hashSync(GOOD, 10)
        const compare = jest.spyOn(bcrypt, 'compare')
        const unknown = json(
            await handleLoginPost(ctx({ store, localAdmin: true, internal: true, body: { email: 'nobody@example.com', password: GOOD } }))
        )
        expect(unknown.status).toBe(401)
        expect(compare).toHaveBeenCalled()
        expect(compare.mock.calls[0][1]).toBe(DUMMY_BCRYPT_HASH)
        owner.status = 'inactive'
        const disabled = json(
            await handleLoginPost(ctx({ store, localAdmin: true, internal: true, body: { email: 'owner@example.com', password: GOOD } }))
        )
        expect(disabled.status).toBe(401)
        expect(compare.mock.calls[compare.mock.calls.length - 1][1]).toBe(DUMMY_BCRYPT_HASH)
        compare.mockRestore()
    })

    it('runs the same dummy bcrypt pad for unknown, disabled, and a wrong scrypt password while bcrypt remains', async () => {
        const { store } = await seed()
        const other = store.users.find((u) => u.id === 'user-b')
        if (!other) throw new Error('missing user-b')
        other.credential = bcrypt.hashSync(OTHER, 10)
        const compare = jest.spyOn(bcrypt, 'compare')
        const unknown = json(await handleLocalLogin(signed({ store, body: { email: 'nobody@example.com', password: OTHER } })))
        const disabled = json(await handleLocalLogin(signed({ store, body: { email: 'disabled@example.com', password: OTHER } })))
        const wrong = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: 'Wrong-Pass1!' } })))
        expect(unknown.status).toBe(401)
        expect(disabled.status).toBe(401)
        expect(wrong.status).toBe(401)
        expect(compare).toHaveBeenCalledTimes(3)
        expect(compare.mock.calls.every((call) => call[1] === DUMMY_BCRYPT_HASH)).toBe(true)
        compare.mockRestore()
    })

    it('runs dummy bcrypt after a wrong password on an eligible scrypt account while any bcrypt hash remains', async () => {
        const { store } = await seed()
        const other = store.users.find((u) => u.id === 'user-b')
        if (!other) throw new Error('missing user-b')
        other.credential = bcrypt.hashSync(OTHER, 10)
        const compare = jest.spyOn(bcrypt, 'compare')
        const memberWrong = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: 'Wrong-Pass1!' } })))
        expect(memberWrong.status).toBe(401)
        expect(compare).toHaveBeenCalled()
        expect(compare.mock.calls.some((call) => call[1] === DUMMY_BCRYPT_HASH)).toBe(true)
        const ownerWrong = json(
            await handleLoginPost(
                ctx({ store, localAdmin: true, internal: true, body: { email: 'owner@example.com', password: 'Wrong-Pass1!' } })
            )
        )
        expect(ownerWrong.status).toBe(401)
        expect(compare.mock.calls[compare.mock.calls.length - 1][1]).toBe(DUMMY_BCRYPT_HASH)
        compare.mockRestore()
    })

    it('keeps the scrypt dummy for an unknown or disabled miss when no bcrypt hash remains', async () => {
        const { store } = await seed()
        const compare = jest.spyOn(bcrypt, 'compare')
        const unknownMember = json(await handleLocalLogin(signed({ store, body: { email: 'nobody@example.com', password: OTHER } })))
        const disabledMember = json(await handleLocalLogin(signed({ store, body: { email: 'disabled@example.com', password: OTHER } })))
        const unknownOwner = json(
            await handleLoginPost(ctx({ store, localAdmin: true, internal: true, body: { email: 'nobody@example.com', password: GOOD } }))
        )
        expect(unknownMember.status).toBe(401)
        expect(disabledMember.status).toBe(401)
        expect(unknownOwner.status).toBe(401)
        expect(compare).not.toHaveBeenCalled()
        compare.mockRestore()
    })

    it('logs out idempotently and refuses a missing or invalid CSRF header', async () => {
        const { store } = await seed()
        const ok = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        const raw = ok.cookies?.[0].value || ''
        const missing = json(await handleLocalLogout(ctx({ store, cookies: { 'cuttlely-local-session': raw } })))
        expect(missing.status).toBe(401)
        expect(missing.body).toEqual({ message: 'Unauthorized' })
        expect(store.local.size).toBe(1)
        const invalid = json(await handleLocalLogout(ctx({ store, internal: false, cookies: { 'cuttlely-local-session': raw }, body: {} })))
        expect(invalid.status).toBe(401)
        const first = json(await handleLocalLogout(ctx({ store, internal: true, cookies: { 'cuttlely-local-session': raw } })))
        expect(first.status).toBe(200)
        expect(first.body).toEqual({ message: 'logged_out', redirectTo: '/signin' })
        expect(first.clearCookies).toEqual(expect.arrayContaining(['cuttlely-local-session', 'wos-session']))
        expect(store.local.size).toBe(0)
        const second = json(await handleLocalLogout(ctx({ store, internal: true, cookies: { 'cuttlely-local-session': raw } })))
        expect(second.status).toBe(200)
        expect(second.body).toEqual(first.body)
        const reused = await establishSession(ctx({ store, cookies: { 'cuttlely-local-session': raw } }))
        expect(reused.user).toBeNull()
    })

    it('changes the current password, rotates this session, and ends the others', async () => {
        const { store } = await seed()
        const first = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        const second = json(
            await handleLocalLogin(signed({ store, ip: '203.0.113.9', body: { email: 'ada@example.com', password: OTHER } }))
        )
        const current = second.cookies?.[0].value || ''
        const other = first.cookies?.[0].value || ''
        const beaBefore = store.users.find((user) => user.id === 'user-b')?.credential
        const noCsrf = json(
            await handleLocalPassword(
                ctx({ store, cookies: { 'cuttlely-local-session': current }, body: { currentPassword: OTHER, newPassword: GOOD } })
            )
        )
        expect(noCsrf.status).toBe(401)
        const badCsrf = json(
            await handleLocalPassword(
                ctx({
                    store,
                    internal: false,
                    cookies: { 'cuttlely-local-session': current },
                    body: { currentPassword: OTHER, newPassword: GOOD }
                })
            )
        )
        expect(badCsrf.status).toBe(401)
        const wrong = json(
            await handleLocalPassword(
                ctx({
                    store,
                    internal: true,
                    cookies: { 'cuttlely-local-session': current },
                    body: { currentPassword: 'Wrong-Pass1!', newPassword: GOOD }
                })
            )
        )
        expect(wrong.status).toBe(401)
        expect(wrong.body).toEqual(INVALID)
        const same = json(
            await handleLocalPassword(
                ctx({
                    store,
                    internal: true,
                    cookies: { 'cuttlely-local-session': current },
                    body: { currentPassword: OTHER, newPassword: OTHER }
                })
            )
        )
        expect(same.status).toBe(400)
        const weak = json(
            await handleLocalPassword(
                ctx({
                    store,
                    internal: true,
                    cookies: { 'cuttlely-local-session': current },
                    body: { currentPassword: OTHER, newPassword: 'short' }
                })
            )
        )
        expect(weak.status).toBe(400)
        const changed = json(
            await handleLocalPassword(
                ctx({
                    store,
                    internal: true,
                    cookies: { 'cuttlely-local-session': current },
                    body: { currentPassword: OTHER, newPassword: GOOD, userId: 'user-b' }
                })
            )
        )
        expect(changed.status).toBe(200)
        expect(changed.body.id).toBe('user-a')
        expect(changed.cookies?.[0].value).not.toBe(current)
        expect(store.users.find((user) => user.id === 'user-b')?.credential).toBe(beaBefore)
        expect(store.users.find((user) => user.id === 'user-a')?.credential).not.toBe(beaBefore)
        const oldCurrent = await establishSession(ctx({ store, cookies: { 'cuttlely-local-session': current } }))
        const oldOther = await establishSession(ctx({ store, cookies: { 'cuttlely-local-session': other } }))
        expect(oldCurrent.user).toBeNull()
        expect(oldOther.user).toBeNull()
        const fresh = await establishSession(ctx({ store, cookies: { 'cuttlely-local-session': changed.cookies?.[0].value } }))
        expect(fresh.user?.id).toBe('user-a')
        expect(fresh.user?.isOrganizationAdmin).toBe(false)
        const signedIn = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: GOOD } })))
        expect(signedIn.status).toBe(200)
        const previous = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        expect(previous.status).toBe(401)
    })

    it('does not let user A use user B session or user B workspace', async () => {
        const { store } = await seed()
        const ada = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        const bea = json(await handleLocalLogin(signed({ store, body: { email: 'bea@example.com', password: OTHER } })))
        const asAda = await establishSession(ctx({ store, cookies: { 'cuttlely-local-session': ada.cookies?.[0].value } }))
        const asBea = await establishSession(ctx({ store, cookies: { 'cuttlely-local-session': bea.cookies?.[0].value } }))
        expect(asAda.user?.id).toBe('user-a')
        expect(asAda.user?.activeWorkspaceId).toBe('ws-a')
        expect(asAda.user?.isOrganizationAdmin).toBe(false)
        expect(asBea.user?.id).toBe('user-b')
        expect(asBea.user?.activeWorkspaceId).toBe('ws-b')
        expect(asAda.user?.id).not.toBe(asBea.user?.id)

        const calls: unknown[][] = []
        const dataSource = {
            options: { type: 'sqlite' },
            query: async (_sql: string, params: unknown[] = []) => {
                calls.push(params)
                return []
            }
        }
        await expect(teamAccess(dataSource as unknown as DataSource, 'user-a', 'ws-b')).resolves.toEqual({
            owner: false,
            permissions: null
        })
        expect(calls[0]).toEqual(['ws-b', 'user-a'])

        setTeamPermissionLookup({
            accessFor: async (userId, workspaceId) => {
                if (userId === 'user-a' && workspaceId === 'ws-a') return { owner: false, permissions: ['chatflows:view'] }
                return { owner: false, permissions: null }
            }
        })
        const app = express()
        app.use((req, _res, next) => {
            req.user = asAda.user as unknown as Express.User
            next()
        })
        app.get('/owned', requireOwner(), (_req, res) => {
            res.json({ ok: true })
        })
        app.get('/view', requirePermission('chatflows:view'), (_req, res) => {
            res.json({ ok: true })
        })
        const server = request(app)
        expect((await server.get('/owned')).status).toBe(403)
        expect((await server.get('/view')).status).toBe(200)

        const crossed = express()
        crossed.use((req, _res, next) => {
            req.user = { ...(asAda.user as object), activeWorkspaceId: 'ws-b' } as Express.User
            next()
        })
        crossed.get('/view', requirePermission('chatflows:view'), (_req: Request, res) => {
            res.json({ ok: true })
        })
        expect((await request(crossed).get('/view')).status).toBe(403)
    })

    it('keeps login and options public, and requires CSRF on logout and password change', async () => {
        const whitelist = whitelistUrls()
        expect(whitelist).toContain('/api/v1/auth/local/login')
        expect(whitelist).toContain('/api/v1/auth/options')
        expect(whitelist).toContain('/api/v1/auth/local/logout')
        expect(whitelist).toContain('/api/v1/auth/recovery/login')
        expect(whitelist).toContain('/api/v1/auth/local/password')

        const server = express()
        server.use(
            apiV1Auth({
                whitelistURLs: whitelist,
                apiKeyBlacklistURLs: [],
                licenseRequired: () => false,
                dataSource: { getRepository: () => ({ findOne: async () => null }) } as unknown as DataSource,
                validateAPIKey: async () => ({ isValid: false }),
                attachIdentitySession: async (req) => (req.path.endsWith('/password') ? { permissions: ['chatflows:view'] } : null)
            })
        )
        server.use((_req, res) => {
            res.status(200).json({ passed: true })
        })
        const http = request(server)
        expect((await http.post('/api/v1/auth/local/login')).status).toBe(200)
        expect((await http.get('/api/v1/auth/options')).status).toBe(200)
        expect((await http.post('/api/v1/auth/local/logout')).status).toBe(200)
        expect((await http.post('/api/v1/auth/local/password')).status).toBe(200)
        const noCookie = json(
            await handleLocalPassword(ctx({ store: new MemoryStore(), body: { currentPassword: OTHER, newPassword: GOOD } }))
        )
        const badHeader = json(
            await handleLocalPassword(
                ctx({
                    store: new MemoryStore(),
                    internal: false,
                    cookies: { 'cuttlely-local-session': 'raw-cookie' },
                    body: { currentPassword: OTHER, newPassword: GOOD }
                })
            )
        )
        expect(noCookie.status).toBe(401)
        expect(badHeader.status).toBe(401)
        expect(noCookie.body).toEqual({ message: 'Unauthorized' })
        expect(badHeader.body).toEqual({ message: 'Unauthorized' })
    })

    it('answers local logout from the route: 401 without CSRF and 200 even when the mode is off', async () => {
        const { store } = await seed()
        mockRouteStore.current = store
        const http = request(localRouteApp())
        const saved = {
            users: process.env.CUTTLELY_LOCAL_USERS,
            admin: process.env.CUTTLELY_LOCAL_ADMIN,
            key: process.env.WORKOS_API_KEY,
            client: process.env.WORKOS_CLIENT_ID
        }
        const restoreEnv = () => {
            if (saved.users === undefined) delete process.env.CUTTLELY_LOCAL_USERS
            else process.env.CUTTLELY_LOCAL_USERS = saved.users
            if (saved.admin === undefined) delete process.env.CUTTLELY_LOCAL_ADMIN
            else process.env.CUTTLELY_LOCAL_ADMIN = saved.admin
            if (saved.key === undefined) delete process.env.WORKOS_API_KEY
            else process.env.WORKOS_API_KEY = saved.key
            if (saved.client === undefined) delete process.env.WORKOS_CLIENT_ID
            else process.env.WORKOS_CLIENT_ID = saved.client
        }
        const keep = async (userId: string, raw: string) => {
            const digest = hashSessionToken(raw)
            await store.insertLocalSession({
                id: raw,
                userId,
                token: digest,
                idleExpires: new Date(NOW + IDLE_MS),
                absoluteExpires: new Date(NOW + ABSOLUTE_MS)
            })
            return digest
        }
        try {
            process.env.CUTTLELY_LOCAL_USERS = 'true'
            delete process.env.CUTTLELY_LOCAL_ADMIN
            delete process.env.WORKOS_API_KEY
            delete process.env.WORKOS_CLIENT_ID

            const disabledDigest = await keep('disabled', 'disabled-raw')
            const denied = await http.post('/api/v1/auth/local/logout').set('Cookie', 'cuttlely-local-session=disabled-raw')
            expect(denied.status).toBe(401)
            expect(denied.body).toEqual({ message: 'Unauthorized' })
            expect(denied.headers['set-cookie']).toBeUndefined()
            expect(store.local.has(disabledDigest)).toBe(true)

            const passwordDenied = await http.post('/api/v1/auth/local/password').set('Cookie', 'cuttlely-local-session=disabled-raw')
            expect(passwordDenied.status).toBe(401)
            expect(passwordDenied.body).toEqual({ message: 'Unauthorized' })
            expect(store.local.has(disabledDigest)).toBe(true)

            const activeDigest = await keep('user-a', 'active-raw')
            const out = await http
                .post('/api/v1/auth/local/logout')
                .set('Cookie', 'cuttlely-local-session=active-raw')
                .set('x-request-from', 'internal')
            expect(out.status).toBe(200)
            expect(out.body).toEqual({ message: 'logged_out', redirectTo: '/signin' })
            expect(store.local.has(activeDigest)).toBe(false)
            const again = await http.post('/api/v1/auth/local/logout').set('x-request-from', 'internal')
            expect(again.status).toBe(200)
            expect(again.body).toEqual(out.body)

            delete process.env.CUTTLELY_LOCAL_USERS
            process.env.CUTTLELY_LOCAL_ADMIN = 'true'
            const memberDigest = await keep('user-a', 'member-raw')
            const missing = await http
                .post('/api/v1/auth/local/logout')
                .set('Cookie', 'cuttlely-local-session=member-raw')
                .set('x-request-from', 'internal')
            expect(missing.status).toBe(200)
            expect(missing.body).toEqual({ message: 'logged_out', redirectTo: '/signin' })
            expect(String(missing.headers['set-cookie'])).toContain('cuttlely-local-session=')
            expect(store.local.has(memberDigest)).toBe(false)
            const passwordMissing = await http.post('/api/v1/auth/local/password').set('x-request-from', 'internal')
            expect(passwordMissing.status).toBe(404)
            expect(passwordMissing.body).toEqual({ message: 'Not Found' })
        } finally {
            mockRouteStore.current = null
            restoreEnv()
        }
    })

    it('does not let header-less sign-in attempts use up the process cap', async () => {
        const { store } = await seed()
        mockRouteStore.current = store
        const http = request(localRouteApp())
        const saved = {
            users: process.env.CUTTLELY_LOCAL_USERS,
            admin: process.env.CUTTLELY_LOCAL_ADMIN,
            key: process.env.WORKOS_API_KEY,
            client: process.env.WORKOS_CLIENT_ID
        }
        try {
            process.env.CUTTLELY_LOCAL_USERS = 'true'
            delete process.env.CUTTLELY_LOCAL_ADMIN
            delete process.env.WORKOS_API_KEY
            delete process.env.WORKOS_CLIENT_ID
            for (let i = 0; i < 15; i++) {
                const refused = await http.post('/api/v1/auth/local/login').send({ email: 'ada@example.com', password: OTHER })
                expect(refused.status).toBe(401)
                expect(refused.body).toEqual(INVALID)
                expect(refused.headers['set-cookie']).toBeUndefined()
            }
            const ok = await http
                .post('/api/v1/auth/local/login')
                .set('x-request-from', 'internal')
                .send({ email: 'ada@example.com', password: OTHER })
            expect(ok.status).toBe(200)
            expect(ok.body.id).toBe('user-a')
            expect(String(ok.headers['set-cookie'])).toContain('cuttlely-local-session=')
        } finally {
            mockRouteStore.current = null
            if (saved.users === undefined) delete process.env.CUTTLELY_LOCAL_USERS
            else process.env.CUTTLELY_LOCAL_USERS = saved.users
            if (saved.admin === undefined) delete process.env.CUTTLELY_LOCAL_ADMIN
            else process.env.CUTTLELY_LOCAL_ADMIN = saved.admin
            if (saved.key === undefined) delete process.env.WORKOS_API_KEY
            else process.env.WORKOS_API_KEY = saved.key
            if (saved.client === undefined) delete process.env.WORKOS_CLIENT_ID
            else process.env.WORKOS_CLIENT_ID = saved.client
        }
    })

    it('caps failed owner sign-ins on POST /login per client and leaves good sign-ins uncounted', async () => {
        const { store } = await seed()
        mockRouteStore.current = store
        let router = identityAuthRouter
        jest.isolateModules(() => {
            router = (require('./http') as typeof import('./http')).identityAuthRouter
        })
        const http = request(localRouteApp(router))
        const saved = { admin: process.env.CUTTLELY_LOCAL_ADMIN, limit: process.env.CUTTLELY_LOGIN_FAILURE_LIMIT }
        const signIn = (password: string) =>
            http.post('/api/v1/auth/login').set('x-request-from', 'internal').send({ email: 'owner@example.com', password })
        try {
            process.env.CUTTLELY_LOCAL_ADMIN = 'true'
            process.env.CUTTLELY_LOGIN_FAILURE_LIMIT = '3'
            for (let i = 0; i < 4; i++) expect((await signIn(OTHER)).status).toBe(401)
            for (let i = 0; i < 5; i++) {
                const ok = await signIn(GOOD)
                expect(ok.status).toBe(200)
                expect(String(ok.headers['set-cookie'])).toContain('cuttlely-local-session=')
            }
            const last = await signIn(OTHER)
            expect(last.status).toBe(401)
            expect(last.body).toEqual(INVALID)
            for (const password of [OTHER, GOOD]) {
                const capped = await signIn(password)
                expect(capped.status).toBe(429)
                expect(capped.body).toEqual(LOCKED)
                expect(capped.headers['set-cookie']).toBeUndefined()
            }
        } finally {
            mockRouteStore.current = null
            if (saved.admin === undefined) delete process.env.CUTTLELY_LOCAL_ADMIN
            else process.env.CUTTLELY_LOCAL_ADMIN = saved.admin
            if (saved.limit === undefined) delete process.env.CUTTLELY_LOGIN_FAILURE_LIMIT
            else process.env.CUTTLELY_LOGIN_FAILURE_LIMIT = saved.limit
        }
    })

    it('does not let header-less or owner-off POST /login requests use up the shared cap', async () => {
        const { store } = await seed()
        mockRouteStore.current = store
        let router = identityAuthRouter
        jest.isolateModules(() => {
            router = (require('./http') as typeof import('./http')).identityAuthRouter
        })
        const http = request(localRouteApp(router))
        const saved = {
            users: process.env.CUTTLELY_LOCAL_USERS,
            admin: process.env.CUTTLELY_LOCAL_ADMIN,
            key: process.env.WORKOS_API_KEY,
            client: process.env.WORKOS_CLIENT_ID,
            limit: process.env.CUTTLELY_LOGIN_FAILURE_LIMIT
        }
        const restore = (key: string, value: string | undefined) => {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        try {
            process.env.CUTTLELY_LOCAL_USERS = 'true'
            process.env.CUTTLELY_LOCAL_ADMIN = 'true'
            process.env.CUTTLELY_LOGIN_FAILURE_LIMIT = '3'
            delete process.env.WORKOS_API_KEY
            delete process.env.WORKOS_CLIENT_ID
            for (let i = 0; i < 15; i++) {
                const refused = await http.post('/api/v1/auth/login').send({ email: 'owner@example.com', password: OTHER })
                expect(refused.status).toBe(401)
            }
            delete process.env.CUTTLELY_LOCAL_ADMIN
            for (let i = 0; i < 15; i++) {
                const off = await http
                    .post('/api/v1/auth/login')
                    .set('x-request-from', 'internal')
                    .send({ email: 'owner@example.com', password: OTHER })
                expect(off.status).toBe(404)
            }
            process.env.CUTTLELY_LOCAL_ADMIN = 'true'
            const local = await http
                .post('/api/v1/auth/local/login')
                .set('x-request-from', 'internal')
                .send({ email: 'ada@example.com', password: OTHER })
            expect(local.status).toBe(200)
            const owner = await http
                .post('/api/v1/auth/login')
                .set('x-request-from', 'internal')
                .send({ email: 'owner@example.com', password: GOOD })
            expect(owner.status).toBe(200)
        } finally {
            mockRouteStore.current = null
            restore('CUTTLELY_LOCAL_USERS', saved.users)
            restore('CUTTLELY_LOCAL_ADMIN', saved.admin)
            restore('WORKOS_API_KEY', saved.key)
            restore('WORKOS_CLIENT_ID', saved.client)
            restore('CUTTLELY_LOGIN_FAILURE_LIMIT', saved.limit)
        }
    })

    it('refuses local login without the internal header and sets no cookie', async () => {
        const { store } = await seed()
        const missing = json(await handleLocalLogin(ctx({ store, internal: false, body: { email: 'ada@example.com', password: OTHER } })))
        expect(missing.status).toBe(401)
        expect(missing.body).toEqual(INVALID)
        expect(missing.cookies).toBeUndefined()
        expect(store.local.size).toBe(0)
    })

    it('account sign-out deletes a local users session when break-glass is off', async () => {
        const { store } = await seed()
        const ok = json(await handleLocalLogin(signed({ store, localAdmin: false, body: { email: 'ada@example.com', password: OTHER } })))
        const raw = ok.cookies?.[0].value || ''
        const denied = json(await handleLogout(ctx({ store, localAdmin: false, cookies: { 'cuttlely-local-session': raw } })))
        expect(denied.status).toBe(401)
        expect(denied.body).toEqual({ message: 'Unauthorized' })
        expect(store.local.size).toBe(1)
        const out = json(await handleLogout(ctx({ store, localAdmin: false, internal: true, cookies: { 'cuttlely-local-session': raw } })))
        expect(out.status).toBe(200)
        expect(store.local.size).toBe(0)
        const again = await establishSession(ctx({ store, localAdmin: false, cookies: { 'cuttlely-local-session': raw } }))
        expect(again.user).toBeNull()
        const refreshed = json(await handleRefresh(ctx({ store, localAdmin: false, cookies: { 'cuttlely-local-session': raw } })))
        expect(refreshed.status).toBe(401)
    })

    it('does the same store work for every failed sign-in', async () => {
        const { store } = await seed()
        const calls: string[] = []
        const find = store.findUsersByEmail.bind(store)
        const open = store.localAccountOpen.bind(store)
        const bcryptLeft = store.hasBcryptCredential.bind(store)
        const drop = store.deleteLocalSessionsForUser.bind(store)
        store.findUsersByEmail = async (email) => {
            calls.push(`find:${email}`)
            return find(email)
        }
        store.localAccountOpen = async (id) => {
            calls.push(`open:${id}`)
            return open(id)
        }
        store.hasBcryptCredential = async () => {
            calls.push('bcrypt')
            return bcryptLeft()
        }
        store.deleteLocalSessionsForUser = async (id) => {
            calls.push(`drop:${id}`)
            return drop(id)
        }
        const attempt = async (email: string, password: string) => {
            calls.length = 0
            const result = json(await handleLocalLogin(signed({ store, body: { email, password } })))
            return { result, calls: [...calls] }
        }
        const unknown = await attempt('nobody@example.com', OTHER)
        const wrong = await attempt('ada@example.com', 'Wrong-Pass1!')
        const empty = await attempt('invited@example.com', OTHER)
        const disabled = await attempt('disabled@example.com', OTHER)
        expect(unknown.result.status).toBe(401)
        const names = (rows: string[]) => rows.map((call) => call.split(':')[0])
        expect(names(unknown.calls)).toEqual(['find', 'open', 'bcrypt', 'drop'])
        expect(names(wrong.calls)).toEqual(names(unknown.calls))
        expect(names(empty.calls)).toEqual(names(unknown.calls))
        expect(names(disabled.calls)).toEqual(names(unknown.calls))
        expect(unknown.calls).toContain(`open:${UNKNOWN_LOCAL_ACCOUNT_ID}`)
        expect(unknown.calls).toContain(`drop:${UNKNOWN_LOCAL_ACCOUNT_ID}`)
        expect(wrong.calls).toContain(`drop:${UNKNOWN_LOCAL_ACCOUNT_ID}`)
        expect(empty.calls).toContain('drop:invited')
        expect(disabled.calls).toContain('drop:disabled')
    })

    it('locks an unknown email the same way as a known one, and drops the oldest hash when the cap is full', async () => {
        const { store } = await seed()
        const unknown = new LoginRateLimit()
        for (let i = 0; i < 10; i++) {
            const result = json(
                await handleLocalLogin(
                    signed({
                        store,
                        rateLimit: unknown,
                        ip: `203.0.113.${i}`,
                        body: { email: 'nobody@example.com', password: 'Wrong-Pass1!' }
                    })
                )
            )
            expect(result.status).toBe(401)
        }
        const lockedUnknown = json(
            await handleLocalLogin(
                signed({ store, rateLimit: unknown, ip: '198.51.100.40', body: { email: 'Nobody@Example.com', password: OTHER } })
            )
        )
        const known = new LoginRateLimit()
        for (let i = 0; i < 10; i++) {
            await handleLocalLogin(
                signed({ store, rateLimit: known, ip: `198.51.100.${i}`, body: { email: 'ada@example.com', password: 'Wrong-Pass1!' } })
            )
        }
        const lockedKnown = json(
            await handleLocalLogin(
                signed({ store, rateLimit: known, ip: '192.0.2.40', body: { email: 'ada@example.com', password: OTHER } })
            )
        )
        expect(lockedUnknown.status).toBe(429)
        expect(lockedKnown.status).toBe(429)
        expect(lockedUnknown.body).toEqual(LOCKED)
        expect(lockedKnown.body).toEqual(lockedUnknown.body)
        expect(JSON.stringify(unknown)).not.toContain('nobody@example.com')

        const capped = new LoginRateLimit(10, 15 * 60 * 1000, 2)
        for (let i = 0; i < 10; i++) await capped.recordFailure(`203.0.113.${i}`, 'old@example.com', NOW)
        await capped.recordFailure('203.0.113.20', 'mid@example.com', NOW)
        await capped.recordFailure('203.0.113.21', 'new@example.com', NOW)
        expect(capped.accountBuckets()).toBe(2)
        expect(await capped.blocked('198.51.100.77', 'old@example.com', NOW)).toBe(false)
        expect(await capped.blocked('198.51.100.78', 'new@example.com', NOW)).toBe(false)
    })

    it('keeps an email lockout after a new database limiter is created', async () => {
        const { DatabaseSync } = require('node:sqlite') as {
            DatabaseSync: new (path: string) => {
                prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
            }
        }
        const db = new DatabaseSync(':memory:')
        const query = async (statement: string, params: unknown[] = []) => {
            const prepared = db.prepare(statement)
            if (/^\s*select/i.test(statement)) return prepared.all(...params)
            prepared.run(...params)
            return []
        }
        const runner = {
            query,
            connect: async () => undefined,
            release: async () => undefined,
            connection: { options: { type: 'sqlite' } }
        }
        await addIdentityLoginGuards(runner as never)
        const database = { createQueryRunner: () => runner }
        const email = 'nobody@example.com'
        const first = new SqlLoginRateLimit(database as never)
        for (let i = 0; i < 10; i++) await first.recordFailure(`203.0.113.${i}`, email, NOW)
        const restarted = new SqlLoginRateLimit(database as never)
        expect(await restarted.blocked('198.51.100.9', 'Nobody@Example.com', NOW)).toBe(true)
        const rows = await query(`SELECT scope, subject FROM identity_login_failure WHERE scope = 'account'`)
        expect(rows).toHaveLength(10)
        expect(rows.every((row) => String(row.subject) === accountLockKey(email))).toBe(true)
        expect(JSON.stringify(rows)).not.toContain(email)
        const stale = new SqlLoginRateLimit(database as never)
        expect(await stale.blocked('198.51.100.9', email, NOW + LOGIN_FAILURE_WINDOW_MS + 1)).toBe(false)
        const left = await query(`SELECT COUNT(*) AS count FROM identity_login_failure`)
        expect(Number(left[0]?.count || 0)).toBe(0)
    })

    it('refuses a member session when local users mode is off and ends recovery after owner demotion', async () => {
        const { store } = await seed()
        const ok = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        const raw = ok.cookies?.[0].value || ''
        const closed = await establishSession(
            ctx({ store, localUsers: false, localAdmin: true, cookies: { 'cuttlely-local-session': raw } })
        )
        expect(closed.user).toBeNull()
        const owner = json(
            await handleLoginPost(
                ctx({ store, localUsers: false, localAdmin: true, internal: true, body: { email: 'owner@example.com', password: GOOD } })
            )
        )
        expect(owner.status).toBe(200)
        expect(owner.body.isOrganizationAdmin).toBe(true)
        const kept = await establishSession(
            ctx({ store, localUsers: false, localAdmin: true, cookies: { 'cuttlely-local-session': owner.cookies?.[0].value } })
        )
        expect(kept.user?.id).toBe('owner')
        store.ownerId = null
        const demoted = await establishSession(
            ctx({ store, localUsers: false, localAdmin: true, cookies: { 'cuttlely-local-session': owner.cookies?.[0].value } })
        )
        expect(demoted.user).toBeNull()
    })

    it('ends local sessions when AuthKit is turned on and reports that on options', async () => {
        const { store } = await seed()
        const member = json(await handleLocalLogin(signed({ store, body: { email: 'ada@example.com', password: OTHER } })))
        const owner = json(
            await handleLoginPost(
                ctx({
                    store,
                    localAdmin: true,
                    localUsers: true,
                    internal: true,
                    body: { email: 'owner@example.com', password: GOOD }
                })
            )
        )
        expect(store.local.size).toBe(2)
        const at = new Date('2026-10-15T12:00:00.000Z')
        expect(await store.applyAuthKitSwitch(true, at)).toEqual({
            configured: true,
            sessionsEnded: 2,
            switchedAt: at.toISOString()
        })
        expect(store.local.size).toBe(0)
        const memberGone = await establishSession(
            ctx({
                store,
                localUsers: false,
                localAdmin: true,
                workosConfigured: true,
                cookies: { 'cuttlely-local-session': member.cookies?.[0].value }
            })
        )
        const ownerGone = await establishSession(
            ctx({
                store,
                localUsers: false,
                localAdmin: true,
                workosConfigured: true,
                cookies: { 'cuttlely-local-session': owner.cookies?.[0].value }
            })
        )
        expect(memberGone.user).toBeNull()
        expect(ownerGone.user).toBeNull()

        const again = json(
            await handleLoginPost(
                ctx({
                    store,
                    localUsers: false,
                    localAdmin: true,
                    workosConfigured: true,
                    internal: true,
                    body: { email: 'owner@example.com', password: GOOD }
                })
            )
        )
        expect(again.status).toBe(200)
        expect(store.local.size).toBe(1)
        const second = await store.applyAuthKitSwitch(true, new Date('2026-10-16T00:00:00.000Z'))
        expect(second.sessionsEnded).toBe(2)
        expect(store.local.size).toBe(1)
        const still = await establishSession(
            ctx({ store, localUsers: false, localAdmin: true, cookies: { 'cuttlely-local-session': again.cookies?.[0].value } })
        )
        expect(still.user?.id).toBe('owner')
        expect(
            json(
                await handleLocalLogin(
                    signed({ store, localUsers: false, workosConfigured: true, body: { email: 'bea@example.com', password: OTHER } })
                )
            ).status
        ).toBe(404)

        mockRouteStore.current = store
        const saved = {
            users: process.env.CUTTLELY_LOCAL_USERS,
            admin: process.env.CUTTLELY_LOCAL_ADMIN,
            key: process.env.WORKOS_API_KEY,
            client: process.env.WORKOS_CLIENT_ID
        }
        const restoreEnv = () => {
            if (saved.users === undefined) delete process.env.CUTTLELY_LOCAL_USERS
            else process.env.CUTTLELY_LOCAL_USERS = saved.users
            if (saved.admin === undefined) delete process.env.CUTTLELY_LOCAL_ADMIN
            else process.env.CUTTLELY_LOCAL_ADMIN = saved.admin
            if (saved.key === undefined) delete process.env.WORKOS_API_KEY
            else process.env.WORKOS_API_KEY = saved.key
            if (saved.client === undefined) delete process.env.WORKOS_CLIENT_ID
            else process.env.WORKOS_CLIENT_ID = saved.client
        }
        try {
            process.env.CUTTLELY_LOCAL_USERS = 'true'
            process.env.CUTTLELY_LOCAL_ADMIN = 'true'
            process.env.WORKOS_API_KEY = 'key'
            process.env.WORKOS_CLIENT_ID = 'client'
            const http = request(localRouteApp())
            const options = await http.get('/api/v1/auth/options')
            expect(options.status).toBe(200)
            expect(options.body).toEqual({
                methods: ['authKit', 'localAdmin'],
                status: {
                    authKit: true,
                    localPasswordSignIn: false,
                    breakGlassOwner: true,
                    localSessions: 'ended',
                    sessionsEnded: 2
                }
            })
            expect(JSON.stringify(options.body)).not.toContain('@')
            const posted = await http.post('/api/v1/auth/options')
            expect(posted.status).toBe(404)
            expect(store.local.size).toBe(1)

            store.switchState = null
            const pending = await http.get('/api/v1/auth/options')
            expect(pending.body.status.localSessions).toBe('pending')
            expect(pending.body.status.sessionsEnded).toBe(0)

            await store.applyAuthKitSwitch(true, at)
            await store.applyAuthKitSwitch(false, new Date('2026-10-17T00:00:00.000Z'), { recordOff: true })
            delete process.env.WORKOS_API_KEY
            delete process.env.WORKOS_CLIENT_ID
            const open = await http.get('/api/v1/auth/options')
            expect(open.body.status).toMatchObject({
                authKit: false,
                localPasswordSignIn: true,
                localSessions: 'open',
                sessionsEnded: 1
            })
            const otherTeam = json(await handleLocalLogin(signed({ store, body: { email: 'bea@example.com', password: OTHER } })))
            expect(otherTeam.status).toBe(200)
            expect(otherTeam.body.activeWorkspaceId).toBe('ws-b')
            await store.applyAuthKitSwitch(true, new Date('2026-10-18T00:00:00.000Z'))
            expect(store.local.size).toBe(0)
            const crossed = await establishSession(
                ctx({
                    store,
                    localUsers: false,
                    localAdmin: true,
                    cookies: { 'cuttlely-local-session': otherTeam.cookies?.[0].value }
                })
            )
            expect(crossed.user).toBeNull()
        } finally {
            mockRouteStore.current = null
            restoreEnv()
        }
    })

    it('does not end sessions again when a process sees AuthKit off after the web server recorded it on', async () => {
        const { store } = await seed()
        const session = (id: string, userId: string) =>
            store.insertLocalSession({
                id,
                userId,
                token: `${id}-token`,
                idleExpires: new Date(NOW + IDLE_MS),
                absoluteExpires: new Date(NOW + ABSOLUTE_MS)
            })
        await session('owner-before', 'owner')
        await session('ada-before', 'user-a')
        await store.applyAuthKitSwitch(true, new Date('2026-10-15T12:00:00.000Z'))
        expect(store.local.size).toBe(0)
        await session('owner-after', 'owner')

        const seenOff = await store.applyAuthKitSwitch(false, new Date('2026-10-16T00:00:00.000Z'))
        expect(seenOff.configured).toBe(true)
        expect(store.local.size).toBe(1)
        const stillOn = await store.applyAuthKitSwitch(true, new Date('2026-10-16T01:00:00.000Z'))
        expect(stillOn.sessionsEnded).toBe(2)
        expect(store.local.has('owner-after-token')).toBe(true)

        const turnedOff = await store.applyAuthKitSwitch(false, new Date('2026-10-17T00:00:00.000Z'), { recordOff: true })
        expect(turnedOff.configured).toBe(false)
        expect(store.local.size).toBe(1)
        await store.applyAuthKitSwitch(true, new Date('2026-10-18T00:00:00.000Z'))
        expect(store.local.size).toBe(0)
    })
})

describe('sign-in method view across processes', () => {
    afterEach(() => {
        jest.restoreAllMocks()
        mockRefreshView.mockReset()
        delete process.env.CUTTLELY_LOCAL_USERS
    })

    it('refreshes the shared method before answering sign-in options and local sign-in', async () => {
        mockRefreshView.mockClear()
        process.env.CUTTLELY_LOCAL_USERS = 'true'
        const state = jest.requireActual('./authenticationState') as typeof import('./authenticationState')
        let method: 'local' | 'workos' = 'workos'
        jest.spyOn(state, 'selectedAuthenticationMethod').mockImplementation(() => method)
        mockRefreshView.mockImplementation(async () => {
            method = 'local'
        })
        const http = request(localRouteApp())
        const options = await http.get('/api/v1/auth/signin-options')
        expect(options.body.localUsers).toBe(true)
        method = 'workos'
        const login = await http.post('/api/v1/auth/local/login').send({ email: 'a@example.com', password: 'x' })
        expect(login.status).not.toBe(404)
        expect(mockRefreshView).toHaveBeenCalledTimes(2)
    })
})
