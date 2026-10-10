/**
 * API-16 (#16): a forged X-Forwarded-For must not open a new prediction rate-limit bucket.
 * The key is Express's client address after TRUST_PROXY. A port or a non-IP is not a bucket.
 */
import express, { Request } from 'express'
import request from 'supertest'
import { RateLimiterManager, rateLimitClientKey } from './rateLimit'

jest.setTimeout(30_000)

const REQUEST_TIMEOUT_MS = 20_000
const hangGuard = (req: request.Test) => req.timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS })

let seq = 0

async function burst(trust: boolean | number | undefined, headers: Array<Record<string, string>>, max = 2): Promise<number[]> {
    const id = `api16-${++seq}`
    await RateLimiterManager.getInstance().addRateLimiter(id, 60, max, 'limited')
    const app = express()
    if (trust !== undefined) app.set('trust proxy', trust)
    app.post('/p/:id', RateLimiterManager.getInstance().getRateLimiter(), (_req, res) => {
        res.end('ok')
    })
    const statuses: number[] = []
    for (const header of headers) {
        let pending = hangGuard(request(app).post(`/p/${id}`))
        for (const [name, value] of Object.entries(header)) pending = pending.set(name, value)
        const res = await pending
        statuses.push(res.status)
    }
    RateLimiterManager.getInstance().removeRateLimiter(id)
    return statuses
}

describe('API-16 prediction rate limit and X-Forwarded-For', () => {
    it('ignores a rotated X-Forwarded-For when TRUST_PROXY is unset', async () => {
        const statuses = await burst(undefined, [
            { 'X-Forwarded-For': '203.0.113.10' },
            { 'X-Forwarded-For': '203.0.113.11' },
            { 'X-Forwarded-For': '198.51.100.8' },
            { 'X-Real-IP': '198.51.100.9', Forwarded: 'for=203.0.113.77' }
        ])
        expect(statuses).toEqual([200, 200, 429, 429])
    })

    it('ignores a rotated X-Forwarded-For when TRUST_PROXY is false', async () => {
        const statuses = await burst(false, [
            { 'X-Forwarded-For': 'not-an-ip-1' },
            { 'X-Forwarded-For': 'not-an-ip-2' },
            { 'X-Forwarded-For': '203.0.113.10:40001' },
            { 'X-Forwarded-For': '203.0.113.10:40002' }
        ])
        expect(statuses).toEqual([200, 200, 429, 429])
    })

    it('does not let a leftmost spoof, a port, or a non-IP open a bucket when one hop is trusted', async () => {
        const spoofedLeft = await burst(1, [
            { 'X-Forwarded-For': '1.1.1.1, 203.0.113.50' },
            { 'X-Forwarded-For': '2.2.2.2, 203.0.113.50' },
            { 'X-Forwarded-For': '3.3.3.3, 203.0.113.50' },
            { 'X-Forwarded-For': '4.4.4.4, 203.0.113.50' }
        ])
        expect(spoofedLeft).toEqual([200, 200, 429, 429])

        const ports = await burst(1, [
            { 'X-Forwarded-For': '203.0.113.10:40001' },
            { 'X-Forwarded-For': '203.0.113.10:40002' },
            { 'X-Forwarded-For': '203.0.113.10:40003' },
            { 'X-Forwarded-For': '203.0.113.10:40004' }
        ])
        expect(ports).toEqual([200, 200, 429, 429])

        const tokens = await burst(1, [
            { 'X-Forwarded-For': 'not-an-ip-1' },
            { 'X-Forwarded-For': 'not-an-ip-2' },
            { 'X-Forwarded-For': 'not-an-ip-3' },
            { 'X-Forwarded-For': 'not-an-ip-4' }
        ])
        expect(tokens).toEqual([200, 200, 429, 429])
    })

    it('still counts each proxy-asserted client on its own when one hop is trusted', async () => {
        const statuses = await burst(
            1,
            [
                { 'X-Forwarded-For': '9.9.9.9, 203.0.113.10' },
                { 'X-Forwarded-For': '8.8.8.8, 203.0.113.10' },
                { 'X-Forwarded-For': '7.7.7.7, 203.0.113.11' }
            ],
            1
        )
        expect(statuses).toEqual([200, 429, 200])
    })

    it('strips a port and an IPv4-mapped prefix, and rejects a non-IP', () => {
        const asReq = (ip: string | undefined, remoteAddress = '127.0.0.1') => ({ ip, socket: { remoteAddress } } as Request)
        expect(rateLimitClientKey(asReq('203.0.113.10:40001'))).toBe('203.0.113.10')
        expect(rateLimitClientKey(asReq('[2001:db8::1]:40001'))).toBe('2001:db8::1')
        expect(rateLimitClientKey(asReq('::ffff:203.0.113.5'))).toBe('203.0.113.5')
        expect(rateLimitClientKey(asReq('not-a-client', '::ffff:192.0.2.1'))).toBe('192.0.2.1')
        expect(rateLimitClientKey({ socket: {} } as Request)).toBe('unknown')
    })
})
