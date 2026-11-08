import { keyHarnessIds, resolveHarnessFlow } from './resources'
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
    // Defined only for enforced key execution. Even an empty map requires a stable pin downstream.
    harnessIds?: Record<string, string>
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
async function loadRequestPrincipal(req: Request): Promise<ApiKey | undefined> {
    if (contexts.has(req)) return contexts.get(req)!.key
    const supplied = bearerApiKey(req.headers.authorization)
    if (!supplied || supplied.length > 256) return undefined
    const { default: service } = await import('../apikey')
    let key: ApiKey | undefined
    try {
        key = await service.getApiKey(supplied)
    } catch (error) {
        if (accessRollout() === 'on') {
            if (error instanceof AppError) throw error
            throw new AppError(503, 'Access key verification is unavailable.')
        }
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
            // Request-local intersection only — never mutate the shared credential entity.
            const permissions = key.permissions.filter((p) => access.permissions!.includes(p))
            key = { ...key, permissions }
        }
    }
    setAccessContext(req, key, ownerPermissions)
    return key
}
/** Normalize every identity-store read, including current workspace and owner authority. */
export async function authenticateRequest(req: Request): Promise<ApiKey | undefined> {
    try {
        return await loadRequestPrincipal(req)
    } catch (error) {
        if (accessRollout() !== 'on' || (error instanceof AppError && error.statusCode < 500)) throw error
        throw new AppError(503, 'Access key verification is unavailable.')
    }
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
async function checkKey(
    req: Request,
    operation: Operation,
    workspaceId: string,
    resource?: ResourceGrant,
    charge = true,
    requiredPermissions?: string[]
): Promise<ApiKey> {
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
    if (requiredPermissions && !requiredPermissions.some((permission) => key.permissions.includes(permission)))
        throw new AppError(403, 'This operation requires additional workspace permissions.')
    if (!callerPolicyAllows(policy, req.headers.origin, req.ip || '')) throw new AccessKeyPolicyError('Caller policy refused this request.')
    const admission = `${operation}:${resource?.resourceType || ''}:${resource?.resourceId || ''}`
    const ctx = contexts.get(req)!
    // The same flow is checked in middleware, controller and builder. Count one accepted HTTP operation.
    if (charge && !ctx.admitted.has('charged')) {
        await consume(data, key, operation, req.res)
        ctx.admitted.add('charged')
    }
    if (req.user?.apiKeyId === key.id && !req.user.id) req.user.permissions = key.permissions
    ctx.admitted.add(admission)
    ctx.checks.set(admission, [operation, workspaceId, resource])
    return key
}
export async function authorizeKey(
    req: Request,
    operation: Operation,
    workspaceId: string,
    resource?: ResourceGrant,
    charge = true,
    requiredPermissions?: string[]
): Promise<ApiKey> {
    try {
        const key = await checkKey(req, operation, workspaceId, resource, charge, requiredPermissions)
        if (charge) void recordKeyUse(req, key, operation, 'accepted').catch(() => undefined)
        return key
    } catch (error) {
        const key = accessContext(req)?.key
        if (key && accessRollout() === 'on') void recordKeyUse(req, key, operation, 'denied').catch(() => undefined)
        if (
            accessRollout() === 'on' &&
            !(error instanceof AppError && error.statusCode < 500) &&
            !(error instanceof AccessKeyPolicyError) &&
            !(error instanceof FlowOriginPolicyError)
        )
            throw new AppError(503, 'Access key verification is unavailable.')
        throw error
    }
}
export function flowOperation(req: Request): Operation {
    const path = req.originalUrl?.split('?')[0].toLowerCase() || ''
    // Segment-aware Harness/Dashflows classifiers first so path tokens like feedback-bot or upload
    // in a name cannot shadow harness:run / dashflow:report / dashflow:read.
    if (/\/harnesses\/[^/]+\/runs(?:\/|$)/.test(path)) return req.method === 'GET' || req.method === 'HEAD' ? 'harness:read' : 'harness:run'
    if (/\/dashflows\/[^/]+\/accounts\/[^/]+\/report(?:\/|$)/.test(path)) return 'dashflow:report'
    if (/\/dashflows\/[^/]+\/refresh(?:\/|$)/.test(path)) return 'dashflow:report'
    if (/\/dashflows\//.test(path)) return req.method === 'GET' || req.method === 'HEAD' ? 'dashflow:read' : 'dashflow:report'
    if (path.includes('/feedback')) return req.method === 'GET' || req.method === 'HEAD' ? 'feedback:read' : 'feedback:write'
    if (path.includes('attachment') || path.includes('upload') || path.includes('/vector')) return 'upload'
    if (path.includes('/chatmessage') || path.includes('/leads'))
        return req.method === 'GET' || req.method === 'HEAD' ? 'feedback:read' : 'feedback:write'
    return 'predict'
}
async function authorizeFlowV2(req: Request, flow: ChatFlow, charge = true): Promise<boolean> {
    try {
        return await authorizeFlowV2Body(req, flow, charge)
    } catch (error) {
        if (
            accessRollout() === 'on' &&
            !(error instanceof AppError && error.statusCode < 500) &&
            !(error instanceof AccessKeyPolicyError) &&
            !(error instanceof FlowOriginPolicyError)
        )
            throw new AppError(503, 'Access key verification is unavailable.')
        throw error
    }
}
async function authorizeFlowV2Body(req: Request, flow: ChatFlow, charge = true): Promise<boolean> {
    if (!req.headers.authorization) return flow.apiAccessMode === 'public' && !flow.apikeyid
    const presenting = await authenticateRequest(req)
    if (!presenting) throw new AppError(401, 'Unauthorized')
    if (
        presenting.accessPolicy?.legacy &&
        (presenting.workspaceId !== flow.workspaceId ||
            (flow.apikeyid && (flow.apikeyid !== presenting.id || !(await hasGrant(await accessData(), presenting, flowResource(flow))))))
    )
        throw new AppError(401, 'Unauthorized')
    const operation = flowOperation(req)
    await authorizeKey(req, operation, flow.workspaceId, flowResource(flow), false)
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
    const harnessIds: Record<string, string> = {}
    if (operation === 'predict' && flow.type === 'HARNESS') {
        await authorizeKey(req, 'harness:run', flow.workspaceId, flowResource(flow), false)
        harnessIds[flow.name] = flow.id
    }
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
            harnessIds[name] = harness.id
        }
        const { checkChatflowOrigin } = await import('../../utils/domainValidation')
        const origin = checkChatflowOrigin(flow.chatbotConfig, req.headers.origin)
        if (!origin.allowed) throw new FlowOriginPolicyError(origin.error)
    }
    const admittedKey = await authorizeKey(req, operation, flow.workspaceId, flowResource(flow), charge)
    // Never lower an authorized canvas to a mutable name. Keep explicitly checked identities even
    // if a concurrent replacement makes that name disappear from the wider nested-call grant set.
    if (operation === 'predict' && accessRollout() === 'on')
        accessContext(req)!.harnessIds = {
            ...(Object.keys(harnessIds).length ? await keyHarnessIds(admittedKey) : {}),
            ...harnessIds,
            ...accessContext(req)!.harnessIds
        }
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
        const priorUserPermissions = req.user?.permissions?.slice()
        const priorContext = contexts.get(req)
        try {
            scoped = await authorizeFlowV2(req, flow, false)
        } catch {
            /* Shadow computes a decision without admitting scoped work. */
        }
        // Probe must not change the legacy request that is actually served.
        if (priorContext) contexts.set(req, priorContext)
        else contexts.delete(req)
        if (req.user && priorUserPermissions) req.user.permissions = priorUserPermissions
        else if (req.user && !priorUserPermissions) delete (req.user as { permissions?: string[] }).permissions
        void compareLegacy(req, key, allowed, scoped, flow.workspaceId, flow.id, flowOperation(req)).catch(() => undefined)
    }
    return allowed
}
