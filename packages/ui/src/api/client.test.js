/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import axios from 'axios'
import apiClient, { onResponseError, resetClientState, setRetrySleep } from './client'
import { getReconnectCount, resetReconnectState, subscribeReconnect } from './connectionState'
import { inFlightRequests } from './resilience'

jest.mock('@/store/constant', () => ({
    baseURL: 'http://localhost',
    ErrorMessage: { TOKEN_EXPIRED: 'Token Expired', INVALID_MISSING_TOKEN: 'Invalid or Missing token' }
}))
jest.mock('@/utils/authUtils', () => ({ __esModule: true, default: { removeCurrentUser: jest.fn() } }))
import AuthUtils from '@/utils/authUtils'

const response = (config, data = { ok: true }, status = 200) => ({ config, data, status, statusText: 'OK', headers: {} })
const networkError = (config, label = 'Network Error') =>
    Object.assign(new Error(label), { isAxiosError: true, request: {}, response: undefined, config })
const httpError = (config, status, data = {}) =>
    Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, config, response: { status, data, headers: {} } })

describe('API client resilience', () => {
    const originalAdapter = apiClient.defaults.adapter

    beforeEach(() => {
        jest.clearAllMocks()
        resetClientState()
        resetReconnectState()
        setRetrySleep(() => Promise.resolve())
        localStorage.clear()
    })

    afterEach(() => {
        apiClient.defaults.adapter = originalAdapter
        jest.restoreAllMocks()
    })

    test('a GET makes four attempts and rejects with its first no-response error', async () => {
        let attempts = 0
        let first
        apiClient.defaults.adapter = jest.fn(async (config) => {
            attempts += 1
            const error = networkError(config, `attempt ${attempts}`)
            if (!first) first = error
            throw error
        })
        await expect(apiClient.get('/nodes')).rejects.toBe(first)
        expect(attempts).toBe(4)
    })

    test('a GET can recover on its third attempt', async () => {
        let attempts = 0
        apiClient.defaults.adapter = jest.fn(async (config) => {
            attempts += 1
            if (attempts < 3) throw networkError(config)
            return response(config, { attempt: attempts })
        })
        await expect(apiClient.get('/nodes')).resolves.toMatchObject({ data: { attempt: 3 } })
        expect(attempts).toBe(3)
    })

    test.each([502, 503, 504])('a GET retries HTTP %s', async (status) => {
        let attempts = 0
        apiClient.defaults.adapter = jest.fn(async (config) => {
            attempts += 1
            if (attempts === 1) throw httpError(config, status)
            return response(config)
        })
        await expect(apiClient.get('/nodes')).resolves.toMatchObject({ status: 200 })
        expect(attempts).toBe(2)
    })

    test.each([400, 404, 500])('a GET does not retry HTTP %s', async (status) => {
        apiClient.defaults.adapter = jest.fn(async (config) => {
            throw httpError(config, status)
        })
        await expect(apiClient.get('/nodes')).rejects.toMatchObject({ response: { status } })
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(1)
    })

    test.each([
        ['no response', (config) => networkError(config)],
        ['HTTP 503', (config) => httpError(config, 503)]
    ])('a POST without opt-in does not retry %s', async (_label, makeError) => {
        apiClient.defaults.adapter = jest.fn(async (config) => {
            throw makeError(config)
        })
        await expect(apiClient.post('/save', { value: 1 })).rejects.toBeTruthy()
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(1)
    })

    test('an opted-in load POST retries', async () => {
        let attempts = 0
        apiClient.defaults.adapter = jest.fn(async (config) => {
            attempts += 1
            if (attempts === 1) throw httpError(config, 503)
            return response(config)
        })
        await expect(apiClient.post('/node-load-method/example', {}, { retry: true })).resolves.toMatchObject({ status: 200 })
        expect(attempts).toBe(2)
    })

    test('a PUT save is not retried', async () => {
        apiClient.defaults.adapter = jest.fn(async (config) => {
            throw networkError(config)
        })
        await expect(apiClient.put('/flow-drafts/id', {})).rejects.toBeTruthy()
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(1)
    })

    test('aborting during backoff cancels without another attempt', async () => {
        const controller = new AbortController()
        let sleepStarted
        const started = new Promise((resolve) => (sleepStarted = resolve))
        setRetrySleep(
            (_delay, signal) =>
                new Promise((_resolve, reject) => {
                    sleepStarted()
                    signal.addEventListener('abort', () => reject(new axios.CanceledError()), { once: true })
                })
        )
        apiClient.defaults.adapter = jest.fn(async (config) => {
            throw networkError(config)
        })
        const pending = apiClient.get('/nodes', { signal: controller.signal })
        await started
        controller.abort()
        await expect(pending).rejects.toBeInstanceOf(axios.CanceledError)
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(1)
        expect(getReconnectCount()).toBe(0)
    })

    test('identical GET callers share one in-flight request and receive separate responses', async () => {
        let release
        apiClient.defaults.adapter = jest.fn(
            (config) => new Promise((resolve) => (release = () => resolve(response(config, { nested: { value: 1 } }))))
        )
        const first = apiClient.get('/nodes', { params: { a: 1 } })
        const second = apiClient.get('/nodes', { params: { a: 1 } })
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(1)
        release()
        const [firstResponse, secondResponse] = await Promise.all([first, second])
        firstResponse.data.nested.value = 2
        expect(secondResponse.data.nested.value).toBe(1)
    })

    test('different params and signal-carrying calls are not shared', async () => {
        apiClient.defaults.adapter = jest.fn(async (config) => response(config))
        await Promise.all([apiClient.get('/nodes', { params: { a: 1 } }), apiClient.get('/nodes', { params: { a: 2 } })])
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(2)
        apiClient.defaults.adapter.mockClear()
        await Promise.all([
            apiClient.get('/nodes', { signal: new AbortController().signal }),
            apiClient.get('/nodes', { signal: new AbortController().signal })
        ])
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(2)
    })

    test('the in-flight entry is removed after settle', async () => {
        apiClient.defaults.adapter = jest.fn(async (config) => response(config))
        await apiClient.get('/nodes')
        expect(inFlightRequests.size).toBe(0)
        await apiClient.get('/nodes')
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(2)
    })

    test('concurrent expired-token responses share one refresh', async () => {
        const seen = new Map()
        apiClient.defaults.adapter = jest.fn(async (config) => {
            const key = config.params.id
            const attempts = (seen.get(key) || 0) + 1
            seen.set(key, attempts)
            if (attempts === 1) throw httpError(config, 401, { message: 'Token Expired', retry: true })
            return response(config, { key })
        })
        const refresh = jest.spyOn(axios, 'post').mockResolvedValue({ data: { id: 'session' } })
        await expect(
            Promise.all([apiClient.get('/one', { params: { id: 1 } }), apiClient.get('/two', { params: { id: 2 } })])
        ).resolves.toHaveLength(2)
        expect(refresh).toHaveBeenCalledTimes(1)
    })

    test('a second 401 after refresh stops and signs out', async () => {
        apiClient.defaults.adapter = jest.fn(async (config) => {
            throw httpError(config, 401, { message: 'Token Expired', retry: true })
        })
        jest.spyOn(axios, 'post').mockResolvedValue({ data: { id: 'session' } })
        await expect(apiClient.get('/nodes')).rejects.toMatchObject({ response: { status: 401 } })
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(2)
        expect(AuthUtils.removeCurrentUser).toHaveBeenCalledTimes(1)
    })

    test('refresh no-response retries outside the client and does not sign out', async () => {
        apiClient.defaults.adapter = jest.fn(async (config) => {
            throw httpError(config, 401, { message: 'Token Expired', retry: true })
        })
        const refreshError = networkError()
        const refresh = jest.spyOn(axios, 'post').mockRejectedValue(refreshError)
        await expect(apiClient.get('/nodes')).rejects.toBe(refreshError)
        expect(refresh).toHaveBeenCalledTimes(4)
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(1)
        expect(AuthUtils.removeCurrentUser).not.toHaveBeenCalled()
        expect(inFlightRequests.size).toBe(0)
    })

    test.each(['success', 'failure'])('connection state returns to zero after retry %s', async (outcome) => {
        const counts = []
        const unsubscribe = subscribeReconnect((count) => counts.push(count))
        let attempts = 0
        apiClient.defaults.adapter = jest.fn(async (config) => {
            attempts += 1
            if (outcome === 'success' && attempts > 1) return response(config)
            throw networkError(config)
        })
        const pending = apiClient.get('/nodes')
        if (outcome === 'success') await expect(pending).resolves.toBeTruthy()
        else await expect(pending).rejects.toBeTruthy()
        unsubscribe()
        expect(counts).toContain(1)
        expect(getReconnectCount()).toBe(0)
    })
})

describe('API client response errors without request config', () => {
    beforeEach(() => jest.clearAllMocks())

    test('a request with no answer is rejected with its own error, not a TypeError', async () => {
        const error = networkError()
        await expect(onResponseError(error)).rejects.toBe(error)
        expect(AuthUtils.removeCurrentUser).not.toHaveBeenCalled()
    })

    test('an error that is not an object is passed on unchanged', async () => {
        await expect(onResponseError(undefined)).rejects.toBeUndefined()
    })

    test('a 401 that is not an expired token signs the browser out', async () => {
        const unauthorized = { response: { status: 401, data: { message: 'Unauthorized' } } }
        await expect(onResponseError(unauthorized)).rejects.toBe(unauthorized)
        expect(AuthUtils.removeCurrentUser).toHaveBeenCalledTimes(1)
    })

    test('a 401 with no body does not throw a TypeError', async () => {
        const unauthorized = { response: { status: 401 } }
        await expect(onResponseError(unauthorized)).rejects.toBe(unauthorized)
    })
})
