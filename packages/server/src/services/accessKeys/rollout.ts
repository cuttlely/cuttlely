import { Request } from 'express'
import { ApiKey } from '../../database/entities/ApiKey'
import { AppError } from '../../errors/appError'
import { recordKeyUse } from './audit'

export type AccessRollout = 'off' | 'shadow' | 'on'
/** Off/shadow never accept a new-format principal. They are a rollback path for existing integrations only. */
export function accessRollout(): AccessRollout {
    const mode = process.env.INBOUND_ACCESS_V2 || 'off'
    if (!['off', 'shadow', 'on'].includes(mode)) throw new AppError(503, 'Invalid inbound access rollout mode.')
    return mode as AccessRollout
}
export function requireAccessRollout(): void {
    if (accessRollout() !== 'on') throw new AppError(503, 'Enable INBOUND_ACCESS_V2=on before issuing or editing access key policies.')
}
const comparisons = new Map<string, number>()
export async function compareLegacy(req: Request, key: ApiKey | undefined, legacy: boolean, next: boolean) {
    if (legacy === next || !key) return
    const id = `${key.id}:${legacy}:${next}`
    const now = Date.now()
    if ((comparisons.get(id) || 0) > now - 300000) return
    for (const [name, stamp] of comparisons) if (stamp <= now - 300000) comparisons.delete(name)
    if (comparisons.size >= 10000) return
    comparisons.set(id, now)
    await recordKeyUse(req, key, 'predict', next ? 'accepted' : 'denied', {
        shadowMismatch: true,
        legacyAllowed: legacy,
        scopedAllowed: next
    })
}
