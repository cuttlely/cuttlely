jest.mock('bullmq', () => ({
    Queue: jest.fn().mockImplementation(() => ({})),
    QueueEvents: jest.fn().mockImplementation(() => ({})),
    Worker: jest.fn().mockImplementation(() => ({}))
}))
jest.mock('./RedisEventPublisher', () => ({
    RedisEventPublisher: jest.fn().mockImplementation(() => ({ connect: jest.fn().mockResolvedValue(undefined) }))
}))
jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }
}))
jest.mock('@cuttlely/components', () => ({ generateAgentflowv2: jest.fn() }), { virtual: true })
jest.mock('../utils', () => ({ databaseEntities: {} }))
jest.mock('../utils/executeCustomNodeFunction', () => ({ executeCustomNodeFunction: jest.fn() }))
jest.mock('../Interface', () => ({}), { virtual: true })
jest.mock('../utils/telemetry', () => ({ Telemetry: class Telemetry {} }))
jest.mock('../CachePool', () => ({ CachePool: class CachePool {} }))
jest.mock('../UsageCacheManager', () => ({ UsageCacheManager: class UsageCacheManager {} }))
jest.mock('../AbortControllerPool', () => ({ AbortControllerPool: class AbortControllerPool {} }))
jest.mock('../utils/buildChatflow', () => ({
    executeFlow: jest.fn()
}))
const notifyFirstSuccess = jest.fn()
jest.mock('../utils/itWorked', () => ({
    notifyFirstSuccess: (...args: unknown[]) => notifyFirstSuccess(...args)
}))

import { PredictionQueue } from './PredictionQueue'
import { executeFlow } from '../utils/buildChatflow'

const mockExecuteFlow = executeFlow as jest.Mock

function queueWithoutAbortPool(): PredictionQueue {
    const queue = Object.create(PredictionQueue.prototype) as PredictionQueue
    ;(queue as any).redisPublisher = { connect: async () => undefined }
    ;(queue as any).appDataSource = {}
    ;(queue as any).telemetry = {}
    ;(queue as any).cachePool = {}
    ;(queue as any).usageCacheManager = {}
    ;(queue as any).componentNodes = {}
    return queue
}

const job = {
    chatflow: { id: 'flow-1' },
    chatId: 'chat-1'
} as any

describe('PredictionQueue processJob It worked prompt', () => {
    beforeEach(() => {
        mockExecuteFlow.mockReset()
        notifyFirstSuccess.mockReset()
    })

    it('notifies after a truthy executeFlow result', async () => {
        mockExecuteFlow.mockResolvedValue({ text: 'ok' })
        const result = await queueWithoutAbortPool().processJob(job)
        expect(result).toEqual({ text: 'ok' })
        await Promise.resolve()
        expect(notifyFirstSuccess).toHaveBeenCalledTimes(1)
    })

    it('does not notify when executeFlow returns a falsy result', async () => {
        mockExecuteFlow.mockResolvedValue(undefined)
        const result = await queueWithoutAbortPool().processJob(job)
        expect(result).toBeUndefined()
        await Promise.resolve()
        expect(notifyFirstSuccess).not.toHaveBeenCalled()
    })
})
