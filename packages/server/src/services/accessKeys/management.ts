import { safeRecordAudit } from '../../identity/auditLog'
import { sqlFromDataSource } from '../../identity/directory'
import { Workspace } from '../../database/entities/identity'
import { accessRollout, requireAccessRollout } from './rollout'
import { randomUUID } from 'crypto'
import { Request, RequestHandler } from 'express'
import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyCredential } from '../../database/entities/ApiKeyCredential'
import { ApiKeyResource } from '../../database/entities/ApiKeyResource'
import { ApiKeyUsage } from '../../database/entities/ApiKeyUsage'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { AppError } from '../../errors/appError'
import { hasAnyPermission } from '../../identity/rbac'
import { accessData } from './data'
import apikeyService, { validatePermissions } from '../apikey'
import { referencedHarnessNames } from '../harnesses/apiAccess'
import { mintCredential, rotateCredential } from './credentials'
import { expiry, OPERATIONS, operationPermissions, parseGrants, parsePolicy, RESOURCE_TYPES, ResourceGrant } from './policy'
import { serial } from './limiter'

const action =
    (fn: (req: Request) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store')
        void fn(req).then((value) => res.json(value), next)
    }
function interactive(req: Request) {
    if (!req.user?.id || !req.user?.activeWorkspaceId) throw new AppError(403, 'Sign in to manage access keys.')
    return req.user
}
export async function target(req: Request): Promise<ApiKey> {
    const user = interactive(req)
    const row = await (await accessData()).getRepository(ApiKey).findOneBy({ id: req.params.id, workspaceId: user.activeWorkspaceId })
    if (!row) throw new AppError(404, 'Access key not found.')
    // Reauthorize the target, including its stored permissions, before editing or revoking it.
    const permitted = await hasAnyPermission(req, 'apikeys:grant-all')
    if (row.accessPolicy?.allResources && !permitted) throw new AppError(403, 'Managing a workspace-wide grant requires apikeys:grant-all.')
    for (const permission of row.permissions)
        if (!(await hasAnyPermission(req, permission))) throw new AppError(403, 'Access key exceeds your current permissions.')
    if (row.accessPolicy?.legacy) {
        // Compatibility scopes include operations that are not independently usable. Check only actual resource authority.
        const grants = await (await accessData()).getRepository(ApiKeyResource).findBy({ principalId: row.id })
        for (const grant of grants) {
            const resource = parseGrants([grant])[0]
            for (const operation of row.accessPolicy.scopes) {
                if (operation.startsWith('api:')) continue // endpoint-specific RBAC is already checked above
                if (operation.startsWith('harness:') && grant.resourceType !== 'HARNESS') continue
                if (operation.startsWith('dashflow:') !== (grant.resourceType === 'DASHFLOW')) continue
                if (!(await hasAnyPermission(req, ...operationPermissions(operation, resource))))
                    throw new AppError(403, 'Access key operations exceed your current permissions.')
            }
        }
    } else {
        const grants: ResourceGrant[] = row.accessPolicy?.allResources
            ? RESOURCE_TYPES.map((resourceType) => ({ resourceType, resourceId: '*' }))
            : parseGrants(await (await accessData()).getRepository(ApiKeyResource).findBy({ principalId: row.id }))
        for (const operation of row.accessPolicy?.scopes || []) {
            if (!(await hasAnyPermission(req, ...OPERATIONS[operation])))
                throw new AppError(403, 'Access key operations exceed your current permissions.')
            for (const grant of grants) {
                if (operation.startsWith('harness:') && grant.resourceType !== 'HARNESS') continue
                if (operation.startsWith('dashflow:') !== (grant.resourceType === 'DASHFLOW')) continue
                if (!(await hasAnyPermission(req, ...operationPermissions(operation, grant))))
                    throw new AppError(403, 'Access key resource operations exceed your current permissions.')
            }
        }
    }
    return row
}
async function choices(req: Request) {
    const user = interactive(req)
    const flows = await (await accessData()).getRepository(ChatFlow).findBy({ workspaceId: user.activeWorkspaceId })
    const resources = []
    for (const flow of flows) {
        if (!['CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS', undefined, null].includes(flow.type)) continue
        const permission = ['AGENTFLOW', 'MULTIAGENT'].includes(flow.type || '') ? 'agentflows:view' : 'chatflows:view'
        if (!(await hasAnyPermission(req, permission))) continue
        resources.push({
            resourceType:
                flow.type === 'HARNESS' ? 'HARNESS' : ['AGENTFLOW', 'MULTIAGENT'].includes(flow.type || '') ? 'AGENTFLOW' : 'CHATFLOW',
            resourceId: flow.id,
            name: flow.name,
            requiredHarnesses: referencedHarnessNames(flow.flowData)
        })
    }
    const { dashFlowsEnabled } = await import('../dashflows/enabled')
    if (dashFlowsEnabled() && (await hasAnyPermission(req, 'chatflows:view'))) {
        const { runtime } = await import('../dashflows')
        for (const row of (await runtime()).dashStore().list(user.activeWorkspaceId))
            resources.push({
                resourceType: 'DASHFLOW',
                resourceId: row.id,
                name: row.definition?.title || row.definition?.name || row.name || row.id,
                requiredHarnesses: row.definition?.harness ? [row.definition.harness] : []
            })
    }
    const scopes = []
    for (const [scope, permissions] of Object.entries(OPERATIONS)) if (await hasAnyPermission(req, ...permissions)) scopes.push(scope)
    return { resources, scopes, rollout: accessRollout(), canGrantAll: await hasAnyPermission(req, 'apikeys:grant-all') }
}
export const accessKeyOptions: RequestHandler = action(choices)

async function policyInput(req: Request) {
    requireAccessRollout()
    const user = interactive(req)
    const policy = parsePolicy(req.body.accessPolicy)
    const resources = parseGrants(req.body.resources)
    const available = await choices(req)
    if (policy.allResources && (!available.canGrantAll || req.body.confirmAllResources !== true))
        throw new AppError(403, 'All resources requires apikeys:grant-all and explicit confirmation.')
    if (policy.scopes.some((s) => !available.scopes.includes(s))) throw new AppError(403, 'You cannot grant these operations.')
    for (const grant of resources) {
        if (!available.resources.some((r) => r.resourceType === grant.resourceType && r.resourceId === grant.resourceId))
            throw new AppError(403, 'You cannot grant this resource.')
    }
    const permissions = req.body.permissions
    if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === 'string'))
        throw new AppError(400, 'Permissions must be an array of strings.')
    validatePermissions(
        { ...user, activeWorkspaceId: user.activeWorkspaceId!, isOrganizationAdmin: available.canGrantAll },
        permissions,
        'update'
    )
    // The principal's RBAC and operation scopes are independent restrictions. Both must be granted by its creator.
    for (const permission of permissions)
        if (!(await hasAnyPermission(req, permission))) throw new AppError(403, 'Permission exceeds your current role.')
    // Match target(): each scope must be authorized for every resource family it can exercise.
    const grants: ResourceGrant[] = policy.allResources
        ? RESOURCE_TYPES.map((resourceType) => ({ resourceType, resourceId: '*' }))
        : resources
    for (const scope of policy.scopes) {
        if (policy.allResources) {
            if (!(await hasAnyPermission(req, ...OPERATIONS[scope]))) throw new AppError(403, 'You cannot grant these operations.')
        }
        for (const grant of grants) {
            if (!(await hasAnyPermission(req, ...operationPermissions(scope, grant))))
                throw new AppError(403, 'You cannot grant these operations for that resource.')
        }
    }
    if (typeof req.body.keyName !== 'string' || !req.body.keyName.trim() || req.body.keyName.length > 100)
        throw new AppError(400, 'A key name of 1 to 100 characters is required.')
    return { policy, resources, permissions, expiresAt: expiry(req.body.expiresAt) }
}
export async function presentAccessKey(row: ApiKey) {
    const data = await accessData()
    const credentials = await data.getRepository(ApiKeyCredential).findBy({ principalId: row.id })
    return {
        resources: await data.getRepository(ApiKeyResource).findBy({ principalId: row.id }),
        credentials: credentials.map(({ digest: _digest, ...credential }) => credential),
        usage: await data.getRepository(ApiKeyUsage).findBy({ principalId: row.id })
    }
}
async function audit(req: Request, key: ApiKey, event: string, detail: Record<string, unknown> = {}) {
    try {
        const data = await accessData()
        const workspace = await data.getRepository(Workspace).findOneBy({ id: key.workspaceId })
        if (!workspace) return
        await safeRecordAudit(sqlFromDataSource(data), {
            type: 'api_key_change',
            organizationId: workspace.organizationId,
            workspaceId: key.workspaceId,
            userId: req.user?.id || null,
            actorId: req.user?.id || null,
            summary: `Access key ${event}`,
            detail: { keyId: key.id, event, ...detail }
        })
    } catch {
        console.warn('[access-keys] lifecycle audit was not saved')
    }
}
export const createAccessKey: RequestHandler = action(async (req) => {
    const user = interactive(req)
    const input = await policyInput(req)
    const data = await accessData()
    if (!(await data.getRepository(Workspace).findOneBy({ id: user.activeWorkspaceId }))) throw new AppError(401, 'Workspace unavailable.')
    const result = await serial(() =>
        data.transaction(async (manager) => {
            const key = manager.getRepository(ApiKey).create({
                id: randomUUID(),
                keyName: req.body.keyName.trim(),
                workspaceId: user.activeWorkspaceId!,
                ownerUserId: user.id,
                apiKey: '',
                apiSecret: '',
                permissions: input.permissions,
                accessPolicy: input.policy,
                expiresAt: input.expiresAt,
                harnesses: []
            })
            await manager.getRepository(ApiKey).save(key)
            for (const resource of input.resources)
                await manager
                    .getRepository(ApiKeyResource)
                    .upsert({ principalId: key.id, ...resource }, ['principalId', 'resourceType', 'resourceId'])
            return { key, ...(await mintCredential(manager, key)) }
        })
    )
    await audit(req, result.key, 'created', { policy: input.policy, resources: input.resources })
    const rows = await apikeyService.getAllApiKeys({ ...user, activeWorkspaceId: user.activeWorkspaceId! })
    return Array.isArray(rows) ? rows.map((r) => (r.id === result.key.id ? { ...r, apiKey: result.secret } : r)) : rows
})
export const updateAccessKey: RequestHandler = action(async (req) => {
    const key = await target(req)
    const input = await policyInput(req)
    const before = {
        policy: key.accessPolicy,
        permissions: key.permissions,
        expiresAt: key.expiresAt,
        resources: (await presentAccessKey(key)).resources.map(({ resourceId, resourceType }) => ({ resourceId, resourceType }))
    }
    const data = await accessData()
    await serial(() =>
        data.transaction(async (manager) => {
            const repo = manager.getRepository(ApiKey)
            const fresh = await repo.findOneByOrFail({ id: key.id, workspaceId: key.workspaceId })
            // The retained bearer has no credential row. Preserve its earliest principal-expiry
            // cutoff before replacing that expiry, using the same monotonic retirement field as rotation.
            const cutoffs = [fresh.expiresAt, input.expiresAt].filter((date): date is Date => !!date)
            if (cutoffs.length) {
                const cutoff = new Date(Math.min(...cutoffs.map((date) => new Date(date).getTime())))
                await repo
                    .createQueryBuilder()
                    .update()
                    .set({ legacyRevokedAt: cutoff })
                    .where('id = :id', { id: key.id })
                    .andWhere('(legacyRevokedAt IS NULL OR legacyRevokedAt > :cutoff)', { cutoff })
                    .execute()
            }
            key.keyName = req.body.keyName.trim()
            key.accessPolicy = input.policy
            key.permissions = input.permissions
            key.expiresAt = input.expiresAt
            await manager
                .getRepository(ApiKey)
                .update(
                    { id: key.id, workspaceId: key.workspaceId },
                    { keyName: key.keyName, accessPolicy: input.policy, permissions: input.permissions, expiresAt: input.expiresAt }
                )
            await manager.getRepository(ApiKeyResource).delete({ principalId: key.id })
            for (const resource of input.resources)
                await manager
                    .getRepository(ApiKeyResource)
                    .upsert({ principalId: key.id, ...resource }, ['principalId', 'resourceType', 'resourceId'])
        })
    )
    await audit(req, key, 'policy changed', {
        before,
        after: { policy: input.policy, permissions: input.permissions, expiresAt: input.expiresAt, resources: input.resources }
    })
    const user = interactive(req)
    return apikeyService.getAllApiKeys({ ...user, activeWorkspaceId: user.activeWorkspaceId! })
})
export const rotateAccessKey: RequestHandler = action(async (req) => {
    requireAccessRollout()
    const key = await target(req)
    const data = await accessData()
    const result = await serial(() =>
        data.transaction((manager) =>
            manager
                .getRepository(ApiKey)
                .findOneByOrFail({ id: key.id, workspaceId: key.workspaceId })
                .then((fresh) => rotateCredential(manager, fresh, req.body?.graceSeconds ?? 3600))
        )
    )
    await audit(req, key, 'rotated', { credentialId: result.credential.id, graceSeconds: req.body?.graceSeconds ?? 3600 })
    const { digest: _digest, ...credential } = result.credential
    return { apiKey: result.secret, credential }
})
export const revokeAccessKey: RequestHandler = action(async (req) => {
    const key = await target(req)
    const now = new Date()
    const data = await accessData()
    await serial(() => data.getRepository(ApiKey).update({ id: key.id, workspaceId: key.workspaceId }, { disabledAt: now }))
    await audit(req, key, 'revoked')
    return { id: key.id, disabledAt: now }
})
export const revokeAccessCredential: RequestHandler = action(async (req) => {
    const key = await target(req)
    const data = await accessData()
    await serial(() =>
        data.transaction(async (manager) => {
            if (req.params.credentialId === 'legacy') {
                const now = new Date()
                await manager
                    .getRepository(ApiKey)
                    .createQueryBuilder()
                    .update()
                    .set({ legacyRevokedAt: now })
                    .where('id = :id', { id: key.id })
                    .andWhere('(legacyRevokedAt IS NULL OR legacyRevokedAt > :now)', { now })
                    .execute()
            } else {
                const result = await manager
                    .getRepository(ApiKeyCredential)
                    .update({ id: req.params.credentialId, principalId: key.id }, { revokedAt: new Date() })
                if (!result.affected) throw new AppError(404, 'Credential not found.')
            }
        })
    )
    await audit(req, key, 'credential revoked', { credentialId: req.params.credentialId })
    return { revoked: true }
})
