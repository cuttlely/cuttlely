// Server settings API: /api/v1/server-settings. Owner only. The API key deny list answers 401 before this
// router, and so does a request with no session. A signed-in caller who is not the owner is 403.
// Secret values are accepted but never returned or logged.
import express, { NextFunction, Request, Response } from 'express'
import { requireOwner } from '../../identity/rbac'
import { startState } from '../../settings/bootstrap'
import {
    AuthKitDeps,
    TEST_STATE_PREFIX,
    applyAuthKitTest,
    authKitTestStatus,
    checkAuthKit,
    defaultAuthKitDeps,
    handleAuthKitTestCallback,
    requestOrigin,
    startAuthKitTest
} from '../../settings/authkit'
import { TestDrivers, TestInputError, defaultDrivers, testConnection } from '../../settings/connection'
import { checkDatabase, restorePreviousDatabase, switchDatabase } from '../../settings/database'
import { listReadOnlyStatus, readOnlyStatusFor } from '../../settings/readOnly'
import { isReadOnly } from '../../settings/registry'
import {
    ServiceDeps,
    SettingsError,
    discardChanges,
    getView,
    listHistory,
    restartNow,
    retryRolledBack,
    saveChanges
} from '../../settings/service'

const router = express.Router()

let depsFactory: () => ServiceDeps = () => ({
    env: process.env,
    state: startState,
    // Loaded on first use: the server utilities pull in the whole app.
    key: () => require('../../utils').getEncryptionKey()
})

let driversFactory: () => TestDrivers = defaultDrivers

/** Tests swap in a temporary settings folder and key. */
export function setServerSettingsDeps(factory: () => ServiceDeps): void {
    depsFactory = factory
}

let authKitFactory: () => AuthKitDeps = defaultAuthKitDeps

/** Tests swap in a fake WorkOS and user lookup for Set up AuthKit. */
export function setAuthKitDeps(factory: () => AuthKitDeps): void {
    authKitFactory = factory
}

/** The settings and AuthKit dependencies in use (the setup link shares them). */
export function currentSettingsDeps(): ServiceDeps {
    return depsFactory()
}

export function currentAuthKitDeps(): AuthKitDeps {
    return authKitFactory()
}

/** True for an AuthKit callback that belongs to a test sign-in from Server settings. */
export function isAuthKitTestCallback(req: Request): boolean {
    const state = req.query?.state
    return typeof state === 'string' && state.startsWith(TEST_STATE_PREFIX)
}

/** AuthKit came back from a test sign-in (mounted on /api/v1/auth/callback, before the normal sign-in). */
export async function authKitTestCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
        res.setHeader('Cache-Control', 'no-store')
        await handleAuthKitTestCallback(depsFactory(), authKitFactory(), req, res)
    } catch (error) {
        next(error)
    }
}

/** Tests swap in fake database, storage and download drivers for Test connection. */
export function setConnectionDrivers(factory: () => TestDrivers): void {
    driversFactory = factory
}

function actor(req: Request): string {
    const user = req.user as { email?: unknown; id?: unknown } | undefined
    if (user && typeof user.email === 'string' && user.email) return user.email
    if (user && typeof user.id === 'string' && user.id) return user.id
    return 'owner'
}

function handle(work: (req: Request) => Promise<unknown> | unknown, status = 200) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            res.setHeader('Cache-Control', 'no-store')
            res.status(status).json(await work(req))
        } catch (error) {
            if (error instanceof TestInputError) {
                return res.status(400).json({ code: 'INVALID', message: error.message, errors: error.errors })
            }
            if (error instanceof SettingsError) {
                const body: Record<string, unknown> = { code: error.code, message: error.message, errors: error.errors }
                if (error.key !== undefined) body.key = error.key
                if (error.reason !== undefined) body.reason = error.reason
                if (error.min !== undefined) body.min = error.min
                if (error.max !== undefined) body.max = error.max
                return res.status(error.status).json(body)
            }
            next(error)
        }
    }
}

/** Rejects a write to an env-only setting. The body is not copied into the error or a log line. */
function rejectReadOnlyWrite(req: Request): never {
    const key = typeof req.params?.key === 'string' ? req.params.key : ''
    const routePath = (req.route as { path?: string } | undefined)?.path ?? ''
    if (routePath === '/read-only') {
        throw new SettingsError(400, 'READ_ONLY', 'This setting cannot be changed.')
    }
    if (key) {
        if (!isReadOnly(key)) throw new SettingsError(404, 'NOT_FOUND', 'No read-only setting with that name.')
        throw new SettingsError(400, 'READ_ONLY', 'This setting cannot be changed.', [
            { key, code: 'READ_ONLY', message: 'This setting cannot be changed.' }
        ])
    }
    const values = req.body && typeof req.body === 'object' ? (req.body as { values?: unknown }).values : undefined
    if (values && typeof values === 'object' && !Array.isArray(values)) {
        const keys = Object.keys(values as Record<string, unknown>).filter((name) => isReadOnly(name))
        if (keys.length) {
            throw new SettingsError(
                400,
                'READ_ONLY',
                'This setting cannot be changed.',
                keys.map((name) => ({ key: name, code: 'READ_ONLY', message: 'This setting cannot be changed.' }))
            )
        }
    }
    throw new SettingsError(405, 'METHOD_NOT_ALLOWED', 'Use PUT /api/v1/server-settings to change a setting.')
}

router.use(requireOwner())
router.get(
    '/',
    handle(() => getView(depsFactory()))
)
router.get(
    '/read-only',
    handle(() => ({ scope: 'instance', settings: listReadOnlyStatus(depsFactory().env) }))
)
router.get(
    '/read-only/:key',
    handle((req) => {
        const status = readOnlyStatusFor(depsFactory().env, req.params.key)
        if (!status) throw new SettingsError(404, 'NOT_FOUND', 'No read-only setting with that name.')
        return status
    })
)
router.put('/read-only/:key', handle(rejectReadOnlyWrite))
router.patch('/read-only', handle(rejectReadOnlyWrite))
router.patch('/read-only/:key', handle(rejectReadOnlyWrite))
router.delete('/read-only', handle(rejectReadOnlyWrite))
router.delete('/read-only/:key', handle(rejectReadOnlyWrite))
router.patch('/', handle(rejectReadOnlyWrite))
router.delete('/', handle(rejectReadOnlyWrite))
router.put(
    '/',
    handle((req) => saveChanges(depsFactory(), req.body, actor(req)))
)
router.post(
    '/discard',
    handle((req) => discardChanges(depsFactory(), actor(req)))
)
// Try it again: puts back the settings safe boot set aside after two starts that did not finish.
router.post(
    '/retry',
    handle((req) => retryRolledBack(depsFactory(), actor(req)))
)
router.get(
    '/history',
    handle((req) => ({ entries: listHistory(depsFactory(), Number(req.query.limit ?? 100)) }))
)
router.post(
    '/restart',
    // Lets runs in progress finish first unless the owner chose Restart now ({ wait: false }).
    handle((req) => restartNow(depsFactory(), actor(req), { wait: (req.body as { wait?: unknown })?.wait !== false }), 202)
)
// Test connection: tries the values on screen without saving them. Nothing is written except a small test file in
// a storage bucket, which is removed again.
router.post(
    '/test',
    handle((req) => testConnection(depsFactory(), req.body, driversFactory()))
)

// Set up AuthKit: check the values, run a test sign-in with them, then save them.
router.post(
    '/authkit/check',
    handle((req) => checkAuthKit(depsFactory(), authKitFactory(), req.body, requestOrigin(req)))
)
router.post(
    '/authkit/test',
    handle((req) => startAuthKitTest(depsFactory(), authKitFactory(), req))
)
router.get(
    '/authkit/test',
    handle((req) => authKitTestStatus(authKitFactory(), req))
)
router.post(
    '/authkit/apply',
    handle((req) => applyAuthKitTest(depsFactory(), authKitFactory(), req))
)

// Switch database: test and explain, then switch (RESTART typed) and restart; Switch back puts the previous one back.
router.post(
    '/database/check',
    handle((req) => checkDatabase(depsFactory(), req.body, driversFactory()))
)
router.post(
    '/database/switch',
    handle((req) => switchDatabase(depsFactory(), req.body, actor(req), driversFactory()))
)
router.post(
    '/database/restore',
    handle((req) => restorePreviousDatabase(depsFactory(), req.body, actor(req), driversFactory()))
)

export default router
