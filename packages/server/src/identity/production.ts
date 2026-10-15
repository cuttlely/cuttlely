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
import { AuthContext } from './handlers'
import { SqlIdentityStore, SqlLoginRateLimit } from './sqlStore'
import { workosPort } from './workosAdapter'

let store: SqlIdentityStore | undefined
let limiter: SqlLoginRateLimit | undefined

/**
 * Runs after migrations, before the server listens.
 * Returns the number of local sessions deleted when AuthKit has just become configured.
 * A second start while AuthKit stays on returns null and does not end new sessions.
 */
export async function applyAuthKitSwitchOnBoot(dataSource: DataSource): Promise<{ ended: number } | null> {
    const switchStore = new SqlIdentityStore(dataSource)
    const before = await switchStore.readAuthKitSwitch()
    const after = await switchStore.applyAuthKitSwitch(workosConfigured(), new Date())
    if (after.configured && !before?.configured) return { ended: after.sessionsEnded }
    return null
}

export function identityStore(): SqlIdentityStore {
    if (!store) store = new SqlIdentityStore(getDataSource())
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
        internal: req.headers['x-request-from'] === 'internal',
        code: typeof code === 'string' ? code : Array.isArray(code) ? String(code[0] || '') : undefined,
        body: req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {},
        cookies: (req.cookies || {}) as Record<string, string | undefined>,
        store: identityStore(),
        workos: workosPort,
        rateLimit: loginLimiter()
    }
}
