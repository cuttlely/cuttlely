import { DataSource, IsNull } from 'typeorm'
import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyResource } from '../../database/entities/ApiKeyResource'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { AppError } from '../../errors/appError'
import { serial } from './limiter'

/** Persist the old one-key binding and its derived grants as one transaction. Explicit policies are independent. */
export async function saveLegacyBoundFlow(data: DataSource, flow: ChatFlow, previous?: ChatFlow): Promise<ChatFlow> {
    if (flow.apikeyid && !['CHATFLOW', 'AGENTFLOW', 'MULTIAGENT', 'HARNESS', undefined, null].includes(flow.type))
        throw new AppError(403, 'This resource type does not support an inbound access-key binding.')
    return serial(() =>
        data.transaction(async (manager) => {
            const flows = manager.getRepository(ChatFlow)
            if (previous) {
                const current = await flows.findOneBy({ id: previous.id, workspaceId: previous.workspaceId })
                if (!current || (current.apikeyid || '') !== (previous.apikeyid || '') || current.apiAccessMode !== previous.apiAccessMode)
                    throw new AppError(409, 'The legacy binding changed. Reload before saving.')
            }
            const saved = await flows.save(flow)
            const resourceType =
                saved.type === 'HARNESS' ? 'HARNESS' : ['AGENTFLOW', 'MULTIAGENT'].includes(saved.type || '') ? 'AGENTFLOW' : 'CHATFLOW'
            const grants = manager.getRepository(ApiKeyResource)
            if (previous?.apikeyid && previous.apikeyid !== saved.apikeyid) {
                const former = await manager.getRepository(ApiKey).findOneBy({ id: previous.apikeyid, workspaceId: saved.workspaceId })
                // A Harness name grant predates the binding and remains independent. Policy editing removes the legacy marker.
                const independentlyNamed =
                    saved.type === 'HARNESS' && Array.isArray(former?.harnesses) && former.harnesses.includes(saved.name)
                if (former?.accessPolicy?.legacy && !independentlyNamed)
                    await grants.delete({ principalId: former.id, resourceType, resourceId: saved.id })
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
            if (requestedMode !== undefined) {
                if (!['public', 'private'].includes(requestedMode || '')) throw new AppError(400, 'Invalid API access mode.')
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
            }
            const { apikeyid: _binding, apiAccessMode: _mode, ...patch } = flow
            await repo.save(patch)
            return repo.findOneByOrFail({ id: flow.id, workspaceId: flow.workspaceId })
        })
    )
}
