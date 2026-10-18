import type { IHarnessCaller } from '../Interface'
import apikeyService from '../services/apikey'

/**
 * The caller for a flow that no person is signed in to: the prediction API, a webhook, MCP, or a schedule. A flow bound
 * to a key runs for that key, read on each call; a key that is gone or in another team lists nothing.
 */
export async function flowHarnessCaller(
    apiKeyId: string | null | undefined,
    workspaceId: string | null | undefined
): Promise<IHarnessCaller> {
    if (!apiKeyId) return { via: 'flow' }
    const key = await apikeyService.getApiKeyById(apiKeyId)
    const stored = key && workspaceId && key.workspaceId === workspaceId && Array.isArray(key.harnesses) ? key.harnesses : []
    return { via: 'api_key', apiKeyId, harnesses: stored.filter((name): name is string => typeof name === 'string') }
}
