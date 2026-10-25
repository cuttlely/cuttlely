import express from 'express'
import request from 'supertest'
import { backgroundBootPass, beginBootPass, finishBootPass, refuseRunsWhileBootPass, resetBootPass } from './bootGate'

afterEach(() => resetBootPass())

function app() {
    const api = express.Router()
    api.use(express.json())
    api.use(refuseRunsWhileBootPass)
    api.post('/prediction/:id', (_req, res) => res.json({ text: 'answer' }))
    api.post('/internal-prediction/:id', (_req, res) => res.json({ text: 'draft' }))
    api.post('/harnesses/:name/runs', (_req, res) => res.json({ ok: true }))
    api.post('/harnesses/:name/runs/async', (_req, res) => res.json({ ok: true }))
    api.get('/ping', (_req, res) => res.send('pong'))
    const server = express()
    server.use('/api/v1', api)
    return server
}

describe('boot compile holds chat and prediction', () => {
    it('answers 503 with Retry-After until the compile finishes, then runs the request', async () => {
        beginBootPass()
        const held = await request(app()).post('/api/v1/prediction/flow-1').send({ question: 'hi' })
        expect(held.status).toBe(503)
        expect(held.headers['retry-after']).toBe('30')
        expect(held.body.code).toBe('PROFILES_COMPILING')
        const draft = await request(app()).post('/api/v1/internal-prediction/flow-1').send({ question: 'hi' })
        expect(draft.status).toBe(503)
        const run = await request(app()).post('/api/v1/harnesses/bakery/runs').send({ question: 'hi' })
        expect(run.status).toBe(503)
        expect(run.headers['retry-after']).toBe('30')
        const ping = await request(app()).get('/api/v1/ping')
        expect(ping.status).toBe(200)
        expect(ping.text).toBe('pong')
        finishBootPass()
        const open = await request(app()).post('/api/v1/prediction/flow-1').send({ question: 'hi' })
        expect(open.status).toBe(200)
        expect(open.body).toEqual({ text: 'answer' })
    })

    it('keeps chat and prediction at 503 after the startup cap, while the compile continues', async () => {
        beginBootPass()
        backgroundBootPass()
        const held = await request(app()).post('/api/v1//Prediction/flow-1').send({ question: 'hi' })
        expect(held.status).toBe(503)
        expect(held.headers['retry-after']).toBe('30')
        finishBootPass()
        const open = await request(app()).post('/api/v1/harnesses/bakery/runs/async').send({ question: 'hi' })
        expect(open.status).toBe(200)
        expect(open.body).toEqual({ ok: true })
    })
})
