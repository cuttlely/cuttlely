// Set up AuthKit from the Server settings page: check the values, then a real test sign-in with the values on the
// page, before anything is saved. The test is bound to the owner's browser session and expires after 10 minutes.
// The values wait in server memory (never sent back to the browser) and are saved only when the owner chooses to.
import { createHash, randomBytes } from 'crypto'
import { Request, Response } from 'express'
import { LOCAL_SESSION_COOKIE, WOS_SESSION_COOKIE } from '../identity/constants'
import { isAuthKitEligible } from '../identity/link'
import { UserRow, WorkosIdentity } from '../identity/types'
import { AUTHKIT_KEYS, AuthKitProof, authKitEnvironment, authKitFingerprint, writeAuthKitProof } from './authkit-proof'
import { TestInputError, cleanMessage, valuesWithDrafts } from './connection'
import { appendHistory } from './history'
import { ServiceDeps, SettingsError, SettingsView, writeValues } from './service'
import { setupSessionHash } from './setup-session'

export const AUTHKIT_SECTION = ['signin']
export const TEST_STATE_PREFIX = 'dfst.'
export const TEST_TTL_MS = 10 * 60 * 1000
export const CALLBACK_PATH = '/api/v1/auth/callback'
const SETUP_KEYS = [...AUTHKIT_KEYS, 'CUTTLELY_BOOTSTRAP_EMAIL'] as const

type Values = Record<string, string>

export interface AuthKitCheck {
    key: string
    label: string
    ok: boolean
    /** A warning: worth reading, does not stop the test. */
    warn?: boolean
    detail?: string
}

export interface AuthKitCheckResult {
    ok: boolean
    environment: AuthKitProof['environment']
    checks: AuthKitCheck[]
    addresses?: { redirectUri: string; signOutUri: string; homepage: string; initiateLogin: string }
}

export interface AuthKitPort {
    authorizationUrl(input: { apiKey: string; clientId: string; redirectUri: string; state: string }): string
    exchange(input: {
        apiKey: string
        clientId: string
        code: string
        cookiePassword: string
    }): Promise<{ user: WorkosIdentity; sealed: string }>
    unseal(input: { apiKey: string; clientId: string; sealed: string; cookiePassword: string }): Promise<boolean>
    checkKey(apiKey: string): Promise<'ok' | 'rejected' | 'unreachable'>
}

export interface AuthKitUsers {
    findUserByExternalId(externalId: string): Promise<UserRow | null>
    findUsersByEmail(email: string): Promise<UserRow[]>
    countUsers?(): Promise<number>
}

/**
 * Who runs a test sign-in. The owner, from Server settings, or (mode setup) whoever opened the one-time setup link
 * on a server where nobody can sign in yet. A test always has to come back to the same browser session.
 */
export interface Principal {
    id: string
    by: string
    sessionHash: string | null
    mode: 'owner' | 'setup'
}

export interface AuthKitDeps {
    port: AuthKitPort
    users: () => AuthKitUsers
    now: () => number
}

export type TestStatus = 'waiting' | 'passed' | 'failed' | 'expired'

interface TestRecord {
    state: string
    ownerId: string
    mode: Principal['mode']
    sessionHash: string
    by: string
    values: Values
    environment: AuthKitProof['environment']
    createdAt: number
    status: TestStatus
    message?: string
    signedInAs?: string
    steps: { label: string; ok: boolean; detail?: string }[]
    finishedAt?: number
    applied?: boolean
}

const tests = new Map<string, TestRecord>()
const latestByOwner = new Map<string, string>()

/** Tests only. */
export function resetAuthKitTests(): void {
    tests.clear()
    latestByOwner.clear()
}

function hash(text: string): string {
    return createHash('sha256').update(text).digest('hex')
}

/** The owner's current browser session, as a hash. A test must come back to the same session. */
export function sessionHashOf(req: Request): string | null {
    const cookies = (req.cookies || {}) as Record<string, string | undefined>
    const value = cookies[LOCAL_SESSION_COOKIE] || cookies[WOS_SESSION_COOKIE]
    return value ? hash(`${LOCAL_SESSION_COOKIE}\n${value}`) : null
}

export function requestOrigin(req: Request): string {
    const host = req.get('host') || 'localhost'
    return `${req.protocol}://${host}`
}

function addressesFor(redirectUri: string) {
    const origin = new URL(redirectUri).origin
    return { redirectUri, signOutUri: `${origin}/signin`, homepage: origin, initiateLogin: `${origin}/api/v1/auth/login` }
}

/** Checks the AuthKit values without calling WorkOS. */
export function checkAuthKitValues(values: Values, origin: string): AuthKitCheckResult {
    const checks: AuthKitCheck[] = []
    const apiKey = (values.WORKOS_API_KEY ?? '').trim()
    const environment = authKitEnvironment(apiKey)
    checks.push(
        !apiKey
            ? { key: 'WORKOS_API_KEY', label: 'API key', ok: false, detail: 'Paste the API key from WorkOS, Developer, API Keys.' }
            : environment === 'unknown'
            ? {
                  key: 'WORKOS_API_KEY',
                  label: 'API key',
                  ok: false,
                  detail: 'WorkOS API keys start with sk_test_ (Staging) or sk_live_ (Production).'
              }
            : {
                  key: 'WORKOS_API_KEY',
                  label: 'API key',
                  ok: true,
                  detail: environment === 'staging' ? 'Staging key.' : 'Production key.'
              }
    )
    const clientId = (values.WORKOS_CLIENT_ID ?? '').trim()
    checks.push(
        clientId.startsWith('client_') && clientId.length > 'client_'.length
            ? { key: 'WORKOS_CLIENT_ID', label: 'Client ID', ok: true }
            : {
                  key: 'WORKOS_CLIENT_ID',
                  label: 'Client ID',
                  ok: false,
                  detail: 'The Client ID starts with client_. It is under Applications, on the Details tab.'
              }
    )
    const redirect = (values.WORKOS_REDIRECT_URI ?? '').trim()
    let addresses: AuthKitCheckResult['addresses']
    let url: URL | null = null
    try {
        url = redirect ? new URL(redirect) : null
    } catch {
        url = null
    }
    if (!url || !/^https?:$/.test(url.protocol)) {
        checks.push({
            key: 'WORKOS_REDIRECT_URI',
            label: 'Redirect URI',
            ok: false,
            detail: `Use this server's address followed by ${CALLBACK_PATH}.`
        })
    } else if (url.pathname !== CALLBACK_PATH || url.search || url.hash) {
        checks.push({
            key: 'WORKOS_REDIRECT_URI',
            label: 'Redirect URI',
            ok: false,
            detail: `It must end with ${CALLBACK_PATH}, with nothing after it.`
        })
    } else if (environment === 'production' && url.protocol !== 'https:') {
        checks.push({ key: 'WORKOS_REDIRECT_URI', label: 'Redirect URI', ok: false, detail: 'Production needs an https:// address.' })
    } else {
        addresses = addressesFor(url.toString())
        const sameHost = url.origin === origin
        checks.push({
            key: 'WORKOS_REDIRECT_URI',
            label: 'Redirect URI',
            ok: true,
            warn: !sameHost,
            detail: sameHost
                ? undefined
                : `You opened Cuttlely at ${origin}. Open it at ${url.origin} to run the test sign-in, so it comes back to this page.`
        })
    }
    const seal = values.WORKOS_COOKIE_PASSWORD ?? ''
    checks.push(
        seal.length >= 32
            ? { key: 'WORKOS_COOKIE_PASSWORD', label: 'Session seal', ok: true }
            : {
                  key: 'WORKOS_COOKIE_PASSWORD',
                  label: 'Session seal',
                  ok: false,
                  detail: 'Use Generate seal, or paste at least 32 characters.'
              }
    )
    const email = (values.CUTTLELY_BOOTSTRAP_EMAIL ?? '').trim()
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        checks.push({
            key: 'CUTTLELY_BOOTSTRAP_EMAIL',
            label: 'First owner email',
            ok: false,
            detail: 'That does not look like an email address.'
        })
    }
    return { ok: checks.every((check) => check.ok), environment, checks, addresses }
}

async function authKitValues(deps: ServiceDeps, drafts: unknown) {
    if (drafts !== undefined && (!drafts || typeof drafts !== 'object' || Array.isArray(drafts))) {
        throw new TestInputError('Send the AuthKit values as values.')
    }
    const result = await valuesWithDrafts(deps, AUTHKIT_SECTION, (drafts ?? {}) as Record<string, unknown>)
    const unreadable = result.unreadable.filter((key) => (SETUP_KEYS as readonly string[]).includes(key))
    return { ...result, unreadable }
}

/** Format checks, then whether WorkOS accepts the API key. */
export async function checkAuthKit(deps: ServiceDeps, kit: AuthKitDeps, input: unknown, origin: string): Promise<AuthKitCheckResult> {
    const { values, unreadable, secrets } = await authKitValues(deps, (input as { values?: unknown })?.values)
    const result = checkAuthKitValues(values, origin)
    for (const key of unreadable) {
        const check = result.checks.find((item) => item.key === key)
        if (check) Object.assign(check, { ok: false, detail: 'The saved value could not be read on this server. Enter it again.' })
    }
    const keyCheck = result.checks.find((check) => check.key === 'WORKOS_API_KEY')
    if (keyCheck?.ok) {
        const answer = await kit.port.checkKey(values.WORKOS_API_KEY).catch(() => 'unreachable' as const)
        if (answer === 'rejected') Object.assign(keyCheck, { ok: false, detail: 'WorkOS did not accept this API key.' })
        if (answer === 'unreachable')
            Object.assign(keyCheck, { warn: true, detail: `${keyCheck.detail} WorkOS could not be reached to confirm it.` })
        if (answer === 'ok') keyCheck.detail = `${keyCheck.detail} WorkOS accepted it.`
    }
    result.ok = result.checks.every((check) => check.ok)
    result.checks = result.checks.map((check) => (check.detail ? { ...check, detail: cleanMessage(check.detail, secrets) } : check))
    return result
}

/** The signed-in owner of this request. */
export function ownerPrincipal(req: Request): Principal {
    const user = req.user as { id?: unknown; email?: unknown } | undefined
    const id = typeof user?.id === 'string' ? user.id : ''
    if (!id) throw new SettingsError(403, 'FORBIDDEN', 'Sign in as the owner first.')
    return { id, by: typeof user?.email === 'string' && user.email ? user.email : id, sessionHash: sessionHashOf(req), mode: 'owner' }
}

/** Starts a test sign-in. Answers with the AuthKit address to open. */
export async function startAuthKitTest(
    deps: ServiceDeps,
    kit: AuthKitDeps,
    req: Request,
    owner: Principal = ownerPrincipal(req)
): Promise<{ url: string; expiresAt: string }> {
    const sessionHash = owner.sessionHash
    if (!sessionHash) throw new SettingsError(403, 'FORBIDDEN', 'Sign in as the owner first.')
    const { values, unreadable } = await authKitValues(deps, (req.body as { values?: unknown })?.values)
    if (owner.mode === 'setup' && !(values.CUTTLELY_BOOTSTRAP_EMAIL ?? '').trim()) {
        throw new TestInputError('Enter the owner email first.', [
            { key: 'CUTTLELY_BOOTSTRAP_EMAIL', message: 'The first person to sign in with this email becomes the owner.' }
        ])
    }
    if (unreadable.length) throw new TestInputError('A saved AuthKit value could not be read on this server. Enter it again.')
    const checked = checkAuthKitValues(values, requestOrigin(req))
    if (!checked.ok) {
        throw new TestInputError(
            'Fix these first.',
            checked.checks.filter((check) => !check.ok).map((check) => ({ key: check.key, message: check.detail ?? check.label }))
        )
    }
    const previous = latestByOwner.get(owner.id)
    if (previous) tests.delete(previous)
    const state = `${TEST_STATE_PREFIX}${randomBytes(32).toString('base64url')}`
    const record: TestRecord = {
        state,
        ownerId: owner.id,
        mode: owner.mode,
        sessionHash,
        by: owner.by,
        values: Object.fromEntries(SETUP_KEYS.map((key) => [key, values[key] ?? ''])),
        environment: checked.environment,
        createdAt: kit.now(),
        status: 'waiting',
        steps: []
    }
    tests.set(state, record)
    latestByOwner.set(owner.id, state)
    const url = kit.port.authorizationUrl({
        apiKey: values.WORKOS_API_KEY,
        clientId: values.WORKOS_CLIENT_ID,
        redirectUri: values.WORKOS_REDIRECT_URI,
        state
    })
    return { url, expiresAt: new Date(record.createdAt + TEST_TTL_MS).toISOString() }
}

function expired(record: TestRecord, now: number): boolean {
    return record.status === 'waiting' && now - record.createdAt > TEST_TTL_MS
}

export interface AuthKitTestView {
    status: TestStatus | 'none'
    message?: string
    signedInAs?: string
    environment?: AuthKitProof['environment']
    steps?: { label: string; ok: boolean; detail?: string }[]
    finishedAt?: string
    applied?: boolean
    /** What will be saved: plain values in full, secrets as set or not. */
    values?: Record<string, string | { set: boolean }>
}

export function authKitTestStatus(kit: AuthKitDeps, req: Request, owner: Principal = ownerPrincipal(req)): AuthKitTestView {
    const state = latestByOwner.get(owner.id)
    const record = state ? tests.get(state) : undefined
    if (!record) return { status: 'none' }
    if (expired(record, kit.now())) {
        record.status = 'expired'
        record.message = 'The test sign-in took longer than 10 minutes. Start it again.'
    }
    const secretKeys = new Set(['WORKOS_API_KEY', 'WORKOS_COOKIE_PASSWORD'])
    return {
        status: record.status,
        message: record.message,
        signedInAs: record.signedInAs,
        environment: record.environment,
        steps: record.steps,
        finishedAt: record.finishedAt ? new Date(record.finishedAt).toISOString() : undefined,
        applied: record.applied,
        values: Object.fromEntries(
            Object.entries(record.values).map(([key, value]) => [key, secretKeys.has(key) ? { set: value !== '' } : value])
        )
    }
}

/** The sign-in a test found would work for the owner, without changing anything. */
async function wouldSignInAsOwner(
    users: AuthKitUsers,
    identity: WorkosIdentity,
    ownerId: string
): Promise<{ ok: boolean; detail: string }> {
    if (identity.emailVerified !== true)
        return { ok: false, detail: 'WorkOS says this email is not verified. Keep email verification on in WorkOS.' }
    const byExternal = await users.findUserByExternalId(identity.id)
    if (byExternal) {
        if (byExternal.id !== ownerId)
            return { ok: false, detail: 'This WorkOS account already belongs to another Cuttlely user. Sign in as yourself.' }
        if (!isAuthKitEligible(byExternal.status)) return { ok: false, detail: 'Your Cuttlely account is not active.' }
        return { ok: true, detail: `${identity.email} signs in as you.` }
    }
    const byEmail = await users.findUsersByEmail(identity.email)
    const mine = byEmail.find((row) => row.id === ownerId)
    if (!mine) {
        return {
            ok: false,
            detail: `${identity.email} is not your Cuttlely account. Sign in to AuthKit with your own email, the one you use here.`
        }
    }
    if (mine.externalId && mine.externalId !== identity.id) {
        return {
            ok: false,
            detail: 'Your account is already linked to a different WorkOS sign-in, for example from the other WorkOS environment (Staging or Production).'
        }
    }
    return { ok: true, detail: `${identity.email} signs in as you. Cuttlely links the two the first time you sign in for real.` }
}

/** On a server with no account yet: the test identity becomes the owner at the first real sign-in. */
async function wouldBecomeOwner(
    users: AuthKitUsers,
    identity: WorkosIdentity,
    ownerEmail: string
): Promise<{ ok: boolean; detail: string }> {
    if (identity.emailVerified !== true)
        return { ok: false, detail: 'WorkOS says this email is not verified. Keep email verification on in WorkOS.' }
    if (!users.countUsers || (await users.countUsers()) > 0) return { ok: false, detail: 'This server already has an account.' }
    if (identity.email.trim().toLowerCase() !== ownerEmail.trim().toLowerCase()) {
        return { ok: false, detail: `You signed in as ${identity.email}. Sign in with the owner email you entered, or change it.` }
    }
    return { ok: true, detail: `${identity.email} becomes the owner at the first sign-in.` }
}

/** AuthKit came back from a test sign-in. Runs the exchange with the values on test and records the result. */
export async function handleAuthKitTestCallback(deps: ServiceDeps, kit: AuthKitDeps, req: Request, res: Response): Promise<void> {
    const state = String(req.query.state ?? '')
    const record = tests.get(state)
    const back = (outcome: string) =>
        res.redirect(302, record?.mode === 'setup' ? `/setup?authkit=${outcome}` : `/server-settings?section=signin&authkit=${outcome}`)
    if (!record) return back('expired')
    if (expired(record, kit.now())) {
        record.status = 'expired'
        record.message = 'The test sign-in took longer than 10 minutes. Start it again.'
        return back('expired')
    }
    if (record.status !== 'waiting') return back('done')
    const finish = (status: TestStatus, message: string) => {
        record.status = status
        record.message = cleanMessage(message, [record.values.WORKOS_API_KEY, record.values.WORKOS_COOKIE_PASSWORD])
        record.finishedAt = kit.now()
        record.steps = record.steps.map((step) =>
            step.detail
                ? { ...step, detail: cleanMessage(step.detail, [record.values.WORKOS_API_KEY, record.values.WORKOS_COOKIE_PASSWORD]) }
                : step
        )
        if (status !== 'passed') record.values = { ...record.values, WORKOS_API_KEY: '', WORKOS_COOKIE_PASSWORD: '' }
        return back('done')
    }
    const sessionNow = record.mode === 'setup' ? setupSessionHash(req, kit.now()) : sessionHashOf(req)
    if (sessionNow !== record.sessionHash) {
        record.steps.push({ label: 'Same browser session', ok: false, detail: 'The test came back to a different browser or session.' })
        return finish('failed', 'The test sign-in has to finish in the browser that started it.')
    }
    const error = req.query.error ? String(req.query.error) : ''
    if (error) {
        const description = req.query.error_description ? String(req.query.error_description) : error
        record.steps.push({ label: 'AuthKit sign-in', ok: false, detail: description })
        return finish('failed', 'AuthKit did not finish the sign-in.')
    }
    const code = String(req.query.code ?? '')
    if (!code) {
        record.steps.push({ label: 'AuthKit sign-in', ok: false, detail: 'AuthKit came back without a sign-in code.' })
        return finish('failed', 'AuthKit did not finish the sign-in.')
    }
    record.steps.push({ label: 'AuthKit sign-in', ok: true })
    const values = record.values
    let identity: WorkosIdentity
    let sealed: string
    try {
        const exchanged = await kit.port.exchange({
            apiKey: values.WORKOS_API_KEY,
            clientId: values.WORKOS_CLIENT_ID,
            code,
            cookiePassword: values.WORKOS_COOKIE_PASSWORD
        })
        identity = exchanged.user
        sealed = exchanged.sealed
        record.steps.push({ label: 'WorkOS accepted the API key and Client ID', ok: true })
    } catch (failure) {
        const status = Number((failure as { status?: unknown })?.status)
        const detail =
            status === 401
                ? 'WorkOS did not accept the API key.'
                : status === 400 || status === 422
                ? 'WorkOS refused the sign-in code. Check that the Client ID belongs to the same environment as the API key.'
                : failure instanceof Error
                ? failure.message
                : 'WorkOS could not be reached.'
        record.steps.push({ label: 'WorkOS accepted the API key and Client ID', ok: false, detail })
        return finish('failed', 'WorkOS did not complete the sign-in.')
    }
    try {
        const ok = await kit.port.unseal({
            apiKey: values.WORKOS_API_KEY,
            clientId: values.WORKOS_CLIENT_ID,
            sealed,
            cookiePassword: values.WORKOS_COOKIE_PASSWORD
        })
        record.steps.push({ label: 'The session seal works', ok, detail: ok ? undefined : 'The sealed session could not be opened again.' })
        if (!ok) return finish('failed', 'The session seal did not work.')
    } catch (failure) {
        record.steps.push({ label: 'The session seal works', ok: false, detail: failure instanceof Error ? failure.message : undefined })
        return finish('failed', 'The session seal did not work.')
    }
    let match: { ok: boolean; detail: string }
    try {
        match =
            record.mode === 'setup'
                ? await wouldBecomeOwner(kit.users(), identity, record.values.CUTTLELY_BOOTSTRAP_EMAIL ?? '')
                : await wouldSignInAsOwner(kit.users(), identity, record.ownerId)
    } catch {
        match = { ok: false, detail: 'Cuttlely could not look up the account.' }
    }
    record.steps.push({ label: record.mode === 'setup' ? 'Becomes the owner' : 'Signs in as you', ok: match.ok, detail: match.detail })
    if (!match.ok) {
        return finish(
            'failed',
            record.mode === 'setup'
                ? 'AuthKit works, but this sign-in would not become the owner.'
                : 'AuthKit works, but it would not sign you in to this account.'
        )
    }
    record.signedInAs = identity.email
    const key = await deps.key()
    writeAuthKitProof(deps.state.dir, {
        fingerprint: authKitFingerprint(values, key),
        passedAt: new Date(kit.now()).toISOString(),
        by: record.by,
        environment: record.environment
    })
    appendHistory(deps.state.dir, {
        kind: 'test',
        by: record.by,
        note: `Test sign-in with AuthKit passed (${record.environment}).`,
        outcome: 'ok'
    })
    return finish('passed', 'Test sign-in passed. AuthKit works with these settings.')
}

/** Saves the values from a passed test, and turns password sign-in off when asked. */
export async function applyAuthKitTest(
    deps: ServiceDeps,
    kit: AuthKitDeps,
    req: Request,
    owner: Principal = ownerPrincipal(req)
): Promise<SettingsView> {
    const state = latestByOwner.get(owner.id)
    const record = state ? tests.get(state) : undefined
    if (!record || record.status !== 'passed' || record.applied) {
        throw new SettingsError(409, 'AUTHKIT_NOT_TESTED', 'Run a test sign-in that passes first.')
    }
    if (kit.now() - (record.finishedAt ?? 0) > TEST_TTL_MS) {
        throw new SettingsError(409, 'AUTHKIT_NOT_TESTED', 'That test is more than 10 minutes old. Test sign-in again.')
    }
    if (record.mode !== owner.mode || record.ownerId !== owner.id) {
        throw new SettingsError(409, 'AUTHKIT_NOT_TESTED', 'Run a test sign-in that passes first.')
    }
    // From the setup link there is no password sign-in to keep or turn off.
    const keepPassword = owner.mode === 'setup' || (req.body as { keepPassword?: unknown })?.keepPassword !== false
    const hostKeys = new Set(deps.state.hostKeys)
    const changes: Values = {}
    for (const key of SETUP_KEYS) if (!hostKeys.has(key)) changes[key] = record.values[key] ?? ''
    if (!keepPassword) {
        if (hostKeys.has('CUTTLELY_LOCAL_ADMIN')) {
            throw new SettingsError(409, 'LOCKED', 'Password sign-in is set by the host, so it can only be turned off there.')
        }
        changes.CUTTLELY_LOCAL_ADMIN = 'false'
    }
    const view = await writeValues(deps, changes, owner.by, 'save', 'AuthKit set up after a test sign-in passed.')
    record.applied = true
    record.values = Object.fromEntries(Object.keys(record.values).map((key) => [key, '']))
    return view
}

/** Real WorkOS calls. */
export function defaultAuthKitDeps(): AuthKitDeps {
    const { WorkOS } = require('@workos-inc/node')
    const client = (apiKey: string, clientId: string) => new WorkOS(apiKey, { clientId })
    return {
        port: {
            authorizationUrl: ({ apiKey, clientId, redirectUri, state }) =>
                client(apiKey, clientId).userManagement.getAuthorizationUrl({ provider: 'authkit', redirectUri, clientId, state }),
            exchange: async ({ apiKey, clientId, code, cookiePassword }) => {
                const response = await client(apiKey, clientId).userManagement.authenticateWithCode({
                    code,
                    clientId,
                    session: { sealSession: true, cookiePassword }
                })
                if (!response.sealedSession) throw new Error('WorkOS did not return a session.')
                const user = response.user
                return {
                    user: { id: user.id, email: user.email, emailVerified: user.emailVerified === true, name: user.name ?? null },
                    sealed: response.sealedSession
                }
            },
            unseal: async ({ apiKey, clientId, sealed, cookiePassword }) => {
                const session = client(apiKey, clientId).userManagement.loadSealedSession({ sessionData: sealed, cookiePassword })
                const result = await session.authenticate()
                return result.authenticated === true
            },
            checkKey: async (apiKey) => {
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), 8000)
                try {
                    const response = await fetch('https://api.workos.com/user_management/users?limit=1', {
                        headers: { Authorization: `Bearer ${apiKey}` },
                        signal: controller.signal
                    })
                    if (response.status === 401 || response.status === 403) return 'rejected'
                    return response.ok ? 'ok' : 'unreachable'
                } catch {
                    return 'unreachable'
                } finally {
                    clearTimeout(timer)
                }
            }
        },
        users: () => require('../identity/production').identityStore(),
        now: () => Date.now()
    }
}
