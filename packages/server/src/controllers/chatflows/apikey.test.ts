const getApiKey = jest.fn()
const getChatflowByApiKey = jest.fn()
const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn(), http: jest.fn() }

jest.mock('../../services/apikey', () => ({
    __esModule: true,
    default: {
        getApiKey: (...args: unknown[]) => getApiKey(...args)
    }
}))

jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowByApiKey: (...args: unknown[]) => getChatflowByApiKey(...args)
    }
}))

jest.mock('../../services/schedule', () => ({
    __esModule: true,
    default: {}
}))

jest.mock('../../schedule/ScheduleBeat', () => ({
    ScheduleBeat: { getInstance: jest.fn() }
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

jest.mock('../../utils/quotaUsage', () => ({
    checkUsageLimit: jest.fn()
}))

jest.mock('../../utils/rateLimit', () => ({
    RateLimiterManager: class RateLimiterManager {}
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: logger
}))

import chatflowsController from './index'

const secret = 'not-a-real-key'

const response = () => {
    const res = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) {
            this.statusCode = code
            return this
        },
        send(body: unknown) {
            this.body = body
            return this
        },
        json(body: unknown) {
            this.body = body
            return this
        }
    }
    return res
}

describe('getChatflowByApiKey', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('answers 401 for an invalid key and does not list flows or log the key', async () => {
        getApiKey.mockResolvedValue(undefined)
        const res = response()
        const next = jest.fn()

        await chatflowsController.getChatflowByApiKey({ params: { apikey: secret }, query: {} } as any, res as any, next)

        expect(res.statusCode).toBe(401)
        expect(res.body).toBe('Unauthorized')
        expect(getChatflowByApiKey).not.toHaveBeenCalled()
        expect(next).not.toHaveBeenCalled()
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret)
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain(secret)
    })

    it('does not return the key when lookup throws', async () => {
        getApiKey.mockRejectedValue(new Error(`lookup failed for ${secret}`))
        const res = response()
        const next = jest.fn()

        await chatflowsController.getChatflowByApiKey({ params: { apikey: secret }, query: {} } as any, res as any, next)

        expect(res.body).toBeUndefined()
        expect(next).toHaveBeenCalledTimes(1)
        expect(String(next.mock.calls[0][0].message)).not.toContain(secret)
        expect(String(next.mock.calls[0][0].message)).toContain('[redacted]')
    })

    it('returns the flows bound to a valid key', async () => {
        getApiKey.mockResolvedValue({ id: 'key-row', workspaceId: 'ws-1' })
        getChatflowByApiKey.mockResolvedValue([{ id: 'flow-1', name: 'Mine', deployed: true, category: null, type: 'CHATFLOW' }])
        const res = response()
        const next = jest.fn()

        await chatflowsController.getChatflowByApiKey({ params: { apikey: secret }, query: { keyonly: 'true' } } as any, res as any, next)

        expect(next).not.toHaveBeenCalled()
        expect(getApiKey).toHaveBeenCalledWith(secret)
        expect(getChatflowByApiKey).toHaveBeenCalledWith('key-row', 'ws-1')
        expect(res.body).toEqual([{ id: 'flow-1', name: 'Mine', deployed: true, category: null, type: 'CHATFLOW' }])
        expect(JSON.stringify(res.body)).not.toContain('flowData')
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret)
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain(secret)
    })
})
