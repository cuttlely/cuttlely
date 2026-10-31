/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { Request, Response, Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import {
    acknowledgeAuthenticationWarning,
    hasRecentAuthentication,
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
    RECENT_AUTH_COOKIE,
    localAdminEnabled,
    localUsersSetting,
    workosEnvironmentConfigured
} from './constants'
import { hashSessionToken } from './password'
import { applicationDataSource, applicationSql, identityStore } from './production'
import { requirePermission } from './rbac'
import { safeRecordAudit } from './auditLog'
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

async function recentlyAuthenticated(req: Request): Promise<boolean> {
    const cookies = (req.cookies || {}) as Record<string, string | undefined>
    const who = actor(req)
    const local = cookies[LOCAL_SESSION_COOKIE]
    if (local) {
        const session = await identityStore().findLocalSession(hashSessionToken(local))
        if (
            session?.issuedAt &&
            (session.authenticationMethod === 'local' || session.authenticationMethod === 'recovery') &&
            Date.now() - session.issuedAt.getTime() <= RECENT_MS
        ) {
            return true
        }
    }
    const recent = cookies[RECENT_AUTH_COOKIE]
    return Boolean(who && recent && (await hasRecentAuthentication(applicationDataSource(), who.id, recent)))
}

async function ownerLocalPasswordReady(): Promise<boolean> {
    return usableLocalOwnerReady(applicationDataSource())
}

async function ownerRecoveryReady(): Promise<boolean> {
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

const switchStageLimit = rateLimit({
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    max: 10,
    standardHeaders: false,
    legacyHeaders: false,
    message: { type: 'authentication_rate_limit', message: 'Too many authentication changes. Try again later.' }
})
const switchApplyLimit = rateLimit({
    windowMs: LOGIN_FAILURE_WINDOW_MS,
    max: 10,
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

identityAuthenticationRouter.get('/', async (req: Request, res: Response) => {
    try {
        const who = actor(req)
        const state =
            (await readAuthenticationState(applicationDataSource())) || (await initializeAuthenticationState(applicationDataSource()))
        res.set('Cache-Control', 'no-store')
            .status(200)
            .json({
                ...state,
                installationId: undefined,
                providerKey: state.providerKey ? state.providerKey.slice(0, 12) : null,
                methods: {
                    local: { configured: localUsersSetting(), label: 'Local login' },
                    workos: { configured: workosEnvironmentConfigured(), label: 'WorkOS' },
                    oidc: { configured: false, available: false, label: 'Generic OIDC' }
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
        if (method !== 'local' && method !== 'workos')
            return void res.status(400).json({ message: 'That sign-in method is not available.' })
        if ((method === 'local' && !localUsersSetting()) || (method === 'workos' && !workosEnvironmentConfigured()))
            return void res.status(409).json({ message: 'Configure this method before selecting it.' })
        if (method === 'workos' && !(await ownerRecoveryReady())) {
            await auditAttempt(who, { newMethod: method, outcome: 'refused', reason: 'owner_recovery_unavailable' })
            return void res.status(409).json({
                code: 'RECOVERY_REQUIRED',
                message: 'WorkOS cannot be activated until an active owner has a usable local password.'
            })
        }
        const state = await readAuthenticationState(applicationDataSource())
        if (method === 'local' && state?.activeMethod === 'workos' && !(await ownerLocalPasswordReady())) {
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
        const staged = await stageAuthenticationMethodSwitch(applicationDataSource(), who.id, method, version)
        res.status(200).json({
            stage: staged.id,
            stageVersion: staged.version,
            method,
            sessionsWillEnd: state.activeMethod !== method,
            apiKeysWillRemain: true,
            expiresAt: staged.expiresAt
        })
    } catch (error) {
        await auditAttempt(who, {
            newMethod: method,
            outcome: 'failed',
            reason: error instanceof Error ? error.message : 'unexpected_error'
        })
        res.status(500).json({ message: 'The sign-in method could not be staged.' })
    }
})

identityAuthenticationRouter.post('/apply', switchApplyLimit, async (req: Request, res: Response) => {
    const who = actor(req)
    const body = req.body as { stage?: unknown; stageVersion?: unknown; method?: unknown; stateVersion?: unknown; confirm?: unknown }
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (
        typeof body.stage !== 'string' ||
        Number(body.stageVersion) !== 1 ||
        (body.method !== 'local' && body.method !== 'workos') ||
        !Number.isInteger(Number(body.stateVersion))
    ) {
        await auditAttempt(who, { outcome: 'refused', reason: 'stage_expired' })
        return void res.status(409).json({ message: 'The staged change expired. Start again.' })
    }
    if (body.confirm !== 'END SESSIONS') {
        await auditAttempt(who, { newMethod: body.method, outcome: 'refused', reason: 'confirmation_missing' })
        return void res.status(400).json({ message: 'Type END SESSIONS to apply this change.' })
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
            redirectTo: '/signin',
            activeMethod: after.activeMethod,
            authenticationEpoch: after.authenticationEpoch,
            sessionsEnded: after.sessionsEnded
        })
    } catch (error) {
        const code = error instanceof Error ? error.message : ''
        await auditAttempt(who, { newMethod: body.method, outcome: 'failed', reason: code || 'unexpected_error' })
        res.status(
            code === 'AUTH_STATE_CHANGED' ||
                code === 'AUTH_STAGE_STALE' ||
                code === 'METHOD_NOT_READY' ||
                code === 'LOCAL_OWNER_REQUIRED' ||
                code === 'RECOVERY_REQUIRED'
                ? 409
                : 500
        ).json({
            message:
                code === 'AUTH_STATE_CHANGED' || code === 'AUTH_STAGE_STALE'
                    ? 'Authentication settings changed. Reload and try again.'
                    : code === 'LOCAL_OWNER_REQUIRED'
                    ? 'Local login requires an active owner with a usable local password.'
                    : code === 'RECOVERY_REQUIRED'
                    ? 'WorkOS cannot be activated until an active owner has a usable local password.'
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
