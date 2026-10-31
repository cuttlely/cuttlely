/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { Request, Response, Router } from 'express'
import { isIP } from 'net'
import {
    expiredOidcBrowserCookie,
    oidcBrowserCookie,
    oidcCallbackUrl,
    oidcSessionCookieSecure,
    recentAuthenticationCookie
} from './cookies'
import { LOGIN_FAILURE_WINDOW_MS, OIDC_BROWSER_COOKIE, RECENT_AUTH_COOKIE, signinErrorUrl } from './constants'
import { issueDatabaseSession, establishSession } from './handlers'
import {
    IdentityFailureRateLimit,
    identityRouteLimit,
    OIDC_ADMIN_WRITE_LIMIT,
    OIDC_CALLBACK_LIMIT,
    OIDC_FAILURE_LIMIT,
    OIDC_LOGIN_START_LIMIT,
    OIDC_TEST_START_LIMIT
} from './rateLimit'
import { applicationDataSource, applicationSql, buildAuthContext, identityStore } from './production'
import { requirePermission } from './rbac'
import {
    beginOidcAuthorization,
    checkOidcConfiguration,
    completeOidcAuthorization,
    oidcCallbackError,
    oidcReauthenticationIsRecent,
    OidcError
} from './oidcProvider'
import {
    isEntraAuthorityIssuer,
    migrateLegacyProviderLinks,
    oidcConfigurationFingerprint,
    oidcProviderKey,
    providerLinkMigrationStatus,
    readOidcConfiguration,
    recordOidcTestResult,
    resolveOidcUser,
    saveOidcDraft,
    validatedOidcIssuer
} from './oidcStore'
import { readAuthenticationState, recordRecentAuthentication } from './authenticationState'
import {
    oidcCallbackFailureAuditDetail,
    oidcFailureLogDetail,
    oidcLinkAuditDetail,
    organizationsForUser,
    safeRecordAudit
} from './auditLog'
import { recentlyAuthenticated } from './authenticationRoutes'

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|::1)$/i

export const oidcAdminRouter = Router()
export const oidcAuthRouter = Router()
const startFailures = new IdentityFailureRateLimit(OIDC_FAILURE_LIMIT)
const callbackFailures = new IdentityFailureRateLimit(OIDC_FAILURE_LIMIT)
const callbackLimitAuditAt = new Map<string, number>()
const CALLBACK_LIMIT_AUDIT_MS = LOGIN_FAILURE_WINDOW_MS

function address(req: Request): string {
    return req.ip || req.socket?.remoteAddress || 'unknown'
}

function actor(req: Request): { id: string; organizationId: string } | null {
    const user = req.user as { id?: unknown; activeOrganizationId?: unknown } | undefined
    return typeof user?.id === 'string' && typeof user.activeOrganizationId === 'string'
        ? { id: user.id, organizationId: user.activeOrganizationId }
        : null
}

export function oidcPostLogoutUrl(): string {
    return `${new URL(oidcCallbackUrl()).origin}/signin`
}

function configuredCallbackError(): string | null {
    const configuredOrigin = process.env.RENDER_EXTERNAL_URL?.trim() || process.env.APP_URL?.trim()
    return oidcCallbackError(configuredOrigin || oidcCallbackUrl())
}

function cacheNoStore(res: Response): void {
    res.set('Cache-Control', 'no-store')
}

function oidcCookieIsSecure(req: Request): boolean {
    return oidcSessionCookieSecure(Boolean(req.secure) || req.protocol === 'https')
}

function providerCallbackUrl(req: Request): string {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined
    return oidcCallbackUrl(provider)
}

function setOidcBrowserCookie(req: Request, res: Response, value: string): void {
    const cookie = oidcBrowserCookie(value, oidcCookieIsSecure(req))
    res.cookie(cookie.name, cookie.value, cookie.options)
}

function clearOidcBrowserCookie(req: Request, res: Response): void {
    const cookie = expiredOidcBrowserCookie(oidcCookieIsSecure(req))
    res.cookie(cookie.name, cookie.value, cookie.options)
}

function configurationBody(config: Awaited<ReturnType<typeof readOidcConfiguration>>) {
    if (!config) return { configured: false, version: 0, fingerprint: null, health: 'unchecked' }
    return {
        configured: true,
        issuer: config.issuer,
        clientId: config.clientId,
        clientSecretEnvVar: config.clientSecretEnvVar,
        clientSecretPresent: Boolean(process.env[config.clientSecretEnvVar]),
        trustMissingEmailVerification: config.trustMissingEmailVerification,
        privateIssuerHosts: config.privateIssuerHosts,
        fingerprint: config.fingerprint,
        health: config.health,
        healthError: config.healthError,
        checkedAt: config.checkedAt,
        tested: config.testedFingerprint === config.fingerprint,
        testedAt: config.testedAt,
        testResult: config.testResult,
        version: config.version
    }
}

async function auditConfiguration(req: Request, outcome: string, fingerprint: string | null): Promise<void> {
    const who = actor(req)
    if (!who) return
    await safeRecordAudit(applicationSql(), {
        type: 'auth_config_change',
        organizationId: who.organizationId,
        workspaceId: null,
        userId: who.id,
        actorId: who.id,
        summary: 'OIDC configuration changed',
        detail: { outcome, configurationFingerprint: fingerprint }
    })
}

async function auditCallbackFailure(error: unknown): Promise<void> {
    await safeRecordAudit(applicationSql(), {
        type: 'sign_in_failure',
        organizationId: '',
        workspaceId: null,
        userId: null,
        actorId: null,
        summary: 'OIDC callback failed',
        detail: oidcCallbackFailureAuditDetail(error)
    })
}

function auditCallbackLimitDue(clientAddress: string, now = Date.now()): boolean {
    for (const [address, recordedAt] of callbackLimitAuditAt) {
        if (now - recordedAt >= CALLBACK_LIMIT_AUDIT_MS) callbackLimitAuditAt.delete(address)
    }
    if (callbackLimitAuditAt.has(clientAddress)) return false
    callbackLimitAuditAt.set(clientAddress, now)
    return true
}

oidcAdminRouter.use(requirePermission('authentication:manage'))

oidcAdminRouter.get('/', async (_req, res) => {
    cacheNoStore(res)
    try {
        const state = await readAuthenticationState(applicationDataSource())
        if (state) await migrateLegacyProviderLinks(applicationDataSource(), state)
        const [draft, active, migration] = await Promise.all([
            readOidcConfiguration(applicationDataSource(), 'draft'),
            readOidcConfiguration(applicationDataSource(), 'active'),
            providerLinkMigrationStatus(applicationDataSource())
        ])
        res.status(200).json({
            draft: configurationBody(draft),
            active: configurationBody(active),
            callbackUrl: draft && state ? oidcCallbackUrl(oidcProviderKey(state.installationId, draft.issuer, draft.clientId)) : null,
            callbackError: configuredCallbackError(),
            postLogoutUrl: oidcPostLogoutUrl(),
            scopes: ['openid', 'email', 'profile'],
            linkMigrationComplete: migration.complete,
            linkMigration: migration
        })
    } catch {
        res.status(500).json({ message: 'OIDC settings could not be read.' })
    }
})

oidcAdminRouter.put('/', identityRouteLimit(OIDC_ADMIN_WRITE_LIMIT), async (req, res) => {
    cacheNoStore(res)
    const who = actor(req)
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (!(await recentlyAuthenticated(req))) return void res.status(409).json({ code: 'REAUTH_REQUIRED', message: 'Sign in again first.' })
    const body = (req.body || {}) as Record<string, unknown>
    const issuer = validatedOidcIssuer(body.issuer)
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : ''
    const clientSecretEnvVar = typeof body.clientSecretEnvVar === 'string' ? body.clientSecretEnvVar.trim() : ''
    const trustMissingEmailVerification = body.trustMissingEmailVerification === true
    const privateIssuerHosts = Array.isArray(body.privateIssuerHosts)
        ? [
              ...new Set(
                  body.privateIssuerHosts
                      .map(String)
                      .map((host) => host.trim().toLowerCase())
                      .filter(Boolean)
              )
          ]
        : []
    const version = Number(body.version)
    if (!issuer || !clientId || !ENV_NAME.test(clientSecretEnvVar) || !Number.isInteger(version) || version < 0) {
        return void res.status(400).json({ message: 'Issuer, client id, secret environment variable name, and version are required.' })
    }
    if (privateIssuerHosts.some((host) => (isIP(host) === 0 && !HOST_NAME.test(host)) || host.includes('..'))) {
        return void res.status(400).json({ message: 'Private issuer hosts must be exact host names.' })
    }
    const fingerprint = oidcConfigurationFingerprint({
        issuer,
        clientId,
        clientSecretEnvVar,
        trustMissingEmailVerification,
        privateIssuerHosts
    })
    const base = {
        issuer,
        clientId,
        clientSecretEnvVar,
        trustMissingEmailVerification,
        privateIssuerHosts,
        fingerprint,
        discovery: null,
        health: 'unchecked' as const,
        healthError: null,
        checkedAt: null
    }
    try {
        const discovery = await checkOidcConfiguration({
            ...base,
            slot: 'draft',
            version,
            testedFingerprint: null,
            testedAt: null,
            testResult: null
        })
        const saved = await saveOidcDraft(
            applicationDataSource(),
            { ...base, discovery: discovery as unknown as Record<string, unknown>, health: 'ready', checkedAt: new Date().toISOString() },
            version
        )
        await auditConfiguration(req, 'saved', saved.fingerprint)
        const state = await readAuthenticationState(applicationDataSource())
        res.status(200).json({
            draft: configurationBody(saved),
            callbackUrl: state ? oidcCallbackUrl(oidcProviderKey(state.installationId, saved.issuer, saved.clientId)) : null
        })
    } catch (error) {
        const category = error instanceof OidcError ? error.category : 'configuration'
        try {
            const saved = await saveOidcDraft(
                applicationDataSource(),
                { ...base, health: 'error', healthError: category, checkedAt: new Date().toISOString() },
                version
            )
            await auditConfiguration(req, 'saved_with_error', saved.fingerprint)
            res.status(200).json({ draft: configurationBody(saved) })
        } catch (saveError) {
            res.status(saveError instanceof Error && saveError.message === 'OIDC_CONFIG_CHANGED' ? 409 : 500).json({
                message:
                    saveError instanceof Error && saveError.message === 'OIDC_CONFIG_CHANGED'
                        ? 'OIDC settings changed. Reload and try again.'
                        : 'OIDC settings could not be saved.'
            })
        }
    }
})

oidcAdminRouter.post('/test', identityRouteLimit(OIDC_TEST_START_LIMIT), async (req, res) => {
    cacheNoStore(res)
    const who = actor(req)
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    try {
        const callbackError = configuredCallbackError()
        if (callbackError) return void res.status(409).json({ code: 'OIDC_HTTPS_REQUIRED', message: callbackError })
        const state = await readAuthenticationState(applicationDataSource())
        if (!state) throw new Error('state')
        const begun = await beginOidcAuthorization({
            dataSource: applicationDataSource(),
            slot: 'draft',
            installationId: state.installationId,
            authenticationEpoch: state.authenticationEpoch,
            callbackUrl: oidcCallbackUrl(),
            redirectTarget: '/authentication-settings',
            purpose: 'test',
            initiatingUserId: who.id
        })
        setOidcBrowserCookie(req, res, begun.browserNonce)
        res.status(200).json({ url: begun.url })
    } catch (error) {
        res.status(409).json({
            message: error instanceof OidcError && error.category === 'configuration' ? error.message : 'OIDC test sign-in could not start.'
        })
    }
})

function safeSigninMessage(error: unknown): string {
    if (error instanceof OidcError && error.category === 'denied') return 'Sign-in was denied.'
    if (error instanceof OidcError && error.category === 'transaction') return 'This sign-in attempt expired or is no longer valid.'
    if (error instanceof OidcError && error.category === 'upstream') return 'The identity provider is temporarily unavailable.'
    return 'Sign-in could not be completed.'
}

async function beginPublic(req: Request, res: Response, purpose: 'signin' | 'reauth' | 'invite', invitationToken?: string) {
    cacheNoStore(res)
    const clientAddress = address(req)
    if (startFailures.blocked(clientAddress)) return void res.redirect(302, signinErrorUrl('Too many attempts. Try again later.'))
    try {
        const state = await readAuthenticationState(applicationDataSource())
        if (!state || state.activeMethod !== 'oidc') return void res.status(404).json({ message: 'Not Found' })
        const ctx = await buildAuthContext(req)
        const current = purpose === 'reauth' ? await establishSession(ctx) : null
        if (purpose === 'reauth' && !current?.user) return void res.redirect(302, '/signin')
        const begun = await beginOidcAuthorization({
            dataSource: applicationDataSource(),
            slot: 'active',
            installationId: state.installationId,
            authenticationEpoch: state.authenticationEpoch,
            callbackUrl: oidcCallbackUrl(),
            redirectTarget: purpose === 'reauth' ? '/authentication-settings' : '/',
            purpose,
            initiatingUserId: current?.user?.id || null,
            invitationToken
        })
        setOidcBrowserCookie(req, res, begun.browserNonce)
        if (purpose === 'reauth') {
            res.clearCookie(RECENT_AUTH_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: oidcCookieIsSecure(req) })
        }
        res.redirect(302, begun.url)
    } catch (error) {
        startFailures.recordFailure(clientAddress)
        res.redirect(302, signinErrorUrl(safeSigninMessage(error)))
    }
}

oidcAuthRouter.get('/login', identityRouteLimit(OIDC_LOGIN_START_LIMIT), (req, res) => void beginPublic(req, res, 'signin'))
oidcAuthRouter.get('/reauthenticate', identityRouteLimit(300), (req, res) => void beginPublic(req, res, 'reauth'))

export async function oidcInviteStartUrl(req: Request, token: string): Promise<{ url: string; browserNonce: string }> {
    const clientAddress = address(req)
    if (startFailures.blocked(clientAddress)) throw new OidcError('transaction', 'Too many attempts.')
    try {
        const state = await readAuthenticationState(applicationDataSource())
        if (!state || state.activeMethod !== 'oidc') throw new OidcError('configuration', 'OIDC is not active.')
        const begun = await beginOidcAuthorization({
            dataSource: applicationDataSource(),
            slot: 'active',
            installationId: state.installationId,
            authenticationEpoch: state.authenticationEpoch,
            callbackUrl: oidcCallbackUrl(),
            redirectTarget: '/',
            purpose: 'invite',
            invitationToken: token
        })
        return { url: begun.url, browserNonce: begun.browserNonce }
    } catch (error) {
        startFailures.recordFailure(clientAddress)
        throw error
    }
}

oidcAuthRouter.get(
    '/callback',
    (req, res, next) => {
        cacheNoStore(res)
        clearOidcBrowserCookie(req, res)
        next()
    },
    identityRouteLimit(OIDC_CALLBACK_LIMIT),
    async (req, res) => {
        cacheNoStore(res)
        const clientAddress = address(req)
        if (callbackFailures.blocked(clientAddress)) {
            if (auditCallbackLimitDue(clientAddress)) {
                await auditCallbackFailure(new OidcError('transaction', 'Callback rate limit reached.', 'rate_limited'))
            }
            return void res.redirect(302, signinErrorUrl('Too many attempts. Try again later.'))
        }
        const state = typeof req.query.state === 'string' ? req.query.state : ''
        const code = typeof req.query.code === 'string' ? req.query.code : undefined
        const errorParam = typeof req.query.error === 'string' ? req.query.error : undefined
        const responseIssuer = typeof req.query.iss === 'string' ? req.query.iss : undefined
        try {
            const authState = await readAuthenticationState(applicationDataSource())
            if (!authState) throw new OidcError('transaction', 'Authentication state is unavailable.')
            const completed = await completeOidcAuthorization({
                dataSource: applicationDataSource(),
                state,
                code,
                error: errorParam,
                responseIssuer,
                callbackUrl: providerCallbackUrl(req),
                browserNonce: (req.cookies || {})[OIDC_BROWSER_COOKIE] || null,
                currentEpoch: authState.authenticationEpoch
            })
            if (completed.envelope.purpose === 'test') {
                const ctx = await buildAuthContext(req)
                const current = await establishSession(ctx)
                if (!current.user || current.user.id !== completed.envelope.initiatingUserId) {
                    throw new OidcError('transaction', 'The test sign-in binding is invalid.')
                }
                const basis =
                    completed.identity.emailVerified === true
                        ? 'email_verified'
                        : completed.identity.xmsEdov === true && isEntraAuthorityIssuer(completed.identity.issuer)
                        ? 'xms_edov'
                        : completed.identity.emailVerified === undefined &&
                          completed.identity.emailVerificationPresent !== true &&
                          completed.config.trustMissingEmailVerification
                        ? 'issuer_trusted'
                        : 'not_assured'
                await recordOidcTestResult(applicationDataSource(), completed.config.fingerprint, {
                    steps: ['discovery', 'authorization', 'token', 'signature', 'claims'],
                    email: completed.identity.email || null,
                    assuranceBasis: basis
                })
                return void res.redirect(302, '/authentication-settings?oidcTest=passed')
            }
            if (authState.activeMethod !== 'oidc') throw new OidcError('transaction', 'OIDC is no longer active.')
            const linked = await resolveOidcUser(applicationDataSource(), identityStore(), completed.identity, {
                trustMissing: completed.config.trustMissingEmailVerification,
                invitationToken: completed.envelope.invitationToken,
                bootstrapEmail: process.env.CUTTLELY_BOOTSTRAP_EMAIL
            })
            const matchedUser = linked.ok ? linked.user.id : null
            const orgs = matchedUser ? await organizationsForUser(applicationSql(), matchedUser) : ['']
            if (!linked.ok) {
                for (const organizationId of orgs.length ? orgs : ['']) {
                    await safeRecordAudit(applicationSql(), {
                        type: 'sign_in_failure',
                        organizationId,
                        workspaceId: null,
                        userId: matchedUser,
                        actorId: matchedUser,
                        summary: 'OIDC identity link refused',
                        detail: oidcLinkAuditDetail({
                            issuer: completed.identity.issuer,
                            subject: completed.identity.subject,
                            matchedUser,
                            basis: linked.basis || null,
                            outcome: linked.reason
                        })
                    })
                }
                callbackFailures.recordFailure(clientAddress)
                return void res.redirect(302, signinErrorUrl('This identity cannot sign in.'))
            }
            if (completed.envelope.purpose === 'reauth' && linked.user.id !== completed.envelope.initiatingUserId) {
                throw new OidcError(
                    'transaction',
                    'Reauthentication must use the account that started it.',
                    'reauthentication_account_mismatch'
                )
            }
            const ctx = await buildAuthContext(req)
            ctx.authenticationEpoch = completed.envelope.authEpoch
            ctx.secure = oidcCookieIsSecure(req)
            const issued = await issueDatabaseSession(ctx, linked.user.id)
            if (issued.type !== 'json' || issued.status !== 200) {
                throw new OidcError('response', 'Session creation failed.', 'session_creation_failed')
            }
            for (const cookie of issued.cookies || []) res.cookie(cookie.name, cookie.value, cookie.options)
            for (const name of issued.clearCookies || [])
                res.clearCookie(name, { path: '/', httpOnly: true, sameSite: 'lax', secure: issued.secure })
            if (oidcReauthenticationIsRecent(completed.envelope, completed.identity)) {
                const recent = await recordRecentAuthentication(applicationDataSource(), linked.user.id)
                const cookie = recentAuthenticationCookie(recent.token, ctx.secure, recent.expiresAt - Date.now())
                res.cookie(cookie.name, cookie.value, cookie.options)
            } else if (completed.envelope.purpose === 'reauth') {
                res.clearCookie(RECENT_AUTH_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.secure })
            }
            for (const organizationId of orgs.length ? orgs : ['']) {
                await safeRecordAudit(applicationSql(), {
                    type: 'sign_in_success',
                    organizationId,
                    workspaceId: null,
                    userId: matchedUser,
                    actorId: matchedUser,
                    summary: 'OIDC identity linked',
                    detail: oidcLinkAuditDetail({
                        issuer: completed.identity.issuer,
                        subject: completed.identity.subject,
                        matchedUser,
                        basis: linked.basis || null,
                        outcome: 'linked'
                    })
                })
            }
            res.redirect(302, completed.envelope.redirectTarget)
        } catch (error) {
            callbackFailures.recordFailure(clientAddress)
            console.warn('[server]: OIDC callback failed', oidcFailureLogDetail(error))
            await auditCallbackFailure(error)
            res.redirect(302, signinErrorUrl(safeSigninMessage(error)))
        }
    }
)
