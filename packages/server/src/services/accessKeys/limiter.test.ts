import { DataSource } from 'typeorm'
import { ApiKey } from '../../database/entities/ApiKey'
import { consume, clearMinuteBuckets } from './limiter'
import { parsePolicy } from './policy'

it('keeps existing principal admission working at capacity while refusing new buckets', async () => {
    clearMinuteBuckets()
    const transaction = jest.fn(async (fn) => fn({ getRepository: () => repo }))
    const query: any = {}
    for (const name of ['insert', 'values', 'orIgnore', 'update', 'set', 'where', 'andWhere', 'delete']) query[name] = () => query
    query.execute = async () => ({ affected: 1 })
    const repo = { createQueryBuilder: () => query, findOneByOrFail: async () => ({ accepted: 1 }) }
    const data = { transaction } as unknown as DataSource
    const accessPolicy = parsePolicy({ rpm: 10 })
    const now = Date.parse('2026-11-07T12:00:00Z')
    try {
        for (let i = 0; i < 10000; i++) await consume(data, { id: `key-${i}`, accessPolicy } as ApiKey, 'predict', undefined, now)
        transaction.mockClear()
        await expect(consume(data, { id: 'new-key', accessPolicy } as ApiKey, 'predict', undefined, now)).rejects.toMatchObject({
            statusCode: 503
        })
        expect(transaction).not.toHaveBeenCalled()
        await expect(consume(data, { id: 'key-0', accessPolicy } as ApiKey, 'predict', undefined, now)).resolves.toBeUndefined()
        expect(transaction).toHaveBeenCalledTimes(1)
    } finally {
        clearMinuteBuckets()
    }
})

it('refuses consume when the principal has no access policy', async () => {
    const { consume } = await import('./limiter')
    const data = { transaction: async (fn: any) => fn({}) } as any
    await expect(consume(data, { id: 'no-policy' } as any, 'predict')).rejects.toMatchObject({
        statusCode: 403,
        message: 'Access policy unavailable.'
    })
})
