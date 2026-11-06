import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyResource } from '../../database/entities/ApiKeyResource'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { accessData } from './data'
import { principalActive } from './credentials'

/** Stable canvas IDs are converted to names only at the existing runtime boundary. Deleted/recreated names inherit nothing. */
export async function keyHarnessNames(key: ApiKey): Promise<string[]> {
    if (!key.accessPolicy) return Array.isArray(key.harnesses) ? key.harnesses : []
    if (!principalActive(key) || !key.accessPolicy.scopes.includes('harness:run')) return []
    const data = await accessData()
    const flows = await data.getRepository(ChatFlow).findBy({ workspaceId: key.workspaceId, type: 'HARNESS' })
    if (key.accessPolicy.allResources) return flows.map((f) => f.name)
    const grants = await data.getRepository(ApiKeyResource).findBy({ principalId: key.id, resourceType: 'HARNESS' })
    const ids = new Set(grants.map((g) => g.resourceId))
    return flows.filter((f) => ids.has(f.id)).map((f) => f.name)
}
