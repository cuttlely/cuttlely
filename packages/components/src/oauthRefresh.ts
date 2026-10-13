import { secureAxiosRequest } from './httpSecurity'

/** Same hosts as DEFAULT_ALLOWED_OAUTH2_DOMAINS. The server route keeps that list for authorize and callback. */
export const OAUTH2_REFRESH_DOMAINS = [
    'login.microsoftonline.com',
    'oauth2.googleapis.com',
    'accounts.google.com',
    'github.com',
    'login.salesforce.com',
    'test.salesforce.com',
    'oauth2.hubapi.com',
    'api.hubapi.com',
    'oauth.pipedrive.com',
    'app.clickup.com',
    'api.clickup.com',
    'login.xero.com',
    'identity.xero.com',
    'oauth2.sky.blackbaud.com',
    'app.asana.com',
    'todoist.com',
    'api.todoist.com',
    'slack.com',
    'oauth.pocketsmith.com',
    'api.notion.com',
    'api.dropboxapi.com',
    'api.box.com',
    'zoom.us',
    'auth.atlassian.com',
    'login.zoho.com',
    'accounts.zoho.com',
    'airtable.com',
    'api.linear.app',
    'discord.com',
    'api.pipedream.com'
]

export const OAUTH2_TOKEN_FIELDS = [
    'access_token',
    'refresh_token',
    'token_type',
    'expires_in',
    'scope',
    'id_token',
    'granted_scope'
] as const

export const OAUTH2_REFRESH_FAILED = 'Failed to refresh access token. Please re-authorize the credential.'

type CredentialRepo = {
    findOneBy: (query: Record<string, unknown>) => Promise<{ id: string; workspaceId?: string } | null>
    update: (id: string, patch: Record<string, unknown>) => Promise<unknown>
    count?: (query: unknown) => Promise<number>
}

type RefreshStore = {
    getRepository: (entity: any) => CredentialRepo
    entityMetadatas?: Array<{ name: string; target: any }>
}

function allowedDomains(): string[] {
    const securityCheckEnabled = process.env.OAUTH2_SECURITY_CHECK !== 'false'
    const custom = (process.env.OAUTH2_ALLOWED_TOKEN_DOMAINS ?? '')
        .split(',')
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean)
    if (securityCheckEnabled) return [...new Set([...OAUTH2_REFRESH_DOMAINS, ...custom])]
    return custom
}

function assertTokenUrl(url: string): void {
    const securityCheckEnabled = process.env.OAUTH2_SECURITY_CHECK !== 'false'
    const domains = allowedDomains()
    if (!securityCheckEnabled && domains.length === 0) return
    const parsed = new URL(url)
    if (securityCheckEnabled && parsed.protocol !== 'https:') {
        throw new Error('OAuth2 URL must use HTTPS')
    }
    const hostname = parsed.hostname.toLowerCase()
    const isAllowed = domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    if (!isAllowed) throw new Error('OAuth2 URL domain is not in the allowed list')
}

function safeProviderCode(data: unknown): string {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'unknown'
    const code = (data as { error?: unknown }).error
    if (typeof code !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(code)) return 'unknown'
    return code
}

function extractTokenFields(data: unknown): Record<string, unknown> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error(OAUTH2_REFRESH_FAILED)
    }
    const source = data as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of OAUTH2_TOKEN_FIELDS) {
        if (source[key] !== undefined) result[key] = source[key]
    }
    return result
}

/**
 * Exchanges a refresh token with the provider. The thrown message never includes the provider body.
 * The returned object is the credential to store, including the new access token, for the node that already holds this secret.
 */
export async function exchangeOAuth2Refresh(decrypted: Record<string, any>): Promise<Record<string, any>> {
    const clientId = decrypted.clientId
    const clientSecret = decrypted.clientSecret
    const refreshToken = decrypted.refresh_token
    const tokenUrl = decrypted.accessTokenUrl
    if (!clientId || !clientSecret || !refreshToken || !tokenUrl) {
        throw new Error(OAUTH2_REFRESH_FAILED)
    }
    try {
        assertTokenUrl(String(tokenUrl))
    } catch {
        console.error('[oauth2] token refresh rejected the token endpoint')
        throw new Error(OAUTH2_REFRESH_FAILED)
    }

    const body: Record<string, string> = {
        client_id: String(clientId),
        client_secret: String(clientSecret),
        grant_type: 'refresh_token',
        refresh_token: String(refreshToken)
    }
    if (decrypted.scope) body.scope = String(decrypted.scope)

    let tokenResponse: { status: number; data: unknown }
    try {
        tokenResponse = await secureAxiosRequest({
            method: 'POST',
            url: String(tokenUrl),
            data: new URLSearchParams(body).toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            }
        })
    } catch {
        console.error('[oauth2] token refresh request failed')
        throw new Error(OAUTH2_REFRESH_FAILED)
    }

    if (tokenResponse.status >= 400) {
        console.error(`[oauth2] token refresh failed status=${tokenResponse.status} code=${safeProviderCode(tokenResponse.data)}`)
        throw new Error(OAUTH2_REFRESH_FAILED)
    }

    let fields: Record<string, unknown>
    try {
        fields = extractTokenFields(tokenResponse.data)
    } catch {
        console.error('[oauth2] token refresh returned an unexpected body')
        throw new Error(OAUTH2_REFRESH_FAILED)
    }

    const updated: Record<string, any> = {
        ...decrypted,
        ...fields,
        token_received_at: new Date().toISOString()
    }
    const expiresIn = typeof fields.expires_in === 'number' ? fields.expires_in : Number(fields.expires_in)
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
        updated.expires_at = new Date(Date.now() + expiresIn * 1000).toISOString()
    }
    return updated
}

/** Owned by this workspace, or shared into it. No workspace id means the caller did not scope the read. */
export async function credentialReadableInWorkspace(
    appDataSource: RefreshStore,
    credential: { id: string; workspaceId?: string } | null | undefined,
    workspaceId?: string
): Promise<boolean> {
    if (!credential) return false
    if (!workspaceId) return true
    if (credential.workspaceId === workspaceId) return true
    return sharedIntoWorkspace(appDataSource, workspaceId, credential.id)
}

async function sharedIntoWorkspace(appDataSource: RefreshStore, workspaceId: string, credentialId: string): Promise<boolean> {
    try {
        const meta = (appDataSource.entityMetadatas || []).find((row) => row.name === 'WorkspaceShared')
        if (!meta) return false
        const shares = appDataSource.getRepository(meta.target)
        if (typeof shares.count !== 'function') return false
        const count = await shares.count({
            where: { workspaceId, sharedItemId: credentialId, itemType: 'credential' }
        })
        return count > 0
    } catch {
        return false
    }
}

/**
 * Refreshes a stored OAuth credential in this process. Tool runs already decrypted it.
 * They do not call the public refresh route. A workspace id limits the write to that workspace or a share into it.
 */
export async function refreshStoredOAuth2Credential(input: {
    credentialId: string
    credentialData: Record<string, any>
    appDataSource?: RefreshStore
    credentialEntity?: unknown
    workspaceId?: string
    encrypt: (plain: Record<string, any>) => Promise<string>
}): Promise<Record<string, any>> {
    const { appDataSource, credentialEntity, credentialId, workspaceId } = input
    if (!appDataSource || !credentialEntity || !credentialId) {
        throw new Error(OAUTH2_REFRESH_FAILED)
    }
    const repo = appDataSource.getRepository(credentialEntity)
    const credential = await repo.findOneBy({ id: credentialId })
    if (!credential) throw new Error(OAUTH2_REFRESH_FAILED)
    if (workspaceId && !(await credentialReadableInWorkspace(appDataSource, credential, workspaceId))) {
        throw new Error(OAUTH2_REFRESH_FAILED)
    }
    const updated = await exchangeOAuth2Refresh(input.credentialData)
    const encryptedData = await input.encrypt(updated)
    await repo.update(credential.id, { encryptedData, updatedDate: new Date() })
    return updated
}
