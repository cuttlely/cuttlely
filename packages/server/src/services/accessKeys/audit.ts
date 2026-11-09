import { sqlFromDataSource } from '../../identity/directory'
import { Request } from 'express'
import { ApiKey } from '../../database/entities/ApiKey'
import { Workspace } from '../../database/entities/identity'
import { safeRecordAudit } from '../../identity/auditLog'
import { accessData } from './data'
import { Operation } from './policy'

const events = new Map<string, number>()
/** One aggregate use/refusal event per principal/operation/outcome per five minutes; never token, IP, Origin or payload. */
export async function recordKeyUse(
    _req: Request,
    key: ApiKey,
    operation: Operation,
    outcome: 'accepted' | 'denied',
    comparison: Record<string, string | boolean> = {}
): Promise<void> {
    const now = Date.now()
    const id = `${key.workspaceId}:${key.id}:${operation}:${outcome}:${comparison.shadowMismatch ? 'shadow' : 'enforced'}:${
        comparison.resourceId || ''
    }`
    if ((events.get(id) || 0) > now - 300000) return
    for (const [name, timestamp] of events) if (timestamp <= now - 300000) events.delete(name)
    if (events.size >= 10000) events.delete(events.keys().next().value!)
    events.set(id, now)
    let data
    let workspace
    try {
        data = await accessData()
        workspace = await data.getRepository(Workspace).findOneBy({ id: key.workspaceId })
    } catch (error) {
        events.delete(id)
        throw error
    }
    if (!workspace) {
        events.delete(id)
        return
    }
    await safeRecordAudit(sqlFromDataSource(data), {
        type: 'api_key_use',
        organizationId: workspace.organizationId,
        workspaceId: key.workspaceId,
        userId: null,
        actorId: key.id || null,
        summary: `Access key request ${outcome}`,
        detail: { keyId: key.id || null, operation, outcome, aggregated: true, ...comparison }
    })
}
