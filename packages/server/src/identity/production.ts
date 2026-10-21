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

import { Request } from 'express'
import { DataSource } from 'typeorm'
import { getDataSource } from '../DataSource'
import { cookiePasswordOk, localAdminEnabled, localUsersMode, workosConfigured } from './constants'
import { cookieSecure } from './cookies'
import { organizationsForUser, recordAudit } from './auditLog'
import { Sql, sqlFromDataSource } from './directory'
import { AuthContext } from './handlers'
import { socketAddress } from './setupLimit'
import { bindSetupCodeStore } from './setupCode'
import { SqlIdentityStore, SqlLoginRateLimit, SqlSetupCodeStore } from './sqlStore'
import { workosPort } from './workosAdapter'

let store: SqlIdentityStore | undefined
let limiter: SqlLoginRateLimit | undefined

export function applicationSql(): Sql {
    return sqlFromDataSource(getDataSource())
}

/**
 * Runs after migrations, before the server listens.
 * Returns the number of local sessions deleted when AuthKit has just become configured.
 * A second start while AuthKit stays on returns null and does not end new sessions.
 */
export async function applyAuthKitSwitchOnBoot(dataSource: DataSource): Promise<{ ended: number } | null> {
    const switchStore = new SqlIdentityStore(dataSource)
    const before = await switchStore.readAuthKitSwitch()
    const configured = workosConfigured()
    // recordOff is this process: the web server. A queue worker does not call this.
    const after = await switchStore.applyAuthKitSwitch(configured, new Date(), { recordOff: !configured })
    if (after.configured && !before?.configured) return { ended: after.sessionsEnded }
    return null
}

export function identityStore(): SqlIdentityStore {
    if (!store) {
        const dataSource = getDataSource()
        store = new SqlIdentityStore(dataSource)
        bindSetupCodeStore(new SqlSetupCodeStore(dataSource))
    }
    return store
}

function loginLimiter(): SqlLoginRateLimit {
    if (!limiter) limiter = new SqlLoginRateLimit(getDataSource())
    return limiter
}

export function buildAuthContext(req: Request): AuthContext {
    const redirectUri = process.env.WORKOS_REDIRECT_URI
    const code = req.query?.code
    return {
        workosConfigured: workosConfigured(),
        localAdmin: localAdminEnabled(),
        localUsers: localUsersMode(),
        cookiePasswordOk: cookiePasswordOk(process.env.WORKOS_COOKIE_PASSWORD),
        bootstrapEmail: process.env.CUTTLELY_BOOTSTRAP_EMAIL?.trim() || undefined,
        redirectUri,
        secure: cookieSecure(redirectUri, Boolean(req.secure) || req.protocol === 'https'),
        now: Date.now(),
        ip: req.ip || req.socket?.remoteAddress || 'unknown',
        socketAddress: socketAddress(req.socket?.remoteAddress),
        internal: req.headers['x-request-from'] === 'internal',
        code: typeof code === 'string' ? code : Array.isArray(code) ? String(code[0] || '') : undefined,
        body: req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {},
        cookies: (req.cookies || {}) as Record<string, string | undefined>,
        store: identityStore(),
        workos: workosPort,
        rateLimit: loginLimiter(),
        noteAudit: noteSignIn
    }
}

async function noteSignIn(note: {
    type: 'sign_in_success' | 'sign_in_failure' | 'lockout'
    userId: string | null
    method: 'local' | 'owner' | 'authkit'
}): Promise<void> {
    const summary = note.type === 'sign_in_success' ? 'Signed in' : note.type === 'lockout' ? 'Sign-in locked' : 'Sign-in failed'
    try {
        const sql = sqlFromDataSource(getDataSource())
        const orgs = note.userId ? await organizationsForUser(sql, note.userId) : []
        const places = orgs.length ? orgs : ['']
        for (const organizationId of places) {
            await recordAudit(sql, {
                type: note.type,
                organizationId,
                workspaceId: null,
                userId: note.userId,
                actorId: note.userId,
                summary,
                detail: { method: note.method }
            })
        }
    } catch {
        console.warn('[server]: audit event was not saved')
    }
}
