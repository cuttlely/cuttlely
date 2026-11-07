import { resolveHarnessFlow } from './resources'
import { accessRollout, compareLegacy } from './rollout'
import { AccessKeyPolicyError, FlowOriginPolicyError } from './errors'
import { recordKeyUse } from './audit'
import { Request } from 'express'
import { DataSource } from 'typeorm'
import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyResource } from '../../database/entities/ApiKeyResource'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { Workspace, User, Organization } from '../../database/entities/identity'
import { AppError } from '../../errors/appError'
import { resolveTeamAccess } from '../../identity/rbac'
import { bearerApiKey } from '../../utils/apiKey'
import { accessData } from './data'
import { principalActive } from './credentials'
import { consume } from './limiter'
import { callerPolicyAllows, Operation, operationPermissions, readPolicy, ResourceGrant } from './policy'

interface AccessContext {
    key: ApiKey
    admitted: Set<string>
    ownerPermissions?: string[]
    checks: Map<string, [Operation, string, ResourceGrant | undefined]>
}
const contexts = new WeakMap<Request, AccessContext>()
export function accessContext(req: Request): AccessContext | undefined {
    return contexts.get(req)
}
export function setAccessContext(req: Request, key: ApiKey, ownerPermissions?: string[]): void {
    const old = contexts.get(req)
    if (!old || old.key.id !== key.id) contexts.set(req, { key, admitted: new Set(), ownerPermissions, checks: new Map() })
}
export async function authenticateRequest(req: Request): Promise<ApiKey | undefined> {
    if (contexts.has(req)) return contexts.get(req)!.key
    const supplied = bearerApiKey(req.headers.authorization)
    if (!supplied || supplied.length > 256) return undefined
    const { default: service } = await import('../apikey')
    let key: ApiKey | undefined
    try {
        key = await service.getApiKey(supplied)
    } catch {
        return undefined
    }
    if (!key || !principalActive(key)) return undefined
    if (key.accessPolicy) key.accessPolicy = readPolicy(key.accessPolicy)
    const data = await accessData()
    const workspace = await data.getRepository(Workspace).findOneBy({ id: key.workspaceId })
    if (!workspace || !(await data.getRepository(Organization).findOneBy({ id: workspace.organizationId }))) return undefined
    let ownerPermissions: string[] | undefined
    if (key.ownerUserId) {
        const owner = await data.getRepository(User).findOneBy({ id: key.ownerUserId })
        if (!owner || typeof owner.status !== 'string' || owner.status.toLowerCase() !== 'active') return undefined
        const access = await resolveTeamAccess(owner.id, key.workspaceId)
        if (!access.owner) {
            if (!access.permissions) return undefined
            ownerPermissions = access.permissions
            key.permissions = key.permissions.filter((p) => access.permissions!.includes(p))
        }
    }
    setAccessContext(req, key, ownerPermissions)
    return key
}
export function flowResource(flow: Pick<ChatFlow, 'id' | 'type'>): ResourceGrant {
    return {
        resourceType:
            flow.type === 'HARNESS' ? 'HARNESS' : ['AGENTFLOW', 'MULTIAGENT'].includes(flow.type || '') ? 'AGENTFLOW' : 'CHATFLOW',
        resourceId: flow.id
    }
}
export async function hasGrant(data: DataSource, key: ApiKey, resource: ResourceGrant): Promise<boolean> {
    if (key.accessPolicy?.allResources) return true
    return !!(await data.getRepository(ApiKeyResource).findOneBy({ principalId: key.id, ...resource }))
}
async function checkKey(req: Request, operation: Operation, workspaceId: string, resource?: ResourceGrant, charge = true): Promise<ApiKey> {
    // Preflight can run long before the body finishes. Refresh credential, principal and owner
    // at admission; an already admitted operation keeps its request-local authentication.
    const pending = charge && !contexts.get(req)?.admitted.has('charged') ? contexts.get(req) : undefined
    if (pending) contexts.delete(req)
    const key = await authenticateRequest(req)
    if (!key) throw new AppError(401, 'Unauthorized')
    if (key.workspaceId !== workspaceId) throw new AppError(401, 'Unauthorized')
    const policy = key.accessPolicy ? readPolicy(key.accessPolicy) : undefined
    if (!policy) throw new AccessKeyPolicyError('Access policy unavailable. Run database migrations.')
    const ownerPermissions = accessContext(req)?.ownerPermissions
    if (
        ownerPermissions &&
        !(policy.legacy && !resource && ['api:read', 'api:write'].includes(operation)) &&
        !operationPermissions(operation, resource).some((p) => ownerPermissions.includes(p))
    )
        throw new AccessKeyPolicyError('The access key owner no longer has permission for this operation.')
    if (!policy.scopes.includes(operation)) throw new AccessKeyPolicyError('Operation is not allowed by this access key.')
    // Revalidate prerequisites (for example stream or nested Harness authority) against the
    // refreshed principal too, before any quota is consumed.
    if (pending) for (const check of pending.checks.values()) await checkKey(req, ...check, false)
    const data = await accessData()
    if (resource && !(await hasGrant(data, key, resource))) throw new AccessKeyPolicyError('Resource is not allowed by this access key.')
    if (!policy.legacy && !operationPermissions(operation, resource).some((permission) => key.permissions.includes(permission)))
        throw new AccessKeyPolicyError('Access key permissions do not allow this operation.')
    if (!callerPolicyAllows(policy, req.headers.origin, req.ip || '')) throw new AccessKeyPolicyError('Caller policy refused this request.')
    const admission = `${operation}:${resource?.resourceType || ''}:${resource?.resourceId || ''}`
    const ctx = contexts.get(req)!
    // The same flow is checked in middleware, controller and builder. Count one accepted HTTP operation.
    if (charge && !ctx.admitted.has('charged')) {
        await consume(data, key, operation, req.res)
        ctx.admitted.add('charged')
    }
    ctx.admitted.add(admission)
    ctx.checks.set(admission, [operation, workspaceId, resource])
    return key
}
export async function authorizeKey(
    req: Request,
    operation: Operation,
    workspaceId: string,
    resource?: ResourceGrant,
    charge = true
): Promise<ApiKey> {
    try {
        const key = await checkKey(req, operation, workspaceId, resource, charge)
        if (charge) void recordKeyUse(req, key, operation, 'accepted').catch(() => undefined)
        return key
    } catch (error) {
        const key = accessContext(req)?.key
        if (key) void recordKeyUse(req, key, operation, 'denied').catch(() => undefined)
        throw error
    }
}
export function flowOperation(req: Request): Operation {
    const path = req.originalUrl?.split('?')[0].toLowerCase() || ''
    if (path.includes('/feedback')) return req.method === 'GET' || req.method === 'HEAD' ? 'feedback:read' : 'feedback:write'
    if (path.includes('attachment') || path.includes('upload') || path.includes('/vector')) return 'upload'
    if (path.includes('/chatmessage') || path.includes('/leads'))
        return req.method === 'GET' || req.method === 'HEAD' ? 'feedback:read' : 'feedback:write'
    return 'predict'
}
async function authorizeFlowV2(req: Request, flow: ChatFlow, charge = true): Promise<boolean> {
    if (!req.headers.authorization) return flow.apiAccessMode === 'public'
    const presenting = await authenticateRequest(req)
    if (!presenting) throw new AppError(401, 'Unauthorized')
    if (
        presenting.accessPolicy?.legacy &&
        (presenting.workspaceId !== flow.workspaceId ||
            (flow.apikeyid && (flow.apikeyid !== presenting.id || !(await hasGrant(await accessData(), presenting, flowResource(flow))))))
    )
        throw new AppError(401, 'Unauthorized')
    const operation = flowOperation(req)
    const key = await authorizeKey(req, operation, flow.workspaceId, flowResource(flow), false)
    if (req.headers['content-type']?.toLowerCase().startsWith('multipart/form-data')) {
        await authorizeKey(req, 'upload', flow.workspaceId, flowResource(flow), false)
        // Fields arrive after file storage starts. Apply the same conservative check to retained legacy bearer values.
        if (operation === 'predict') await authorizeKey(req, 'stream', flow.workspaceId, flowResource(flow), false)
    }
    // Streaming is an additional scope. Check again after multipart parsing before starting SSE.
    const external = (req as Request & { orchestrate?: { stream?: unknown; method?: unknown } }).orchestrate
    if (
        external?.stream === true ||
        external?.method === 'message/stream' ||
        req.body?.streaming === true ||
        req.body?.streaming === 'true' ||
        req.headers.accept?.includes('text/event-stream')
    )
        await authorizeKey(req, 'stream', flow.workspaceId, flowResource(flow), false)
    if (operation === 'predict' && flow.type === 'HARNESS')
        await authorizeKey(req, 'harness:run', flow.workspaceId, flowResource(flow), false)
    if (operation === 'predict') {
        // Nested execution uses the presenting principal, never the flow's old bound key.
        if (typeof flow.flowData === 'string') {
            try {
                JSON.parse(flow.flowData)
            } catch {
                throw new AccessKeyPolicyError('Flow authorization data is unavailable.')
            }
        }
        const { referencedHarnessNames } = await import('../harnesses/apiAccess')
        const names = referencedHarnessNames(flow.flowData)
        for (const name of names) {
            const harness = await resolveHarnessFlow(name, flow.workspaceId)
            if (!harness || harness.name !== name) throw new AccessKeyPolicyError('Referenced harness is unavailable.')
            await authorizeKey(req, 'harness:run', flow.workspaceId, flowResource(harness), false)
        }
        const { checkChatflowOrigin } = await import('../../utils/domainValidation')
        const origin = checkChatflowOrigin(flow.chatbotConfig, req.headers.origin)
        if (!origin.allowed) throw new FlowOriginPolicyError(origin.error)
    }
    await authorizeKey(req, operation, flow.workspaceId, flowResource(flow), charge)
    setAccessContext(req, key)
    return true
}

export async function authorizeFlowKey(req: Request, flow: ChatFlow, charge = true): Promise<boolean> {
    const mode = accessRollout()
    if (mode === 'on') return authorizeFlowV2(req, flow, charge)
    const key = req.headers.authorization ? await authenticateRequest(req) : undefined
    if (key && !key.accessPolicy?.legacy) throw new AppError(503, 'Scoped access keys require INBOUND_ACCESS_V2=on.')
    const allowed =
        (flow.apiAccessMode === 'public' && !flow.apikeyid) || !!(key && key.id === flow.apikeyid && key.workspaceId === flow.workspaceId)
    if (mode === 'shadow') {
        let scoped = false
        try {
            scoped = await authorizeFlowV2(req, flow, false)
        } catch {
            /* Shadow computes a decision without admitting scoped work. */
        }
        void compareLegacy(req, key, allowed, scoped, flow.workspaceId, flow.id).catch(() => undefined)
    }
    return allowed
}
