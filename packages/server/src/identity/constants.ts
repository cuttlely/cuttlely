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

/** Break-glass session only. Never a WorkOS seal. */
export const LOCAL_SESSION_COOKIE = 'cuttlely-local-session'

export const IDLE_MS = 12 * 60 * 60 * 1000
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000
export const LOGIN_FAILURE_LIMIT = 10
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000

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
    return Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID)
}

export function localAdminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.CUTTLELY_LOCAL_ADMIN === 'true'
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
