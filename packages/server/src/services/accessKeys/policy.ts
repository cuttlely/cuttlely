import { BlockList, isIP } from 'net'
import { AppError } from '../../errors/appError'

/** A closed operation registry. No route/path strings are accepted as capabilities. */
export const OPERATIONS = {
    predict: ['chatflows:view', 'agentflows:view'],
    stream: ['chatflows:view', 'agentflows:view'],
    upload: ['chatflows:view', 'agentflows:view'],
    'feedback:read': ['chatflows:view', 'agentflows:view'],
    'feedback:write': ['chatflows:view', 'agentflows:view'],
    'harness:run': ['chatflows:create', 'chatflows:update', 'agentflows:create'],
    'harness:read': ['chatflows:view', 'agentflows:view'],
    'dashflow:read': ['chatflows:view'],
    'dashflow:report': ['chatflows:update'],
    'api:read': ['chatflows:view', 'agentflows:view'],
    'api:write': ['chatflows:update', 'agentflows:update']
} as const
export type Operation = keyof typeof OPERATIONS
export const RESOURCE_TYPES = ['CHATFLOW', 'AGENTFLOW', 'HARNESS', 'DASHFLOW'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]
export interface ResourceGrant {
    resourceType: ResourceType
    resourceId: string
}
export interface AccessPolicy {
    version: 1
    /** Only the migration can set this. Editing a policy removes compatibility. */
    legacy?: boolean
    environment: 'live' | 'test'
    service: string
    allResources: boolean
    scopes: Operation[]
    rpm: number
    daily: number
    monthly: number
    origins: string[]
    allowNoOrigin: boolean
    ips: string[]
}
export function normalizeOrigin(value: string): string {
    try {
        const url = new URL(value)
        if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.hostname.includes('*') ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash
        )
            throw new Error()
        return url.origin
    } catch {
        throw new AppError(400, 'Origins must be exact HTTP(S) origins, without paths or wildcards.')
    }
}
function strings(value: unknown, field: string, max = 200): string[] {
    if (!Array.isArray(value) || value.length > max || !value.every((s) => typeof s === 'string' && s.length <= 256))
        throw new AppError(400, `${field} must be a bounded list of strings.`)
    return [...new Set(value)]
}
export function ipBlock(value: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } {
    const [address, prefix, extra] = value.split('/')
    const version = isIP(address)
    const bits = version === 4 ? 32 : 128
    if (!version || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > bits)))
        throw new AppError(400, 'IP rules must be exact IP addresses or CIDRs.')
    return { address, prefix: prefix === undefined ? bits : Number(prefix), family: version === 4 ? 'ipv4' : 'ipv6' }
}
export function parsePolicy(raw: unknown): AccessPolicy {
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new AppError(400, 'Invalid access policy.')
    const p = (raw || {}) as Record<string, unknown>
    const scopes = strings(p.scopes ?? [], 'scopes')
    if (scopes.some((s) => !Object.prototype.hasOwnProperty.call(OPERATIONS, s))) throw new AppError(400, 'Unknown operation scope.')
    const limit = (name: string, fallback: number) => {
        const value = p[name] ?? fallback
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1000000000)
            throw new AppError(400, `Invalid ${name} limit.`)
        return value
    }
    for (const field of ['allResources', 'allowNoOrigin'])
        if (p[field] !== undefined && typeof p[field] !== 'boolean') throw new AppError(400, `Invalid ${field}.`)
    if (p.environment !== undefined && p.environment !== 'live' && p.environment !== 'test') throw new AppError(400, 'Invalid environment.')
    if (p.service !== undefined && (typeof p.service !== 'string' || p.service.length > 100))
        throw new AppError(400, 'Invalid service name.')
    const origins = strings(p.origins ?? [], 'origins').map(normalizeOrigin)
    const ips = strings(p.ips ?? [], 'ips')
    ips.forEach(ipBlock)
    return {
        version: 1,
        environment: p.environment === 'test' ? 'test' : 'live',
        service: String(p.service || ''),
        allResources: p.allResources === true,
        scopes: scopes as Operation[],
        rpm: limit('rpm', 60),
        daily: limit('daily', 0),
        monthly: limit('monthly', 0),
        origins,
        allowNoOrigin: p.allowNoOrigin === true || (p.allowNoOrigin === undefined && origins.length === 0),
        ips
    }
}
export function parseGrants(raw: unknown): ResourceGrant[] {
    if (raw === undefined) return []
    if (!Array.isArray(raw) || raw.length > 500) throw new AppError(400, 'Resources must be a list of at most 500 grants.')
    return raw.map((r) => {
        if (
            !r ||
            !RESOURCE_TYPES.includes(r.resourceType) ||
            typeof r.resourceId !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(r.resourceId)
        )
            throw new AppError(400, 'Invalid resource grant.')
        return { resourceType: r.resourceType, resourceId: r.resourceId }
    })
}
export function callerPolicyAllows(policy: AccessPolicy, origin: unknown, ip: string): boolean {
    if (origin === undefined) {
        if (!policy.allowNoOrigin) return false
    } else {
        if (typeof origin !== 'string') return false
        try {
            if (policy.origins.length && !policy.origins.includes(normalizeOrigin(origin))) return false
        } catch {
            return false
        }
    }
    if (!policy.ips.length) return true
    try {
        const blocks = new BlockList()
        for (const rule of policy.ips) {
            const r = ipBlock(rule)
            blocks.addSubnet(r.address, r.prefix, r.family)
        }
        const address = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip
        const version = isIP(address)
        return !!version && blocks.check(address, version === 4 ? 'ipv4' : 'ipv6')
    } catch {
        return false
    }
}
export function expiry(raw: unknown, defaultDays = 90): Date | null {
    if (raw === null) return null
    if (raw === undefined) return new Date(Date.now() + defaultDays * 86400000)
    if (typeof raw !== 'string' || !raw.endsWith('Z')) throw new AppError(400, 'Expiry must be an absolute UTC timestamp or null.')
    const date = new Date(raw)
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new AppError(400, 'Expiry must be in the future.')
    return date
}

/** Runtime scopes preserve the owning flow type's RBAC boundary. */
export function operationPermissions(operation: Operation, resource?: ResourceGrant): readonly string[] {
    if (resource && ['predict', 'stream', 'upload', 'feedback:read', 'feedback:write', 'api:read', 'api:write'].includes(operation)) {
        const prefix = resource.resourceType === 'AGENTFLOW' ? 'agentflows' : 'chatflows'
        return [`${prefix}:${operation === 'api:write' ? 'update' : 'view'}`]
    }
    return OPERATIONS[operation]
}

/** Stored policy is server-owned. Malformed or incomplete rows fail closed instead of receiving new-key defaults. */
export function readPolicy(raw: unknown): AccessPolicy {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(403, 'Access policy unavailable.')
    const value = raw as Record<string, unknown>
    if (
        value.version !== 1 ||
        ['scopes', 'origins', 'ips'].some((name) => !Array.isArray(value[name])) ||
        ['allResources', 'allowNoOrigin'].some((name) => typeof value[name] !== 'boolean') ||
        ['rpm', 'daily', 'monthly'].some((name) => typeof value[name] !== 'number')
    )
        throw new AppError(403, 'Access policy unavailable.')
    try {
        const policy = parsePolicy(value)
        if (value.legacy === true) {
            policy.legacy = true
            policy.allResources = false
        }
        return policy
    } catch {
        throw new AppError(403, 'Access policy unavailable.')
    }
}
