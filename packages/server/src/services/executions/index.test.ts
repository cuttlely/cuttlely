// Tied updatedDate values are one second apart at most on SQLite. Paging must break the tie with id.
const order: Array<{ method: string; args: unknown[] }> = []
const queryBuilder: any = {
    leftJoinAndSelect: () => queryBuilder,
    orderBy: (...args: unknown[]) => {
        order.push({ method: 'orderBy', args })
        return queryBuilder
    },
    addOrderBy: (...args: unknown[]) => {
        order.push({ method: 'addOrderBy', args })
        return queryBuilder
    },
    skip: () => queryBuilder,
    take: () => queryBuilder,
    andWhere: () => queryBuilder,
    getManyAndCount: async () => [[], 0]
}
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: { getRepository: () => ({ createQueryBuilder: () => queryBuilder }) }
    })
}))
jest.mock('../../utils', () => ({ _removeCredentialId: (value: unknown) => value }))

import executionsService from './index'

describe('getAllExecutions order', () => {
    test('orders by updatedDate then id, both newest first', async () => {
        order.length = 0
        await executionsService.getAllExecutions({ agentflowId: 'flow-1', page: 2, limit: 50 })
        expect(order).toEqual([
            { method: 'orderBy', args: ['execution.updatedDate', 'DESC'] },
            { method: 'addOrderBy', args: ['execution.id', 'DESC'] }
        ])
    })
})
