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

import { OPEN_SOURCE_FEATURES } from './constants'

export interface UserRow {
    id: string
    email: string
    name: string
    status: string
    externalId: string | null
    credential: string | null
}

export interface SessionUser {
    id: string
    email: string
    name: string
    status: string
    role: string
    isSSO: false
    activeOrganizationId: string | null
    activeOrganizationSubscriptionId: null
    activeOrganizationCustomerId: null
    activeOrganizationProductId: null
    activeWorkspaceId: string | null
    activeWorkspace: string | null
    lastLogin: string | null
    isOrganizationAdmin: boolean
    assignedWorkspaces: { id: string; name: string }[]
    permissions: string[]
    features: typeof OPEN_SOURCE_FEATURES
}

/**
 * Fields an Apache request puts on req.user.
 * Interactive sign-in fills SessionUser. An API key fills the workspace fields and permissions.
 */
export interface LoggedInUser {
    id?: string
    email?: string
    name?: string
    status?: string
    role?: string
    permissions: string[]
    activeOrganizationId?: string
    activeOrganizationSubscriptionId?: string
    activeOrganizationCustomerId?: string
    activeOrganizationProductId?: string
    activeWorkspaceId?: string
    activeWorkspace?: string
    isOrganizationAdmin?: boolean
    features?: { [key: string]: string }
    assignedWorkspaces?: { id: string; name: string }[]
    lastLogin?: string | null
    isSSO?: boolean
    /** Present for an API key. This is the key id, never the key secret. */
    apiKeyId?: string
}

export interface LocalSession {
    id: string
    userId: string
    token: string
    idleExpires: Date
    absoluteExpires: Date
    /** When the session was created. Older rows derive this from the absolute expiry. */
    issuedAt?: Date
    /** Last time the session was issued or refreshed. Older rows derive this from the idle expiry. */
    lastSeenAt?: Date
    /** Version copied from the user when the session was issued. */
    permissionVersion?: number
    /** Version on the user row when the session was read. */
    currentPermissionVersion?: number
}

export interface CreateOwnerInput {
    email: string
    name: string
    credential: string | null
    externalId: string | null
}

/**
 * Optional. consumeSetupHmac inserts the owner only when that HMAC is still unused and unexpired.
 * Operator commands omit it, and an open setup code row is retired in the same transaction.
 */
export interface CreateOwnerOptions {
    consumeSetupHmac?: string
    now?: number
}

export interface WorkosIdentity {
    id: string
    email: string
    emailVerified: boolean
    name: string | null
}

export type LinkFailure =
    | 'unverified'
    | 'rebind'
    | 'unknown'
    | 'inactive'
    | 'ambiguous'
    | 'bootstrap-unset'
    | 'bootstrap-denied'
    | 'invite-required'
    | 'invite-invalid'

/** An AuthKit sign-in that carries the raw token from an invite link. */
export interface InviteSignIn {
    token: string
    userId: string
    email: string
    externalId: string
    now: number
}

export type LinkResult = { ok: true; user: UserRow; bootstrapped: boolean } | { ok: false; reason: LinkFailure }

export interface WorkosPort {
    authorizationUrl(redirectUri: string): string
    authenticate(code: string): Promise<{ user: WorkosIdentity; sealedSession: string }>
    authenticateSession(
        sealed: string
    ): Promise<{ authenticated: true; user: WorkosIdentity; sessionId?: string } | { authenticated: false; reason: string }>
    refresh(
        sealed: string
    ): Promise<
        { authenticated: true; sealedSession: string; user: WorkosIdentity; sessionId?: string } | { authenticated: false; reason: string }
    >
    logoutUrl(sealed: string, returnTo?: string): Promise<string>
    setExternalId(workosUserId: string, ourUserId: string): Promise<void>
}

export class WorkosUnavailableError extends Error {
    constructor() {
        super('WorkOS is unavailable')
        this.name = 'WorkosUnavailableError'
    }
}

export class NotEmptyError extends Error {
    constructor() {
        super('not-empty')
        this.name = 'NotEmptyError'
    }
}

/** The setup code was missing, expired, already used, or did not match inside the owner transaction. */
export class SetupCodeRejected extends Error {
    constructor() {
        super('setup-code')
        this.name = 'SetupCodeRejected'
    }
}

export interface CookieOptions {
    httpOnly: true
    sameSite: 'lax'
    path: string
    secure: boolean
    maxAge?: number
}

export interface SetCookie {
    name: string
    value: string
    options: CookieOptions
}

export type HandlerResult =
    | { type: 'next' }
    | { type: 'redirect'; status: number; url: string; cookies?: SetCookie[]; clearCookies?: string[]; secure?: boolean }
    | { type: 'json'; status: number; body: unknown; cookies?: SetCookie[]; clearCookies?: string[]; secure?: boolean }
    | { type: 'text'; status: number; body: string; cookies?: SetCookie[]; clearCookies?: string[]; secure?: boolean; log?: string }
