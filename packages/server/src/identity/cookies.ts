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
    RECENT_AUTH_COOKIE,
    WOS_EPOCH_COOKIE,
    WOS_SESSION_COOKIE
} from './constants'
import { SetCookie } from './types'

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

function epochDigest(sealed: string, epoch: number, password: string): string {
    return createHmac('sha256', password).update(`${epoch}\n${sealed}`).digest('base64url')
}

export function workosEpochCookie(sealed: string, epoch: number, password: string, secure: boolean): SetCookie {
    return {
        name: WOS_EPOCH_COOKIE,
        value: `${epoch}.${epochDigest(sealed, epoch, password)}`,
        options: { httpOnly: true, sameSite: 'lax', path: '/', secure }
    }
}

export function workosEpochCookieValid(value: string | undefined, sealed: string, epoch: number, password: string): boolean {
    // Cookies issued before Phase A are accepted only before the first method switch.
    if (!value) return epoch === 0
    const [stored, digest] = value.split('.')
    if (Number(stored) !== epoch || !digest) return false
    const expected = epochDigest(sealed, epoch, password)
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
