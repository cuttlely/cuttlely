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
import logger from '../utils/logger'
import {
    handleCallback,
    handleLocalLogin,
    handleLocalLogout,
    handleLocalPassword,
    handleLoginGet,
    handleLoginPost,
    handleLogout,
    handlePasswordRecoveryGone,
    handleRefresh,
    handleRegister,
    handleResolve
} from './handlers'
import { apiKeyPermissionCatalog, rolePermissionCatalog } from './permissionsCatalog'
import { requireAnyPermission, requirePermission } from './rbac'
import { registerInvite } from './directoryRoutes'
import { enabledSignInMethods, signInOptionsBody } from './signInOptions'
import { buildAuthContext } from './production'
import { HandlerResult } from './types'

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
    run: (ctx: ReturnType<typeof buildAuthContext>) => Promise<HandlerResult>
) {
    try {
        const result = await run(buildAuthContext(req))
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
identityAuthRouter.get('/signin-options', (_req, res) => {
    res.json(signInOptionsBody())
})
identityAuthRouter.get('/options', (_req, res) => {
    res.json(enabledSignInMethods())
})
identityAuthRouter.post('/local/login', (req, res, next) => void dispatch(req, res, next, handleLocalLogin))
identityAuthRouter.post('/local/logout', (req, res, next) => void dispatch(req, res, next, handleLocalLogout))
identityAuthRouter.post('/local/password', (req, res, next) => void dispatch(req, res, next, handleLocalPassword))
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
identityAuthRouter.get('/callback', (req, res, next) => {
    // A test sign-in from Server settings, Set up AuthKit. It never signs anyone in. Loaded on use, so this
    // router never pulls in the settings start-up code.
    const state = req.query?.state
    if (typeof state === 'string' && state.startsWith('dfst.')) {
        return void require('../routes/server-settings').authKitTestCallback(req, res, next)
    }
    void dispatch(req, res, next, handleCallback)
})
identityAuthRouter.post('/login', (req, res, next) => void dispatch(req, res, next, handleLoginPost))
identityAuthRouter.post('/refreshToken', (req, res, next) => void dispatch(req, res, next, handleRefresh))
identityAuthRouter.post('/resolve', (req, res, next) => void dispatch(req, res, next, handleResolve))

function gone(_req: Request, res: Response) {
    res.status(404).json({ message: 'Not Found' })
}

export const identityAccountRouter = Router()
identityAccountRouter.post('/logout', (req, res, next) => void dispatch(req, res, next, handleLogout))
identityAccountRouter.post('/register', (req, res, next) => void dispatch(req, res, next, handleRegister))
identityAccountRouter.post('/forgot-password', (req, res, next) => void dispatch(req, res, next, handlePasswordRecoveryGone))
identityAccountRouter.post('/reset-password', (req, res, next) => void dispatch(req, res, next, handlePasswordRecoveryGone))
identityAccountRouter.post('/resend-verification', gone)
identityAccountRouter.post('/confirm-email-change', gone)
identityAccountRouter.post('/verify', gone)
identityAccountRouter.post('/billing', gone)
registerInvite(identityAccountRouter)
identityAccountRouter.use(gone)

identityAuthRouter.use(gone)
