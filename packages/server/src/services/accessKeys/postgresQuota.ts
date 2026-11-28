import { Response } from 'express'
import { DataSource, EntityManager, In } from 'typeorm'
import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyUsage } from '../../database/entities/ApiKeyUsage'
import { AppError } from '../../errors/appError'
import { AccessKeyAuthenticationError, AccessKeyLimitError } from './errors'
import { AccessPolicy, Operation, readPolicy } from './policy'
import { isDeepStrictEqual } from 'node:util'

/** One API instance retains the released in-memory minute limiter. */
export function usesSharedKeyQuotas(data: DataSource): boolean {
    const instances = Number(process.env.CUTTLELY_API_KEY_INSTANCES || '1')
    if (instances === 1) return false
    if (Number.isSafeInteger(instances) && instances > 1 && data.options?.type === 'postgres') return true
    throw new AppError(503, 'Shared access-key quotas require PostgreSQL and a positive integer API instance count.')
}

type Window = { period: string; limit: number; reset: number; prefix: string }

function quotaWindows(now: Date, policy: AccessPolicy): Window[] {
    const iso = now.toISOString()
    const minute = Math.floor(now.getTime() / 60000)
    return [
        { period: 'm' + minute, limit: policy.rpm, reset: (minute + 1) * 60000, prefix: 'X-RateLimit' },
        {
            period: iso.slice(0, 10),
            limit: policy.daily,
            reset: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
            prefix: 'X-RateLimit-Day'
        },
        {
            period: iso.slice(0, 7),
            limit: policy.monthly,
            reset: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
            prefix: 'X-RateLimit-Month'
        }
    ]
}

/** The existing authorization path hands us its refreshed principal. Serialize charges for that principal
 * on the primary, across processes. The next statement sees commits made while we waited on its row. */
async function scopedPrincipal(manager: EntityManager, key: ApiKey, charge: boolean) {
    const current = await manager.getRepository(ApiKey).findOne({
        select: { id: true, updatedDate: true, accessPolicy: true, disabledAt: true, expiresAt: true },
        where: { id: key.id, workspaceId: key.workspaceId },
        lock: charge ? { mode: 'pessimistic_write' } : undefined
    })
    if (!current || current.disabledAt || (charge && current.updatedDate.getTime() !== key.updatedDate.getTime()))
        throw new AccessKeyAuthenticationError()
    if (!isDeepStrictEqual(readPolicy(current.accessPolicy), key.accessPolicy)) throw new AccessKeyAuthenticationError()
    return current
}

export async function postgresKeyQuota(
    data: DataSource,
    key: ApiKey,
    operation: Operation,
    charge: boolean,
    res?: Response
): Promise<void> {
    try {
        const reply = await data.transaction('READ COMMITTED', async (manager) => {
            const principal = await scopedPrincipal(manager, key, charge)
            const [{ now }] = await manager.query('SELECT clock_timestamp() AS now')
            if (principal.expiresAt && principal.expiresAt.getTime() <= now.getTime()) throw new AccessKeyAuthenticationError()
            const windows = quotaWindows(now, key.accessPolicy!)
            const periods = windows.map((w) => w.period)
            const repo = manager.getRepository(ApiKeyUsage)
            const counts = await repo.findBy({ principalId: key.id, period: In(periods), operation: '*' })
            for (const w of windows) {
                // The aggregate bounds all operations, including old daily/monthly usage charged before rollout.
                const total = counts.find((r) => r.period === w.period)?.accepted ?? 0
                if (w.limit && total >= w.limit) return { retry: Math.max(1, Math.ceil((w.reset - now.getTime()) / 1000)), headers: [] }
            }
            if (!charge) return { retry: 0, headers: [] }
            const headers: [string, string][] = []
            // No other shared-mode transaction may change this principal's buckets until commit.
            // The fixed period/operation cross product bounds this to six rows.
            const rows = periods.flatMap((period) =>
                ['*', operation].map((op) => ({ principalId: key.id, period, operation: op, accepted: 1, lastUsedAt: now }))
            )
            const applied = await repo
                .createQueryBuilder('quota')
                .insert()
                .values(rows)
                .onConflict(
                    `("principalId", period, operation) DO UPDATE SET accepted = quota.accepted + 1, "lastUsedAt" = EXCLUDED."lastUsedAt"`
                )
                .returning(['period', 'operation', 'accepted'])
                .execute()
            const updated: ApiKeyUsage[] = applied.raw
            if (updated.length !== rows.length) throw new Error('Incomplete access-key quota charge.')
            for (const w of windows) {
                const total = updated.find((row) => row.period === w.period && row.operation === '*')
                if (
                    !total ||
                    !Number.isSafeInteger(total.accepted) ||
                    total.accepted !== (counts.find((r) => r.period === w.period)?.accepted ?? 0) + 1
                )
                    throw new Error('Incomplete access-key quota charge.')
                if (w.limit) headers.push([w.prefix + '-Remaining', String(w.limit - total.accepted)])
                headers.push([w.prefix + '-Reset', String(w.reset / 1000)])
            }
            await repo
                .createQueryBuilder()
                .delete()
                .where({ principalId: key.id })
                .andWhere('period NOT IN (:...periods)', { periods })
                .execute()
            return { retry: 0, headers }
        })
        if (reply.retry) {
            res?.setHeader('Retry-After', String(reply.retry))
            throw new AccessKeyLimitError()
        }
        if (charge) for (const [name, value] of reply.headers) res?.setHeader(name, value)
    } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError(503, 'Access key quota store is unavailable.')
    }
}
