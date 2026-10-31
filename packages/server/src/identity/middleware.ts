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
 * Session attach. Prediction is skipped so an API-key call does not contact WorkOS.
 */

import { Request, Response } from 'express'
import { LOCAL_SESSION_COOKIE, WOS_SESSION_COOKIE } from './constants'
import { normalizeApiPath } from './apiGate'
import { establishSession } from './handlers'
import { buildAuthContext } from './production'
import { SessionUser } from './types'

// These routes write the status and the cookie themselves. Attaching a session here would clear or delete it before their mode and CSRF checks.
const HANDLED_BY_ROUTE = new Set(
    [
        '/api/v1/auth/login',
        '/api/v1/auth/callback',
        '/api/v1/auth/refreshToken',
        '/api/v1/auth/resolve',
        '/api/v1/auth/options',
        '/api/v1/auth/local/login',
        '/api/v1/auth/recovery/login',
        '/api/v1/auth/local/logout',
        '/api/v1/auth/local/password',
        '/api/v1/account/logout',
        '/api/v1/account/register'
    ].map(normalizeApiPath)
)

export async function attachIdentitySession(req: Request, res: Response): Promise<SessionUser | null> {
    // Express routes ignore letter case and route `/api/v1//x` like `/api/v1/x`, so this check does too.
    const path = normalizeApiPath(req.path)
    if (HANDLED_BY_ROUTE.has(path) || path.startsWith('/api/v1/prediction')) return null
    const cookies = (req.cookies || {}) as Record<string, string | undefined>
    if (!cookies[WOS_SESSION_COOKIE] && !cookies[LOCAL_SESSION_COOKIE]) return null
    try {
        const established = await establishSession(await buildAuthContext(req))
        const secure = established.secure ?? established.cookies?.[0]?.options.secure ?? false
        for (const name of established.clearCookies || []) {
            res.clearCookie(name, { path: '/', httpOnly: true, sameSite: 'lax', secure })
        }
        for (const cookie of established.cookies || []) res.cookie(cookie.name, cookie.value, cookie.options)
        return established.user
    } catch {
        return null
    }
}
