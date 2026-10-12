/**
 * Rate limit: a forged X-Forwarded-For must not open a new prediction rate-limit bucket.
 * The key is Express's client address after TRUST_PROXY. A port or a non-IP is not a bucket.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import express, { Request } from 'express'
import request from 'supertest'
import {
    RateLimiterManager,
    UI_PAGE_LIMIT_MAX,
    UI_PAGE_LIMIT_WINDOW_MS,
    rateLimitClientKey,
    uiAssetMiddleware,
    uiPageRateLimiter
} from './rateLimit'

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

describe('Prediction rate limit and X-Forwarded-For', () => {
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

describe('UI page fallback limiter', () => {
    it('uses a one-minute window and a few thousand requests per client', () => {
        expect(UI_PAGE_LIMIT_WINDOW_MS).toBe(60_000)
        expect(UI_PAGE_LIMIT_MAX).toBe(3000)
    })

    it('is wired only around the UI index fallback in the server', () => {
        const source = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8')
        const limiter = fs.readFileSync(path.join(__dirname, 'rateLimit.ts'), 'utf8')
        expect(source).toMatch(/this\.app\.use\(uiAssetMiddleware\(uiBuild\.directory\)\)/)
        expect(source).toMatch(
            /this\.app\.use\(uiPageRateLimiter\(\), \(_req: Request, res: Response\) => \{\s*res\.sendFile\(uiBuild\.indexHtml\)/
        )
        expect(limiter).toMatch(/express\.static\(directory, \{ index: false, redirect: false \}\)/)
        expect(limiter).toMatch(/req\.path === '\/' \|\| req\.path === '\/index\.html'/)
        expect(source).not.toMatch(/embed\/chat\.js[\s\S]{0,400}uiPageRateLimiter/)
    })

    it('limits GET / and GET /index.html, and leaves hashed assets, the embed script, and ping unlimited', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-ui-limit-'))
        fs.mkdirSync(path.join(dir, 'assets'))
        fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'asset')
        fs.writeFileSync(path.join(dir, 'index.html'), '<html>ui</html>')
        const app = express()
        app.get('/api/v1/ping', (_req, res) => res.type('text').send('pong'))
        app.get('/embed/chat.js', (_req, res) => res.type('js').send('widget'))
        app.use(uiAssetMiddleware(dir))
        app.use(uiPageRateLimiter(3), (_req, res) => {
            res.sendFile(path.join(dir, 'index.html'))
        })

        for (const url of ['/', '/index.html', '/']) {
            const page = await hangGuard(request(app).get(url))
            expect(page.status).toBe(200)
            expect(page.type).toMatch(/html/)
            expect(page.text).toBe('<html>ui</html>')
            expect(page.headers['x-ratelimit-limit']).toBeUndefined()
            expect(page.headers['ratelimit-limit']).toBeUndefined()
            expect(page.headers['retry-after']).toBeUndefined()
        }
        for (const url of ['/', '/index.html', '/chatflows']) {
            const limited = await hangGuard(request(app).get(url))
            expect(limited.status).toBe(429)
            expect(limited.text).toBe('Too many requests, please try again later.')
        }

        for (let i = 0; i < 8; i += 1) {
            const asset = await hangGuard(request(app).get('/assets/app-abc123.js'))
            expect(asset.status).toBe(200)
            expect(asset.text).toBe('asset')
            expect(asset.headers['x-ratelimit-limit']).toBeUndefined()
        }
        const embed = await hangGuard(request(app).get('/embed/chat.js'))
        expect(embed.status).toBe(200)
        expect(embed.text).toBe('widget')
        const ping = await hangGuard(request(app).get('/api/v1/ping'))
        expect(ping.status).toBe(200)
        expect(ping.text).toBe('pong')

        fs.rmSync(dir, { recursive: true, force: true })
    })
})
