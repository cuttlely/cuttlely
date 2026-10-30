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

import { randomUUID } from 'crypto'
import type { DataSource } from 'typeorm'
import { expiredInviteCookie, inviteCookie, localCookie, sealedCookie, workosEpochCookie, workosEpochCookieValid } from './cookies'
import {
    EMAIL_MAX_LENGTH,
    INVITE_COOKIE,
    INVITE_TOKEN_MAX_LENGTH,
    LOCAL_SESSION_COOKIE,
    PASSWORD_MAX_LENGTH,
    WOS_SESSION_COOKIE,
    WOS_EPOCH_COOKIE,
    signOutReturnTo,
    signinErrorUrl,
    unavailablePage
} from './constants'
import { INVITE_LINK_INVALID, isActiveStatus, linkFailureMessage, linkWorkosUser } from './link'
import {
    hashForLoginCompare,
    hashPassword,
    hashSessionToken,
    passwordErrors,
    randomToken,
    tokensEqual,
    verifyPassword,
    isBcryptHash
} from './password'
import { SEEN_EVERY_MS, localSessionBlock, localSessionTimes, sessionLimitsMs } from './sessionLifetime'
import { LoginLimiter } from './rateLimit'
import {
    noteSetupFailure,
    reissueExpiredSetupCode,
    SETUP_CODE_EXPIRED_MESSAGE,
    setupCodeHmac,
    setupCodeVerdict,
    setupServiceName
} from './setupCode'
import { IdentityStore } from './store'
import {
    HandlerResult,
    LocalSession,
    NotEmptyError,
    SessionUser,
    SetCookie,
    SetupCodeRejected,
    WorkosPort,
    WorkosUnavailableError
} from './types'

export interface AuthContext {
    dataSource?: DataSource
    /** Captured at request start so a concurrent method switch can stop completion. */
    authenticationEpoch?: number
    workosConfigured: boolean
    localAdmin: boolean
    /** CUTTLELY_LOCAL_USERS is on and AuthKit is not configured. */
    localUsers: boolean
    cookiePasswordOk: boolean
    cookiePassword?: string
    redirectUri?: string
    secure: boolean
    now: number
    ip: string
    /** Socket remote address. Failure limits use this value. */
    socketAddress: string
    internal: boolean
    code?: string
    body: Record<string, unknown>
    cookies: Record<string, string | undefined>
    bootstrapEmail?: string
    store: IdentityStore
    workos: WorkosPort
    rateLimit: LoginLimiter
    automaticWorkosLinkingAllowed?: () => Promise<boolean>
    recordRecentAuthentication?: (userId: string) => Promise<SetCookie>
    /** Optional. Production writes a redacted audit row. Tests leave it unset. */
    noteAudit?: (note: {
        type: 'sign_in_success' | 'sign_in_failure' | 'lockout'
        userId: string | null
        method: 'local' | 'owner' | 'authkit'
    }) => Promise<void>
}

const INVALID_LOGIN = 'Invalid email or password.'
async function authenticationEpochCurrent(ctx: AuthContext): Promise<boolean> {
    if (ctx.authenticationEpoch === undefined) return true
    if (!ctx.dataSource) return true
    const { refreshAuthenticationState, selectedAuthenticationEpoch } =
        require('./authenticationState') as typeof import('./authenticationState')
    await refreshAuthenticationState(ctx.dataSource, true)
    return selectedAuthenticationEpoch() === ctx.authenticationEpoch
}

async function sealedSessionEpochCurrent(ctx: AuthContext, sealed: string): Promise<boolean> {
    if (ctx.authenticationEpoch === undefined) return true
    if (!(await authenticationEpochCurrent(ctx))) return false
    const { selectedAuthenticationBaselineEpoch } = require('./authenticationState') as typeof import('./authenticationState')
    if (!ctx.cookies[WOS_EPOCH_COOKIE]) {
        return Boolean(ctx.cookiePassword && ctx.authenticationEpoch === selectedAuthenticationBaselineEpoch())
    }
    return Boolean(
        ctx.cookiePassword && workosEpochCookieValid(ctx.cookies[WOS_EPOCH_COOKIE], sealed, ctx.authenticationEpoch, ctx.cookiePassword)
    )
}

function missingEpochCookie(ctx: AuthContext, sealed: string): SetCookie[] | undefined {
    if (ctx.cookies[WOS_EPOCH_COOKIE] || ctx.authenticationEpoch === undefined || !ctx.cookiePassword) return undefined
    return [workosEpochCookie(sealed, ctx.authenticationEpoch, ctx.cookiePassword, ctx.secure)]
}

function sealedCookies(ctx: AuthContext, sealed: string): SetCookie[] {
    const cookies = [sealedCookie(sealed, ctx.secure)]
    if (ctx.authenticationEpoch !== undefined && ctx.cookiePassword) {
        cookies.push(workosEpochCookie(sealed, ctx.authenticationEpoch, ctx.cookiePassword, ctx.secure))
    }
    return cookies
}
export function setupLinkNeeded(env: NodeJS.ProcessEnv = process.env): string {
    const service = setupServiceName(env)
    return `Open the setup link from the server log to create the first account. With Docker, run: docker compose logs ${service} | grep 'Setup code'`
}
export const SETUP_LINK_NEEDED = setupLinkNeeded()
/** Shown when the request included a setup code and that code did not match. */
export const SETUP_CODE_REJECTED = 'This setup code is not right. Copy it again from the server log.'
/** Shown when the code matched a row that is past its time. The replacement stays in the server log. */
export const SETUP_CODE_EXPIRED = SETUP_CODE_EXPIRED_MESSAGE
export const SETUP_TOO_MANY = 'Too many attempts. Try again later.'

function setupAttemptMessage(candidate: unknown): string {
    if (typeof candidate === 'string' && candidate.trim()) return SETUP_CODE_REJECTED
    return setupLinkNeeded()
}
export const TOO_MANY = 'Too many sign-in attempts. Try again later.'

async function accountId(ctx: AuthContext, email: string): Promise<string | null> {
    if (!ctx.noteAudit || !email) return null
    try {
        const matches = await ctx.store.findUsersByEmail(email)
        return matches.length === 1 ? matches[0].id : null
    } catch {
        return null
    }
}

async function noteSignIn(
    ctx: AuthContext,
    type: 'sign_in_success' | 'sign_in_failure' | 'lockout',
    userId: string | null,
    method: 'local' | 'owner' | 'authkit'
): Promise<void> {
    if (!ctx.noteAudit) return
    try {
        await ctx.noteAudit({ type, userId, method })
    } catch {
        // The sign-in result does not depend on the audit row.
    }
}

function textUnavailable(): HandlerResult {
    return { type: 'text', status: 503, body: unavailablePage() }
}

function json(
    status: number,
    body: unknown,
    extra: { cookies?: SetCookie[]; clearCookies?: string[]; secure?: boolean } = {}
): HandlerResult {
    return { type: 'json', status, body, cookies: extra.cookies, clearCookies: extra.clearCookies, secure: extra.secure }
}

/**
 * Secure follows the request, the same way the break-glass cookie does.
 * ctx.secure is the redirect URI scheme, or the request when that URI is unset.
 * A trusted proxy's scheme counts only when TRUST_PROXY says so.
 */
function localSessionSecure(ctx: AuthContext): boolean {
    return ctx.secure
}

/** Break-glass cookies are set and cleared with ctx.secure. localSessionSecure is only for a local-users cookie. */
function clearSecure(ctx: AuthContext, names: string[]): boolean {
    if (ctx.localUsers && names.includes(LOCAL_SESSION_COOKIE)) return localSessionSecure(ctx)
    return ctx.secure
}

function cleared(ctx: AuthContext, names: string[]): { clearCookies: string[]; secure: boolean } {
    return { clearCookies: names, secure: clearSecure(ctx, names) }
}

function bootstrapPage(reason: 'bootstrap-unset' | 'bootstrap-denied'): HandlerResult {
    const log =
        reason === 'bootstrap-unset'
            ? 'CUTTLELY_BOOTSTRAP_EMAIL is unset. Refusing to bootstrap the first user.'
            : 'Verified email did not match CUTTLELY_BOOTSTRAP_EMAIL. Refusing to bootstrap.'
    return {
        type: 'text',
        status: 403,
        log,
        body: '<p>First-user setup is not available.</p><p><a href="/signin">Return to sign in</a></p>'
    }
}

async function sessionAfterLogin(store: IdentityStore, userId: string, now: number): Promise<SessionUser | null> {
    const current = await store.sessionFor(userId)
    if (!current) return null
    await store.touchLastLogin(userId, current.activeWorkspaceId, new Date(now))
    return store.sessionFor(userId)
}

/**
 * `ok` keeps the session. `end` deletes every session for that user (disabled or no longer active).
 * `reject` drops this cookie. Break-glass (local admin, local users mode off) accepts only the owner.
 * A local session never becomes the owner by itself: the caller loads RBAC with sessionFor.
 */
function stalePermission(row: LocalSession): boolean {
    if (typeof row.permissionVersion !== 'number' || typeof row.currentPermissionVersion !== 'number') return false
    return row.permissionVersion !== row.currentPermissionVersion
}

async function localCookieGate(ctx: AuthContext, userId: string): Promise<'ok' | 'end' | 'reject'> {
    if (!ctx.localAdmin && !ctx.localUsers) return 'reject'
    const open = await ctx.store.localAccountOpen(userId)
    if (!open) return 'end'
    if (ctx.localUsers) return 'ok'
    const owner = await ctx.store.findSuperUser()
    if (!owner || owner.id !== userId) return 'reject'
    return 'ok'
}

/** A method switch can commit between the epoch check and the insert. Recheck after the insert and remove a session that missed the switch. */
async function sessionSurvivedSwitch(ctx: AuthContext, token: string): Promise<boolean> {
    if (await authenticationEpochCurrent(ctx)) return true
    await ctx.store.deleteLocalSession(hashSessionToken(token))
    return false
}

async function issueLocalSession(ctx: AuthContext, userId: string): Promise<{ token: string; session: SessionUser } | null> {
    if (!(await authenticationEpochCurrent(ctx))) return null
    const token = randomToken()
    const limits = sessionLimitsMs()
    const at = new Date(ctx.now)
    await ctx.store.insertLocalSession({
        id: randomUUID(),
        userId,
        token: hashSessionToken(token),
        idleExpires: new Date(ctx.now + limits.idleMs),
        absoluteExpires: new Date(ctx.now + limits.absoluteMs),
        issuedAt: at,
        lastSeenAt: at
    })
    if (!(await sessionSurvivedSwitch(ctx, token))) return null
    const session = await sessionAfterLogin(ctx.store, userId, ctx.now)
    if (!session) return null
    return { token, session }
}

function loginFields(body: Record<string, unknown>): { ok: true; email: string; password: string } | { ok: false; message: string } {
    const emailRaw = body.email
    const password = body.password
    if (typeof emailRaw !== 'string' || typeof password !== 'string') {
        return { ok: false, message: 'Email and password are required.' }
    }
    if (emailRaw.length > EMAIL_MAX_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
        return { ok: false, message: 'Email or password is too long.' }
    }
    const email = emailRaw.trim().toLowerCase()
    if (!email || !password) return { ok: false, message: 'Email and password are required.' }
    return { ok: true, email, password }
}

/** Compare-and-swap a migrated bcrypt hash to scrypt. A missed write still signs the person in. */
async function rehashBcryptAfterLogin(store: IdentityStore, userId: string, current: string | null, password: string): Promise<void> {
    if (!current || !isBcryptHash(current)) return
    try {
        await store.replaceCredential(userId, current, await hashPassword(password))
    } catch {
        // Best-effort: sign-in can proceed even if the rehash fails.
    }
}

export async function handleLoginGet(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.workosConfigured) return json(404, { message: 'Not Found' })
    if (!ctx.redirectUri) return textUnavailable()
    try {
        const url = ctx.workos.authorizationUrl(ctx.redirectUri)
        return { type: 'redirect', status: 302, url }
    } catch (error) {
        if (error instanceof WorkosUnavailableError) return textUnavailable()
        return textUnavailable()
    }
}

function inviteTokenFrom(ctx: AuthContext): string | undefined {
    const raw = ctx.cookies[INVITE_COOKIE]
    if (typeof raw !== 'string' || !raw || raw.length > INVITE_TOKEN_MAX_LENGTH) return undefined
    return raw
}

/**
 * Starts the AuthKit sign-in for an invite link. The token waits in a short-lived httpOnly cookie, never in a URL,
 * and the callback checks it. Starting does not use the token or reveal whether it is valid.
 */
export async function handleInviteStart(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.workosConfigured) return json(404, { message: 'Not Found' })
    if (!ctx.internal) return json(401, { message: 'Unauthorized' })
    const token = typeof ctx.body.token === 'string' ? ctx.body.token : ''
    if (!token || token.length > INVITE_TOKEN_MAX_LENGTH) return json(400, { message: INVITE_LINK_INVALID })
    return json(200, { url: '/api/v1/auth/login' }, { cookies: [inviteCookie(token, ctx.secure)] })
}

export async function handleCallback(ctx: AuthContext): Promise<HandlerResult> {
    const result = await callbackResult(ctx)
    if (ctx.cookies[INVITE_COOKIE] === undefined || result.type === 'next') return result
    return { ...result, cookies: [...(result.cookies || []), expiredInviteCookie(ctx.secure)] }
}

async function callbackResult(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.workosConfigured) return json(404, { message: 'Not Found' })
    if (!ctx.code) return json(400, { message: 'No code provided' })
    if (!ctx.cookiePasswordOk) return textUnavailable()
    try {
        const authenticated = await ctx.workos.authenticate(ctx.code)
        if (!(await authenticationEpochCurrent(ctx))) return { type: 'redirect', status: 302, url: '/signin' }
        const linked = await linkWorkosUser(ctx.store, authenticated.user, {
            bootstrapEmail: ctx.bootstrapEmail,
            inviteToken: inviteTokenFrom(ctx),
            now: ctx.now,
            automaticEmailLinking: ctx.automaticWorkosLinkingAllowed ? await ctx.automaticWorkosLinkingAllowed() : true
        })
        if (!linked.ok && (linked.reason === 'bootstrap-unset' || linked.reason === 'bootstrap-denied')) {
            return bootstrapPage(linked.reason)
        }
        if (!linked.ok) {
            await noteSignIn(ctx, 'sign_in_failure', null, 'authkit')
            return { type: 'redirect', status: 302, url: signinErrorUrl(linkFailureMessage(linked.reason)) }
        }
        try {
            await ctx.workos.setExternalId(authenticated.user.id, linked.user.id)
        } catch {
            // Optional. Sign-in still succeeds when WorkOS rejects the external id write.
        }
        const session = await sessionAfterLogin(ctx.store, linked.user.id, ctx.now)
        if (!session) {
            await noteSignIn(ctx, 'sign_in_failure', linked.user.id, 'authkit')
            return { type: 'redirect', status: 302, url: signinErrorUrl('No account exists for this email.') }
        }
        await noteSignIn(ctx, 'sign_in_success', linked.user.id, 'authkit')
        return {
            type: 'redirect',
            status: 302,
            url: '/',
            cookies: [
                ...sealedCookies(ctx, authenticated.sealedSession),
                ...(ctx.recordRecentAuthentication ? [await ctx.recordRecentAuthentication(linked.user.id)] : [])
            ],
            ...cleared(ctx, [LOCAL_SESSION_COOKIE])
        }
    } catch (error) {
        if (error instanceof WorkosUnavailableError) return textUnavailable()
        await noteSignIn(ctx, 'sign_in_failure', null, 'authkit')
        return { type: 'redirect', status: 302, url: signinErrorUrl('Sign-in could not be completed.') }
    }
}

export async function handleLoginPost(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.localAdmin) return json(404, { message: 'Not Found' })
    if (!ctx.internal) return json(401, { message: 'Unauthorized' })
    const email = typeof ctx.body.email === 'string' ? ctx.body.email.trim() : ''
    const password = typeof ctx.body.password === 'string' ? ctx.body.password : ''
    if (await ctx.rateLimit.blocked(ctx.ip, email, ctx.now)) {
        await noteSignIn(ctx, 'lockout', await accountId(ctx, email), 'owner')
        return json(429, { message: TOO_MANY })
    }

    const fail = async (): Promise<HandlerResult> => {
        await ctx.rateLimit.recordFailure(ctx.ip, email, ctx.now)
        const userId = await accountId(ctx, email)
        await noteSignIn(ctx, 'sign_in_failure', userId, 'owner')
        if (await ctx.rateLimit.blocked(ctx.ip, email, ctx.now)) await noteSignIn(ctx, 'lockout', userId, 'owner')
        return json(401, { message: INVALID_LOGIN })
    }
    if (!email || !password) return fail()

    const owner = await ctx.store.findSuperUser()
    const bcryptPresent = await ctx.store.hasBcryptCredential()
    if (!owner || owner.email.toLowerCase() !== email.toLowerCase()) {
        await verifyPassword(password, hashForLoginCompare(false, owner ? owner.credential : null, bcryptPresent), bcryptPresent)
        return fail()
    }
    if (!(await verifyPassword(password, hashForLoginCompare(true, owner.credential, bcryptPresent), bcryptPresent))) return fail()
    await rehashBcryptAfterLogin(ctx.store, owner.id, owner.credential, password)

    if (!(await authenticationEpochCurrent(ctx))) return json(409, { message: 'Sign-in settings changed. Sign in again.' })
    const token = randomToken()
    const limits = sessionLimitsMs()
    const at = new Date(ctx.now)
    await ctx.store.insertLocalSession({
        id: randomUUID(),
        userId: owner.id,
        token: hashSessionToken(token),
        idleExpires: new Date(ctx.now + limits.idleMs),
        absoluteExpires: new Date(ctx.now + limits.absoluteMs),
        issuedAt: at,
        lastSeenAt: at
    })
    if (!(await sessionSurvivedSwitch(ctx, token))) return json(409, { message: 'Sign-in settings changed. Sign in again.' })
    const session = await sessionAfterLogin(ctx.store, owner.id, ctx.now)
    if (!session) {
        await noteSignIn(ctx, 'sign_in_failure', owner.id, 'owner')
        return json(401, { message: INVALID_LOGIN })
    }
    await noteSignIn(ctx, 'sign_in_success', owner.id, 'owner')
    return json(200, session, {
        cookies: [localCookie(token, ctx.secure, sessionLimitsMs().idleMs)],
        ...cleared(ctx, [WOS_SESSION_COOKIE, WOS_EPOCH_COOKIE])
    })
}

export async function handleRefresh(ctx: AuthContext): Promise<HandlerResult> {
    const sealed = ctx.cookies[WOS_SESSION_COOKIE]
    if (sealed && ctx.workosConfigured) {
        if (!(await sealedSessionEpochCurrent(ctx, sealed)))
            return json(401, { message: 'Token Expired' }, cleared(ctx, [WOS_SESSION_COOKIE, WOS_EPOCH_COOKIE]))
        if (!ctx.cookiePasswordOk) return json(401, { message: 'Token Expired' }, cleared(ctx, [WOS_SESSION_COOKIE]))
        try {
            const refreshed = await ctx.workos.refresh(sealed)
            if (!refreshed.authenticated || !refreshed.sealedSession) {
                const message =
                    refreshed.authenticated === false && refreshed.reason === 'invalid_grant' ? 'Refresh Token Expired' : 'Token Expired'
                return json(401, { message }, cleared(ctx, [WOS_SESSION_COOKIE]))
            }
            const row = await ctx.store.findUserByExternalId(refreshed.user.id)
            if (!row || !isActiveStatus(row.status)) {
                return json(401, { message: 'Token Expired' }, cleared(ctx, [WOS_SESSION_COOKIE]))
            }
            if (await enforceAuthKit(ctx, refreshed.sessionId, row.id)) {
                return json(401, { message: 'Token Expired' }, cleared(ctx, [WOS_SESSION_COOKIE]))
            }
            const session = await ctx.store.sessionFor(row.id)
            if (!session) return json(401, { message: 'Token Expired' }, cleared(ctx, [WOS_SESSION_COOKIE]))
            return json(200, session, { cookies: sealedCookies(ctx, refreshed.sealedSession) })
        } catch (error) {
            if (error instanceof WorkosUnavailableError) {
                return json(401, { message: 'Token Expired' }, cleared(ctx, [WOS_SESSION_COOKIE]))
            }
            return json(401, { message: 'Token Expired' }, cleared(ctx, [WOS_SESSION_COOKIE]))
        }
    }

    const token = ctx.cookies[LOCAL_SESSION_COOKIE]
    if (token && (ctx.localAdmin || ctx.localUsers)) {
        const digest = hashSessionToken(token)
        const row = await ctx.store.findLocalSession(digest)
        if (!row || !tokensEqual(row.token, digest)) {
            return json(401, { message: 'Token Expired' }, cleared(ctx, [LOCAL_SESSION_COOKIE]))
        }
        const ended = localSessionBlock(row, ctx.now)
        if (ended) {
            await ctx.store.deleteLocalSession(digest)
            return json(
                401,
                { message: ended === 'absolute' ? 'Refresh Token Expired' : 'Token Expired' },
                cleared(ctx, [LOCAL_SESSION_COOKIE])
            )
        }
        if (stalePermission(row)) {
            await ctx.store.deleteLocalSessionsForUser(row.userId)
            return json(401, { message: 'Token Expired' }, cleared(ctx, [LOCAL_SESSION_COOKIE]))
        }
        const gate = await localCookieGate(ctx, row.userId)
        if (gate === 'end') {
            await ctx.store.deleteLocalSessionsForUser(row.userId)
            return json(401, { message: 'Token Expired' }, cleared(ctx, [LOCAL_SESSION_COOKIE]))
        }
        if (gate !== 'ok') return json(401, { message: 'Token Expired' }, cleared(ctx, [LOCAL_SESSION_COOKIE]))
        const limits = sessionLimitsMs()
        const times = localSessionTimes(row)
        const idleExpires = new Date(Math.min(ctx.now + limits.idleMs, times.issuedAt + limits.absoluteMs))
        await ctx.store.slideLocalSession(digest, idleExpires, new Date(ctx.now))
        const session = await ctx.store.sessionFor(row.userId)
        if (!session) return json(401, { message: 'Token Expired' }, cleared(ctx, [LOCAL_SESSION_COOKIE]))
        const secure = ctx.localUsers ? localSessionSecure(ctx) : ctx.secure
        return json(200, session, { cookies: [localCookie(token, secure, idleExpires.getTime() - ctx.now)] })
    }

    return json(401, { message: 'Token Expired' })
}

export async function handleLogout(ctx: AuthContext): Promise<HandlerResult> {
    const sealed = ctx.cookies[WOS_SESSION_COOKIE]
    const localToken = ctx.cookies[LOCAL_SESSION_COOKIE]
    if (sealed && ctx.workosConfigured) {
        if (!ctx.internal) return json(401, { message: 'Unauthorized' })
        let redirectTo = signOutReturnTo(ctx.redirectUri) || '/signin'
        if (ctx.cookiePasswordOk) {
            const returnTo = signOutReturnTo(ctx.redirectUri)
            try {
                redirectTo = await ctx.workos.logoutUrl(sealed, returnTo)
            } catch (error) {
                if (!(error instanceof WorkosUnavailableError)) {
                    try {
                        const refreshed = await ctx.workos.refresh(sealed)
                        if (refreshed.authenticated) redirectTo = await ctx.workos.logoutUrl(refreshed.sealedSession, returnTo)
                    } catch {
                        redirectTo = returnTo || '/signin'
                    }
                }
            }
        }
        if (localToken) await ctx.store.deleteLocalSession(hashSessionToken(localToken))
        return json(200, { message: 'logged_out', redirectTo }, cleared(ctx, [WOS_SESSION_COOKIE, WOS_EPOCH_COOKIE, LOCAL_SESSION_COOKIE]))
    }

    if (localToken) {
        if (!ctx.internal) return json(401, { message: 'Unauthorized' })
        await ctx.store.deleteLocalSession(hashSessionToken(localToken))
        return json(
            200,
            { message: 'logged_out', redirectTo: '/signin' },
            cleared(ctx, [LOCAL_SESSION_COOKIE, WOS_SESSION_COOKIE, WOS_EPOCH_COOKIE])
        )
    }
    return json(
        200,
        { message: 'logged_out', redirectTo: '/signin' },
        cleared(ctx, [LOCAL_SESSION_COOKIE, WOS_SESSION_COOKIE, WOS_EPOCH_COOKIE])
    )
}

export async function handleResolve(ctx: AuthContext): Promise<HandlerResult> {
    const count = await ctx.store.countUsers()
    // No account yet, and AuthKit is not the way in: one setup page, whether or not the password form is on.
    if (count === 0 && !ctx.workosConfigured) return json(200, { redirectUrl: '/setup' })
    if (!ctx.workosConfigured && !ctx.localAdmin) return json(404, { message: 'Not Found' })
    return json(200, { redirectUrl: '/signin' })
}

export async function handleRegister(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.localAdmin) return json(404, { message: 'Not Found' })
    if (!ctx.internal) return json(401, { message: 'Unauthorized' })
    if ((await ctx.store.countUsers()) > 0) return json(404, { message: 'Not Found' })
    const address = ctx.socketAddress || 'unknown'
    const user = ctx.body.user
    if (!user || typeof user !== 'object') return json(400, { message: 'Name, email, and password are required.' })
    const record = user as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const email = typeof record.email === 'string' ? record.email.trim() : ''
    const credential = typeof record.credential === 'string' ? record.credential : ''
    if (!name || name.length > 100 || !email || !credential) return json(400, { message: 'Name, email, and password are required.' })
    const errors = passwordErrors(credential)
    if (errors.length) return json(400, { message: errors[0] })
    // The one-time code from the setup link is required before the password is hashed. Loopback is not a shortcut.
    const hmac = setupCodeHmac(ctx.body.setupCode)
    const verdict = await setupCodeVerdict(ctx.body.setupCode, ctx.now)
    if (!hmac || verdict !== 'match') {
        await reissueExpiredSetupCode(ctx.now)
        // Expired and not-right misses share this cap. An expired code is not a separate allowance.
        if (noteSetupFailure(address, ctx.now).limited) return json(429, { message: SETUP_TOO_MANY })
        if (verdict === 'expired') return json(400, { code: 'CODE_EXPIRED', reason: 'expired', message: SETUP_CODE_EXPIRED })
        return json(400, { message: setupAttemptMessage(ctx.body.setupCode) })
    }
    try {
        const created = await ctx.store.createOwner(
            {
                email,
                name,
                credential: await hashPassword(credential),
                externalId: null
            },
            { consumeSetupHmac: hmac, now: ctx.now }
        )
        // The same session cookie as a password sign-in, in this response, so the browser is already signed in.
        const issued = await issueLocalSession(ctx, created.id)
        const body = { message: 'Account created', id: created.id, ...(issued?.session ?? {}) }
        if (!issued) return json(200, body)
        return json(200, body, { cookies: [localCookie(issued.token, ctx.secure, sessionLimitsMs().idleMs)] })
    } catch (error) {
        if (error instanceof NotEmptyError) return json(404, { message: 'Not Found' })
        if (error instanceof SetupCodeRejected) {
            if (noteSetupFailure(address, ctx.now).limited) return json(429, { message: SETUP_TOO_MANY })
            return json(400, { message: setupAttemptMessage(ctx.body.setupCode) })
        }
        throw error
    }
}

/** Password recovery is AuthKit, or `pnpm user` for the break-glass owner. These posts do not fall through. */
export async function handlePasswordRecoveryGone(): Promise<HandlerResult> {
    return json(404, { message: 'Not Found' })
}

/** Fixed id for a sign-in that does not match one open user. It matches no session row. */
export const UNKNOWN_LOCAL_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000'

/**
 * Password sign-in for any active local user who already has a password.
 * 404 unless local users mode is on. Break-glass stays on POST /api/v1/auth/login.
 * Unknown email, a wrong password, a null credential, and a disabled user share one 401 body.
 */
export async function handleLocalLogin(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.localUsers) return json(404, { message: 'Not Found' })
    if (!ctx.internal) return json(401, { message: INVALID_LOGIN })
    const fields = loginFields(ctx.body)
    if (!fields.ok) return json(400, { message: fields.message })
    if (await ctx.rateLimit.blocked(ctx.ip, fields.email, ctx.now)) {
        await noteSignIn(ctx, 'lockout', await accountId(ctx, fields.email), 'local')
        return json(429, { message: TOO_MANY })
    }

    const matches = await ctx.store.findUsersByEmail(fields.email)
    const user = matches.length === 1 ? matches[0] : null
    const open = await ctx.store.localAccountOpen(user ? user.id : UNKNOWN_LOCAL_ACCOUNT_ID)
    const eligible = Boolean(user && open && user.credential)
    const bcryptPresent = await ctx.store.hasBcryptCredential()
    const passwordOk = await verifyPassword(
        fields.password,
        hashForLoginCompare(eligible, user ? user.credential : null, bcryptPresent),
        bcryptPresent
    )
    if (!user || !eligible || !passwordOk) {
        await ctx.store.deleteLocalSessionsForUser(user && !open ? user.id : UNKNOWN_LOCAL_ACCOUNT_ID)
        await ctx.rateLimit.recordFailure(ctx.ip, fields.email, ctx.now)
        const userId = user && matches.length === 1 ? user.id : null
        await noteSignIn(ctx, 'sign_in_failure', userId, 'local')
        if (await ctx.rateLimit.blocked(ctx.ip, fields.email, ctx.now)) await noteSignIn(ctx, 'lockout', userId, 'local')
        return json(401, { message: INVALID_LOGIN })
    }
    await rehashBcryptAfterLogin(ctx.store, user.id, user.credential, fields.password)

    const issued = await issueLocalSession(ctx, user.id)
    if (!issued) {
        await noteSignIn(ctx, 'sign_in_failure', user.id, 'local')
        return json(401, { message: INVALID_LOGIN })
    }
    await noteSignIn(ctx, 'sign_in_success', user.id, 'local')
    return json(200, issued.session, {
        cookies: [localCookie(issued.token, localSessionSecure(ctx), sessionLimitsMs().idleMs)],
        ...cleared(ctx, [WOS_SESSION_COOKIE])
    })
}

/** Clears this browser's local session. Repeating it returns the same success. CSRF is required. */
export async function handleLocalLogout(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.localUsers) return json(404, { message: 'Not Found' })
    if (!ctx.internal) return json(401, { message: 'Unauthorized' })
    const token = ctx.cookies[LOCAL_SESSION_COOKIE]
    if (token) await ctx.store.deleteLocalSession(hashSessionToken(token))
    return json(200, { message: 'logged_out', redirectTo: '/signin' }, cleared(ctx, [LOCAL_SESSION_COOKIE, WOS_SESSION_COOKIE]))
}

/**
 * Changes the signed-in user's own password. There is no field for another user's id.
 * The current password is required. Other sessions end and this browser receives a new cookie.
 */
export async function handleLocalPassword(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.localUsers) return json(404, { message: 'Not Found' })
    if (!ctx.internal) return json(401, { message: 'Unauthorized' })
    const token = ctx.cookies[LOCAL_SESSION_COOKIE]
    if (!token) return json(401, { message: 'Unauthorized' })
    const digest = hashSessionToken(token)
    const row = await ctx.store.findLocalSession(digest)
    if (!row || !tokensEqual(row.token, digest)) return json(401, { message: 'Unauthorized' })
    if (localSessionBlock(row, ctx.now)) {
        await ctx.store.deleteLocalSession(digest)
        return json(401, { message: 'Unauthorized' })
    }
    const gate = await localCookieGate(ctx, row.userId)
    if (gate === 'end') {
        await ctx.store.deleteLocalSessionsForUser(row.userId)
        return json(401, { message: 'Unauthorized' })
    }
    if (gate !== 'ok') return json(401, { message: 'Unauthorized' })

    const currentRaw = ctx.body.currentPassword
    const nextRaw = ctx.body.newPassword
    if (typeof currentRaw !== 'string' || typeof nextRaw !== 'string') {
        return json(400, { message: 'Current password and new password are required.' })
    }
    if (currentRaw.length > PASSWORD_MAX_LENGTH || nextRaw.length > PASSWORD_MAX_LENGTH) {
        return json(400, { message: 'Password is too long.' })
    }
    if (!currentRaw || !nextRaw) return json(400, { message: 'Current password and new password are required.' })
    const errors = passwordErrors(nextRaw)
    if (errors.length) return json(400, { message: errors[0] })
    if (nextRaw === currentRaw) return json(400, { message: 'New password must be different.' })

    const account = await accountForSession(ctx, row.userId)
    if (await ctx.rateLimit.blocked(ctx.ip, account.email, ctx.now)) {
        await noteSignIn(ctx, 'lockout', row.userId, 'local')
        return json(429, { message: TOO_MANY })
    }
    const eligible = Boolean(account.credential)
    const currentOk = await verifyPassword(currentRaw, hashForLoginCompare(eligible, account.credential))
    if (!eligible || !currentOk) {
        await ctx.rateLimit.recordFailure(ctx.ip, account.email, ctx.now)
        if (await ctx.rateLimit.blocked(ctx.ip, account.email, ctx.now)) await noteSignIn(ctx, 'lockout', row.userId, 'local')
        return json(401, { message: INVALID_LOGIN })
    }

    await ctx.store.setCredential(row.userId, await hashPassword(nextRaw))
    await ctx.store.deleteLocalSessionsForUser(row.userId)
    const issued = await issueLocalSession(ctx, row.userId)
    if (!issued) return json(401, { message: INVALID_LOGIN })
    return json(200, issued.session, {
        cookies: [localCookie(issued.token, localSessionSecure(ctx), sessionLimitsMs().idleMs)],
        ...cleared(ctx, [WOS_SESSION_COOKIE])
    })
}

/** Email used for lockout. Empty when the row is gone, so no new account key is stored. */
async function accountForSession(ctx: AuthContext, userId: string): Promise<{ email: string; credential: string | null }> {
    const session = await ctx.store.sessionFor(userId)
    if (!session) return { email: '', credential: null }
    const matches = await ctx.store.findUsersByEmail(session.email)
    const user = matches.find((row) => row.id === userId) || null
    if (!user) return { email: '', credential: null }
    return { email: user.email.trim().toLowerCase(), credential: user.credential }
}

export async function establishSession(
    ctx: AuthContext
): Promise<{ user: SessionUser | null; cookies?: SetCookie[]; clearCookies?: string[]; secure?: boolean }> {
    const sealed = ctx.cookies[WOS_SESSION_COOKIE]
    if (sealed && ctx.workosConfigured && ctx.cookiePasswordOk) {
        if (!(await sealedSessionEpochCurrent(ctx, sealed))) {
            return { user: null, clearCookies: [WOS_SESSION_COOKIE, WOS_EPOCH_COOKIE], secure: ctx.secure }
        }
        try {
            const authenticated = await ctx.workos.authenticateSession(sealed)
            if (authenticated.authenticated) {
                const row = await ctx.store.findUserByExternalId(authenticated.user.id)
                if (row && isActiveStatus(row.status)) {
                    if (await enforceAuthKit(ctx, authenticated.sessionId, row.id)) {
                        return { user: null, clearCookies: [WOS_SESSION_COOKIE], secure: ctx.secure }
                    }
                    const user = await ctx.store.sessionFor(row.id)
                    return { user, cookies: user ? missingEpochCookie(ctx, sealed) : undefined }
                }
                return { user: null, clearCookies: [WOS_SESSION_COOKIE], secure: ctx.secure }
            }
            if (authenticated.reason === 'no_session_cookie_provided') return { user: null }
            const refreshed = await ctx.workos.refresh(sealed)
            if (!refreshed.authenticated) return { user: null, clearCookies: [WOS_SESSION_COOKIE], secure: ctx.secure }
            const row = await ctx.store.findUserByExternalId(refreshed.user.id)
            if (!row || !isActiveStatus(row.status)) return { user: null, clearCookies: [WOS_SESSION_COOKIE], secure: ctx.secure }
            if (await enforceAuthKit(ctx, refreshed.sessionId, row.id)) {
                return { user: null, clearCookies: [WOS_SESSION_COOKIE], secure: ctx.secure }
            }
            const user = await ctx.store.sessionFor(row.id)
            return {
                user,
                cookies: user ? sealedCookies(ctx, refreshed.sealedSession) : undefined,
                clearCookies: user ? undefined : [WOS_SESSION_COOKIE],
                secure: ctx.secure
            }
        } catch (error) {
            if (error instanceof WorkosUnavailableError) return { user: null, clearCookies: [WOS_SESSION_COOKIE], secure: ctx.secure }
            return { user: null, clearCookies: [WOS_SESSION_COOKIE], secure: ctx.secure }
        }
    }

    const token = ctx.cookies[LOCAL_SESSION_COOKIE]
    if (token && (ctx.localAdmin || ctx.localUsers)) {
        const digest = hashSessionToken(token)
        const row = await ctx.store.findLocalSession(digest)
        if (!row || !tokensEqual(row.token, digest))
            return { user: null, clearCookies: [LOCAL_SESSION_COOKIE], secure: clearSecure(ctx, [LOCAL_SESSION_COOKIE]) }
        if (localSessionBlock(row, ctx.now)) {
            await ctx.store.deleteLocalSession(digest)
            return { user: null, clearCookies: [LOCAL_SESSION_COOKIE], secure: clearSecure(ctx, [LOCAL_SESSION_COOKIE]) }
        }
        if (stalePermission(row)) {
            await ctx.store.deleteLocalSessionsForUser(row.userId)
            return { user: null, clearCookies: [LOCAL_SESSION_COOKIE], secure: clearSecure(ctx, [LOCAL_SESSION_COOKIE]) }
        }
        const gate = await localCookieGate(ctx, row.userId)
        if (gate === 'end') {
            await ctx.store.deleteLocalSessionsForUser(row.userId)
            return { user: null, clearCookies: [LOCAL_SESSION_COOKIE], secure: clearSecure(ctx, [LOCAL_SESSION_COOKIE]) }
        }
        if (gate !== 'ok') return { user: null, clearCookies: [LOCAL_SESSION_COOKIE], secure: clearSecure(ctx, [LOCAL_SESSION_COOKIE]) }
        const maxAge = await noteSessionUse(ctx, row, digest)
        const user = await ctx.store.sessionFor(row.userId)
        const secure = ctx.localUsers ? localSessionSecure(ctx) : ctx.secure
        return { user, secure, cookies: maxAge === null ? undefined : [localCookie(token, secure, maxAge)] }
    }
    return { user: null }
}

/**
 * Writes lastSeenAt when the session has been quiet for at least a minute.
 * Returns the cookie lifetime to send, or null when the browser cookie can stay as it is.
 */
async function noteSessionUse(ctx: AuthContext, row: LocalSession, token: string): Promise<number | null> {
    const times = localSessionTimes(row)
    if (ctx.now - times.lastSeenAt < SEEN_EVERY_MS) return null
    const limits = sessionLimitsMs()
    const seen = new Date(ctx.now)
    const idleExpires = new Date(Math.min(ctx.now + limits.idleMs, times.issuedAt + limits.absoluteMs))
    await ctx.store.slideLocalSession(token, idleExpires, seen)
    row.lastSeenAt = seen
    row.idleExpires = idleExpires
    return Math.max(0, idleExpires.getTime() - ctx.now)
}

const SESSION_TOMBSTONE = new Date(0)

function sessionTombstone(row: LocalSession): boolean {
    return row.idleExpires.getTime() === 0 || row.lastSeenAt?.getTime() === 0
}

function duplicateSession(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /UNIQUE constraint failed|duplicate key|ER_DUP_ENTRY|23505/i.test(message)
}

const warnedMissingAuthKitSession = new Set<string>()

/**
 * WorkOS session id when AuthKit sent one. Otherwise this server's own key for that account,
 * so a response without a session id still has an idle and absolute clock. Logged once per account.
 */
function authKitKey(sessionId: string | undefined, userId: string): string {
    if (sessionId) return sessionId
    if (!warnedMissingAuthKitSession.has(userId)) {
        warnedMissingAuthKitSession.add(userId)
        console.warn("[server]: AuthKit session has no session id, so idle and absolute limits use this server's record for that account")
    }
    return `authkit-user:${userId}`
}

async function enforceAuthKit(ctx: AuthContext, sessionId: string | undefined, userId: string): Promise<'idle' | 'absolute' | null> {
    return authKitActivity(ctx, authKitKey(sessionId, userId), userId)
}

/**
 * Idle and absolute limits for an AuthKit session. The WorkOS session id is stable across access-token refreshes.
 * The first request this server sees starts the clock. Activity is stored with the local session rows, keyed by that id.
 */
async function authKitActivity(ctx: AuthContext, sessionId: string, userId: string): Promise<'idle' | 'absolute' | null> {
    const token = hashSessionToken(sessionId)
    let existing = await ctx.store.findLocalSession(token)
    if (!existing) {
        const limits = sessionLimitsMs()
        const at = new Date(ctx.now)
        try {
            await ctx.store.insertLocalSession({
                id: randomUUID(),
                userId,
                token,
                idleExpires: new Date(ctx.now + limits.idleMs),
                absoluteExpires: new Date(ctx.now + limits.absoluteMs),
                issuedAt: at,
                lastSeenAt: at
            })
        } catch (error) {
            if (!duplicateSession(error)) throw error
        }
        existing = await ctx.store.findLocalSession(token)
        if (!existing) return 'idle'
    }
    if (sessionTombstone(existing)) return 'idle'
    const ended = localSessionBlock(existing, ctx.now)
    if (ended) {
        await ctx.store.slideLocalSession(token, SESSION_TOMBSTONE, SESSION_TOMBSTONE)
        existing.lastSeenAt = SESSION_TOMBSTONE
        existing.idleExpires = SESSION_TOMBSTONE
        return ended
    }
    await noteSessionUse(ctx, existing, token)
    return null
}
