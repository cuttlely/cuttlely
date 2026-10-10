/**
 * API-2 (#11): refusals and errors on /api/v1/prediction never leave a request without an answer, whatever `streaming` says.
 *
 * Before this change the error handler wrote nothing when `req.body.streaming` was truthy and not 'false', while the
 * controller and authorizeFlowAccess only stream for `true` / 'true'. A JSON body with `streaming: 1`, '1', 'TRUE' or {}
 * was therefore refused or failed through `next(error)` and then hung until the client gave up.
 *
 * The real predictions route, controller, rate limiter, authorizeFlowAccess and error handler run behind supertest.
 * buildChatflow is a stand-in: it repeats utilBuildChatflow's external key check and can be told to throw.
 * Every request has a client hang guard, so a stuck handler fails the test instead of stalling the suite.
 * 20 s is that guard under a busy machine. It is not an API latency budget. Jest's 5 s default is too short for the same load.
 */
import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { generateSecretHash } from './apiKey'

const HANG_GUARD_MS = 20_000
jest.setTimeout(30_000)

const hangGuard = (req: request.Test) => req.timeout({ response: HANG_GUARD_MS, deadline: HANG_GUARD_MS })

const mockState = {
    sseClients: [] as string[],
    buildCalls: 0,
    buildError: undefined as undefined | { statusCode: number; message: string },
    streamErrors: [] as string[]
}

jest.mock('./logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

jest.mock('./index', () => {
    const multer = require('multer')
    return { getMulterStorage: () => multer({ storage: multer.memoryStorage() }) }
})

const mockApiKeys = new Map<string, { id: string; workspaceId: string; apiSecret: string }>()
jest.mock('../services/apikey', () => ({
    __esModule: true,
    default: { getApiKeyById: jest.fn(async (id: string) => mockApiKeys.get(id) ?? null) }
}))

const mockDb = { chatflows: new Map<string, any>() }
const mockSseResponses = new Map<string, any>()
jest.mock('./getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: (entity: { name: string }) => ({
                findOneBy: async ({ id }: { id: string }) => (entity.name === 'ChatFlow' ? mockDb.chatflows.get(id) ?? null : null)
            })
        },
        sseStreamer: {
            addExternalClient: (chatId: string, res: any) => {
                mockState.sseClients.push(chatId)
                mockSseResponses.set(chatId, res)
            },
            streamMetadataEvent: jest.fn(),
            streamErrorEvent: (chatId: string, message: string) => {
                mockState.streamErrors.push(message)
                mockSseResponses.get(chatId)?.write(`message:\ndata:${JSON.stringify({ event: 'error', data: message })}\n\n`)
            },
            // As the real SSEStreamer does, removing the client ends its response.
            removeClient: (chatId: string) => {
                mockSseResponses.get(chatId)?.end()
                mockSseResponses.delete(chatId)
            }
        }
    })
}))

jest.mock('../services/chatflows', () => {
    const { InternalFlowiseError } = jest.requireActual('../errors/internalFlowiseError')
    return {
        __esModule: true,
        default: {
            getChatflowById: async (id: string) => {
                const flow = mockDb.chatflows.get(id)
                if (!flow) throw new InternalFlowiseError(404, `Chatflow ${id} not found in the database!`)
                return flow
            },
            checkIfChatflowIsValidForStreaming: async () => ({ isStreaming: true })
        }
    }
})

jest.mock('../services/predictions', () => {
    const { InternalFlowiseError } = jest.requireActual('../errors/internalFlowiseError')
    const { validateFlowAPIKey } = jest.requireActual('./validateKey')
    return {
        __esModule: true,
        default: {
            buildChatflow: async (req: any) => {
                mockState.buildCalls += 1
                const chatflow = mockDb.chatflows.get(req.params.id)
                if (!(await validateFlowAPIKey(req, chatflow))) throw new InternalFlowiseError(401, 'Unauthorized')
                if (mockState.buildError) throw new InternalFlowiseError(mockState.buildError.statusCode, mockState.buildError.message)
                return { text: 'ok', chatId: req.body.chatId ?? 'chat-1' }
            }
        }
    }
})

// Imported after the mocks.
import predictionsController from '../controllers/predictions'
import predictionsRouter from '../routes/predictions'
import errorHandlerMiddleware from '../middlewares/errors'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import { isStreamingRequest, isStreamingValue } from './streaming'

const WS = 'ws-1'
const K = '11111111-1111-4111-8111-111111111111'
const F = '33333333-3333-4333-8333-333333333333'
const O = '77777777-7777-4777-8777-777777777777'
const KEY_K = 'key-for-flow-k-0123456789abcdef'
const KEY_O = 'key-for-flow-o-0123456789abcdef'
const ALLOWED_ORIGIN = 'https://allowed.example'
const DISALLOWED_ORIGIN = 'https://evil.example'
const ORIGIN_ERROR = 'Embed not allowed here'

// JSON `streaming` values that do not ask for a stream; the truthy ones used to hang on any refusal.
const NON_STREAMING_VALUES: unknown[] = [1, '1', 'TRUE', 'True', {}, [], 'yes', 'false', false, 0, null]
const STREAMING_VALUES: unknown[] = [true, 'true']
const label = (value: unknown) => JSON.stringify(value)

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use('/api/v1/prediction', predictionsRouter)
app.use(errorHandlerMiddleware)

const post = (flowId: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const req = request(app).post(`/api/v1/prediction/${flowId}`)
    for (const [name, value] of Object.entries(headers)) req.set(name, value)
    return hangGuard(req.send(body))
}

const expectJsonError = (res: request.Response, statusCode: number, message: string) => {
    expect(res.status).toBe(statusCode)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/)
    expect(res.body).toEqual({ statusCode, success: false, message, stack: {} })
}

beforeAll(() => {
    mockApiKeys.set('apikey-k', { id: 'apikey-k', workspaceId: WS, apiSecret: generateSecretHash(KEY_K) })
    mockApiKeys.set('apikey-o', { id: 'apikey-o', workspaceId: WS, apiSecret: generateSecretHash(KEY_O) })
    mockDb.chatflows.set(K, { id: K, workspaceId: WS, apikeyid: 'apikey-k' })
    mockDb.chatflows.set(F, { id: F, workspaceId: WS, apikeyid: '' })
    const chatbotConfig = JSON.stringify({ allowedOrigins: [ALLOWED_ORIGIN], allowedOriginsError: ORIGIN_ERROR })
    mockDb.chatflows.set(O, { id: O, workspaceId: WS, apikeyid: 'apikey-o', chatbotConfig })
})

beforeEach(() => {
    mockState.sseClients = []
    mockState.buildCalls = 0
    mockState.buildError = undefined
    mockState.streamErrors = []
})

describe('API-2: one streaming rule', () => {
    it('1: isStreamingValue accepts only true and "true"', () => {
        for (const value of STREAMING_VALUES) expect(isStreamingValue(value)).toBe(true)
        for (const value of [...NON_STREAMING_VALUES, undefined, 'streaming', ' true']) expect(isStreamingValue(value)).toBe(false)
        expect(isStreamingRequest({ body: { streaming: 'true' } } as Request)).toBe(true)
        expect(isStreamingRequest({ body: { streaming: 1 } } as Request)).toBe(false)
        expect(isStreamingRequest({} as Request)).toBe(false)
    })
})

describe('API-2: refusals are answered before any stream, for every streaming value', () => {
    it.each(NON_STREAMING_VALUES.map((value) => [label(value), value]))(
        '2: streaming %s, no key -> 401 JSON, no SSE client',
        async (_name, streaming) => {
            expectJsonError(await post(K, { question: 'hi', streaming }), 401, 'Unauthorized')
            expect(mockState.sseClients).toEqual([])
            expect(mockState.buildCalls).toBe(0)
        }
    )

    it.each([...STREAMING_VALUES, ...NON_STREAMING_VALUES].map((value) => [label(value), value]))(
        '3: streaming %s, wrong key -> 401 JSON, no SSE client',
        async (_name, streaming) => {
            expectJsonError(await post(K, { question: 'hi', streaming }, { Authorization: 'Bearer wrong-key' }), 401, 'Unauthorized')
            expect(mockState.sseClients).toEqual([])
        }
    )

    it.each(STREAMING_VALUES.map((value) => [label(value), value]))('4: streaming %s, no key -> 401 JSON', async (_name, streaming) => {
        expectJsonError(await post(K, { question: 'hi', streaming }), 401, 'Unauthorized')
        expect(mockState.sseClients).toEqual([])
    })

    it.each(NON_STREAMING_VALUES.map((value) => [label(value), value]))(
        '5: streaming %s, valid key from a disallowed Origin -> 403 JSON with the flow message',
        async (_name, streaming) => {
            const res = await post(O, { question: 'hi', streaming }, { Authorization: `Bearer ${KEY_O}`, Origin: DISALLOWED_ORIGIN })
            expectJsonError(res, 403, ORIGIN_ERROR)
            expect(mockState.buildCalls).toBe(0)
        }
    )

    it('6: streaming true from a disallowed Origin keeps its plain-text 403 (unchanged)', async () => {
        const res = await post(O, { question: 'hi', streaming: true }, { Authorization: `Bearer ${KEY_O}`, Origin: DISALLOWED_ORIGIN })
        expect(res.status).toBe(403)
        expect(res.text).toBe(ORIGIN_ERROR)
        expect(res.headers['content-type']).not.toMatch(/text\/event-stream/)
    })

    it.each([1, 'TRUE', {}].map((value) => [label(value), value]))(
        '7: streaming %s, unknown flow -> 404 JSON; invalid id -> 400 JSON; missing id -> 412 JSON',
        async (_name, streaming) => {
            const missing = '44444444-4444-4444-8444-444444444444'
            expectJsonError(await post(missing, { streaming }), 404, `Chatflow ${missing} not found`)
            expectJsonError(await post('not-a-uuid', { streaming }), 400, 'Invalid chatflowId format - must be a valid UUID')
            const noId = await hangGuard(request(app).post('/api/v1/prediction/').send({ streaming }))
            expectJsonError(noId, 412, 'Error: predictionsController.createPrediction - id not provided!')
        }
    )
})

describe('API-2: errors after access is granted', () => {
    it.each(NON_STREAMING_VALUES.map((value) => [label(value), value]))(
        '8: streaming %s, valid key, the flow run fails -> JSON error with its status, no SSE client',
        async (_name, streaming) => {
            mockState.buildError = { statusCode: 422, message: 'cannot run: missing model' }
            expectJsonError(
                await post(K, { question: 'hi', streaming }, { Authorization: `Bearer ${KEY_K}` }),
                422,
                'cannot run: missing model'
            )
            mockState.buildError = { statusCode: 500, message: 'boom' }
            expectJsonError(await post(F, { question: 'hi', streaming }), 500, 'boom')
            expect(mockState.sseClients).toEqual([])
        }
    )

    it.each(NON_STREAMING_VALUES.map((value) => [label(value), value]))(
        '9: streaming %s, valid key, success -> the normal JSON answer, no SSE client',
        async (_name, streaming) => {
            const res = await post(K, { question: 'hi', streaming }, { Authorization: `Bearer ${KEY_K}` })
            expect(res.status).toBe(200)
            expect(res.body).toEqual({ text: 'ok', chatId: 'chat-1' })
            expect(mockState.sseClients).toEqual([])
        }
    )

    it.each(STREAMING_VALUES.map((value) => [label(value), value]))(
        '10: streaming %s, valid key, the flow run fails after the stream starts -> 200 event stream with the error event, then it ends',
        async (_name, streaming) => {
            mockState.buildError = { statusCode: 500, message: 'mid-stream failure' }
            const res = await post(K, { question: 'hi', streaming, chatId: 'c-10' }, { Authorization: `Bearer ${KEY_K}` })
            expect(res.status).toBe(200)
            expect(res.headers['content-type']).toMatch(/text\/event-stream/)
            expect(mockState.sseClients).toHaveLength(1)
            expect(mockState.sseClients[0]).not.toBe('c-10')
            expect(mockState.streamErrors).toEqual(['mid-stream failure'])
            expect(res.text).toContain('"event":"error"')
            expect(res.text).not.toContain('"success":false')
        }
    )

    it('11: multipart streaming "true" and "1" with a valid key -> event stream for "true", JSON for "1"', async () => {
        const multipart = (streaming: string) =>
            hangGuard(
                request(app)
                    .post(`/api/v1/prediction/${K}`)
                    .set('Authorization', `Bearer ${KEY_K}`)
                    .field('question', 'hi')
                    .field('streaming', streaming)
                    .field('chatId', `c-11-${streaming}`)
                    .attach('files', Buffer.from('file one'), { filename: 'one.txt', contentType: 'text/plain' })
            )
        const streamed = await multipart('true')
        expect(streamed.headers['content-type']).toMatch(/text\/event-stream/)
        const plain = await multipart('1')
        expect(plain.status).toBe(200)
        expect(plain.body).toEqual({ text: 'ok', chatId: 'c-11-1' })
        expect(mockState.sseClients).toHaveLength(1)
        expect(mockState.sseClients[0]).not.toBe('c-11-true')
    })
})

describe('API-2: error handler', () => {
    const run = (headersSent: boolean, body: unknown) => {
        const res: any = { headersSent, setHeader: jest.fn(), status: jest.fn(() => res), json: jest.fn() }
        errorHandlerMiddleware(
            new InternalFlowiseError(401, 'Unauthorized'),
            { body } as Request,
            res as Response,
            jest.fn() as NextFunction
        )
        return res
    }

    it('12: writes the JSON error whenever headers are not sent yet, whatever the body says', () => {
        for (const body of [undefined, {}, { streaming: true }, { streaming: 'true' }, { streaming: 1 }, { streaming: 'false' }]) {
            const res = run(false, body)
            expect(res.status).toHaveBeenCalledWith(401)
            expect(res.json).toHaveBeenCalledWith({ statusCode: 401, success: false, message: 'Unauthorized', stack: {} })
        }
    })

    it('13: writes nothing once headers are sent (a started stream reports its own error event)', () => {
        for (const body of [{ streaming: true }, { streaming: false }, undefined]) {
            const res = run(true, body)
            expect(res.status).not.toHaveBeenCalled()
            expect(res.json).not.toHaveBeenCalled()
            expect(res.setHeader).not.toHaveBeenCalled()
        }
    })
})

describe('API-2: the prediction controller refuses a bad flow key before it opens a stream', () => {
    // The route middleware also checks the key. This app is the controller alone, so a regression that
    // flushes SSE headers and only then checks the key shows up as HTTP 200.
    const bare = express()
    bare.use(express.json())
    bare.post('/api/v1/prediction/:id', predictionsController.createPrediction)
    bare.use(errorHandlerMiddleware)

    const barePost = (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
        const req = request(bare).post(`/api/v1/prediction/${K}`)
        for (const [name, value] of Object.entries(headers)) req.set(name, value)
        return hangGuard(req.send(body))
    }

    it.each(STREAMING_VALUES.map((value) => [label(value), value]))(
        '14: streaming %s, no key -> 401 JSON, no SSE client, prediction not started',
        async (_name, streaming) => {
            expectJsonError(await barePost({ question: 'hi', streaming }), 401, 'Unauthorized')
            expect(mockState.sseClients).toEqual([])
            expect(mockState.buildCalls).toBe(0)
        }
    )

    it.each(STREAMING_VALUES.map((value) => [label(value), value]))(
        '15: streaming %s, wrong key -> 401 JSON, no SSE client, prediction not started',
        async (_name, streaming) => {
            expectJsonError(await barePost({ question: 'hi', streaming }, { Authorization: 'Bearer wrong-key' }), 401, 'Unauthorized')
            expect(mockState.sseClients).toEqual([])
            expect(mockState.buildCalls).toBe(0)
        }
    )

    it('16: streaming true, valid key, controller alone still opens the event stream', async () => {
        const res = await barePost({ question: 'hi', streaming: true, chatId: 'c-16' }, { Authorization: `Bearer ${KEY_K}` })
        expect(res.status).toBe(200)
        expect(res.headers['content-type']).toMatch(/text\/event-stream/)
        expect(mockState.sseClients).toHaveLength(1)
        expect(mockState.buildCalls).toBe(1)
    })
})
