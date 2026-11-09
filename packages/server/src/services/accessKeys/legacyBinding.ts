import { DataSource, EntityManager, IsNull } from 'typeorm'
import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyResource } from '../../database/entities/ApiKeyResource'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { AppError } from '../../errors/appError'
import { serial } from './limiter'

// Canvas writers enter the same mutex as binding and principal writers through this boundary.
export { serial as withAccessKeyWrite } from './limiter'

function resourceTypeOf(type: ChatFlow['type']): 'HARNESS' | 'AGENTFLOW' | 'CHATFLOW' {
    return type === 'HARNESS' ? 'HARNESS' : ['AGENTFLOW', 'MULTIAGENT'].includes(type || '') ? 'AGENTFLOW' : 'CHATFLOW'
}

/** Persist the old one-key binding and its derived grants as one transaction. Explicit policies are independent. */
export async function saveLegacyBoundFlow(data: DataSource, flow: ChatFlow, previous?: ChatFlow): Promise<ChatFlow> {
    if (flow.apikeyid && !['CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS', undefined, null].includes(flow.type))
        throw new AppError(403, 'This resource type does not support an inbound access-key binding.')
    return serial(() =>
        data.transaction(async (manager) => {
            const flows = manager.getRepository(ChatFlow)
            // Authority comes from the current row, not a stale caller snapshot.
            // SQLite cannot take row locks here; serial() already serializes binding writers in-process.
            const locked = flow.id ? (await flows.findOneBy({ id: flow.id, workspaceId: flow.workspaceId })) || undefined : undefined
            if (previous) {
                if (!locked || (locked.apikeyid || '') !== (previous.apikeyid || '') || locked.apiAccessMode !== previous.apiAccessMode)
                    throw new AppError(409, 'The legacy binding changed. Reload before saving.')
            }
            const formerKeyId = locked?.apikeyid || previous?.apikeyid || undefined
            const formerType = locked?.type ?? previous?.type
            // Binding allowlist is decided from the persisted row after write, not a partial caller type.
            if (
                flow.apikeyid &&
                locked &&
                !['CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS', undefined, null].includes(locked.type) &&
                flow.type === undefined
            )
                throw new AppError(403, 'This resource type does not support an inbound access-key binding.')
            const { mcpServerConfig: _mcp, webhookSecret: _webhook, webhookSecretConfigured: _configured, ...patch } = flow
            if (flow.id) {
                const result = await flows.update({ id: flow.id, workspaceId: flow.workspaceId }, patch)
                if (!result.affected) throw new AppError(409, 'Flow changed. Reload before saving.')
            } else {
                const inserted = await flows.insert(patch)
                flow = Object.assign(new ChatFlow(), flow, inserted.identifiers[0])
            }
            const saved = await flows.findOneByOrFail({ id: flow.id, workspaceId: flow.workspaceId })
            if (saved.apikeyid && !['CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS', undefined, null].includes(saved.type))
                throw new AppError(403, 'This resource type does not support an inbound access-key binding.')
            const resourceType = resourceTypeOf(saved.type)
            const grants = manager.getRepository(ApiKeyResource)
            // Key change or resource-type change must drop the prior derived grant so unbind cannot leave a stale type.
            if (formerKeyId && (formerKeyId !== saved.apikeyid || resourceTypeOf(formerType) !== resourceType)) {
                const former = await manager.getRepository(ApiKey).findOneBy({ id: formerKeyId, workspaceId: saved.workspaceId })
                // A Harness name grant predates the binding and remains independent. Policy editing removes the legacy marker.
                // Only a prior HARNESS grant for a name already on the legacy allowlist is independent.
                // Independence is decided from the pre-write name so a same-request rename cannot
                // inherit or drop a derived grant by landing on (or off) the legacy allowlist.
                const priorName = locked?.name ?? previous?.name
                const independentlyNamed =
                    resourceTypeOf(formerType) === 'HARNESS' &&
                    typeof priorName === 'string' &&
                    Array.isArray(former?.harnesses) &&
                    former.harnesses.includes(priorName)
                if (former?.accessPolicy?.legacy && !independentlyNamed)
                    await grants.delete({
                        principalId: former.id,
                        resourceType: resourceTypeOf(formerType),
                        resourceId: saved.id
                    })
            }
            if (saved.apikeyid) {
                const key = await manager.getRepository(ApiKey).findOneBy({ id: saved.apikeyid, workspaceId: saved.workspaceId })
                if (!key?.accessPolicy?.legacy) throw new AppError(403, 'Legacy bindings require a legacy key in this workspace.')
                await grants.upsert({ principalId: key.id, resourceType, resourceId: saved.id }, [
                    'principalId',
                    'resourceType',
                    'resourceId'
                ])
            }
            return saved
        })
    )
}

/** Reconcile on the conditional row writer's manager; row and grants must commit or roll back together. */
export async function reconcileLegacyBoundTypeChange(
    manager: EntityManager,
    flow: ChatFlow,
    formerType: ChatFlow['type'],
    formerName = flow.name
): Promise<void> {
    if (!flow.apikeyid) return
    const nextType = resourceTypeOf(flow.type)
    const priorType = resourceTypeOf(formerType)
    if (nextType === priorType) return
    const key = await manager.getRepository(ApiKey).findOneBy({ id: flow.apikeyid, workspaceId: flow.workspaceId })
    if (!key?.accessPolicy?.legacy) return
    const grants = manager.getRepository(ApiKeyResource)
    const independentlyNamed = priorType === 'HARNESS' && Array.isArray(key.harnesses) && key.harnesses.includes(formerName)
    if (!independentlyNamed) await grants.delete({ principalId: key.id, resourceType: priorType, resourceId: flow.id })
    await grants.upsert({ principalId: key.id, resourceType: nextType, resourceId: flow.id }, ['principalId', 'resourceType', 'resourceId'])
}

/** An ordinary or compensating canvas save must never write the access fields from its earlier snapshot. */
export async function saveFlowPreservingAccess(
    data: DataSource,
    flow: ChatFlow,
    previous: ChatFlow,
    requestedMode?: string | null
): Promise<ChatFlow> {
    return serial(() =>
        data.transaction(async (manager) => {
            const repo = manager.getRepository(ChatFlow)
            // Compare with the transactional pre-image, even for an ordinary category/name save.
            // A stale snapshot must not restore a former type and strand its derived grant.
            const former = await repo.findOneBy({ id: flow.id, workspaceId: flow.workspaceId })
            if (!former || (flow.type === previous.type && former.type !== previous.type))
                throw new AppError(409, 'Flow type changed. Reload before saving.')
            if (requestedMode !== undefined) {
                if (!['public', 'private'].includes(requestedMode || '')) throw new AppError(400, 'Invalid API access mode.')
                // Drivers that report changed-rows (SQLite/MySQL without FOUND_ROWS) return affected=0 for a no-op.
                // Skip the UPDATE when the requested mode already matches the admitted previous snapshot.
                if (requestedMode !== previous.apiAccessMode) {
                    const result = await repo.update(
                        {
                            id: flow.id,
                            workspaceId: flow.workspaceId,
                            apikeyid: (previous.apikeyid ?? IsNull()) as any,
                            apiAccessMode: (previous.apiAccessMode ?? IsNull()) as any
                        },
                        { apiAccessMode: requestedMode }
                    )
                    if (!result.affected) throw new AppError(409, 'API access changed. Reload before saving.')
                } else {
                    const still = await repo.findOneBy({
                        id: flow.id,
                        workspaceId: flow.workspaceId,
                        apikeyid: (previous.apikeyid ?? IsNull()) as any,
                        apiAccessMode: (previous.apiAccessMode ?? IsNull()) as any
                    })
                    if (!still) throw new AppError(409, 'API access changed. Reload before saving.')
                }
            }
            const {
                apikeyid: _binding,
                apiAccessMode: _mode,
                mcpServerConfig: _mcp,
                webhookSecret: _webhook,
                webhookSecretConfigured: _configured,
                ...patch
            } = flow
            const result = await repo.update({ id: flow.id, workspaceId: flow.workspaceId, type: (former.type ?? IsNull()) as any }, patch)
            if (!result.affected) throw new AppError(409, 'Flow changed. Reload before saving.')
            const saved = await repo.findOneByOrFail({ id: flow.id, workspaceId: flow.workspaceId })
            await reconcileLegacyBoundTypeChange(manager, saved, former.type, former.name)
            return saved
        })
    )
}
