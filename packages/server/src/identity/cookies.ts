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

import { createHmac, timingSafeEqual } from 'crypto'
import {
    INVITE_COOKIE,
    INVITE_COOKIE_MS,
    INVITE_COOKIE_PATH,
    LOCAL_SESSION_COOKIE,
    OIDC_BROWSER_COOKIE,
    OIDC_BROWSER_COOKIE_MS,
    OIDC_BROWSER_COOKIE_PATH,
    REAUTH_STATE_COOKIE,
    REAUTH_STATE_COOKIE_MS,
    RECENT_AUTH_COOKIE,
    WOS_EPOCH_COOKIE,
    WOS_SESSION_COOKIE
} from './constants'
import { SetCookie } from './types'
import { publicOrigin } from './setupCode'

export function oidcCallbackUrl(providerKey?: string, env: NodeJS.ProcessEnv = process.env): string {
    const url = new URL(`${publicOrigin(env.PORT || '3000', env)}/api/v1/auth/oidc/callback`)
    if (providerKey) url.searchParams.set('provider', providerKey)
    return url.toString()
}

export function oidcSessionCookieSecure(httpsRequest: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
    return cookieSecure(oidcCallbackUrl(undefined, env), httpsRequest)
}

export function cookieSecure(redirectUri: string | undefined, httpsRequest: boolean): boolean {
    if (redirectUri?.startsWith('https://')) return true
    if (redirectUri?.startsWith('http://')) return false
    return httpsRequest
}

export function sealedCookie(value: string, secure: boolean): SetCookie {
    return {
        name: WOS_SESSION_COOKIE,
        value,
        options: { httpOnly: true, sameSite: 'lax', path: '/', secure }
    }
}

function epochDigest(sealed: string, epoch: number, bindingSecret: string): string {
    return createHmac('sha256', bindingSecret).update(`${epoch}\n${sealed}`).digest('base64url')
}

export function workosEpochCookie(sealed: string, epoch: number, bindingSecret: string, secure: boolean): SetCookie {
    return {
        name: WOS_EPOCH_COOKIE,
        value: `${epoch}.${epochDigest(sealed, epoch, bindingSecret)}`,
        options: { httpOnly: true, sameSite: 'lax', path: '/', secure }
    }
}

export function workosEpochCookieValid(value: string | undefined, sealed: string, epoch: number, bindingSecret: string): boolean {
    if (!value) return false
    const [stored, digest] = value.split('.')
    if (Number(stored) !== epoch || !digest) return false
    const expected = epochDigest(sealed, epoch, bindingSecret)
    const left = Buffer.from(digest)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right)
}

export function inviteCookie(value: string, secure: boolean): SetCookie {
    return {
        name: INVITE_COOKIE,
        value,
        options: { httpOnly: true, sameSite: 'lax', path: INVITE_COOKIE_PATH, secure, maxAge: INVITE_COOKIE_MS }
    }
}

/** Expires the invite cookie on its own path. A clear on `/` would not reach it. */
export function expiredInviteCookie(secure: boolean): SetCookie {
    return { name: INVITE_COOKIE, value: '', options: { httpOnly: true, sameSite: 'lax', path: INVITE_COOKIE_PATH, secure, maxAge: 0 } }
}

export function oidcBrowserCookie(value: string, secure: boolean): SetCookie {
    return {
        name: OIDC_BROWSER_COOKIE,
        value,
        options: { httpOnly: true, sameSite: 'lax', path: OIDC_BROWSER_COOKIE_PATH, secure, maxAge: OIDC_BROWSER_COOKIE_MS }
    }
}

export function expiredOidcBrowserCookie(secure: boolean): SetCookie {
    return {
        name: OIDC_BROWSER_COOKIE,
        value: '',
        options: { httpOnly: true, sameSite: 'lax', path: OIDC_BROWSER_COOKIE_PATH, secure, maxAge: 0 }
    }
}

export function localCookie(value: string, secure: boolean, maxAge: number): SetCookie {
    return {
        name: LOCAL_SESSION_COOKIE,
        value,
        options: { httpOnly: true, sameSite: 'lax', path: '/', secure, maxAge }
    }
}

export function recentAuthenticationCookie(value: string, secure: boolean, maxAge: number): SetCookie {
    return { name: RECENT_AUTH_COOKIE, value, options: { httpOnly: true, sameSite: 'lax', path: '/', secure, maxAge } }
}

export function reauthenticationStateCookie(value: string, secure: boolean): SetCookie {
    return {
        name: REAUTH_STATE_COOKIE,
        value,
        options: { httpOnly: true, sameSite: 'lax', path: INVITE_COOKIE_PATH, secure, maxAge: REAUTH_STATE_COOKIE_MS }
    }
}

function reauthenticationStateDigest(requestedAt: number, nonce: string, password: string): string {
    return createHmac('sha256', password).update(`${requestedAt}\n${nonce}`).digest('base64url')
}

export function signedReauthenticationState(requestedAt: number, nonce: string, password: string): string {
    return `${requestedAt}.${nonce}.${reauthenticationStateDigest(requestedAt, nonce, password)}`
}

export function reauthenticationRequestTime(value: string | undefined, password: string | undefined): number | null {
    if (!value || !password) return null
    const [requestedAtText, nonce, digest, extra] = value.split('.')
    const requestedAt = Number(requestedAtText)
    if (extra !== undefined || !Number.isSafeInteger(requestedAt) || requestedAt <= 0 || !nonce || !digest) return null
    const expected = reauthenticationStateDigest(requestedAt, nonce, password)
    const left = Buffer.from(digest)
    const right = Buffer.from(expected)
    return left.length === right.length && timingSafeEqual(left, right) ? requestedAt : null
}

export function expiredReauthenticationStateCookie(secure: boolean): SetCookie {
    return {
        name: REAUTH_STATE_COOKIE,
        value: '',
        options: { httpOnly: true, sameSite: 'lax', path: INVITE_COOKIE_PATH, secure, maxAge: 0 }
    }
}
