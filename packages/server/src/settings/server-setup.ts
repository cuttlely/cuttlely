// The one-time setup link, for a server where nobody can sign in yet (for example Render without AuthKit). The
// server prints the link in its log at start. It opens only Sign-in & identity: turn on the password sign-in with
// a first account, or set up AuthKit after a test sign-in. The link works once and stops working as soon as the
// first account exists, a sign-in method is on, or the setup is done.
import { Request } from 'express'
import {
    noSignInMethod,
    reissueExpiredSetupCode,
    retireFirstRunSetupCode,
    setupCodeMatches,
    setupCodeRetired,
    storedSetupCodeLive
} from '../identity/setupCode'
import { hashPassword, passwordErrors } from '../identity/password'
import { CreateOwnerInput, NotEmptyError, SetupCodeRejected, UserRow } from '../identity/types'
import { Principal } from './authkit'
import { ServiceDeps, SettingView, SettingsError, getView, restartNow, writeValues } from './service'
import { setupSessionCodeHmac, setupSessionHash } from './setup-session'

export const SETUP_BY = 'setup link'
export const SIGNIN_SECTION = 'signin'
// Domain labels cannot hold a dot, so each dot has one place to match and a long input stays linear.
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/

export interface SetupUsers {
    countUsers(): Promise<number>
    createOwner(
        input: CreateOwnerInput,
        options?: { consumeSetupHmac?: string; now?: number; activateLocalAuthentication?: boolean }
    ): Promise<UserRow>
}

export interface SetupDeps {
    service: ServiceDeps
    users: () => SetupUsers
}

export type SetupClosedReason = 'used' | 'signin-on' | 'has-account'

/** Why the link no longer works, or null while it still does. */
export async function setupClosed(deps: SetupDeps): Promise<SetupClosedReason | null> {
    if (await setupCodeRetired()) return 'used'
    if (!noSignInMethod(deps.service.env)) return 'signin-on'
    if ((await deps.users().countUsers()) > 0) return 'has-account'
    return null
}

export const CLOSED_MESSAGE: Record<SetupClosedReason, string> = {
    used: 'This setup link has already been used. Sign in instead.',
    'signin-on': 'This server already has a way to sign in. Sign in instead.',
    'has-account': 'This server already has an account. Sign in instead.'
}

/** True when the code from the link is right and the link still works. */
export async function codeOpensSetup(deps: SetupDeps, code: unknown): Promise<boolean> {
    if (!(await setupCodeMatches(code))) return false
    return (await setupClosed(deps)) === null
}

/** The setup session of this request, as a principal for the AuthKit test, or null. */
export function setupPrincipal(req: Request, now = Date.now()): Principal | null {
    const sessionHash = setupSessionHash(req, now)
    if (!sessionHash) return null
    return { id: `setup:${sessionHash.slice(0, 16)}`, by: SETUP_BY, sessionHash, mode: 'setup' }
}

export interface SetupState {
    install: string
    restartInPlace: boolean
    /** Set by the host, so the password sign-in can't be turned on from here. */
    passwordLocked: boolean
    settings: SettingView[]
    authKit: { complete: boolean; environment: string; tested: boolean; locked: boolean }
    redirectUri: string
}

/** What the setup page shows: Sign-in & identity only. */
export async function setupState(deps: SetupDeps): Promise<SetupState> {
    const view = await getView(deps.service)
    const settings = view.settings.filter((setting) => setting.section === SIGNIN_SECTION)
    const local = settings.find((setting) => setting.key === 'CUTTLELY_LOCAL_ADMIN')
    return {
        install: view.restart.install,
        restartInPlace: view.restart.inPlace,
        passwordLocked: Boolean(local?.locked),
        settings,
        authKit: {
            complete: view.authKit.complete,
            environment: view.authKit.environment,
            tested: view.authKit.tested,
            locked: view.authKit.locked
        },
        redirectUri: String(settings.find((setting) => setting.key === 'WORKOS_REDIRECT_URI')?.value ?? '')
    }
}

/** Ends the link and restarts when the server can, else answers with what to do. */
export async function finishSetup(deps: SetupDeps): Promise<{ restarting: boolean; steps: string[] }> {
    await retireFirstRunSetupCode()
    return restartNow(deps.service, SETUP_BY)
}

/** Use a password for now: creates the first account (the owner) and turns the password sign-in on. */
export async function createOwnerFromSetup(
    deps: SetupDeps,
    body: unknown,
    req: Request
): Promise<{ restarting: boolean; steps: string[]; email: string }> {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const email = typeof input.email === 'string' ? input.email.trim() : ''
    const password = typeof input.password === 'string' ? input.password : ''
    const errors: { key: string; message: string }[] = []
    if (!name || name.length > 100) errors.push({ key: 'name', message: 'Enter your name.' })
    if (email.length > 254 || !EMAIL.test(email)) errors.push({ key: 'email', message: 'Enter an email address.' })
    const weak = password ? passwordErrors(password) : ['Choose a password.']
    if (weak.length) errors.push({ key: 'password', message: weak[0] })
    if (errors.length) throw new SettingsError(400, 'INVALID', 'Check the highlighted fields.', errors)
    if (new Set(deps.service.state.hostKeys).has('CUTTLELY_LOCAL_ADMIN')) {
        throw new SettingsError(
            409,
            'LOCKED',
            'The password sign-in is set by the host, so it can only be turned on there. Set up AuthKit instead.'
        )
    }
    const closed = await setupClosed(deps)
    if (closed) throw new SettingsError(410, 'SETUP_CLOSED', CLOSED_MESSAGE[closed])
    // The HMAC bound when this browser opened the link, checked against the stored row. This process may no
    // longer have the plaintext (a restart, or a second copy that did not print the link).
    const hmac = setupSessionCodeHmac(req)
    if (!hmac || !(await storedSetupCodeLive(hmac))) {
        await reissueExpiredSetupCode()
        throw new SettingsError(410, 'SETUP_CLOSED', 'Open the setup link from the server log again.')
    }
    // Turn the password sign-in on first: if the file can't be written, no account exists that nobody can use. If
    // the account can't be created, the link keeps working for another try (and after a restart the password
    // sign-in offers the usual first-account link).
    await writeValues(deps.service, { CUTTLELY_LOCAL_ADMIN: 'true' }, SETUP_BY, 'save', 'Password sign-in turned on from the setup link.')
    try {
        await deps
            .users()
            .createOwner(
                { email, name, credential: await hashPassword(password), externalId: null },
                { consumeSetupHmac: hmac, now: Date.now(), activateLocalAuthentication: true }
            )
    } catch (error) {
        if (error instanceof NotEmptyError) throw new SettingsError(410, 'SETUP_CLOSED', CLOSED_MESSAGE['has-account'])
        if (error instanceof SetupCodeRejected) throw new SettingsError(410, 'SETUP_CLOSED', CLOSED_MESSAGE.used)
        throw error
    }
    const restart = await finishSetup(deps)
    return { ...restart, email }
}
