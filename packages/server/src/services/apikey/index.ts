import { StatusCodes } from 'http-status-codes'
import { v4 as uuidv4 } from 'uuid'
import { ApiKey } from '../../database/entities/ApiKey'
import { User } from '../../database/entities/identity'
import { AppError } from '../../errors/appError'
import { getErrorMessage } from '../../errors/utils'
import { Platform } from '../../Interface'
import { addChatflowsCount } from '../../utils/addChatflowsCount'
import { decideStoredApiKeyAuth, generateAPIKey, generateSecretHash, MAX_API_KEY_LENGTH, storedApiKeyLookup } from '../../utils/apiKey'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'

/** Fields this service reads off the signed-in user or an API-key session. */
interface ApiKeyActor {
    id?: string
    email?: string
    permissions: string[]
    features?: Record<string, string> | null
    isOrganizationAdmin?: boolean
    activeOrganizationId?: string
    activeOrganizationSubscriptionId?: string
    activeOrganizationCustomerId?: string
    activeWorkspaceId: string
    apiKeyOwnerUserId?: string
}

export function ownerForCreatedApiKey(user: Pick<ApiKeyActor, 'id' | 'apiKeyOwnerUserId'>): string | null {
    return user.id || user.apiKeyOwnerUserId || null
}

/**
 * Validates that requested permissions are allowed for API keys
 * @param user - The logged-in user
 * @param permissions - string array of requested permissions
 * @param operation - The operation being performed (for error message)
 * @throws AppError if validation fails
 */
function validatePermissions(user: ApiKeyActor, requestedPermissions: string[], operation: string) {
    // API credentials cannot hold workspace, admin, server-log, audit, or authentication permissions.
    // This applies to ALL users, including admins (platform constraint).
    const hasRestrictedPermissions = requestedPermissions.some(
        (permission: string) =>
            permission.startsWith('workspace:') ||
            permission.startsWith('admin:') ||
            permission.startsWith('logs:') ||
            permission.startsWith('audit:') ||
            permission.startsWith('authentication:')
    )

    if (hasRestrictedPermissions) {
        throw new AppError(
            StatusCodes.BAD_REQUEST,
            `Cannot ${operation} API credential with workspace, admin, server log, audit, or authentication permissions`
        )
    }

    // For Cloud platform, check feature-gated permissions
    // This also applies to ALL users, including admins (platform constraint)
    const appServer = getRunningExpressApp()
    if (appServer.identityManager.getPlatformType() === Platform.CLOUD) {
        if (!user.features) {
            // On Cloud platform, user features should always exist
            // Log the anomaly with context for debugging
            logger.error(
                `[server]: Missing user features on Cloud platform for ${operation} API key. ` +
                    `User: ${user.email || user.id}, ` +
                    `Organization: ${user.activeOrganizationId || 'unknown'}, ` +
                    `Subscription: ${user.activeOrganizationSubscriptionId || 'unknown'}, ` +
                    `Customer: ${user.activeOrganizationCustomerId || 'unknown'}, ` +
                    `Workspace: ${user.activeWorkspaceId || 'unknown'}`
            )
            throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Unable to validate permissions: user features not available`)
        }

        const featureToPermissionMap: { [key: string]: string[] } = {
            'feat:login-activity': ['loginActivity:'],
            'feat:logs': ['logs:'],
            'feat:roles': ['roles:'],
            'feat:share': ['credentials:share', 'templates:custom-share'],
            'feat:sso-config': ['sso:'],
            'feat:users': ['users:'],
            'feat:workspaces': ['workspace:']
        }

        const disabledFeatures = Object.entries(user.features).filter(([, value]) => value === 'false')
        const disabledPermissionPrefixes: string[] = []
        disabledFeatures.forEach(([featureKey]) => {
            const prefixes = featureToPermissionMap[featureKey]
            if (prefixes) {
                disabledPermissionPrefixes.push(...prefixes)
            }
        })

        const hasDisabledFeaturePermissions = requestedPermissions.some((permission: string) =>
            disabledPermissionPrefixes.some((prefix) => permission.startsWith(prefix))
        )

        if (hasDisabledFeaturePermissions) {
            throw new AppError(StatusCodes.BAD_REQUEST, `Cannot ${operation} API key with permissions for disabled features`)
        }
    }

    // User permission validation - only applies to non-admins (authorization check)
    if (!user.isOrganizationAdmin) {
        // Check if all requested permissions are included in user permissions
        const hasInvalidPermissions = requestedPermissions.some((permission: string) => !user.permissions.includes(permission))
        if (hasInvalidPermissions) {
            throw new AppError(StatusCodes.BAD_REQUEST, `Cannot ${operation} API key with permissions that exceed your own permissions`)
        }
    }
}

/**
 * Get all API keys for an organization
 * Returns all API keys across all workspaces in the organization
 */
async function getAllApiKeysByOrganization(organizationId: string): Promise<ApiKey[]> {
    const appServer = getRunningExpressApp()
    const ApiKeys = await appServer.AppDataSource.getRepository(ApiKey)
        .createQueryBuilder('api_key')
        .select(['api_key.keyName', 'api_key.permissions'])
        .leftJoin('workspace', 'workspace', 'api_key.workspaceId = workspace.id')
        .where('workspace.organizationId = :organizationId', { organizationId })
        .getMany()
    return ApiKeys
}

/**
 * Get all API keys for a workspace
 * Non-admin users can only view API keys whose permissions are a subset of their own permissions
 */
const getAllApiKeys = async (user: ApiKeyActor, page: number = -1, limit: number = -1) => {
    try {
        const appServer = getRunningExpressApp()
        const queryBuilder = appServer.AppDataSource.getRepository(ApiKey)
            .createQueryBuilder('api_key')
            .orderBy('api_key.updatedDate', 'DESC')
        if (page > 0 && limit > 0) {
            queryBuilder.skip((page - 1) * limit)
            queryBuilder.take(limit)
        }
        queryBuilder.andWhere('api_key.workspaceId = :workspaceId', { workspaceId: user.activeWorkspaceId })
        const allKeys = await queryBuilder.getMany()

        // Filter keys based on user permissions
        let filteredKeys = allKeys
        if (!user.isOrganizationAdmin) {
            // Non-admin users can only see API keys whose permissions are a subset of their own
            filteredKeys = allKeys.filter((key) => {
                // Check if all key permissions are included in user permissions
                return key.permissions.every((permission: string) => user.permissions.includes(permission))
            })
        }

        const keysWithChatflows = await addChatflowsCount(filteredKeys)
        const presented = presentApiKeys(keysWithChatflows)

        if (page > 0 && limit > 0) {
            return { total: filteredKeys.length, data: presented }
        } else {
            return presented
        }
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: apikeyService.getAllApiKeys - ${getErrorMessage(error)}`)
    }
}

const presentApiKeyRow = (key: ApiKey & { chatFlows?: unknown }) => {
    const presented: Record<string, unknown> = { ...key, harnesses: Array.isArray(key.harnesses) ? key.harnesses : [] }
    delete presented.apiKey
    delete presented.apiSecret
    return presented
}

const presentApiKeys = (keys: Array<ApiKey & { chatFlows?: unknown }>) => keys.map((key) => presentApiKeyRow(key))

/**
 * Find the row for a bearer token.
 * Hashed rows match sha256:<digest> and then the scrypt secret.
 * A leftover plaintext row is checked the same way and rewritten to the lookup.
 * Presenting the stored digest does not match and does not rewrite the row.
 */
const findBySuppliedKey = async (suppliedKey: string): Promise<ApiKey | undefined> => {
    if (!suppliedKey || suppliedKey.length > MAX_API_KEY_LENGTH) return undefined
    const appServer = getRunningExpressApp()
    const repo = appServer.AppDataSource.getRepository(ApiKey)
    const lookup = storedApiKeyLookup(suppliedKey)
    const hashed = await repo.findOneBy({ apiKey: lookup })
    const hashedDecision = decideStoredApiKeyAuth(hashed ?? undefined, suppliedKey, 'lookup')
    if (hashedDecision.status === 'accept') return hashed && (await apiKeyOwnerActive(hashed)) ? hashed : undefined
    if (hashedDecision.status !== 'absent') return undefined

    const legacy = await repo.findOneBy({ apiKey: suppliedKey })
    const legacyDecision = decideStoredApiKeyAuth(legacy ?? undefined, suppliedKey, 'legacy')
    if ((legacyDecision.status === 'accept-rewrite' || legacyDecision.status === 'reject-rewrite') && legacy) {
        await repo.update({ id: legacy.id, apiKey: suppliedKey }, { apiKey: legacyDecision.lookup })
        legacy.apiKey = legacyDecision.lookup
    }
    if (legacyDecision.status === 'accept-rewrite') return legacy && (await apiKeyOwnerActive(legacy)) ? legacy : undefined
    return undefined
}

async function apiKeyOwnerActive(row: ApiKey): Promise<boolean> {
    if (!row.ownerUserId) return true
    const appServer = getRunningExpressApp()
    const user = await appServer.AppDataSource.getRepository(User).findOneBy({ id: row.ownerUserId })
    return Boolean(user && user.status.toLowerCase() === 'active')
}

const getApiKey = async (apiKey: string) => {
    try {
        return await findBySuppliedKey(apiKey)
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: apikeyService.getApiKey - ${getErrorMessage(error)}`)
    }
}

const getApiKeyById = async (apiKeyId: string) => {
    try {
        const appServer = getRunningExpressApp()
        const currentKey = await appServer.AppDataSource.getRepository(ApiKey).findOneBy({
            id: apiKeyId
        })
        if (!currentKey) {
            return undefined
        }
        return (await apiKeyOwnerActive(currentKey)) ? currentKey : undefined
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: apikeyService.getApiKeyById - ${getErrorMessage(error)}`)
    }
}

const createApiKey = async (user: ApiKeyActor, keyName: string, permissions: string[], harnesses: string[] = []) => {
    // Validate permissions before creating the key
    validatePermissions(user, permissions, 'create')

    const plaintext = generateAPIKey()
    const apiSecret = generateSecretHash(plaintext)
    const appServer = getRunningExpressApp()
    const newKey = new ApiKey()
    newKey.id = uuidv4()
    newKey.apiKey = storedApiKeyLookup(plaintext)
    newKey.apiSecret = apiSecret
    newKey.keyName = keyName
    newKey.permissions = permissions
    newKey.harnesses = harnesses
    newKey.workspaceId = user.activeWorkspaceId
    newKey.ownerUserId = ownerForCreatedApiKey(user)
    const key = appServer.AppDataSource.getRepository(ApiKey).create(newKey)
    await appServer.AppDataSource.getRepository(ApiKey).save(key)
    const listed = await getAllApiKeys(user)
    const reveal = (row: { id?: string }) => (row.id === newKey.id ? { ...row, apiKey: plaintext } : row)
    if (Array.isArray(listed)) return listed.map(reveal)
    return listed
}

// Update api key
// harnesses left undefined keeps the stored list.
const updateApiKey = async (user: ApiKeyActor, id: string, keyName: string, permissions: string[], harnesses?: string[]) => {
    // Validate permissions before updating the key
    validatePermissions(user, permissions, 'update')

    const appServer = getRunningExpressApp()
    const currentKey = await appServer.AppDataSource.getRepository(ApiKey).findOneBy({
        id: id,
        workspaceId: user.activeWorkspaceId
    })
    if (!currentKey) {
        throw new AppError(StatusCodes.NOT_FOUND, `ApiKey ${currentKey} not found`)
    }
    currentKey.keyName = keyName
    currentKey.permissions = permissions
    if (harnesses !== undefined) currentKey.harnesses = harnesses
    await appServer.AppDataSource.getRepository(ApiKey).save(currentKey)
    return await getAllApiKeys(user)
}

const deleteApiKey = async (id: string, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = await appServer.AppDataSource.getRepository(ApiKey).delete({ id, workspaceId })
        if (!dbResponse) {
            throw new AppError(StatusCodes.NOT_FOUND, `ApiKey ${id} not found`)
        }
        return dbResponse
    } catch (error) {
        throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: apikeyService.deleteApiKey - ${getErrorMessage(error)}`)
    }
}

const verifyApiKey = async (paramApiKey: string): Promise<string> => {
    try {
        const apiKey = await findBySuppliedKey(paramApiKey)
        if (!apiKey) {
            throw new AppError(StatusCodes.UNAUTHORIZED, `Unauthorized`)
        }
        return 'OK'
    } catch (error) {
        if (error instanceof AppError && error.statusCode === StatusCodes.UNAUTHORIZED) {
            throw error
        } else {
            throw new AppError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: apikeyService.verifyApiKey - ${getErrorMessage(error)}`)
        }
    }
}

export default {
    createApiKey,
    deleteApiKey,
    getAllApiKeys,
    getAllApiKeysByOrganization,
    updateApiKey,
    verifyApiKey,
    getApiKey,
    getApiKeyById
}
