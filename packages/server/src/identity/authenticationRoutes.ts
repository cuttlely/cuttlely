/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { Request, Response, Router } from 'express'
import { MemoryStore, rateLimit } from 'express-rate-limit'
import {
    acknowledgeAuthenticationWarning,
    initializeAuthenticationState,
    readAuthenticationState,
    stageAuthenticationMethodSwitch,
    switchAuthenticationMethod,
    usableLocalOwnerReady,
    workosConfigurationFingerprint
} from './authenticationState'
import {
    LOCAL_SESSION_COOKIE,
    LOGIN_FAILURE_WINDOW_MS,
    localAdminEnabled,
    localUsersSetting,
    workosEnvironmentConfigured
} from './constants'
import { hashSessionToken } from './password'
import type { IdentityStore } from './store'
import { applicationDataSource, applicationSql, identityStore } from './production'
import { requirePermission } from './rbac'
import { safeRecordAudit } from './auditLog'
import {
    oidcConfigurationTestPassed,
    providerLinkMigrationComplete,
    readOidcConfiguration,
    testedOidcDraftDiffersFromActive
} from './oidcStore'
import { oidcCallbackError } from './oidcProvider'
import { publicOrigin } from './setupCode'
import { acknowledgeRecoveryAlert, currentRecoveryAlert } from './recovery'
import { createScimToken, endScimOverlap, readScimTokenState, revokeScimTokens, rotateScimToken, ScimError } from './scim'
import {
    createMapping,
    mappingOptions,
    previewMappingCreation,
    previewMappingRemoval,
    readScimOperations,
    removeMapping
} from './scimGroups'

const RECENT_MS = 10 * 60 * 1000
export const identityAuthenticationRouter = Router()

function actor(req: Request): { id: string; organizationId: string } | null {
    const user = req.user as { id?: unknown; activeOrganizationId?: unknown } | undefined
    return typeof user?.id === 'string' && typeof user.activeOrganizationId === 'string'
        ? { id: user.id, organizationId: user.activeOrganizationId }
        : null
}

export async function databaseSessionRecentlyAuthenticated(
    store: Pick<IdentityStore, 'findLocalSession'>,
    token: string | undefined,
    now = Date.now()
): Promise<boolean> {
    if (!token) return false
    const session = await store.findLocalSession(hashSessionToken(token))
    if (!session) return false
    const authenticatedAt = session.authenticationMethod === 'oidc' ? session.recentAuthenticationAt : session.issuedAt
    return Boolean(
        authenticatedAt &&
            (session.authenticationMethod === 'local' ||
                session.authenticationMethod === 'oidc' ||
                session.authenticationMethod === 'recovery') &&
            now >= authenticatedAt.getTime() &&
            now - authenticatedAt.getTime() <= RECENT_MS
    )
}

export async function recentlyAuthenticated(req: Request): Promise<boolean> {
    const cookies = (req.cookies || {}) as Record<string, string | undefined>
    return databaseSessionRecentlyAuthenticated(identityStore(), cookies[LOCAL_SESSION_COOKIE])
}

async function ownerLocalPasswordReady(): Promise<boolean> {
    return usableLocalOwnerReady(applicationDataSource())
}

export async function ownerRecoveryReady(): Promise<boolean> {
    return ownerLocalPasswordReady()
}

async function auditAttempt(who: { id: string; organizationId: string }, detail: Record<string, unknown>): Promise<void> {
    const outcome = detail.outcome === 'failed' ? 'failed' : 'refused'
    await safeRecordAudit(applicationSql(), {
        type: 'auth_method_change',
        organizationId: who.organizationId,
        workspaceId: null,
        userId: who.id,
        actorId: who.id,
        summary: `Sign-in method change ${outcome}`,
        detail: { configurationFingerprint: workosConfigurationFingerprint(), ...detail }
    })
}

identityAuthenticationRouter.use(requirePermission('authentication:manage'))

const switchStageStore = new MemoryStore()
const switchApplyStore = new MemoryStore()
const switchStageLimit = rateLimit({
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    max: 10,
    store: switchStageStore,
    standardHeaders: false,
    legacyHeaders: false,
    message: { type: 'authentication_rate_limit', message: 'Too many authentication changes. Try again later.' }
})
const switchApplyLimit = rateLimit({
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    max: 10,
    store: switchApplyStore,
    standardHeaders: false,
    legacyHeaders: false,
    message: { type: 'authentication_rate_limit', message: 'Too many authentication changes. Try again later.' }
})
const scimChangeLimit = rateLimit({
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    max: 10,
    standardHeaders: false,
    legacyHeaders: false,
    message: { type: 'authentication_rate_limit', message: 'Too many SCIM administration requests. Try again later.' }
})

export async function resetAuthenticationRouteLimitsForTests(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') return
    await Promise.all([switchStageStore.resetAll(), switchApplyStore.resetAll()])
}

identityAuthenticationRouter.get('/', async (req: Request, res: Response) => {
    try {
        const who = actor(req)
        const state =
            (await readAuthenticationState(applicationDataSource())) || (await initializeAuthenticationState(applicationDataSource()))
        const oidcDraft = await readOidcConfiguration(applicationDataSource(), 'draft')
        const localUsersConfigured = localUsersSetting()
        const localOwnerConfigured = localAdminEnabled()
        res.set('Cache-Control', 'no-store')
            .status(200)
            .json({
                ...state,
                installationId: undefined,
                providerKey: state.providerKey ? state.providerKey.slice(0, 12) : null,
                methods: {
                    local: {
                        configured: localUsersConfigured || localOwnerConfigured,
                        selectable: localUsersConfigured,
                        scope: localUsersConfigured ? 'local-users' : localOwnerConfigured ? 'owner-only' : null,
                        label: 'Local login'
                    },
                    workos: { configured: workosEnvironmentConfigured(), label: 'WorkOS' },
                    oidc: { configured: Boolean(oidcDraft), available: true, label: 'Generic OIDC' }
                },
                recovery: {
                    available: await ownerRecoveryReady(),
                    routeEnabled: true,
                    compatibilityRouteEnabled: localAdminEnabled(),
                    alert: await currentRecoveryAlert(applicationDataSource())
                },
                scim: {
                    available: true,
                    basePath: '/api/v1/scim/v2',
                    ...(await readScimTokenState(applicationSql())),
                    operations: await readScimOperations(applicationSql(), who?.organizationId || ''),
                    mapping: who ? await mappingOptions(applicationSql(), who) : { mappings: [], groups: [], workspaces: [], roles: [] }
                }
            })
    } catch {
        res.status(500).json({ message: 'Authentication settings could not be read.' })
    }
})

async function requireRecentScimAuthentication(req: Request, res: Response): Promise<boolean> {
    if (await recentlyAuthenticated(req)) return true
    res.status(409).json({ code: 'REAUTH_REQUIRED', message: 'Sign in again before changing the SCIM credential.' })
    return false
}

function sendScimAdminError(res: Response, error: unknown): void {
    if (error instanceof ScimError) {
        res.status(error.status).json({ message: error.message })
        return
    }
    res.status(500).json({ message: 'The SCIM settings could not be changed.' })
}

identityAuthenticationRouter.post('/scim-mappings/preview', scimChangeLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    res.set('Cache-Control', 'no-store')
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    try {
        res.status(200).json(await previewMappingCreation(applicationSql(), who, req.body))
    } catch (error) {
        sendScimAdminError(res, error)
    }
})

identityAuthenticationRouter.post('/scim-mappings/confirm', scimChangeLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    res.set('Cache-Control', 'no-store')
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (!(await requireRecentScimAuthentication(req, res))) return
    try {
        const fingerprint = (req.body as { fingerprint?: unknown })?.fingerprint
        res.status(201).json(await createMapping(applicationSql(), who, req.body, fingerprint))
    } catch (error) {
        sendScimAdminError(res, error)
    }
})

identityAuthenticationRouter.get('/scim-mappings/:id/remove-preview', scimChangeLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    res.set('Cache-Control', 'no-store')
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    try {
        res.status(200).json(await previewMappingRemoval(applicationSql(), who, req.params.id))
    } catch (error) {
        sendScimAdminError(res, error)
    }
})

identityAuthenticationRouter.post('/scim-mappings/:id/remove', scimChangeLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    res.set('Cache-Control', 'no-store')
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (!(await requireRecentScimAuthentication(req, res))) return
    try {
        await removeMapping(applicationSql(), who, req.params.id, (req.body as { fingerprint?: unknown })?.fingerprint)
        res.status(204).end()
    } catch (error) {
        sendScimAdminError(res, error)
    }
})

identityAuthenticationRouter.post('/scim-token', scimChangeLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    res.set('Cache-Control', 'no-store')
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (!(await requireRecentScimAuthentication(req, res))) return
    try {
        res.status(201).json(await createScimToken(applicationSql(), who))
    } catch (error) {
        sendScimAdminError(res, error)
    }
})

identityAuthenticationRouter.post('/scim-token/rotate', scimChangeLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    res.set('Cache-Control', 'no-store')
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (!(await requireRecentScimAuthentication(req, res))) return
    try {
        const supplied = (req.body as { overlapHours?: unknown })?.overlapHours
        const overlapHours = supplied === undefined ? 1 : Number(supplied)
        res.status(200).json(await rotateScimToken(applicationSql(), who, overlapHours))
    } catch (error) {
        sendScimAdminError(res, error)
    }
})

identityAuthenticationRouter.post('/scim-token/end-previous', scimChangeLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    res.set('Cache-Control', 'no-store')
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (!(await requireRecentScimAuthentication(req, res))) return
    try {
        res.status(200).json({ state: await endScimOverlap(applicationSql(), who) })
    } catch (error) {
        sendScimAdminError(res, error)
    }
})

identityAuthenticationRouter.delete('/scim-token', scimChangeLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    res.set('Cache-Control', 'no-store')
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (!(await requireRecentScimAuthentication(req, res))) return
    try {
        res.status(200).json({ state: await revokeScimTokens(applicationSql(), who) })
    } catch (error) {
        sendScimAdminError(res, error)
    }
})

identityAuthenticationRouter.post('/stage', switchStageLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    const method = (req.body as { method?: unknown })?.method
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    try {
        const version = Number((req.body as { version?: unknown })?.version)
        if (method !== 'local' && method !== 'workos' && method !== 'oidc')
            return void res.status(400).json({ message: 'That sign-in method is not available.' })
        const oidc = method === 'oidc' ? await readOidcConfiguration(applicationDataSource(), 'draft') : null
        if (method === 'local' && !localUsersSetting())
            return void res.status(409).json({
                code: 'METHOD_NOT_READY',
                message: 'Set CUTTLELY_LOCAL_USERS=true before switching to Local.'
            })
        if ((method === 'workos' && !workosEnvironmentConfigured()) || (method === 'oidc' && (!oidc || oidc.health !== 'ready')))
            return void res.status(409).json({ message: 'Configure this method before selecting it.' })
        if ((method === 'workos' || method === 'oidc') && !(await ownerRecoveryReady())) {
            await auditAttempt(who, { newMethod: method, outcome: 'refused', reason: 'owner_recovery_unavailable' })
            return void res.status(409).json({
                code: 'RECOVERY_REQUIRED',
                message: 'A remote sign-in method cannot be activated until owner recovery is ready.'
            })
        }
        if (method === 'oidc' && oidc && !oidcConfigurationTestPassed(oidc)) {
            return void res.status(409).json({ code: 'OIDC_TEST_REQUIRED', message: 'Test this OIDC configuration before activation.' })
        }
        if (method === 'oidc' && !(await providerLinkMigrationComplete(applicationDataSource()))) {
            return void res.status(409).json({ code: 'LINK_MIGRATION_REQUIRED', message: 'Identity link migration must complete first.' })
        }
        if (method === 'oidc') {
            const configuredOrigin = process.env.RENDER_EXTERNAL_URL?.trim() || process.env.APP_URL?.trim()
            const callbackError = oidcCallbackError(
                configuredOrigin || `${publicOrigin(process.env.PORT || '3000')}/api/v1/auth/oidc/callback`
            )
            if (callbackError) return void res.status(409).json({ code: 'OIDC_HTTPS_REQUIRED', message: callbackError })
        }
        const state = await readAuthenticationState(applicationDataSource())
        if (
            method === 'local' &&
            (state?.activeMethod === 'workos' || state?.activeMethod === 'oidc') &&
            !(await ownerLocalPasswordReady())
        ) {
            await auditAttempt(who, { newMethod: method, outcome: 'refused', reason: 'local_owner_unavailable' })
            return void res.status(409).json({
                code: 'LOCAL_OWNER_REQUIRED',
                message: 'Local login requires an active owner with a usable local password.'
            })
        }
        if (!(await recentlyAuthenticated(req)))
            return void res.status(409).json({ code: 'REAUTH_REQUIRED', message: 'Sign in again before changing the sign-in method.' })
        if (!state || state.version !== version)
            return void res.status(409).json({ code: 'STATE_CHANGED', message: 'Authentication settings changed. Reload and try again.' })
        const staged =
            method === 'oidc' && oidc
                ? await stageAuthenticationMethodSwitch(applicationDataSource(), who.id, method, version, oidc.fingerprint)
                : await stageAuthenticationMethodSwitch(applicationDataSource(), who.id, method, version)
        const oidcRefresh = Boolean(
            method === 'oidc' &&
                oidc &&
                state.activeMethod === 'oidc' &&
                state.configurationFingerprint === oidc.fingerprint &&
                testedOidcDraftDiffersFromActive(oidc, await readOidcConfiguration(applicationDataSource(), 'active'))
        )
        res.status(200).json({
            stage: staged.id,
            stageVersion: staged.version,
            method,
            action: oidcRefresh ? 'oidc_refresh' : 'method_change',
            sessionsWillEnd: state.activeMethod !== method || (method === 'oidc' && state.configurationFingerprint !== oidc?.fingerprint),
            apiKeysWillRemain: true,
            expiresAt: staged.expiresAt
        })
    } catch (error) {
        const code = error instanceof Error ? error.message : ''
        await auditAttempt(who, {
            newMethod: method,
            outcome: 'failed',
            reason: code || 'unexpected_error'
        })
        res.status(code === 'AUTH_STATE_CHANGED' ? 409 : 500).json({
            message:
                code === 'AUTH_STATE_CHANGED'
                    ? 'Authentication settings changed. Reload and try again.'
                    : 'The sign-in method could not be staged.'
        })
    }
})

identityAuthenticationRouter.post('/apply', switchApplyLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    const body = req.body as { stage?: unknown; stageVersion?: unknown; method?: unknown; stateVersion?: unknown; confirm?: unknown }
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (
        typeof body.stage !== 'string' ||
        Number(body.stageVersion) !== 1 ||
        (body.method !== 'local' && body.method !== 'workos' && body.method !== 'oidc') ||
        !Number.isInteger(Number(body.stateVersion))
    ) {
        await auditAttempt(who, { outcome: 'refused', reason: 'stage_expired' })
        return void res.status(409).json({ message: 'The staged change expired. Start again.' })
    }
    const current = await readAuthenticationState(applicationDataSource())
    const oidcDraft = body.method === 'oidc' ? await readOidcConfiguration(applicationDataSource(), 'draft') : null
    const oidcRefreshConfirmation = Boolean(
        body.method === 'oidc' &&
            current?.activeMethod === 'oidc' &&
            current.version === Number(body.stateVersion) &&
            oidcDraft &&
            current.configurationFingerprint === oidcDraft.fingerprint
    )
    const expectedConfirmation = oidcRefreshConfirmation ? 'APPLY SETTINGS' : 'END SESSIONS'
    if (body.confirm !== expectedConfirmation) {
        await auditAttempt(who, { newMethod: body.method, outcome: 'refused', reason: 'confirmation_missing' })
        return void res.status(400).json({
            message: oidcRefreshConfirmation
                ? 'Confirm that you want to apply these provider settings.'
                : 'Type END SESSIONS to apply this change.'
        })
    }
    if (!(await recentlyAuthenticated(req))) {
        await auditAttempt(who, { newMethod: body.method, outcome: 'refused', reason: 'reauth_required' })
        return void res.status(409).json({ code: 'REAUTH_REQUIRED', message: 'Sign in again before changing the sign-in method.' })
    }
    try {
        const after = await switchAuthenticationMethod(
            applicationDataSource(),
            body.method,
            Number(body.stateVersion),
            { organizationId: who.organizationId, actorId: who.id },
            { id: body.stage, actorId: who.id, version: Number(body.stageVersion) }
        )
        res.status(200).json({
            applied: true,
            refreshed: after.change === 'oidc_refresh',
            redirectTo: after.change === 'method' ? '/signin' : null,
            activeMethod: after.activeMethod,
            authenticationEpoch: after.authenticationEpoch,
            sessionsEnded: after.change === 'method' ? after.sessionsEnded : 0
        })
    } catch (error) {
        const code = error instanceof Error ? error.message : ''
        await auditAttempt(who, { newMethod: body.method, outcome: 'failed', reason: code || 'unexpected_error' })
        res.status(
            code === 'AUTH_STATE_CHANGED' ||
                code === 'AUTH_STAGE_STALE' ||
                code === 'METHOD_NOT_READY' ||
                code === 'LOCAL_OWNER_REQUIRED' ||
                code === 'RECOVERY_REQUIRED' ||
                code === 'OIDC_TEST_REQUIRED' ||
                code === 'LINK_MIGRATION_REQUIRED'
                ? 409
                : 500
        ).json({
            message:
                code === 'AUTH_STATE_CHANGED' || code === 'AUTH_STAGE_STALE'
                    ? 'Authentication settings changed. Reload and try again.'
                    : code === 'LOCAL_OWNER_REQUIRED'
                    ? 'Local login requires an active owner with a usable local password.'
                    : code === 'RECOVERY_REQUIRED'
                    ? 'A remote sign-in method cannot be activated until owner recovery is ready.'
                    : code === 'OIDC_TEST_REQUIRED'
                    ? 'Test this OIDC configuration before activation.'
                    : code === 'LINK_MIGRATION_REQUIRED'
                    ? 'Identity link migration must complete first.'
                    : code === 'METHOD_NOT_READY' && body.method === 'local'
                    ? 'Set CUTTLELY_LOCAL_USERS=true before switching to Local.'
                    : 'The sign-in method was not changed.'
        })
    }
})

identityAuthenticationRouter.post('/acknowledge-warning', async (req: Request, res: Response) => {
    const who = actor(req)
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (!(await recentlyAuthenticated(req)))
        return void res.status(409).json({ code: 'REAUTH_REQUIRED', message: 'Sign in again before acknowledging this warning.' })
    try {
        const state = await acknowledgeAuthenticationWarning(applicationDataSource(), Number((req.body as { version?: unknown }).version), {
            organizationId: who.organizationId,
            actorId: who.id
        })
        res.status(200).json({
            acknowledged: true,
            redirectTo: '/signin',
            version: state.version,
            authenticationEpoch: state.authenticationEpoch,
            sessionsEnded: state.sessionsEnded
        })
    } catch (error) {
        const code = error instanceof Error ? error.message : ''
        res.status(code === 'AUTH_STATE_CHANGED' ? 409 : 500).json({
            message: 'The warning could not be acknowledged. Reload and try again.'
        })
    }
})

identityAuthenticationRouter.post('/acknowledge-recovery-alert', async (req: Request, res: Response) => {
    const who = actor(req)
    const id = (req.body as { id?: unknown })?.id
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (typeof id !== 'string' || !id) return void res.status(400).json({ message: 'The recovery alert is not valid.' })
    try {
        const acknowledged = await acknowledgeRecoveryAlert(applicationDataSource(), applicationSql(), {
            id,
            actorId: who.id,
            organizationId: who.organizationId,
            at: Date.now()
        })
        if (!acknowledged) return void res.status(409).json({ message: 'The recovery alert was already acknowledged.' })
        res.status(200).json({ acknowledged: true })
    } catch {
        res.status(500).json({ message: 'The recovery alert could not be acknowledged.' })
    }
})
