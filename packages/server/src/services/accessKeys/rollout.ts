import { Request } from 'express'
import { ApiKey } from '../../database/entities/ApiKey'
import { AppError } from '../../errors/appError'
import { recordKeyUse } from './audit'
import { Operation } from './policy'

import { rolloutState } from '../../settings/accessRollout'
export type { AccessRollout } from '../../settings/accessRollout'
import type { AccessRollout } from '../../settings/accessRollout'
/** Off/shadow never accept a new-format principal. They are a rollback path for existing integrations only. */
export function accessRollout(): AccessRollout {
    const mode = rolloutState().value
    if (mode === 'invalid') throw new AppError(503, 'Invalid inbound access rollout mode.')
    return mode as AccessRollout
}
export function requireAccessRollout(): void {
    if (accessRollout() !== 'on')
        throw new AppError(
            503,
            'Enable access-key enforcement in Server settings (or INBOUND_ACCESS_V2=on on the host) before issuing or editing access key policies.'
        )
}
const comparisons = new Map<string, number>()
export async function compareLegacy(
    req: Request,
    key: ApiKey | undefined,
    legacy: boolean,
    next: boolean,
    workspaceId: string,
    resourceId: string,
    operation: Operation = 'predict'
) {
    if (legacy === next) return
    const id = `${workspaceId}:${resourceId}:${key?.id || 'public'}:${operation}:${legacy}:${next}`
    const now = Date.now()
    if ((comparisons.get(id) || 0) > now - 300000) return
    for (const [name, stamp] of comparisons) if (stamp <= now - 300000) comparisons.delete(name)
    if (comparisons.size >= 10000) comparisons.delete(comparisons.keys().next().value!)
    await recordKeyUse(req, key || ({ id: '', workspaceId } as ApiKey), operation, next ? 'accepted' : 'denied', {
        shadowMismatch: true,
        resourceId,
        legacyAllowed: legacy,
        scopedAllowed: next
    })
    comparisons.set(id, now)
}
