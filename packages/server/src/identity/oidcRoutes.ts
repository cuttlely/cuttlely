/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { Request, Response, Router } from 'express'
import { isIP } from 'net'
import { recentAuthenticationCookie } from './cookies'
import { LOCAL_SESSION_COOKIE, signinErrorUrl } from './constants'
import { issueDatabaseSession, establishSession } from './handlers'
import { identityRouteLimit } from './rateLimit'
import { applicationDataSource, applicationSql, buildAuthContext, identityStore } from './production'
import { requirePermission } from './rbac'
import { beginOidcAuthorization, browserSessionBinding, checkOidcConfiguration, completeOidcAuthorization, OidcError } from './oidcProvider'
import {
    migrateLegacyProviderLinks,
    oidcConfigurationFingerprint,
    providerLinkMigrationComplete,
    readOidcConfiguration,
    recordOidcTestResult,
    resolveOidcUser,
    saveOidcDraft
} from './oidcStore'
import { hasRecentAuthentication, readAuthenticationState, recordRecentAuthentication } from './authenticationState'
import { hashSessionToken } from './password'
import { oidcFailureLogDetail, oidcLinkAuditDetail, organizationsForUser, safeRecordAudit } from './auditLog'
import { publicOrigin } from './setupCode'

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|::1)$/i

export const oidcAdminRouter = Router()
export const oidcAuthRouter = Router()

function actor(req: Request): { id: string; organizationId: string } | null {
    const user = req.user as { id?: unknown; activeOrganizationId?: unknown } | undefined
    return typeof user?.id === 'string' && typeof user.activeOrganizationId === 'string'
        ? { id: user.id, organizationId: user.activeOrganizationId }
        : null
}

function trustedOrigin(): string {
    const candidate = publicOrigin(process.env.PORT || '3000')
    const url = new URL(candidate)
    return url.origin
}

export function oidcCallbackUrl(): string {
    return `${trustedOrigin()}/api/v1/auth/oidc/callback`
}

export function oidcPostLogoutUrl(): string {
    return `${trustedOrigin()}/signin`
}

function cacheNoStore(res: Response): void {
    res.set('Cache-Control', 'no-store')
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

async function recent(req: Request, userId: string): Promise<boolean> {
    const cookies = (req.cookies || {}) as Record<string, string | undefined>
    const local = cookies[LOCAL_SESSION_COOKIE]
    if (local) {
        const session = await identityStore().findLocalSession(hashSessionToken(local))
        if (session?.issuedAt && Date.now() - session.issuedAt.getTime() <= 10 * 60 * 1000) return true
    }
    const token = cookies['cuttlely-recent-auth']
    return Boolean(token && (await hasRecentAuthentication(applicationDataSource(), userId, token)))
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

oidcAdminRouter.use(requirePermission('authentication:manage'))

oidcAdminRouter.get('/', async (_req, res) => {
    cacheNoStore(res)
    try {
        const state = await readAuthenticationState(applicationDataSource())
        if (state) await migrateLegacyProviderLinks(applicationDataSource(), state)
        const [draft, active, migrated] = await Promise.all([
            readOidcConfiguration(applicationDataSource(), 'draft'),
            readOidcConfiguration(applicationDataSource(), 'active'),
            providerLinkMigrationComplete(applicationDataSource())
        ])
        res.status(200).json({
            draft: configurationBody(draft),
            active: configurationBody(active),
            callbackUrl: oidcCallbackUrl(),
            postLogoutUrl: oidcPostLogoutUrl(),
            scopes: ['openid', 'email', 'profile'],
            linkMigrationComplete: migrated
        })
    } catch {
        res.status(500).json({ message: 'OIDC settings could not be read.' })
    }
})

oidcAdminRouter.put('/', identityRouteLimit(10), async (req, res) => {
    cacheNoStore(res)
    const who = actor(req)
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (!(await recent(req, who.id))) return void res.status(409).json({ code: 'REAUTH_REQUIRED', message: 'Sign in again first.' })
    const body = (req.body || {}) as Record<string, unknown>
    const issuerText = typeof body.issuer === 'string' ? body.issuer.trim().replace(/\/$/, '') : ''
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
    if (!issuerText || !clientId || !ENV_NAME.test(clientSecretEnvVar) || !Number.isInteger(version) || version < 0) {
        return void res.status(400).json({ message: 'Issuer, client id, secret environment variable name, and version are required.' })
    }
    if (privateIssuerHosts.some((host) => (isIP(host) === 0 && !HOST_NAME.test(host)) || host.includes('..'))) {
        return void res.status(400).json({ message: 'Private issuer hosts must be exact host names.' })
    }
    let issuer: string
    try {
        const parsed = new URL(issuerText)
        if (parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('parts')
        issuer = parsed.toString().replace(/\/$/, '')
    } catch {
        return void res.status(400).json({ message: 'Issuer must be a valid URL.' })
    }
    const fingerprint = oidcConfigurationFingerprint({ issuer, clientId, clientSecretEnvVar, trustMissingEmailVerification })
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
        res.status(200).json({ draft: configurationBody(saved) })
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

oidcAdminRouter.post('/test', identityRouteLimit(10), async (req, res) => {
    cacheNoStore(res)
    const who = actor(req)
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    try {
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
            initiatingSession: browserSessionBinding((req.cookies || {}) as Record<string, string | undefined>),
            initiatingUserId: who.id
        })
        res.status(200).json({ url: begun.url })
    } catch {
        res.status(409).json({ message: 'OIDC test sign-in could not start.' })
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
            initiatingSession: purpose === 'reauth' ? browserSessionBinding(ctx.cookies) : null,
            initiatingUserId: current?.user?.id || null,
            invitationToken
        })
        res.redirect(302, begun.url)
    } catch (error) {
        res.redirect(302, signinErrorUrl(safeSigninMessage(error)))
    }
}

oidcAuthRouter.get('/login', identityRouteLimit(30), (req, res) => void beginPublic(req, res, 'signin'))
oidcAuthRouter.get('/reauthenticate', identityRouteLimit(20), (req, res) => void beginPublic(req, res, 'reauth'))

export async function oidcInviteStartUrl(req: Request, token: string): Promise<string> {
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
        initiatingSession: null,
        invitationToken: token
    })
    return begun.url
}

oidcAuthRouter.get('/callback', identityRouteLimit(60), async (req, res) => {
    cacheNoStore(res)
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
            callbackUrl: oidcCallbackUrl(),
            browserSession: browserSessionBinding((req.cookies || {}) as Record<string, string | undefined>),
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
                    : completed.identity.xmsEdov === true && new URL(completed.identity.issuer).hostname === 'login.microsoftonline.com'
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
        for (const organizationId of orgs.length ? orgs : ['']) {
            await safeRecordAudit(applicationSql(), {
                type: linked.ok ? 'sign_in_success' : 'sign_in_failure',
                organizationId,
                workspaceId: null,
                userId: matchedUser,
                actorId: matchedUser,
                summary: linked.ok ? 'OIDC identity linked' : 'OIDC identity link refused',
                detail: oidcLinkAuditDetail({
                    issuer: completed.identity.issuer,
                    subject: completed.identity.subject,
                    matchedUser,
                    basis: linked.basis || null,
                    outcome: linked.ok ? 'linked' : linked.reason
                })
            })
        }
        if (!linked.ok) return void res.redirect(302, signinErrorUrl('This identity cannot sign in.'))
        if (completed.envelope.purpose === 'reauth' && linked.user.id !== completed.envelope.initiatingUserId) {
            throw new OidcError('transaction', 'Reauthentication must use the account that started it.')
        }
        const ctx = await buildAuthContext(req)
        ctx.authenticationEpoch = completed.envelope.authEpoch
        const issued = await issueDatabaseSession(ctx, linked.user.id)
        if (issued.type !== 'json' || issued.status !== 200) throw new OidcError('response', 'Session creation failed.')
        for (const cookie of issued.cookies || []) res.cookie(cookie.name, cookie.value, cookie.options)
        for (const name of issued.clearCookies || [])
            res.clearCookie(name, { path: '/', httpOnly: true, sameSite: 'lax', secure: issued.secure })
        if (
            completed.envelope.purpose === 'reauth' &&
            completed.identity.authTime !== undefined &&
            completed.identity.authTime * 1000 >= completed.envelope.requestTime
        ) {
            const recent = await recordRecentAuthentication(applicationDataSource(), linked.user.id)
            const cookie = recentAuthenticationCookie(recent.token, ctx.secure, recent.expiresAt - Date.now())
            res.cookie(cookie.name, cookie.value, cookie.options)
        }
        res.redirect(302, completed.envelope.redirectTarget)
    } catch (error) {
        console.warn('[server]: OIDC callback failed', oidcFailureLogDetail(error))
        res.redirect(302, signinErrorUrl(safeSigninMessage(error)))
    }
})
