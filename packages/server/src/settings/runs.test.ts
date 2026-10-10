import express from 'express'
import request from 'supertest'
import { drainRuns, isRunRequest, resetRuns, runsInProgress, trackRuns, waitLimitMs } from './runs'

afterEach(() => resetRuns())

function app(hold: { release?: () => void }) {
    const server = express()
    server.use('/api/v1', trackRuns)
    server.post('/api/v1/prediction/:id', (_req, res) => {
        hold.release = () => res.json({ text: 'made-up answer' })
    })
    server.post('/api/v1/harnesses/:name/runs', (_req, res) => res.json({ ok: true }))
    server.get('/api/v1/ping', (_req, res) => res.send('pong'))
    return server
}

describe('runs in progress', () => {
    it('knows which requests are runs', () => {
        expect(isRunRequest('POST', '/api/v1/prediction/abc')).toBe(true)
        expect(isRunRequest('POST', '/api/v1/internal-prediction/abc')).toBe(true)
        expect(isRunRequest('POST', '/api/v1/harnesses/bakery/runs')).toBe(true)
        expect(isRunRequest('GET', '/api/v1/harnesses/bakery/runs')).toBe(false)
        expect(isRunRequest('POST', '/api/v1/server-settings')).toBe(false)
    })

    it('counts a run while it is open, waits for it, and turns new runs away meanwhile', async () => {
        const hold: { release?: () => void } = {}
        const server = app(hold)
        const pending = request(server)
            .post('/api/v1/prediction/flow-1')
            .send({ question: 'How many croissants?' })
            .then((r) => r)
        for (let i = 0; i < 40 && runsInProgress() === 0; i++) await new Promise((r) => setTimeout(r, 25))
        expect(runsInProgress()).toBe(1)
        const drained = drainRuns(5000, 20)
        const refused = await request(server).post('/api/v1/harnesses/bakery/runs').send({})
        expect(refused.status).toBe(503)
        expect((await request(server).get('/api/v1/ping')).text).toBe('pong')
        hold.release?.()
        expect((await pending).status).toBe(200)
        expect(await drained).toBe(0)
    })

    it('stops waiting at the limit', async () => {
        const hold: { release?: () => void } = {}
        const pending = request(app(hold))
            .post('/api/v1/prediction/flow-1')
            .send({})
            .then((r) => r)
        for (let i = 0; i < 40 && runsInProgress() === 0; i++) await new Promise((r) => setTimeout(r, 25))
        expect(await drainRuns(100, 20)).toBe(1)
        hold.release?.()
        await pending
    })

    it('waits at most the turn time limit', () => {
        expect(waitLimitMs({})).toBe(45000)
        expect(waitLimitMs({ CUTTLELY_HARNESS_TURN_BUDGET_MS: '240000' })).toBe(240000)
        expect(waitLimitMs({ CUTTLELY_HARNESS_TURN_BUDGET_MS: 'nope' })).toBe(45000)
    })
})
