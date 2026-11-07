import { Response } from 'express'
import { DataSource } from 'typeorm'
import { ApiKey } from '../../database/entities/ApiKey'
import { ApiKeyUsage } from '../../database/entities/ApiKeyUsage'
import { AppError } from '../../errors/appError'
import { Operation } from './policy'

// Serializes SQLite transactions and minute admission in this process. SQL conditional increments enforce quotas.
let tail: Promise<unknown> = Promise.resolve()
export async function serial<T>(fn: () => Promise<T>): Promise<T> {
    const pending = tail.then(fn, fn)
    tail = pending.catch(() => undefined)
    return pending
}
const minutes = new Map<string, { minute: number; count: number }>()
export function clearMinuteBuckets(): void {
    minutes.clear()
}
export function utcWindows(now: number) {
    const d = new Date(now)
    return {
        day: d.toISOString().slice(0, 10),
        month: d.toISOString().slice(0, 7),
        dayReset: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
        monthReset: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    }
}
function limited(res: Response | undefined, reset: number, now: number): never {
    res?.setHeader('Retry-After', String(Math.max(1, Math.ceil((reset - now) / 1000))))
    throw new AppError(429, 'Access key request limit reached.')
}
export async function consume(data: DataSource, key: ApiKey, operation: Operation, res?: Response, now = Date.now()): Promise<void> {
    const policy = key.accessPolicy
    if (!policy) return
    if (Number(process.env.CUTTLELY_API_KEY_INSTANCES || '1') !== 1)
        throw new AppError(503, 'Access key limiting requires one API instance until a shared limiter is configured.')
    await serial(async () => {
        const minute = Math.floor(now / 60000)
        for (const [id, bucket] of minutes) if (bucket.minute !== minute) minutes.delete(id)
        const ids = [`${key.id}:*`, `${key.id}:${operation}`]
        if (ids.some((id) => (minutes.get(id)?.count || 0) >= policy.rpm) && policy.rpm) limited(res, (minute + 1) * 60000, now)
        if (minutes.size + ids.filter((id) => !minutes.has(id)).length > 20000)
            throw new AppError(503, 'Access key limiter is at capacity.')
        const windows = utcWindows(now)
        const headers: Array<[string, string]> = []
        await data.transaction(async (manager) => {
            const repo = manager.getRepository(ApiKeyUsage)
            for (const [period, limit, reset, header] of [
                [windows.day, policy.daily, windows.dayReset, 'Day'],
                [windows.month, policy.monthly, windows.monthReset, 'Month']
            ] as const) {
                for (const op of ['*', operation]) {
                    await repo
                        .createQueryBuilder()
                        .insert()
                        .values({ principalId: key.id, period, operation: op, accepted: 0 })
                        .orIgnore()
                        .execute()
                    const update = repo
                        .createQueryBuilder()
                        .update()
                        .set({ accepted: () => 'accepted + 1', lastUsedAt: new Date(now) })
                        .where({ principalId: key.id, period, operation: op })
                    if (op === '*' && limit) update.andWhere('accepted < :limit', { limit })
                    const result = await update.execute()
                    if (!result.affected) limited(res, reset, now)
                }
                const total = await repo.findOneByOrFail({ principalId: key.id, period, operation: '*' })
                if (limit) headers.push([`X-RateLimit-${header}-Remaining`, String(Math.max(0, limit - total.accepted))])
                headers.push([`X-RateLimit-${header}-Reset`, String(Math.ceil(reset / 1000))])
            }
            // Only current day/month per key/operation: bounded storage, even on a long-lived install.
            await repo
                .createQueryBuilder()
                .delete()
                .where('principalId = :id', { id: key.id })
                .andWhere('period NOT IN (:...periods)', { periods: [windows.day, windows.month] })
                .execute()
        })
        for (const [name, value] of headers) res?.setHeader(name, value)
        for (const id of ids) minutes.set(id, { minute, count: (minutes.get(id)?.count || 0) + 1 })
        if (policy.rpm) res?.setHeader('X-RateLimit-Remaining', String(Math.max(0, policy.rpm - (minutes.get(ids[0])?.count || 0))))
        res?.setHeader('X-RateLimit-Reset', String((minute + 1) * 60))
    }).catch((error) => {
        if (error instanceof AppError) throw error
        throw new AppError(503, 'Access key quota store is unavailable.')
    })
}

/** Reject already-exhausted budgets before parsing without charging until body-dependent scopes are resolved. */
export async function assertCapacity(data: DataSource, key: ApiKey, operation: Operation, res?: Response, now = Date.now()): Promise<void> {
    const policy = key.accessPolicy
    if (!policy) throw new AppError(403, 'Access policy unavailable.')
    if (Number(process.env.CUTTLELY_API_KEY_INSTANCES || '1') !== 1)
        throw new AppError(503, 'A shared limiter is required for multiple API instances.')
    const minute = Math.floor(now / 60000)
    if (
        policy.rpm &&
        [`${key.id}:*`, `${key.id}:${operation}`].some((id) => {
            const bucket = minutes.get(id)
            return bucket?.minute === minute && bucket.count >= policy.rpm
        })
    )
        limited(res, (minute + 1) * 60000, now)
    const w = utcWindows(now)
    try {
        for (const [period, limit, reset] of [
            [w.day, policy.daily, w.dayReset],
            [w.month, policy.monthly, w.monthReset]
        ] as const) {
            if (!limit) continue
            const row = await data.getRepository(ApiKeyUsage).findOneBy({ principalId: key.id, period, operation: '*' })
            if ((row?.accepted || 0) >= limit) limited(res, reset, now)
        }
    } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError(503, 'Access key quota store is unavailable.')
    }
}
