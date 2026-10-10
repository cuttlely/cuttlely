import type { UsageCacheManager } from '../UsageCacheManager'

type UsageType = 'flows' | 'users'

/**
 * Open source does not enforce commercial seat, prediction, or storage quotas (D50).
 * Call sites stay. These functions return without reading Stripe or UsageCacheManager.
 */
export const ENTERPRISE_FEATURE_FLAGS = [
    //'feat:account', // Only for Cloud
    'feat:datasets',
    'feat:evaluations',
    'feat:evaluators',
    'feat:files',
    'feat:login-activity',
    'feat:users',
    'feat:workspaces',
    'feat:logs',
    'feat:roles',
    'feat:sso-config'
]

/** Teams, users, and roles on an open-source install. Datasets, evaluations, SSO, and logs stay off. */
export const OPEN_SOURCE_RBAC_FEATURES: Record<string, string> = {
    'feat:users': 'true',
    'feat:roles': 'true',
    'feat:workspaces': 'true'
}

export const applyOpenSourceRbacFeatures = (features?: Record<string, string> | null): Record<string, string> => {
    return { ...(features || {}), ...OPEN_SOURCE_RBAC_FEATURES }
}

export const getCurrentUsage = async (_orgId: string, _subscriptionId: string, _usageCacheManager: UsageCacheManager) => {
    return {
        predictions: { usage: 0, limit: -1 },
        storage: { usage: 0, limit: -1 }
    }
}

export const checkUsageLimit = async (
    _type: UsageType,
    _subscriptionId: string,
    _usageCacheManager: UsageCacheManager,
    _currentUsage: number
) => {
    return
}

export const updatePredictionsUsage = async (
    _orgId: string,
    _subscriptionId: string,
    _workspaceId: string = '',
    _usageCacheManager?: UsageCacheManager
) => {
    return
}

export const checkPredictions = async (_orgId: string, _subscriptionId: string, _usageCacheManager: UsageCacheManager) => {
    return
}

export const updateStorageUsage = (
    _orgId: string,
    _workspaceId: string = '',
    _totalSize: number,
    _usageCacheManager?: UsageCacheManager
) => {
    return
}

export const checkStorage = async (_orgId: string, _subscriptionId: string, _usageCacheManager: UsageCacheManager) => {
    return
}
