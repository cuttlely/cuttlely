import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { watchClientDisconnect } from '../utils/clientAbort'
import { sanitizeMiddleware } from '../utils/XSS'
import {
    drainRuns,
    drainTimeoutMs,
    isRunRequest,
    isShuttingDown,
    refuseWhileShuttingDown,
    resetRuns,
    runsInProgress,
    shutdownDrain,
    trackRuns,
    waitLimitMs
} from './runs'

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

    it('matches a run path in any letter case and with repeated slashes, as Express routes it', () => {
        expect(isRunRequest('POST', '/api/v1/Prediction/abc')).toBe(true)
        expect(isRunRequest('POST', '/api/v1//prediction/abc')).toBe(true)
        expect(isRunRequest('POST', '/api/v1//Harnesses//bakery/runs')).toBe(true)
        expect(isRunRequest('POST', '/api/v1/predictions/abc')).toBe(false)
    })

    it('turns away a run with a percent-encoded path while a restart drains, as the router decodes it', async () => {
        const server = express()
        server.use(sanitizeMiddleware)
        const api = express.Router()
        api.use(trackRuns)
        api.post(['/prediction/:id', '/internal-prediction/:id', '/harnesses/:name/runs'], (_req, res) => res.json({ ran: true }))
        server.use('/api/v1', api)
        expect((await request(server).post('/api/v1/%70rediction/x').send({})).body).toEqual({ ran: true })
        await drainRuns(0)
        for (const path of [
            '/api/v1/%70rediction/x',
            '/api/v1/internal-%70rediction/x',
            '/api/v1/harnesses/bakery/%72uns',
            '/api/v1//%50rediction/x'
        ]) {
            const res = await request(server).post(path).send({})
            expect({ path, status: res.status }).toEqual({ path, status: 503 })
        }
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

// ─── Shutdown (SIGTERM / SIGINT) ─────────────────────────────────────────────

type Held = { release: () => void; signal: AbortSignal }

/** A real HTTP server like the app: the shutdown guard first, then run tracking, then routes that wait to answer. */
function liveApp() {
    const held: Held[] = []
    const app = express()
    app.use(refuseWhileShuttingDown)
    app.use('/api/v1', trackRuns)
    app.get('/api/v1/ping', (_req, res) => res.send('pong'))
    app.post('/api/v1/prediction/:id', (req, res) => {
        const signal = watchClientDisconnect(res)
        if (req.query.stream === '1') {
            res.setHeader('Content-Type', 'text/event-stream')
            res.flushHeaders()
            res.write(`message:\ndata:${JSON.stringify({ event: 'token', data: 'Fresh ' })}\n\n`)
            held.push({ release: () => res.end(), signal })
            return
        }
        held.push({ release: () => res.json({ text: `${req.params.id}: two dozen croissants` }), signal })
    })
    const api = express.Router()
    const harnesses = express.Router()
    api.use('/harnesses', harnesses)
    harnesses.post('/:name/runs', (_req, res) => {
        const signal = watchClientDisconnect(res)
        res.setHeader('Content-Type', 'text/event-stream')
        res.flushHeaders()
        res.write(`message:\ndata:${JSON.stringify({ event: 'token', data: 'Fresh ' })}\n\n`)
        held.push({ release: () => res.end(), signal })
    })
    app.use('/api/v1', api)
    const server = http.createServer(sanitizedApp(app))
    return new Promise<{ server: http.Server; base: string; held: Held[] }>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, held }))
    )
}

// The real URL decoding in front, as in production, so an encoded path routes the way Express sees it.
function sanitizedApp(inner: express.Express) {
    const outer = express()
    outer.use(sanitizeMiddleware)
    outer.use(inner)
    return outer
}

function streamEvents(text: string) {
    return text
        .split('\n\n')
        .filter((chunk) => chunk.includes('data:'))
        .map((chunk) => JSON.parse(chunk.slice(chunk.indexOf('data:') + 5)))
}

async function waitFor(check: () => boolean, ms = 3000) {
    const until = Date.now() + ms
    while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 10))
    if (!check()) throw new Error('timed out waiting')
}

async function readAll(response: Response): Promise<string> {
    try {
        return await response.text()
    } catch (error) {
        return `READ FAILED ${(error as Error).name}`
    }
}

describe('shutdown drain', () => {
    afterEach(() => resetRuns())

    it('lets five requests in flight during SIGTERM finish with 200, then closes', async () => {
        const { server, base, held } = await liveApp()
        const answers = Array.from({ length: 5 }, (_, i) =>
            fetch(`${base}/api/v1/prediction/flow-${i}`, { method: 'POST' }).then(async (r) => ({ status: r.status, text: await r.text() }))
        )
        await waitFor(() => held.length === 5)
        const drained = shutdownDrain(server, 5000, 10)
        expect(isShuttingDown()).toBe(true)
        await new Promise((r) => setTimeout(r, 50))
        for (const h of held) h.release()
        const results = await Promise.all(answers)
        expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
        expect(results[3].text).toContain('flow-3: two dozen croissants')
        expect(await drained).toEqual({ endedRuns: 0, closedInTime: true })
        expect(server.listening).toBe(false)
        expect(held.some((h) => h.signal.aborted)).toBe(false)
    })

    it('turns new requests away with 503 and Retry-After while draining, the health check too', async () => {
        await shutdownDrain(undefined, 0)
        const app = express()
        app.use(refuseWhileShuttingDown)
        app.use('/api/v1', trackRuns)
        app.get('/api/v1/ping', (_req, res) => res.send('pong'))
        app.post('/api/v1/prediction/:id', (_req, res) => res.json({ text: 'should not run' }))

        const ping = await request(app).get('/api/v1/ping')
        expect(ping.status).toBe(503)
        expect(ping.headers['retry-after']).toBe('30')
        const run = await request(app).post('/api/v1/prediction/flow-1').send({ question: 'Rye today?' })
        expect(run.status).toBe(503)
        expect(run.headers['retry-after']).toBe('30')
        expect(run.body).toMatchObject({ statusCode: 503, code: 'UNAVAILABLE' })
        expect(runsInProgress()).toBe(0)
    })

    it('ends a stream that runs past the drain time with an error event, and aborts its work', async () => {
        const { server, base, held } = await liveApp()
        const response = await fetch(`${base}/api/v1/prediction/flow-1?stream=1`, { method: 'POST' })
        expect(response.status).toBe(200)
        await waitFor(() => held.length === 1)
        const body = readAll(response)

        const result = await shutdownDrain(server, 100, 10)

        expect(result).toEqual({ endedRuns: 1, closedInTime: false })
        const text = await body
        expect(text).toContain('"event":"token"')
        const events = text
            .split('\n\n')
            .filter((chunk) => chunk.includes('data:'))
            .map((chunk) => JSON.parse(chunk.slice(chunk.indexOf('data:') + 5)))
        expect(events).toContainEqual({
            event: 'error',
            data: 'Cuttlely is restarting. Try again in a minute.',
            status: 503,
            code: 'UNAVAILABLE'
        })
        expect(events[events.length - 1]).toEqual({ event: 'end', data: '[DONE]' })
        expect(held[0].signal.aborted).toBe(true)
        expect(server.listening).toBe(false)
    })

    it.each([
        '/api/v1/harnesses/bakery/runs',
        '/api/v1/Harnesses/bakery/runs',
        '/api/v1//harnesses//bakery/runs',
        '/api/v1/%68arnesses/bakery/runs'
    ])('ends a harness stream on %s past the drain time with the harness error shape', async (runPath) => {
        const { server, base, held } = await liveApp()
        const response = await fetch(`${base}${runPath}`, { method: 'POST' })
        expect(response.status).toBe(200)
        await waitFor(() => held.length === 1)
        const body = readAll(response)

        expect(await shutdownDrain(server, 100, 10)).toEqual({ endedRuns: 1, closedInTime: false })
        const events = streamEvents(await body)
        expect(events).toContainEqual({
            event: 'error',
            data: { message: 'Cuttlely is restarting. Try again in a minute.' },
            status: 503,
            code: 'UNAVAILABLE'
        })
        expect(events[events.length - 1]).toEqual({ event: 'end', data: '[DONE]' })
    })

    it('answers a run that has not answered by the drain time with 503 and Retry-After', async () => {
        const { server, base, held } = await liveApp()
        const answer = fetch(`${base}/api/v1/prediction/flow-1`, { method: 'POST' })
        await waitFor(() => held.length === 1)

        const result = await shutdownDrain(server, 100, 10)
        const response = await answer

        expect(result.endedRuns).toBe(1)
        expect(response.status).toBe(503)
        expect(response.headers.get('retry-after')).toBe('30')
        expect(held[0].signal.aborted).toBe(true)
    })

    it('closes at once when nothing is running', async () => {
        const { server } = await liveApp()
        const started = Date.now()
        expect(await shutdownDrain(server, 5000, 10)).toEqual({ endedRuns: 0, closedInTime: true })
        expect(Date.now() - started).toBeLessThan(1000)
    })

    it('reads the drain time from CUTTLELY_DRAIN_TIMEOUT_MS', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-drain-'))
        const env = (extra: Record<string, string> = {}) => ({ CUTTLELY_DATA_DIR: dir, ...extra })
        expect(drainTimeoutMs(env())).toBe(25000)
        expect(drainTimeoutMs(env({ CUTTLELY_DRAIN_TIMEOUT_MS: '60000' }))).toBe(60000)
        expect(drainTimeoutMs(env({ CUTTLELY_DRAIN_TIMEOUT_MS: '0' }))).toBe(0)
        expect(drainTimeoutMs(env({ CUTTLELY_DRAIN_TIMEOUT_MS: '1000' }))).toBe(1000)
        expect(drainTimeoutMs(env({ CUTTLELY_DRAIN_TIMEOUT_MS: '' }))).toBe(25000)
        expect(drainTimeoutMs(env({ CUTTLELY_DRAIN_TIMEOUT_MS: 'soon' }))).toBe(25000)
        expect(drainTimeoutMs(env({ CUTTLELY_DRAIN_TIMEOUT_MS: '99999999' }))).toBe(25000)
    })
})
