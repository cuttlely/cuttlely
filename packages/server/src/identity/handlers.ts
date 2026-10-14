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
import { localCookie, sealedCookie } from './cookies'
import {
    ABSOLUTE_MS,
    EMAIL_MAX_LENGTH,
    IDLE_MS,
    LOCAL_SESSION_COOKIE,
    PASSWORD_MAX_LENGTH,
    WOS_SESSION_COOKIE,
    signOutReturnTo,
    signinErrorUrl,
    unavailablePage
} from './constants'
import { isActiveStatus, linkFailureMessage, linkWorkosUser } from './link'
import { hashForLoginCompare, hashPassword, hashSessionToken, passwordErrors, randomToken, tokensEqual, verifyPassword } from './password'
import { LoginLimiter } from './rateLimit'
import { isLoopbackAddress } from './sessionGuard'
import { setupCodeMatches } from './setupCode'
import { IdentityStore } from './store'
import { HandlerResult, SessionUser, SetCookie, WorkosPort, WorkosUnavailableError } from './types'

export interface AuthContext {
    workosConfigured: boolean
    localAdmin: boolean
    /** CUTTLELY_LOCAL_USERS is on and AuthKit is not configured. */
    localUsers: boolean
    cookiePasswordOk: boolean
    redirectUri?: string
    secure: boolean
    now: number
    ip: string
    internal: boolean
    code?: string
    body: Record<string, unknown>
    cookies: Record<string, string | undefined>
    bootstrapEmail?: string
    store: IdentityStore
    workos: WorkosPort
    rateLimit: LoginLimiter
}

const INVALID_LOGIN = 'Invalid email or password.'
export const SETUP_LINK_NEEDED =
    'Open the setup link from the server log to create the first account. With Docker, run: docker compose logs cuttlely'
const TOO_MANY = 'Too many sign-in attempts. Try again later.'

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

function cleared(ctx: AuthContext, names: string[]): { clearCookies: string[]; secure: boolean } {
    return { clearCookies: names, secure: ctx.secure }
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

/** Secure in production even when the request itself is not https. Other cookie flags stay as they are. */
function localSessionSecure(ctx: AuthContext): boolean {
    return ctx.secure || process.env.NODE_ENV === 'production'
}

/**
 * `ok` keeps the session. `end` deletes every session for that user (disabled or no longer active).
 * `reject` drops this cookie. Break-glass (local admin, local users mode off) accepts only the owner.
 * A local session never becomes the owner by itself: the caller loads RBAC with sessionFor.
 */
async function localCookieGate(ctx: AuthContext, userId: string): Promise<'ok' | 'end' | 'reject'> {
    if (!ctx.localAdmin && !ctx.localUsers) return 'reject'
    const open = await ctx.store.localAccountOpen(userId)
    if (!open) return 'end'
    if (ctx.localUsers) return 'ok'
    const owner = await ctx.store.findSuperUser()
    if (!owner || owner.id !== userId) return 'reject'
    return 'ok'
}

async function issueLocalSession(ctx: AuthContext, userId: string): Promise<{ token: string; session: SessionUser } | null> {
    const token = randomToken()
    await ctx.store.insertLocalSession({
        id: randomUUID(),
        userId,
        token: hashSessionToken(token),
        idleExpires: new Date(ctx.now + IDLE_MS),
        absoluteExpires: new Date(ctx.now + ABSOLUTE_MS)
    })
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

export async function handleCallback(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.workosConfigured) return json(404, { message: 'Not Found' })
    if (!ctx.code) return json(400, { message: 'No code provided' })
    if (!ctx.cookiePasswordOk) return textUnavailable()
    try {
        const authenticated = await ctx.workos.authenticate(ctx.code)
        const linked = await linkWorkosUser(ctx.store, authenticated.user, { bootstrapEmail: ctx.bootstrapEmail })
        if (!linked.ok && (linked.reason === 'bootstrap-unset' || linked.reason === 'bootstrap-denied')) {
            return bootstrapPage(linked.reason)
        }
        if (!linked.ok) {
            return { type: 'redirect', status: 302, url: signinErrorUrl(linkFailureMessage(linked.reason)) }
        }
        try {
            await ctx.workos.setExternalId(authenticated.user.id, linked.user.id)
        } catch {
            // Optional. Sign-in still succeeds when WorkOS rejects the external id write.
        }
        const session = await sessionAfterLogin(ctx.store, linked.user.id, ctx.now)
        if (!session) return { type: 'redirect', status: 302, url: signinErrorUrl('No account exists for this email.') }
        return {
            type: 'redirect',
            status: 302,
            url: '/',
            cookies: [sealedCookie(authenticated.sealedSession, ctx.secure)],
            ...cleared(ctx, [LOCAL_SESSION_COOKIE])
        }
    } catch (error) {
        if (error instanceof WorkosUnavailableError) return textUnavailable()
        return { type: 'redirect', status: 302, url: signinErrorUrl('Sign-in could not be completed.') }
    }
}

export async function handleLoginPost(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.localAdmin) return json(404, { message: 'Not Found' })
    if (!ctx.internal) return json(401, { message: 'Unauthorized' })
    const email = typeof ctx.body.email === 'string' ? ctx.body.email.trim() : ''
    const password = typeof ctx.body.password === 'string' ? ctx.body.password : ''
    if (await ctx.rateLimit.blocked(ctx.ip, email, ctx.now)) return json(429, { message: TOO_MANY })

    const fail = async (): Promise<HandlerResult> => {
        await ctx.rateLimit.recordFailure(ctx.ip, email, ctx.now)
        return json(401, { message: INVALID_LOGIN })
    }
    if (!email || !password) return fail()

    const owner = await ctx.store.findSuperUser()
    if (!owner || owner.email.toLowerCase() !== email.toLowerCase()) return fail()
    if (!(await verifyPassword(password, owner.credential))) return fail()

    const token = randomToken()
    await ctx.store.insertLocalSession({
        id: randomUUID(),
        userId: owner.id,
        token: hashSessionToken(token),
        idleExpires: new Date(ctx.now + IDLE_MS),
        absoluteExpires: new Date(ctx.now + ABSOLUTE_MS)
    })
    const session = await sessionAfterLogin(ctx.store, owner.id, ctx.now)
    if (!session) return json(401, { message: INVALID_LOGIN })
    return json(200, session, {
        cookies: [localCookie(token, ctx.secure, IDLE_MS)],
        ...cleared(ctx, [WOS_SESSION_COOKIE])
    })
}

export async function handleRefresh(ctx: AuthContext): Promise<HandlerResult> {
    const sealed = ctx.cookies[WOS_SESSION_COOKIE]
    if (sealed && ctx.workosConfigured) {
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
            const session = await ctx.store.sessionFor(row.id)
            if (!session) return json(401, { message: 'Token Expired' }, cleared(ctx, [WOS_SESSION_COOKIE]))
            return json(200, session, { cookies: [sealedCookie(refreshed.sealedSession, ctx.secure)] })
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
        if (ctx.now >= row.absoluteExpires.getTime()) {
            await ctx.store.deleteLocalSession(digest)
            return json(401, { message: 'Refresh Token Expired' }, cleared(ctx, [LOCAL_SESSION_COOKIE]))
        }
        if (ctx.now >= row.idleExpires.getTime()) {
            await ctx.store.deleteLocalSession(digest)
            return json(401, { message: 'Token Expired' }, cleared(ctx, [LOCAL_SESSION_COOKIE]))
        }
        const gate = await localCookieGate(ctx, row.userId)
        if (gate === 'end') {
            await ctx.store.deleteLocalSessionsForUser(row.userId)
            return json(401, { message: 'Token Expired' }, cleared(ctx, [LOCAL_SESSION_COOKIE]))
        }
        if (gate !== 'ok') return json(401, { message: 'Token Expired' }, cleared(ctx, [LOCAL_SESSION_COOKIE]))
        const idleExpires = new Date(Math.min(ctx.now + IDLE_MS, row.absoluteExpires.getTime()))
        await ctx.store.slideLocalSession(digest, idleExpires)
        const session = await ctx.store.sessionFor(row.userId)
        if (!session) return json(401, { message: 'Token Expired' }, cleared(ctx, [LOCAL_SESSION_COOKIE]))
        const secure = ctx.localUsers ? localSessionSecure(ctx) : ctx.secure
        return json(200, session, { cookies: [localCookie(token, secure, idleExpires.getTime() - ctx.now)] })
    }

    return json(401, { message: 'Token Expired' })
}

export async function handleLogout(ctx: AuthContext): Promise<HandlerResult> {
    const sealed = ctx.cookies[WOS_SESSION_COOKIE]
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
        return json(200, { message: 'logged_out', redirectTo }, cleared(ctx, [WOS_SESSION_COOKIE, LOCAL_SESSION_COOKIE]))
    }

    const token = ctx.cookies[LOCAL_SESSION_COOKIE]
    if (token && ctx.localAdmin) {
        if (!ctx.internal) return json(401, { message: 'Unauthorized' })
        await ctx.store.deleteLocalSession(hashSessionToken(token))
        return json(200, { message: 'logged_out', redirectTo: '/signin' }, cleared(ctx, [LOCAL_SESSION_COOKIE, WOS_SESSION_COOKIE]))
    }
    return json(200, { message: 'logged_out', redirectTo: '/signin' }, cleared(ctx, [LOCAL_SESSION_COOKIE, WOS_SESSION_COOKIE]))
}

export async function handleResolve(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.workosConfigured && !ctx.localAdmin) return json(404, { message: 'Not Found' })
    const count = await ctx.store.countUsers()
    if (count === 0 && ctx.workosConfigured) return json(200, { redirectUrl: '/signin' })
    if (count === 0 && ctx.localAdmin) return json(200, { redirectUrl: '/organization-setup' })
    return json(200, { redirectUrl: '/signin' })
}

export async function handleRegister(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.localAdmin) return json(404, { message: 'Not Found' })
    if ((await ctx.store.countUsers()) > 0) return json(404, { message: 'Not Found' })
    // The setup form on this machine is loopback. Anything else, such as Docker's published port, needs the one-time
    // code from the setup link the server prints in its log.
    if (!isLoopbackAddress(ctx.ip) && !setupCodeMatches(ctx.body.setupCode)) return json(400, { message: SETUP_LINK_NEEDED })
    const user = ctx.body.user
    if (!user || typeof user !== 'object') return json(400, { message: 'Name, email, and password are required.' })
    const record = user as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const email = typeof record.email === 'string' ? record.email.trim() : ''
    const credential = typeof record.credential === 'string' ? record.credential : ''
    if (!name || name.length > 100 || !email || !credential) return json(400, { message: 'Name, email, and password are required.' })
    const errors = passwordErrors(credential)
    if (errors.length) return json(400, { message: errors[0] })
    const created = await ctx.store.createOwner({
        email,
        name,
        credential: await hashPassword(credential),
        externalId: null
    })
    return json(200, { message: 'Account created', id: created.id })
}

/** Password recovery is AuthKit, or `pnpm user` for the break-glass owner. These posts do not fall through. */
export async function handlePasswordRecoveryGone(): Promise<HandlerResult> {
    return json(404, { message: 'Not Found' })
}

/**
 * Password sign-in for any active local user who already has a password.
 * 404 unless local users mode is on. Break-glass stays on POST /api/v1/auth/login.
 * Unknown email, a wrong password, a null credential, and a disabled user share one 401 body.
 */
export async function handleLocalLogin(ctx: AuthContext): Promise<HandlerResult> {
    if (!ctx.localUsers) return json(404, { message: 'Not Found' })
    const fields = loginFields(ctx.body)
    if (!fields.ok) return json(400, { message: fields.message })
    if (await ctx.rateLimit.blocked(ctx.ip, fields.email, ctx.now)) return json(429, { message: TOO_MANY })

    const matches = await ctx.store.findUsersByEmail(fields.email)
    const user = matches.length === 1 ? matches[0] : null
    const open = user ? await ctx.store.localAccountOpen(user.id) : false
    const eligible = Boolean(user && open && user.credential)
    const passwordOk = await verifyPassword(fields.password, hashForLoginCompare(eligible, user ? user.credential : null))
    if (!user || !eligible || !passwordOk) {
        if (user && !open) await ctx.store.deleteLocalSessionsForUser(user.id)
        // Unknown emails must not become account keys. The client address still counts.
        await ctx.rateLimit.recordFailure(ctx.ip, user ? fields.email : '', ctx.now)
        return json(401, { message: INVALID_LOGIN })
    }

    const issued = await issueLocalSession(ctx, user.id)
    if (!issued) return json(401, { message: INVALID_LOGIN })
    return json(200, issued.session, {
        cookies: [localCookie(issued.token, localSessionSecure(ctx), IDLE_MS)],
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
    if (ctx.now >= row.absoluteExpires.getTime() || ctx.now >= row.idleExpires.getTime()) {
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
    if (await ctx.rateLimit.blocked(ctx.ip, account.email, ctx.now)) return json(429, { message: TOO_MANY })
    const eligible = Boolean(account.credential)
    const currentOk = await verifyPassword(currentRaw, hashForLoginCompare(eligible, account.credential))
    if (!eligible || !currentOk) {
        await ctx.rateLimit.recordFailure(ctx.ip, account.email, ctx.now)
        return json(401, { message: INVALID_LOGIN })
    }

    await ctx.store.setCredential(row.userId, await hashPassword(nextRaw))
    await ctx.store.deleteLocalSessionsForUser(row.userId)
    const issued = await issueLocalSession(ctx, row.userId)
    if (!issued) return json(401, { message: INVALID_LOGIN })
    return json(200, issued.session, {
        cookies: [localCookie(issued.token, localSessionSecure(ctx), IDLE_MS)],
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
        try {
            const authenticated = await ctx.workos.authenticateSession(sealed)
            if (authenticated.authenticated) {
                const row = await ctx.store.findUserByExternalId(authenticated.user.id)
                if (row && isActiveStatus(row.status)) {
                    const user = await ctx.store.sessionFor(row.id)
                    return { user }
                }
                return { user: null, clearCookies: [WOS_SESSION_COOKIE], secure: ctx.secure }
            }
            if (authenticated.reason === 'no_session_cookie_provided') return { user: null }
            const refreshed = await ctx.workos.refresh(sealed)
            if (!refreshed.authenticated) return { user: null, clearCookies: [WOS_SESSION_COOKIE], secure: ctx.secure }
            const row = await ctx.store.findUserByExternalId(refreshed.user.id)
            if (!row || !isActiveStatus(row.status)) return { user: null, clearCookies: [WOS_SESSION_COOKIE], secure: ctx.secure }
            const user = await ctx.store.sessionFor(row.id)
            return {
                user,
                cookies: user ? [sealedCookie(refreshed.sealedSession, ctx.secure)] : undefined,
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
        if (!row || !tokensEqual(row.token, digest)) return { user: null, clearCookies: [LOCAL_SESSION_COOKIE], secure: ctx.secure }
        if (ctx.now >= row.absoluteExpires.getTime() || ctx.now >= row.idleExpires.getTime()) {
            return { user: null, clearCookies: [LOCAL_SESSION_COOKIE], secure: ctx.secure }
        }
        const gate = await localCookieGate(ctx, row.userId)
        if (gate === 'end') {
            await ctx.store.deleteLocalSessionsForUser(row.userId)
            return { user: null, clearCookies: [LOCAL_SESSION_COOKIE], secure: ctx.secure }
        }
        if (gate !== 'ok') return { user: null, clearCookies: [LOCAL_SESSION_COOKIE], secure: ctx.secure }
        const user = await ctx.store.sessionFor(row.userId)
        return { user, secure: ctx.secure }
    }
    return { user: null }
}
