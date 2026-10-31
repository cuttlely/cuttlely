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
 *
 * Issuer is not set until the dashboard value is known.
 */

import { WorkOS } from '@workos-inc/node'
import { cookiePasswordOk } from './constants'
import { WorkosIdentity, WorkosPort, WorkosUnavailableError } from './types'

let cached: { key: string; client: WorkOS } | undefined

function client(): WorkOS {
    const apiKey = process.env.WORKOS_API_KEY || ''
    const clientId = process.env.WORKOS_CLIENT_ID || ''
    const key = `${apiKey}\n${clientId}`
    if (!cached || cached.key !== key) cached = { key, client: new WorkOS(apiKey, { clientId }) }
    return cached.client
}

function password(): string {
    const value = process.env.WORKOS_COOKIE_PASSWORD
    if (!cookiePasswordOk(value)) throw new WorkosUnavailableError()
    return value
}

function identityOf(user: { id: string; email: string; emailVerified: boolean; name?: string | null }): WorkosIdentity {
    return {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified === true,
        name: user.name ?? null
    }
}

export function sessionIdFromAccessToken(accessToken: string): string | undefined {
    const payload = accessToken.split('.')[1]
    if (!payload) return undefined
    try {
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sid?: unknown }
        return typeof decoded.sid === 'string' && decoded.sid.length > 0 && decoded.sid.length <= 255 ? decoded.sid : undefined
    } catch {
        return undefined
    }
}

export function workosUnavailable(error: unknown): boolean {
    if (error instanceof WorkosUnavailableError) return true
    if (!error || typeof error !== 'object') return false
    const status = 'status' in error ? Number((error as { status?: unknown }).status) : NaN
    if (status === 408 || status === 429 || status >= 500) return true
    if (error instanceof TypeError) return true
    const message = error instanceof Error ? error.message : ''
    return /network|timeout|ECONN|ENOTFOUND|fetch failed|getaddrinfo/i.test(message)
}

function rethrow(error: unknown): never {
    if (workosUnavailable(error)) throw new WorkosUnavailableError()
    throw error
}

export const workosPort: WorkosPort = {
    authorizationUrl(redirectUri: string): string {
        return client().userManagement.getAuthorizationUrl({
            provider: 'authkit',
            redirectUri,
            clientId: process.env.WORKOS_CLIENT_ID
        })
    },

    async authenticate(code: string) {
        try {
            const response = await client().userManagement.authenticateWithCode({
                code,
                clientId: process.env.WORKOS_CLIENT_ID
            })
            return { user: identityOf(response.user), sessionId: sessionIdFromAccessToken(response.accessToken) }
        } catch (error) {
            rethrow(error)
        }
    },

    async authenticateSession(sealed: string) {
        try {
            const session = client().userManagement.loadSealedSession({ sessionData: sealed, cookiePassword: password() })
            const result = await session.authenticate()
            if (!result.authenticated) return { authenticated: false as const, reason: result.reason }
            return { authenticated: true as const, sessionId: result.sessionId, user: identityOf(result.user) }
        } catch (error) {
            rethrow(error)
        }
    },

    async refresh(sealed: string) {
        try {
            const session = client().userManagement.loadSealedSession({ sessionData: sealed, cookiePassword: password() })
            const result = await session.refresh()
            if (!result.authenticated || !result.sealedSession) {
                return { authenticated: false as const, reason: result.authenticated ? 'invalid_session_cookie' : result.reason }
            }
            return {
                authenticated: true as const,
                sealedSession: result.sealedSession,
                sessionId: result.sessionId,
                user: identityOf(result.user)
            }
        } catch (error) {
            rethrow(error)
        }
    },

    async logoutUrl(sessionId: string, returnTo?: string) {
        try {
            return client().userManagement.getLogoutUrl({ sessionId, ...(returnTo ? { returnTo } : {}) })
        } catch (error) {
            rethrow(error)
        }
    },

    async setExternalId(workosUserId: string, ourUserId: string) {
        await client().userManagement.updateUser({ userId: workosUserId, externalId: ourUserId })
    }
}
