const getApiKey = jest.fn()
const verifyApiKey = jest.fn()
const getChatflowByApiKey = jest.fn()
const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn(), http: jest.fn() }

jest.mock('../../services/apikey', () => ({
    __esModule: true,
    default: {
        getApiKey: (...args: unknown[]) => getApiKey(...args),
        verifyApiKey: (...args: unknown[]) => verifyApiKey(...args)
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

import express from 'express'
import request from 'supertest'
import chatflowsController from './index'
import chatflowsRouter from '../../routes/chatflows'
import apikeyController from '../apikey'

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

        await chatflowsController.getChatflowByApiKey(
            { headers: { authorization: `Bearer ${secret}` }, params: {}, query: {} } as any,
            res as any,
            next
        )

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

        await chatflowsController.getChatflowByApiKey(
            { headers: { authorization: `Bearer ${secret}` }, params: {}, query: {} } as any,
            res as any,
            next
        )

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

        await chatflowsController.getChatflowByApiKey(
            { headers: { authorization: `Bearer ${secret}` }, params: {}, query: { keyonly: 'true' } } as any,
            res as any,
            next
        )

        expect(next).not.toHaveBeenCalled()
        expect(getApiKey).toHaveBeenCalledWith(secret)
        expect(getChatflowByApiKey).toHaveBeenCalledWith('key-row', 'ws-1')
        expect(res.body).toEqual([{ id: 'flow-1', name: 'Mine', deployed: true, category: null, type: 'CHATFLOW' }])
        expect(JSON.stringify(res.body)).not.toContain('flowData')
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret)
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain(secret)
    })

    it('does not take the key from the URL path', async () => {
        const res = response()
        const next = jest.fn()

        await chatflowsController.getChatflowByApiKey({ headers: {}, params: { apikey: secret }, query: {} } as any, res as any, next)

        expect(getApiKey).not.toHaveBeenCalled()
        expect(next).toHaveBeenCalledTimes(1)
        expect(next.mock.calls[0][0].statusCode).toBe(412)
    })

    it('ignores an Authorization header that is not a bearer key', async () => {
        const res = response()
        const next = jest.fn()

        await chatflowsController.getChatflowByApiKey(
            { headers: { authorization: `Basic ${secret}` }, params: {}, query: {} } as any,
            res as any,
            next
        )

        expect(getApiKey).not.toHaveBeenCalled()
        expect(next.mock.calls[0][0].statusCode).toBe(412)
    })
})

describe('refuseApiKeyInUrl', () => {
    it('answers 400 and names the Authorization header without echoing the key', () => {
        const res = response()

        apikeyController.refuseApiKeyInUrl({ params: { apikey: secret } } as any, res as any)

        expect(res.statusCode).toBe(400)
        expect(JSON.stringify(res.body)).toContain('Authorization: Bearer')
        expect(JSON.stringify(res.body)).not.toContain(secret)
        expect(getApiKey).not.toHaveBeenCalled()
    })
})

describe('verifyApiKey', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('checks the key from the Authorization header', async () => {
        verifyApiKey.mockResolvedValue('OK')
        const res = response()
        const next = jest.fn()

        await apikeyController.verifyApiKey({ headers: { authorization: `Bearer ${secret}` }, params: {} } as any, res as any, next)

        expect(verifyApiKey).toHaveBeenCalledWith(secret)
        expect(res.body).toBe('OK')
        expect(next).not.toHaveBeenCalled()
    })

    it('does not check a key sent in the URL path', async () => {
        const res = response()
        const next = jest.fn()

        await apikeyController.verifyApiKey({ headers: {}, params: { apikey: secret } } as any, res as any, next)

        expect(verifyApiKey).not.toHaveBeenCalled()
        expect(next.mock.calls[0][0].statusCode).toBe(412)
    })
})

describe('chatflows API-key routes', () => {
    const app = express()
    app.use('/api/v1/chatflows', chatflowsRouter)

    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('serves GET /apikey/ from the Authorization header, not as a chatflow id', async () => {
        getApiKey.mockResolvedValue({ id: 'key-row', workspaceId: 'ws-1' })
        getChatflowByApiKey.mockResolvedValue([])

        const res = await request(app).get('/api/v1/chatflows/apikey/').set('Authorization', `Bearer ${secret}`)

        expect(res.status).toBe(200)
        expect(getApiKey).toHaveBeenCalledWith(secret)
    })

    it('refuses a key in the URL path without looking it up', async () => {
        const res = await request(app).get(`/api/v1/chatflows/apikey/${secret}`)

        expect(res.status).toBe(400)
        expect(res.text).not.toContain(secret)
        expect(getApiKey).not.toHaveBeenCalled()
    })
})
