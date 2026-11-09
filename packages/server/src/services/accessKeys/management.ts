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
import {
    expiry,
    missingPolicyPermissions,
    operationAppliesTo,
    OPERATIONS,
    operationPermissions,
    parseGrants,
    parsePolicy,
    RESOURCE_TYPES,
    ResourceGrant
} from './policy'
import { ACCESS_KEY_DOCS } from './errors'
import { resolveHarnessFlow } from './resources'
import { serial } from './limiter'
import { EntityManager } from 'typeorm'

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
    if (typeof req.params.id !== 'string' || !req.params.id.trim()) throw new AppError(412, 'Access key id is required.')
    const row = await (await accessData()).getRepository(ApiKey).findOneBy({ id: req.params.id, workspaceId: user.activeWorkspaceId })
    if (!row) throw new AppError(404, 'Access key not found.')
    const grants = await (await accessData()).getRepository(ApiKeyResource).findBy({ principalId: row.id })
    await assertTarget(req, row, grants)
    return row
}
async function assertTarget(req: Request, row: ApiKey, grants: ApiKeyResource[]): Promise<void> {
    // Reauthorize the target, including its stored permissions, before editing or revoking it.
    const permitted = await hasAnyPermission(req, 'apikeys:grant-all')
    if (row.accessPolicy?.allResources && !permitted) throw new AppError(403, 'Managing a workspace-wide grant requires apikeys:grant-all.')
    for (const permission of row.permissions)
        if (!(await hasAnyPermission(req, permission))) throw new AppError(403, 'Access key exceeds your current permissions.')
    if (row.accessPolicy?.legacy) {
        // Compatibility scopes include operations that are not independently usable. Check only actual resource authority.
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
        const applicable: ResourceGrant[] = row.accessPolicy?.allResources
            ? RESOURCE_TYPES.map((resourceType) => ({ resourceType, resourceId: '*' }))
            : parseGrants(grants)
        for (const operation of row.accessPolicy?.scopes || []) {
            if (!(await hasAnyPermission(req, ...OPERATIONS[operation])))
                throw new AppError(403, 'Access key operations exceed your current permissions.')
            for (const grant of applicable) {
                if (operation.startsWith('harness:') && grant.resourceType !== 'HARNESS') continue
                if (operation.startsWith('dashflow:') !== (grant.resourceType === 'DASHFLOW')) continue
                if (!(await hasAnyPermission(req, ...operationPermissions(operation, grant))))
                    throw new AppError(403, 'Access key resource operations exceed your current permissions.')
            }
        }
    }
}
async function choices(req: Request) {
    const user = interactive(req)
    const flows = await (await accessData()).getRepository(ChatFlow).findBy({ workspaceId: user.activeWorkspaceId })
    const resources: Array<ResourceGrant & { name: string; requiredHarnesses: string[] }> = []
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

/** Preview explicit additions; only a subsequent, confirmed save grants access. */
async function requirements(req: Request) {
    const policy = parsePolicy(req.body.accessPolicy)
    const resources = parseGrants(req.body.resources)
    const permissions: string[] = Array.isArray(req.body.permissions) ? [...req.body.permissions] : []
    const available = await choices(req)
    const missing: string[] = []
    let canFix = true
    for (const resource of resources) {
        if (!available.resources.some((r) => r.resourceType === resource.resourceType && r.resourceId === resource.resourceId))
            throw new AppError(403, `This resource is unavailable or outside your permissions. Remove its grant. Help: ${ACCESS_KEY_DOCS}`)
    }
    if (!resources.length && !policy.allResources) {
        missing.push('Choose at least one flow or resource for this key.')
        canFix = false
    }
    if (!policy.scopes.length) {
        missing.push('Choose an API operation, such as predict to call the selected flow.')
        canFix = false
    }
    const queue = policy.allResources
        ? [...available.resources]
        : resources.map(
              (grant) => available.resources.find((r) => r.resourceType === grant.resourceType && r.resourceId === grant.resourceId)!
          )
    const seen = new Set<string>()
    if (policy.scopes.includes('predict')) {
        while (queue.length) {
            const resource = queue.shift()!
            if (seen.has(resource.resourceType + ':' + resource.resourceId)) continue
            seen.add(resource.resourceType + ':' + resource.resourceId)
            if (seen.size > 500) throw new AppError(400, 'This selection has too many dependent resources. Choose fewer flows.')
            if (resource.resourceType === 'HARNESS' && !policy.scopes.includes('harness:run')) {
                missing.push(`Calling ${resource.name} also needs the harness:run API operation.`)
                policy.scopes.push('harness:run')
            }
            for (const name of resource.requiredHarnesses || []) {
                const harness = await resolveHarnessFlow(name, interactive(req).activeWorkspaceId!)
                const choice = harness && available.resources.find((r) => r.resourceType === 'HARNESS' && r.resourceId === harness.id)
                if (!choice) {
                    missing.push(
                        `${resource.name} needs the ${name} Harness, which is unavailable. Ask an admin to publish it and grant you view access.`
                    )
                    canFix = false
                    continue
                }
                if (!policy.allResources && !resources.some((r) => r.resourceType === 'HARNESS' && r.resourceId === choice.resourceId)) {
                    missing.push(`This key can't call ${resource.name} yet: it also needs the ${choice.name} Harness. Add it?`)
                    resources.push({ resourceType: 'HARNESS', resourceId: choice.resourceId })
                }
                queue.push(choice)
            }
        }
    }
    const grants: ResourceGrant[] = policy.allResources ? available.resources : resources
    for (const operation of policy.scopes) {
        for (const grant of grants.filter((r) => operationAppliesTo(operation, r))) {
            const needed = operationPermissions(operation, grant)
            if (needed.some((p) => permissions.includes(p))) continue
            let allowed: string | undefined
            for (const permission of needed)
                if (await hasAnyPermission(req, permission)) {
                    allowed = permission
                    break
                }
            if (!allowed) {
                missing.push(`Ask an admin for ${needed.join(' or ')} before granting ${operation}.`)
                canFix = false
            } else {
                missing.push(`${operation} also needs ${allowed} permission. Add it?`)
                permissions.push(allowed)
            }
        }
    }
    return { valid: missing.length === 0, missing, canFix, suggested: { accessPolicy: policy, resources, permissions } }
}

export const validateAccessKey: RequestHandler = action(async (req) => {
    requireAccessRollout()
    interactive(req)
    const result = await requirements(req)
    if (result.canFix) {
        const proposed = { ...req, body: { ...req.body, ...result.suggested } } as Request
        await policyInput(proposed, false)
    }
    return result
})

async function policyInput(req: Request, checkDependencies = true) {
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
    const missing = missingPolicyPermissions(policy, permissions, resources)
    if (missing.length)
        throw new AppError(400, `This key cannot call the selected API yet: ${missing.join('; ')}. Help: ${ACCESS_KEY_DOCS}`)
    if (checkDependencies && policy.scopes.includes('predict')) {
        const ready = await requirements(req)
        if (!ready.valid) throw new AppError(400, `${ready.missing.join(' ')} Help: ${ACCESS_KEY_DOCS}`)
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
            // Authority can change while this request waits for another lifecycle writer.
            await policyInput(req)
            if (!(await manager.getRepository(Workspace).findOneBy({ id: user.activeWorkspaceId })))
                throw new AppError(401, 'Workspace unavailable.')
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
// Test seam: pause after the initial policy snapshot, before joining the writer mutex.
export const lifecycleHooks: { beforeLock: null | (() => Promise<void>) } = { beforeLock: null }

function policySnapshot(key: ApiKey, grants: ApiKeyResource[]): string {
    return JSON.stringify({
        policy: key.accessPolicy,
        permissions: [...key.permissions].sort(),
        ownerUserId: key.ownerUserId,
        expiresAt: key.expiresAt,
        disabledAt: key.disabledAt,
        harnesses: key.harnesses,
        grants: grants.map(({ resourceType, resourceId }) => `${resourceType}:${resourceId}`).sort()
    })
}
async function lifecycleSnapshot(req: Request) {
    const key = await target(req)
    const grants = await (await accessData()).getRepository(ApiKeyResource).findBy({ principalId: key.id })
    return { key, grants, policy: policySnapshot(key, grants) }
}
async function withLifecycleTarget<T>(
    req: Request,
    expected: Awaited<ReturnType<typeof lifecycleSnapshot>>,
    work: (manager: EntityManager, key: ApiKey) => Promise<T>
): Promise<T> {
    const data = await accessData()
    if (lifecycleHooks.beforeLock) await lifecycleHooks.beforeLock()
    return serial(() =>
        data.transaction(async (manager) => {
            const key = await manager.getRepository(ApiKey).findOneBy({ id: expected.key.id, workspaceId: expected.key.workspaceId })
            const grants = key ? await manager.getRepository(ApiKeyResource).findBy({ principalId: key.id }) : []
            if (!key || policySnapshot(key, grants) !== expected.policy)
                throw new AppError(409, 'Access key policy changed. Reload before saving.')
            // The definitive authorization runs on the same snapshot and transaction as the mutation.
            await assertTarget(req, key, grants)
            return work(manager, key)
        })
    )
}

export const updateAccessKey: RequestHandler = action(async (req) => {
    const snapshot = await lifecycleSnapshot(req)
    const key = snapshot.key
    const input = await policyInput(req)
    const before = {
        policy: key.accessPolicy,
        permissions: key.permissions,
        expiresAt: key.expiresAt,
        resources: snapshot.grants.map(({ resourceId, resourceType }) => ({ resourceId, resourceType }))
    }
    await withLifecycleTarget(req, snapshot, async (manager, fresh) => {
        await policyInput(req)
        const repo = manager.getRepository(ApiKey)
        // Principal activity is reversible; an issued bearer's earliest expiry is not. Cap
        // every credential in the same transaction before replacing the principal expiry.
        const cutoffs = [fresh.expiresAt, input.expiresAt].filter((date): date is Date => !!date)
        if (cutoffs.length) {
            const cutoff = new Date(Math.min(...cutoffs.map((date) => new Date(date).getTime())))
            await manager
                .getRepository(ApiKeyCredential)
                .createQueryBuilder()
                .update()
                .set({ expiresAt: cutoff })
                .where('principalId = :id', { id: key.id })
                .andWhere('(expiresAt IS NULL OR expiresAt > :cutoff)', { cutoff })
                .execute()
            // Retained legacy bearers have no credential row.
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
    await audit(req, key, 'policy changed', {
        before,
        after: { policy: input.policy, permissions: input.permissions, expiresAt: input.expiresAt, resources: input.resources }
    })
    const user = interactive(req)
    return apikeyService.getAllApiKeys({ ...user, activeWorkspaceId: user.activeWorkspaceId! })
})
export const rotateAccessKey: RequestHandler = action(async (req) => {
    requireAccessRollout()
    const snapshot = await lifecycleSnapshot(req)
    const result = await withLifecycleTarget(req, snapshot, (manager, key) =>
        rotateCredential(manager, key, req.body?.graceSeconds ?? 3600)
    )
    await audit(req, snapshot.key, 'rotated', { credentialId: result.credential.id, graceSeconds: req.body?.graceSeconds ?? 3600 })
    const { digest: _digest, ...credential } = result.credential
    return { apiKey: result.secret, credential }
})
export const revokeAccessKey: RequestHandler = action(async (req) => {
    const snapshot = await lifecycleSnapshot(req)
    const now = new Date()
    await withLifecycleTarget(req, snapshot, (manager, key) =>
        manager.getRepository(ApiKey).update({ id: key.id, workspaceId: key.workspaceId }, { disabledAt: now })
    )
    await audit(req, snapshot.key, 'revoked')
    return { id: snapshot.key.id, disabledAt: now }
})
export const revokeAccessCredential: RequestHandler = action(async (req) => {
    const snapshot = await lifecycleSnapshot(req)
    await withLifecycleTarget(req, snapshot, async (manager, key) => {
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
    await audit(req, snapshot.key, 'credential revoked', { credentialId: req.params.credentialId })
    return { revoked: true }
})
