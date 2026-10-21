// The one-time setup link: /api/v1/server-setup. Public (no sign-in exists yet), so every call is guarded here:
// the code from the link opens a short setup session, and the session only reaches Sign-in & identity. Everything
// answers 410 once the link has been used, a sign-in method is on, or the first account exists.
import express, { NextFunction, Request, Response } from 'express'
import { localAdminEnabled } from '../../identity/constants'
import { applySetupHeaders, cookieMutationAllowed } from '../../identity/sessionGuard'
import {
    noSignInMethod,
    noteSetupFailure,
    reissueExpiredSetupCode,
    SETUP_CODE_EXPIRED_MESSAGE,
    setupCodeHmac,
    setupCodeRetired,
    setupCodeVerdict,
    setupServiceName,
    type SetupCodeVerdict
} from '../../identity/setupCode'
import { setupFailureLimited, socketAddress } from '../../identity/setupLimit'
import { Principal, applyAuthKitTest, authKitTestStatus, checkAuthKit, requestOrigin, startAuthKitTest } from '../../settings/authkit'
import { TestInputError } from '../../settings/connection'
import { SettingsError } from '../../settings/service'
import {
    CLOSED_MESSAGE,
    SetupDeps,
    SetupUsers,
    codeOpensSetup,
    createOwnerFromSetup,
    finishSetup,
    setupClosed,
    setupPrincipal,
    setupState
} from '../../settings/server-setup'
import { endSetupSessions, openSetupSession } from '../../settings/setup-session'
import { currentAuthKitDeps, currentSettingsDeps } from '../server-settings'

const router = express.Router()

let usersFactory: () => SetupUsers = () => require('../../identity/production').identityStore()

/** Tests swap in a fake account store. */
export function setSetupUsers(factory: () => SetupUsers): void {
    usersFactory = factory
}

function deps(): SetupDeps {
    return { service: currentSettingsDeps(), users: usersFactory }
}

type SetupRequest = Request & { setupPrincipal?: Principal }

function handle(work: (req: SetupRequest, res: Response) => Promise<unknown> | unknown) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            res.status(200).json(await work(req as SetupRequest, res))
        } catch (error) {
            if (error instanceof TestInputError) {
                return res.status(400).json({ code: 'INVALID', message: error.message, errors: error.errors })
            }
            if (error instanceof SettingsError) {
                return res.status(error.status).json({ code: error.code, message: error.message, errors: error.errors })
            }
            next(error)
        }
    }
}

router.use((req, res, next) => {
    applySetupHeaders(res)
    // Writes need the app's own header, like every cookie-signed write (a page elsewhere can't send it).
    if (!cookieMutationAllowed(req.method, req.headers['x-request-from'] === 'internal')) {
        return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
    }
    next()
})

const BAD_CODE_MESSAGE = 'This setup code is not right. Copy it again from the server log.'
const EXPIRED_CODE_MESSAGE = SETUP_CODE_EXPIRED_MESSAGE
const TOO_MANY_MESSAGE = 'Too many attempts. Try again later.'

function rejectSetupCode(res: Response, verdict: SetupCodeVerdict) {
    if (verdict === 'expired') {
        return res.status(404).json({ code: 'CODE_EXPIRED', reason: 'expired', message: EXPIRED_CODE_MESSAGE })
    }
    return res.status(404).json({ code: 'BAD_CODE', message: BAD_CODE_MESSAGE })
}

// Where to read the setup code, and whether setup is still open. The code itself stays in the server log.
// The same failure cap as exchanging a code. A hint does not record a failure.
router.get('/hint', async (req, res, next) => {
    try {
        const address = socketAddress(req.socket?.remoteAddress)
        if (setupFailureLimited(address, Date.now())) {
            return res.status(429).json({ code: 'TOO_MANY', message: TOO_MANY_MESSAGE })
        }
        const setup = deps()
        const env = setup.service.env
        const users = await setup.users().countUsers()
        const open = users === 0 && !(await setupCodeRetired()) && (noSignInMethod(env) || localAdminEnabled(env))
        res.json({ serviceName: setupServiceName(env), open })
    } catch (error) {
        next(error)
    }
})

// Accepts the code from the fragment (or a pasted code) and says which step comes next.
// The password-sign-in path does not open a settings session: the account call still checks the code.
router.post('/begin', async (req, res, next) => {
    try {
        const address = socketAddress(req.socket?.remoteAddress)
        const now = Date.now()
        const setup = deps()
        const env = setup.service.env
        const users = await setup.users().countUsers()
        if (users > 0 || (await setupCodeRetired())) {
            const reason = users > 0 ? 'has-account' : 'used'
            return res.status(410).json({ code: 'SETUP_CLOSED', message: CLOSED_MESSAGE[reason] })
        }
        if (!noSignInMethod(env) && !localAdminEnabled(env)) {
            return res.status(410).json({ code: 'SETUP_CLOSED', message: CLOSED_MESSAGE['signin-on'] })
        }
        const code = (req.body as { code?: unknown })?.code
        const verdict = await setupCodeVerdict(code, now)
        if (verdict !== 'match') {
            await reissueExpiredSetupCode(now)
            if (noteSetupFailure(address, now).limited) {
                return res.status(429).json({ code: 'TOO_MANY', message: TOO_MANY_MESSAGE })
            }
            return rejectSetupCode(res, verdict)
        }
        if (noSignInMethod(env)) {
            const hmac = setupCodeHmac(code)
            if (!hmac) return res.status(404).json({ code: 'BAD_CODE', message: BAD_CODE_MESSAGE })
            openSetupSession(req, res, hmac)
            return res.json({ next: 'choose' })
        }
        return res.json({ next: 'owner' })
    } catch (error) {
        next(error)
    }
})

// The code from the link opens a setup session in this browser.
router.post('/open', async (req, res, next) => {
    try {
        const address = socketAddress(req.socket?.remoteAddress)
        const now = Date.now()
        const setup = deps()
        const closed = await setupClosed(setup)
        if (closed) return res.status(410).json({ code: 'SETUP_CLOSED', message: CLOSED_MESSAGE[closed] })
        const code = (req.body as { code?: unknown })?.code
        const verdict = await setupCodeVerdict(code, now)
        if (verdict !== 'match' || !(await codeOpensSetup(setup, code))) {
            if (verdict !== 'match') await reissueExpiredSetupCode(now)
            if (noteSetupFailure(address, now).limited) {
                return res.status(429).json({ code: 'TOO_MANY', message: TOO_MANY_MESSAGE })
            }
            return rejectSetupCode(res, verdict)
        }
        const hmac = setupCodeHmac(code)
        if (!hmac) {
            return res.status(404).json({ code: 'BAD_CODE', message: BAD_CODE_MESSAGE })
        }
        openSetupSession(req, res, hmac)
        res.json({ ok: true })
    } catch (error) {
        next(error)
    }
})

// Everything else needs the setup session, and a link that still works.
router.use(async (req, res, next) => {
    try {
        const principal = setupPrincipal(req)
        if (!principal) return res.status(401).json({ code: 'NO_SETUP_SESSION', message: 'Open the setup link from the server log again.' })
        const closed = await setupClosed(deps())
        if (closed) {
            endSetupSessions(res)
            return res.status(410).json({ code: 'SETUP_CLOSED', message: CLOSED_MESSAGE[closed] })
        }
        ;(req as SetupRequest).setupPrincipal = principal
        next()
    } catch (error) {
        next(error)
    }
})

router.get(
    '/state',
    handle(() => setupState(deps()))
)
router.post(
    '/owner',
    handle(async (req, res) => {
        const result = await createOwnerFromSetup(deps(), req.body, req)
        endSetupSessions(res)
        return result
    })
)
router.post(
    '/authkit/check',
    handle((req) => checkAuthKit(currentSettingsDeps(), currentAuthKitDeps(), req.body, requestOrigin(req)))
)
router.post(
    '/authkit/test',
    handle((req) => startAuthKitTest(currentSettingsDeps(), currentAuthKitDeps(), req, req.setupPrincipal))
)
router.get(
    '/authkit/test',
    handle((req) => authKitTestStatus(currentAuthKitDeps(), req, req.setupPrincipal))
)
router.post(
    '/authkit/apply',
    handle(async (req, res) => {
        await applyAuthKitTest(currentSettingsDeps(), currentAuthKitDeps(), req, req.setupPrincipal)
        const result = await finishSetup(deps())
        endSetupSessions(res)
        return result
    })
)

export default router
