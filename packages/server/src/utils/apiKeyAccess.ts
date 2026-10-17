import type { IApiKeyAccess } from '../Interface'

/** The node options a Harness card reads. Empty when no API key is in play. */
export function apiKeyNodeOptions(access?: IApiKeyAccess): { apiKeyId?: string; apiKeyHarnesses?: string[] } {
    return access?.apiKeyId ? { apiKeyId: access.apiKeyId, apiKeyHarnesses: [...access.harnesses] } : {}
}
