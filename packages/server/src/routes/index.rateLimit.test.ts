/**
 * The real API router: each guarded prefix has its own page-load counter in front of its router.
 */
import express from 'express'
import request from 'supertest'

jest.mock('../utils/rateLimit', () => {
    const actual = jest.requireActual('../utils/rateLimit')
    return { ...actual, uiPageRateLimiter: () => actual.uiPageRateLimiter(2) }
})

import apiRouter from './index'

jest.setTimeout(60_000)

const GUARDED = ['/components-credentials-icon', '/node-icon', '/oauth2-credential', '/verify', '/custom-mcp-servers', '/auth', '/account']

const hangGuard = (req: request.Test) => req.timeout({ response: 20_000, deadline: 20_000 })

describe('API router page-load limits', () => {
    const app = express()
    app.use('/api/v1', apiRouter)
    app.use((_req, res) => res.status(404).end())
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).end())

    it('answers one 429 per guarded prefix after two requests, each prefix on its own counter', async () => {
        const limited: Record<string, number[]> = {}
        for (const prefix of GUARDED) {
            const statuses: number[] = []
            for (let i = 0; i < 3; i += 1) {
                statuses.push((await hangGuard(request(app).get(`/api/v1${prefix}/no-such-route`))).status)
            }
            limited[prefix] = statuses
        }
        for (const prefix of GUARDED) {
            expect({ prefix, count: limited[prefix].filter((status) => status === 429).length, last: limited[prefix][2] }).toEqual({
                prefix,
                count: 1,
                last: 429
            })
        }
    })

    it('leaves an unguarded prefix without that counter', async () => {
        for (let i = 0; i < 4; i += 1) {
            expect((await hangGuard(request(app).get('/api/v1/version/no-such-route'))).status).not.toBe(429)
        }
    })
})
