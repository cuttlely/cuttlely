import express from 'express'
import request from 'supertest'

jest.mock('./getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({})
}))

import errorHandlerMiddleware from '../middlewares/errors'
import { a2aBodyErrorHandler, a2aContentTypeGuard, a2aJsonParser } from '../routes/a2a'
import { orchestrateContentTypeGuard, orchestrateJsonParser } from '../routes/orchestrate'
import { mcpJsonParser, skipGlobalJsonParser, unlessExternalJson, whenMcpEndpoint } from './externalJsonLimit'

const REQUEST_TIMEOUT_MS = 20_000
const hangGuard = (req: request.Test) => req.timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS })

const overOneMb = JSON.stringify({ data: 'x'.repeat(1_100_000) })

const productionParsers = () => {
    const app = express()
    app.use('/api/v1/orchestrate', orchestrateContentTypeGuard, orchestrateJsonParser)
    app.use('/api/v1/a2a', a2aContentTypeGuard)
    app.use('/api/v1/a2a', a2aJsonParser)
    app.use('/api/v1/a2a', a2aBodyErrorHandler)
    app.use(whenMcpEndpoint(mcpJsonParser))
    app.use(unlessExternalJson(express.json({ limit: '50mb' })))
    app.use(unlessExternalJson(express.urlencoded({ limit: '50mb', extended: true })))
    const parsed = (_req: express.Request, res: express.Response) => res.json({ parsed: true })
    app.post('/api/v1/a2a/:id', parsed)
    app.post('/api/v1/orchestrate/:id', parsed)
    app.post('/api/v1/orchestrate/:id/chat/completions', parsed)
    app.post('/api/v1/mcp/:id', parsed)
    app.post('/api/v1/mcp-server/:id', parsed)
    app.post('/api/v1/prediction/:id', parsed)
    app.use(errorHandlerMiddleware)
    return app
}

describe('skipGlobalJsonParser', () => {
    it('skips A2A, Orchestrate, MCP Streamable HTTP, and SCIM, not mcp-server or prediction', () => {
        expect(skipGlobalJsonParser({ originalUrl: '/api/v1/a2a/flow-1' })).toBe(true)
        expect(skipGlobalJsonParser({ originalUrl: '/API/v1//A2A/flow-1' })).toBe(true)
        expect(skipGlobalJsonParser({ originalUrl: '/api/v1/orchestrate/flow-1/chat/completions' })).toBe(true)
        expect(skipGlobalJsonParser({ originalUrl: '/api/v1/mcp/flow-1' })).toBe(true)
        expect(skipGlobalJsonParser({ originalUrl: '/api/v1/scim/v2/Users' })).toBe(true)
        expect(skipGlobalJsonParser({ originalUrl: '/api/v1/mcp-server/flow-1' })).toBe(false)
        expect(skipGlobalJsonParser({ originalUrl: '/api/v1/prediction/flow-1' })).toBe(false)
    })
})

describe('1 MB JSON cap with the global file-size parser still mounted', () => {
    const app = productionParsers()
    const post = (path: string) => hangGuard(request(app).post(path).set('Content-Type', 'application/json').send(overOneMb))

    it('refuses A2A over 1 MB with body_too_large', async () => {
        const res = await post('/api/v1/a2a/flow-1')
        expect(res.status).toBe(413)
        expect(res.body).toEqual({
            error: { message: 'Request body too large', type: 'invalid_request_error', code: 'body_too_large' }
        })
    })

    it('refuses Orchestrate over 1 MB with the global 413 body', async () => {
        const res = await post('/api/v1/orchestrate/flow-1')
        expect(res.status).toBe(413)
        expect(res.body.statusCode).toBe(413)
        expect(res.body.success).toBe(false)
        expect(res.body.message).toBeDefined()
        expect(res.body.stack).toEqual({})
        expect(res.body.error).toBeUndefined()
    })

    it('refuses MCP over 1 MB with the global 413 body', async () => {
        const res = await post('/api/v1/mcp/flow-1')
        expect(res.status).toBe(413)
        expect(res.body.statusCode).toBe(413)
        expect(res.body.success).toBe(false)
        expect(res.body.message).toBeDefined()
        expect(res.body.stack).toEqual({})
    })

    it('still parses a body over 1 MB on prediction and mcp-server', async () => {
        const prediction = await post('/api/v1/prediction/flow-1')
        expect(prediction.status).toBe(200)
        expect(prediction.body).toEqual({ parsed: true })
        const mcpServer = await post('/api/v1/mcp-server/flow-1')
        expect(mcpServer.status).toBe(200)
        expect(mcpServer.body).toEqual({ parsed: true })
    })
})
