import type { DataSource } from 'typeorm'
import { AccessKeyUnavailableError, isMissingAccessResource } from './errors'
import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyResource } from '../../database/entities/ApiKeyResource'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { accessData } from './data'
import { principalActive } from './credentials'
import { accessRollout } from './rollout'

/** Retain stable identities at admission, including Harness cards called by another Harness. */
export async function keyHarnessIds(key: ApiKey, forRun = true, dataSource?: DataSource): Promise<Record<string, string>> {
    if (!key.accessPolicy) return {}
    if (!principalActive(key)) return {}
    if (key.accessPolicy.legacy && accessRollout() !== 'on') return {}
    if (
        !(forRun
            ? key.accessPolicy.scopes.includes('harness:run')
            : key.accessPolicy.scopes.some((s) =>
                  ['harness:run', 'harness:read', 'api:read', 'feedback:read', 'feedback:write'].includes(s)
              ))
    )
        return {}
    const data = await accessData(dataSource)
    const flows = await data.getRepository(ChatFlow).findBy({ workspaceId: key.workspaceId, type: 'HARNESS' })
    const eligible = []
    for (const flow of flows) {
        // Read and run alike: only the runtime canvas for this name may appear. A stale same-name
        // SQL row must not mint an allowlisted name that getHarness would bind to another id.
        const actual = await resolveHarnessFlow(flow.name, key.workspaceId, dataSource)
        if (actual?.id === flow.id) eligible.push(flow)
    }
    if (key.accessPolicy.allResources) return Object.fromEntries(eligible.map((f) => [f.name, f.id]))
    const grants = await data.getRepository(ApiKeyResource).findBy({ principalId: key.id, resourceType: 'HARNESS' })
    const ids = new Set(grants.map((g) => g.resourceId))
    return Object.fromEntries(eligible.filter((f) => ids.has(f.id)).map((f) => [f.name, f.id]))
}

/** Off/shadow keep the legacy name-list contract. Enforced execution retains the IDs too. */
export async function keyHarnessNames(key: ApiKey, forRun = true, dataSource?: DataSource): Promise<string[]> {
    if (!key.accessPolicy || (key.accessPolicy.legacy && accessRollout() !== 'on')) return Array.isArray(key.harnesses) ? key.harnesses : []
    return Object.keys(await keyHarnessIds(key, forRun, dataSource))
}

/** Resolve the runtime's actual canvas ID, rather than an arbitrary SQL row with the same display name. */
export async function resolveHarnessFlow(name: string, workspaceId: string, dataSource?: DataSource): Promise<ChatFlow | undefined> {
    try {
        const { default: harnesses } = await import('../harnesses')
        const record = await harnesses.getHarness(name, workspaceId, dataSource)
        if (!record?.chatflowId || record.orphaned) return undefined
        const flow = await (await accessData(dataSource))
            .getRepository(ChatFlow)
            .findOneBy({ id: record.chatflowId, workspaceId, type: 'HARNESS' })
        return flow?.name === name ? flow : undefined
    } catch (error) {
        if (isMissingAccessResource(error)) return undefined
        throw new AccessKeyUnavailableError('Harness authorization is unavailable.')
    }
}
