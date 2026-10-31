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
 * Route wiring. Unmatched auth and account paths answer 404 here.
 */

import { NextFunction, Request, Response, Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import logger from '../utils/logger'
import { LOGIN_FAILURE_WINDOW_MS, localAdminEnabled, localUsersMode } from './constants'
import { runtimeNumber } from '../settings/runtime'
import {
    TOO_MANY,
    handleCallback,
    handleInviteStart,
    handleLocalLogin,
    handleLocalLogout,
    handleLocalPassword,
    handleLoginGet,
    handleReauthenticationGet,
    handleLoginPost,
    handleLogout,
    handlePasswordRecoveryGone,
    handleRefresh,
    handleRegister,
    handleResolve
} from './handlers'
import { apiKeyPermissionCatalog, rolePermissionCatalog } from './permissionsCatalog'
import { requireAnyPermission, requirePermission } from './rbac'
import { acceptLocalRoute, registerInvite } from './directoryRoutes'
import { authOptionsBody, signInOptionsBody } from './signInOptions'
import { applicationDataSource, buildAuthContext, identityStore } from './production'
import { applySetupHeaders } from './sessionGuard'
import { HandlerResult } from './types'
import { readAuthenticationState } from './authenticationState'

function apply(res: Response, result: Exclude<HandlerResult, { type: 'next' }>): void {
    const secure = result.secure ?? result.cookies?.[0]?.options.secure ?? false
    if ('log' in result && result.log) logger.error(result.log)
    for (const name of result.clearCookies || []) {
        res.clearCookie(name, { path: '/', httpOnly: true, sameSite: 'lax', secure })
    }
    for (const cookie of result.cookies || []) res.cookie(cookie.name, cookie.value, cookie.options)
    if (result.type === 'redirect') {
        res.redirect(result.status, result.url)
        return
    }
    if (result.type === 'text') {
        res.status(result.status).type('html').send(result.body)
        return
    }
    res.status(result.status).json(result.body)
}

async function dispatch(
    req: Request,
    res: Response,
    next: NextFunction,
    run: (ctx: Awaited<ReturnType<typeof buildAuthContext>>) => Promise<HandlerResult>
) {
    try {
        const result = await run(await buildAuthContext(req))
        if (result.type === 'next') {
            next()
            return
        }
        apply(res, result)
    } catch (error) {
        logger.error(`identity request failed: ${error instanceof Error ? error.name : 'error'}`)
        if (!res.headersSent) res.status(500).json({ message: 'Internal Server Error' })
    }
}

export const identityAuthRouter = Router()

/**
 * Extra per-client cap in this process for unsuccessful responses on the ordinary local password routes.
 * A request without x-request-from: internal, or while local users mode is off, is answered before this cap and does not count.
 * Client-address rows and email rows in identity_login_failure both survive a restart. This process cap ends with the process.
 * The email is stored only as an HMAC. Successful responses are not counted here.
 * The key is req.ip, which trusts proxy headers only when TRUST_PROXY says so.
 */
const localAuthRateLimit = rateLimit({
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    max: () => runtimeNumber('CUTTLELY_LOGIN_FAILURE_LIMIT'),
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { message: TOO_MANY }
})

const recoveryAuthRateLimit = rateLimit({
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    max: 5,
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) => {
        void Promise.resolve(buildAuthContext(req))
            .then(async (ctx) => {
                if (!ctx.noteRecoveryAttempt) throw new Error('recovery audit unavailable')
                await ctx.noteRecoveryAttempt('throttled', null)
                res.status(429).json({ message: TOO_MANY })
            })
            .catch((error: unknown) => {
                logger.error(`identity request failed: ${error instanceof Error ? error.name : 'error'}`)
                if (!res.headersSent) res.status(500).json({ message: 'Internal Server Error' })
            })
    }
})

/** Refreshes the process view of the sign-in method so a switch applied by another process is seen within the cache window. */
export async function currentAuthenticationView(): Promise<void> {
    try {
        const { refreshAuthenticationView } = await import('./production')
        await refreshAuthenticationView()
    } catch (error: unknown) {
        logger.error(`authentication state refresh failed: ${error instanceof Error ? error.name : 'error'}`)
    }
}

function localAuthPreconditions(missingHeader: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
        void currentAuthenticationView().then(() => checkLocalAuth(req, res, next, missingHeader))
    }
}

function checkLocalAuth(req: Request, res: Response, next: NextFunction, missingHeader: string): void {
    if (!localUsersMode()) {
        res.status(404).json({ message: 'Not Found' })
        return
    }
    if (req.headers['x-request-from'] !== 'internal') {
        res.status(401).json({ message: missingHeader })
        return
    }
    next()
}

function ownerLoginPreconditions(req: Request, res: Response, next: NextFunction): void {
    if (!localAdminEnabled()) {
        res.status(404).json({ message: 'Not Found' })
        return
    }
    if (req.headers['x-request-from'] !== 'internal') {
        res.status(401).json({ message: 'Unauthorized' })
        return
    }
    next()
}

identityAuthRouter.get('/signin-options', (_req, res) => {
    void currentAuthenticationView().then(() => {
        if (!res.headersSent) res.json(signInOptionsBody())
    })
})

export async function currentAuthOptionsBody() {
    const dataSource = applicationDataSource()
    const durable = dataSource ? await readAuthenticationState(dataSource) : null
    const state = durable || (await identityStore().readAuthKitSwitch())
    return authOptionsBody(process.env, state)
}

identityAuthRouter.get('/options', (_req, res) => {
    void (async () => {
        const body = await currentAuthOptionsBody()
        if (!res.headersSent) res.json(body)
    })().catch((error: unknown) => {
        logger.error(`identity request failed: ${error instanceof Error ? error.name : 'error'}`)
        if (!res.headersSent) res.status(500).json({ message: 'Internal Server Error' })
    })
})
identityAuthRouter.post(
    '/local/login',
    localAuthPreconditions('Invalid email or password.'),
    localAuthRateLimit,
    (req, res, next) => void dispatch(req, res, next, handleLocalLogin)
)
identityAuthRouter.post(
    '/local/logout',
    (req, res, next) => {
        if (req.headers['x-request-from'] !== 'internal') return void res.status(401).json({ message: 'Unauthorized' })
        next()
    },
    (req, res, next) => void dispatch(req, res, next, handleLocalLogout)
)
identityAuthRouter.post(
    '/local/password',
    localAuthPreconditions('Unauthorized'),
    localAuthRateLimit,
    (req, res, next) => void dispatch(req, res, next, handleLocalPassword)
)
identityAuthRouter.get('/permissions/ROLE', requirePermission('roles:manage'), (_req, res) => {
    res.json(rolePermissionCatalog())
})
identityAuthRouter.get('/permissions/API_KEY', requireAnyPermission('apikeys:view,apikeys:create'), (_req, res) => {
    res.json(apiKeyPermissionCatalog())
})
identityAuthRouter.get('/permissions/:type', (_req, res) => {
    res.status(404).json({ message: 'Not Found' })
})
identityAuthRouter.get('/login', (req, res, next) => void dispatch(req, res, next, handleLoginGet))
identityAuthRouter.get('/reauthenticate', (req, res, next) => void dispatch(req, res, next, handleReauthenticationGet))
identityAuthRouter.get('/callback', (req, res, next) => {
    // A test sign-in from Server settings, Set up AuthKit. It never signs anyone in. Loaded on use, so this
    // router never pulls in the settings start-up code.
    const state = req.query?.state
    if (typeof state === 'string' && state.startsWith('dfst.')) {
        return void require('../routes/server-settings').authKitTestCallback(req, res, next)
    }
    void dispatch(req, res, next, handleCallback)
})
identityAuthRouter.post(
    '/login',
    ownerLoginPreconditions,
    recoveryAuthRateLimit,
    (req, res, next) => void dispatch(req, res, next, handleLoginPost)
)
identityAuthRouter.post(
    '/recovery/login',
    (_req, res, next) => {
        applySetupHeaders(res)
        next()
    },
    (req, res, next) => {
        if (req.headers['x-request-from'] !== 'internal') return void res.status(401).json({ message: 'Invalid email or password.' })
        next()
    },
    recoveryAuthRateLimit,
    (req, res, next) => void dispatch(req, res, next, handleLoginPost)
)
const acceptLinkLimit = rateLimit({
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    // Same live cap as local password sign-in. A saved failure limit applies without a restart.
    max: () => runtimeNumber('CUTTLELY_LOGIN_FAILURE_LIMIT'),
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { message: 'Too many attempts. Try again later.' }
})

identityAuthRouter.post('/local/accept', acceptLinkLimit, (req, res) => {
    const query = req.query && typeof req.query === 'object' ? (req.query as Record<string, unknown>) : {}
    void buildAuthContext(req)
        .then((ctx) => acceptLocalRoute(ctx, query))
        .then((result) => {
            if (res.headersSent) return
            if (result.type !== 'json') {
                res.status(500).json({ message: 'Internal Server Error' })
                return
            }
            const body = result.body
            const message = body && typeof body === 'object' && 'message' in body ? (body as { message: unknown }).message : ''
            res.status(result.status).json({ message: typeof message === 'string' ? message : 'Internal Server Error' })
        })
        .catch((error: unknown) => {
            logger.error(`identity request failed: ${error instanceof Error ? error.name : 'error'}`)
            if (!res.headersSent) res.status(500).json({ message: 'Internal Server Error' })
        })
})
identityAuthRouter.post('/invite/start', (req, res, next) => void dispatch(req, res, next, handleInviteStart))
identityAuthRouter.post('/refreshToken', (req, res, next) => void dispatch(req, res, next, handleRefresh))
identityAuthRouter.post('/resolve', (req, res, next) => void dispatch(req, res, next, handleResolve))

function gone(_req: Request, res: Response) {
    res.status(404).json({ message: 'Not Found' })
}

export const identityAccountRouter = Router()
identityAccountRouter.post('/logout', (req, res, next) => void dispatch(req, res, next, handleLogout))
identityAccountRouter.post('/register', (req, res, next) => {
    applySetupHeaders(res)
    void dispatch(req, res, next, handleRegister)
})
identityAccountRouter.post('/forgot-password', (req, res, next) => void dispatch(req, res, next, handlePasswordRecoveryGone))
identityAccountRouter.post('/reset-password', (req, res, next) => void dispatch(req, res, next, handlePasswordRecoveryGone))
identityAccountRouter.post('/resend-verification', gone)
identityAccountRouter.post('/confirm-email-change', gone)
identityAccountRouter.post('/verify', gone)
identityAccountRouter.post('/billing', gone)
registerInvite(identityAccountRouter)
identityAccountRouter.use(gone)

identityAuthRouter.use(gone)
