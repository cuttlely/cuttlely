import axios from 'axios'
import { backoffDelay, dedupeKey, isNoResponse, isRetryableStatus, shouldRetry } from './resilience'

describe('request resilience helpers', () => {
    test('backoff uses the three delays and stays within the jitter bounds', () => {
        expect([1, 2, 3].map((attempt) => backoffDelay(attempt, () => 0.5))).toEqual([300, 1000, 3000])
        expect([1, 2, 3].map((attempt) => backoffDelay(attempt, () => 0))).toEqual([225, 750, 2250])
        expect([1, 2, 3].map((attempt) => backoffDelay(attempt, () => 1))).toEqual([375, 1250, 3750])
    })

    test('a missing response is distinct from HTTP and cancellation errors', () => {
        expect(isNoResponse(Object.assign(new Error('down'), { request: {} }))).toBe(true)
        expect(isNoResponse({ response: { status: 503 } })).toBe(false)
        expect(isNoResponse(new axios.CanceledError())).toBe(false)
    })

    test('only gateway failure statuses are retryable', () => {
        expect([502, 503, 504].every(isRetryableStatus)).toBe(true)
        expect([400, 404, 500].some(isRetryableStatus)).toBe(false)
    })

    test('safe methods and opted-in load posts retry', () => {
        const network = Object.assign(new Error('down'), { request: {} })
        expect(shouldRetry({ method: 'get' }, network)).toBe(true)
        expect(shouldRetry({ method: 'head' }, { response: { status: 503 } })).toBe(true)
        expect(shouldRetry({ method: 'post', retry: true }, network)).toBe(true)
        expect(shouldRetry({ method: 'post' }, network)).toBe(false)
        expect(shouldRetry({ method: 'put', retry: true }, { response: { status: 500 } })).toBe(false)
        expect(shouldRetry({ method: 'get', retry: false }, network)).toBe(false)
    })

    test('dedupe keys are stable and include opted-in post bodies', () => {
        const first = dedupeKey({ method: 'get', baseURL: 'http://local/api', url: '/nodes', params: { b: 2, a: 1 } })
        const second = dedupeKey({ method: 'get', baseURL: 'http://local/api', url: '/nodes', params: { a: 1, b: 2 } })
        expect(first).toBe(second)
        expect(dedupeKey({ method: 'post', baseURL: 'http://local', url: '/load', data: { a: 1 }, retry: true })).not.toBe(
            dedupeKey({ method: 'post', baseURL: 'http://local', url: '/load', data: { a: 2 }, retry: true })
        )
        expect(dedupeKey({ method: 'get', url: '/nodes', signal: new AbortController().signal })).toBeNull()
    })
})
