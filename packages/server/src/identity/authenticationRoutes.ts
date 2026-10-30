/** Copyright 2026 The Cuttlely Authors. Licensed under the Apache License, Version 2.0. */
import { randomUUID } from 'crypto'
import { Request, Response, Router } from 'express'
import { getDataSource } from '../DataSource'
import {
    AuthenticationMethod,
    acknowledgeAuthenticationWarning,
    hasRecentAuthentication,
    initializeAuthenticationState,
    readAuthenticationState,
    switchAuthenticationMethod,
    workosConfigurationFingerprint
} from './authenticationState'
import { LOCAL_SESSION_COOKIE, RECENT_AUTH_COOKIE, localAdminEnabled, localUsersSetting, workosEnvironmentConfigured } from './constants'
import { hashSessionToken } from './password'
import { applicationSql, identityStore } from './production'
import { requirePermission } from './rbac'
import { safeRecordAudit } from './auditLog'

const RECENT_MS = 10 * 60 * 1000
const stages = new Map<string, { actorId: string; method: AuthenticationMethod; version: number; expiresAt: number }>()

export const identityAuthenticationRouter = Router()

function actor(req: Request): { id: string; organizationId: string } | null {
    const user = req.user as { id?: unknown; activeOrganizationId?: unknown } | undefined
    return typeof user?.id === 'string' && typeof user.activeOrganizationId === 'string'
        ? { id: user.id, organizationId: user.activeOrganizationId }
        : null
}

async function recentlyAuthenticated(req: Request): Promise<boolean> {
    const cookies = (req.cookies || {}) as Record<string, string | undefined>
    const local = cookies[LOCAL_SESSION_COOKIE]
    if (local) {
        const session = await identityStore().findLocalSession(hashSessionToken(local))
        return Boolean(session?.issuedAt && Date.now() - session.issuedAt.getTime() <= RECENT_MS)
    }
    const who = actor(req)
    const recent = cookies[RECENT_AUTH_COOKIE]
    return Boolean(who && recent && (await hasRecentAuthentication(getDataSource(), who.id, recent)))
}

async function ownerRecoveryReady(): Promise<boolean> {
    if (!localAdminEnabled()) return false
    const owner = await identityStore().findSuperUser()
    return Boolean(owner?.credential && (await identityStore().localAccountOpen(owner.id)))
}

async function auditAttempt(who: { id: string; organizationId: string }, detail: Record<string, unknown>): Promise<void> {
    await safeRecordAudit(applicationSql(), {
        type: 'auth_method_change',
        organizationId: who.organizationId,
        workspaceId: null,
        userId: who.id,
        actorId: who.id,
        summary: 'Sign-in method change refused',
        detail: { configurationFingerprint: workosConfigurationFingerprint(), ...detail }
    })
}

identityAuthenticationRouter.use(requirePermission('authentication:manage'))

identityAuthenticationRouter.get('/', async (_req: Request, res: Response) => {
    try {
        const state = (await readAuthenticationState(getDataSource())) || (await initializeAuthenticationState(getDataSource()))
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
                recovery: { available: await ownerRecoveryReady(), routeEnabled: localAdminEnabled() },
                scim: { available: false }
            })
    } catch {
        res.status(500).json({ message: 'Authentication settings could not be read.' })
    }
})

identityAuthenticationRouter.post('/stage', async (req: Request, res: Response) => {
    try {
        const who = actor(req)
        const method = (req.body as { method?: unknown })?.method
        const version = Number((req.body as { version?: unknown })?.version)
        if (!who) return void res.status(401).json({ message: 'Unauthorized' })
        if (method !== 'local' && method !== 'workos')
            return void res.status(400).json({ message: 'That sign-in method is not available.' })
        if ((method === 'local' && !localUsersSetting()) || (method === 'workos' && !workosEnvironmentConfigured()))
            return void res.status(409).json({ message: 'Configure this method before selecting it.' })
        if (method === 'workos' && !(await ownerRecoveryReady())) {
            await auditAttempt(who, { newMethod: method, outcome: 'refused', reason: 'owner_recovery_unavailable' })
            return void res.status(409).json({
                code: 'RECOVERY_REQUIRED',
                message: 'WorkOS cannot be activated until the owner recovery route is enabled and an active owner has a usable password.'
            })
        }
        if (!(await recentlyAuthenticated(req)))
            return void res.status(409).json({ code: 'REAUTH_REQUIRED', message: 'Sign in again before changing the sign-in method.' })
        const state = await readAuthenticationState(getDataSource())
        if (!state || state.version !== version)
            return void res.status(409).json({ code: 'STATE_CHANGED', message: 'Authentication settings changed. Reload and try again.' })
        const id = randomUUID()
        stages.set(id, { actorId: who.id, method, version, expiresAt: Date.now() + RECENT_MS })
        res.status(200).json({
            stage: id,
            method,
            sessionsWillEnd: state.activeMethod !== method,
            apiKeysWillRemain: true,
            expiresAt: new Date(Date.now() + RECENT_MS).toISOString()
        })
    } catch {
        res.status(500).json({ message: 'The sign-in method could not be staged.' })
    }
})

identityAuthenticationRouter.post('/apply', async (req: Request, res: Response) => {
    const who = actor(req)
    const body = req.body as { stage?: unknown; confirm?: unknown }
    const staged = typeof body.stage === 'string' ? stages.get(body.stage) : undefined
    if (!who) return void res.status(401).json({ message: 'Unauthorized' })
    if (!staged || staged.actorId !== who.id || staged.expiresAt < Date.now()) {
        await auditAttempt(who, { outcome: 'refused', reason: 'stage_expired' })
        return void res.status(409).json({ message: 'The staged change expired. Start again.' })
    }
    if (body.confirm !== 'END SESSIONS') {
        await auditAttempt(who, { newMethod: staged.method, outcome: 'refused', reason: 'confirmation_missing' })
        return void res.status(400).json({ message: 'Type END SESSIONS to apply this change.' })
    }
    stages.delete(body.stage as string)
    try {
        const after = await switchAuthenticationMethod(getDataSource(), staged.method, staged.version, {
            organizationId: who.organizationId,
            actorId: who.id
        })
        res.status(200).json({
            applied: true,
            redirectTo: '/signin',
            activeMethod: after.activeMethod,
            authenticationEpoch: after.authenticationEpoch,
            sessionsEnded: after.sessionsEnded
        })
    } catch (error) {
        const code = error instanceof Error ? error.message : ''
        await auditAttempt(who, { newMethod: staged.method, outcome: 'failed', reason: code || 'unexpected_error' })
        res.status(code === 'AUTH_STATE_CHANGED' || code === 'METHOD_NOT_READY' ? 409 : 500).json({
            message:
                code === 'AUTH_STATE_CHANGED'
                    ? 'Authentication settings changed. Reload and try again.'
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
        const state = await acknowledgeAuthenticationWarning(getDataSource(), Number((req.body as { version?: unknown }).version), {
            organizationId: who.organizationId,
            actorId: who.id
        })
        res.status(200).json({ acknowledged: true, version: state.version })
    } catch (error) {
        const code = error instanceof Error ? error.message : ''
        res.status(code === 'AUTH_STATE_CHANGED' ? 409 : 500).json({
            message: 'The warning could not be acknowledged. Reload and try again.'
        })
    }
})
