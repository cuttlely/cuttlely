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

/** Sealed AuthKit session. The SDK examples use this name. */
export const WOS_SESSION_COOKIE = 'wos-session'
/** Authenticated binding from a sealed WorkOS session to the global authentication epoch. */
export const WOS_EPOCH_COOKIE = 'cuttlely-workos-epoch'

/** Break-glass session only. Never a WorkOS seal. */
export const LOCAL_SESSION_COOKIE = 'cuttlely-local-session'
/** Opaque handle for a server-side fresh-sign-in record. */
export const RECENT_AUTH_COOKIE = 'cuttlely-recent-auth'
export const REAUTH_STATE_COOKIE = 'cuttlely-reauth-state'
export const REAUTH_STATE_COOKIE_MS = 10 * 60 * 1000

/** Raw invite token held only for the AuthKit round trip. The callback always clears it. */
export const INVITE_COOKIE = 'cuttlely-invite'
export const INVITE_COOKIE_MS = 15 * 60 * 1000
/** The browser sends the invite cookie only to the AuthKit callback. */
export const INVITE_COOKIE_PATH = '/api/v1/auth/callback'
/** randomToken output is far shorter. Anything longer is not a token. */
export const INVITE_TOKEN_MAX_LENGTH = 256

/** Defaults used before these could be changed, and the fallback when a session row has no issue time. */
export const IDLE_MS = 12 * 60 * 60 * 1000
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
/** Historical default. The live cap is CUTTLELY_LOGIN_FAILURE_LIMIT. */
export const LOGIN_FAILURE_LIMIT = 10
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000

/** RFC 5321 mailbox limit. Longer values are rejected before lookup or scrypt. */
export const EMAIL_MAX_LENGTH = 254
/** Rejected before scrypt. Strength rules still cap a new password at 128. */
export const PASSWORD_MAX_LENGTH = 256

/**
 * @workos-inc/node 11.0.0 seals with a password of at least 32 characters.
 * `openssl rand -base64 32` emits 44 characters and meets that minimum.
 */
export const COOKIE_PASSWORD_MIN_LENGTH = 32

export const PERSONAL_WORKSPACE = 'Personal Workspace'
export const DEFAULT_WORKSPACE = 'Default Workspace'
export const OWNER_ROLE = 'owner'

export const OPEN_SOURCE_FEATURES = {
    'feat:users': 'true',
    'feat:roles': 'true',
    'feat:workspaces': 'true',
    'feat:datasets': 'true',
    'feat:evaluators': 'true',
    'feat:evaluations': 'true'
} as const

export function workosConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    const configured = Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID)
    if (env !== process.env) return configured
    const { selectedAuthenticationMethod } = require('./authenticationState') as typeof import('./authenticationState')
    const selected = selectedAuthenticationMethod()
    return selected === undefined ? configured : selected === 'workos' && configured
}

/** Provider configuration presence, independent of the selected ordinary sign-in method. */
export function workosEnvironmentConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID)
}

export function localAdminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.CUTTLELY_LOCAL_ADMIN === 'true'
}

/** The setting itself, before AuthKit is considered. */
export function localUsersSetting(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.CUTTLELY_LOCAL_USERS === 'true'
}

/**
 * Password sign-in for any active local user.
 * AuthKit turns this off. The owner break-glass route is separate and stays on its own flag.
 */
export function localUsersMode(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env !== process.env) return localUsersSetting(env) && !workosConfigured(env)
    const { selectedAuthenticationMethod } = require('./authenticationState') as typeof import('./authenticationState')
    const selected = selectedAuthenticationMethod()
    return selected === undefined ? localUsersSetting(env) && !workosConfigured(env) : selected === 'local' && localUsersSetting(env)
}

export function cookiePasswordOk(value: string | undefined): value is string {
    return typeof value === 'string' && value.length >= COOKIE_PASSWORD_MIN_LENGTH
}

export function signinErrorUrl(message: string): string {
    return `/signin?error=${encodeURIComponent(JSON.stringify({ message }))}`
}

/** Sign-out redirect is the origin of WORKOS_REDIRECT_URI plus /signin. The redirect URI string is not rewritten. */
export function signOutReturnTo(redirectUri: string | undefined): string | undefined {
    if (!redirectUri) return undefined
    try {
        return `${new URL(redirectUri).origin}/signin`
    } catch {
        return undefined
    }
}

export function unavailablePage(): string {
    return '<p>Sign-in is unavailable.</p><p><a href="/signin">Return to sign in</a></p>'
}
