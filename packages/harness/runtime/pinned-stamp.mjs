// HMAC stamp for a saved pinned query. The key is getPinnedQueryKey() from packages/components/src/utils.ts.
// The PostgreSQL MCP node and the server test route both use these helpers, so there is one stamp format.
import { createHmac, timingSafeEqual } from 'node:crypto'

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object')
        return `{${Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(',')}}`
    return JSON.stringify(value ?? null)
}

export function stampPayload({ workspaceId, cred, statementHash, params, relations, allowedFunctions, testedColumns }) {
    return canonical({
        workspaceId: workspaceId ?? null,
        cred: cred ?? null,
        statementHash: statementHash ?? null,
        params: params ?? [],
        relations: [...(relations || [])].sort(),
        allowedFunctions: [...(allowedFunctions || [])].sort(),
        testedColumns: testedColumns ?? null
    })
}

export function computeStamp(key, payload) {
    return createHmac('sha256', key).update(payload).digest('hex')
}

export function verifyStamp(key, payload, stamp) {
    if (typeof stamp !== 'string' || !/^[a-f0-9]{64}$/.test(stamp)) return false
    return timingSafeEqual(Buffer.from(computeStamp(key, payload), 'hex'), Buffer.from(stamp, 'hex'))
}
