import { AccessKeyUnavailableError, isMissingAccessResource } from './errors'
import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyResource } from '../../database/entities/ApiKeyResource'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { accessData } from './data'
import { principalActive } from './credentials'
import { accessRollout } from './rollout'

/** Stable canvas IDs are converted to names only at the existing runtime boundary. Deleted/recreated names inherit nothing. */
export async function keyHarnessNames(key: ApiKey, forRun = true): Promise<string[]> {
    if (!key.accessPolicy) return Array.isArray(key.harnesses) ? key.harnesses : []
    if (!principalActive(key)) return []
    if (key.accessPolicy.legacy && accessRollout() !== 'on') return Array.isArray(key.harnesses) ? key.harnesses : []
    if (
        !(forRun
            ? key.accessPolicy.scopes.includes('harness:run')
            : key.accessPolicy.scopes.some((s) => ['harness:run', 'harness:read', 'api:read'].includes(s)))
    )
        return []
    const data = await accessData()
    const flows = await data.getRepository(ChatFlow).findBy({ workspaceId: key.workspaceId, type: 'HARNESS' })
    const eligible = []
    for (const flow of flows) {
        // Read and run alike: only the runtime canvas for this name may appear. A stale same-name
        // SQL row must not mint an allowlisted name that getHarness would bind to another id.
        const actual = await resolveHarnessFlow(flow.name, key.workspaceId)
        if (actual?.id === flow.id) eligible.push(flow)
    }
    if (key.accessPolicy.allResources) return eligible.map((f) => f.name)
    const grants = await data.getRepository(ApiKeyResource).findBy({ principalId: key.id, resourceType: 'HARNESS' })
    const ids = new Set(grants.map((g) => g.resourceId))
    return eligible.filter((f) => ids.has(f.id)).map((f) => f.name)
}

/** Resolve the runtime's actual canvas ID, rather than an arbitrary SQL row with the same display name. */
export async function resolveHarnessFlow(name: string, workspaceId: string): Promise<ChatFlow | undefined> {
    try {
        const { default: harnesses } = await import('../harnesses')
        const record = await harnesses.getHarness(name, workspaceId)
        if (!record?.chatflowId || record.orphaned) return undefined
        const flow = await (await accessData()).getRepository(ChatFlow).findOneBy({ id: record.chatflowId, workspaceId, type: 'HARNESS' })
        return flow?.name === name ? flow : undefined
    } catch (error) {
        if (isMissingAccessResource(error)) return undefined
        throw new AccessKeyUnavailableError('Harness authorization is unavailable.')
    }
}
