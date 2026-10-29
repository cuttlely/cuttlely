// A HARNESS canvas on the public prediction route uses the harness runtime.
// A chatflow still builds through the prediction service. The route's own checks stay in front.
import express from 'express'
import request from 'supertest'
import { generateSecretHash } from '../../utils/apiKey'
import { configureSessionOwnershipForTests, createMemoryGrantStore, resetSessionOwnershipForTests } from '../../utils/sessionOwnership'

jest.setTimeout(30_000)

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

jest.mock('../../utils', () => {
    const multer = require('multer')
    return { getMulterStorage: () => multer({ storage: multer.memoryStorage() }) }
})

const mockDb = { chatflows: new Map<string, Record<string, unknown>>() }
const mockStreamingChecks: string[] = []
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: () => ({
                findOneBy: async ({ id }: { id: string }) => mockDb.chatflows.get(id) ?? null
            })
        },
        sseStreamer: {
            addExternalClient: jest.fn(),
            streamMetadataEvent: jest.fn(),
            streamErrorEvent: jest.fn(),
            removeClient: jest.fn()
        }
    })
}))

jest.mock('../../services/chatflows', () => {
    const { AppError } = jest.requireActual('../../errors/appError')
    return {
        __esModule: true,
        default: {
            getChatflowById: async (id: string) => {
                const flow = mockDb.chatflows.get(id)
                if (!flow) throw new AppError(404, `Chatflow ${id} not found in the database!`)
                return flow
            },
            checkIfChatflowIsValidForStreaming: async (id: string) => {
                mockStreamingChecks.push(id)
                return { isStreaming: true }
            }
        }
    }
})

const mockBuildChatflow = jest.fn(async (..._args: unknown[]) => ({ text: 'ok', chatId: 'chat-1' }))
jest.mock('../../services/predictions', () => ({
    __esModule: true,
    default: {
        buildChatflow: (...args: unknown[]) => mockBuildChatflow(...args)
    }
}))

const mockStartCanvasRun = jest.fn()
const mockChatImages = jest.fn((..._args: unknown[]) => [] as unknown[])
jest.mock('../../services/harnesses', () => ({
    __esModule: true,
    default: {
        startCanvasRun: (...args: unknown[]) => mockStartCanvasRun(...args),
        chatImages: (...args: unknown[]) => mockChatImages(...args)
    }
}))

const mockStored = new Map<string, { id: string; workspaceId: string; apiSecret: string; harnesses: string[] }>()
jest.mock('../../services/apikey', () => ({
    __esModule: true,
    default: {
        getApiKeyById: async (id: string) => mockStored.get(id) ?? null
    }
}))

import predictionsRouter from '../../routes/predictions'
import errorHandlerMiddleware from '../../middlewares/errors'

const HARNESS_ID = '33333333-3333-4333-8333-333333333333'
const OPEN_ID = '44444444-4444-4444-8444-444444444444'
const CHAT_ID = '22222222-2222-4222-8222-222222222222'
const STORED_ID = 'apikey-bakery'
const PRESENTED = 'bakery-prediction-token-0123456789abcd'
const WS = 'team-a'

const app = express()
app.use(express.json())
app.use('/api/v1/prediction', predictionsRouter)
app.use(errorHandlerMiddleware)

const canvas = (id: string, name: string, type: string, apikeyid: string) => ({
    id,
    name,
    type,
    flowData: '{"nodes":[{"data":{"name":"harnessChief"}}],"edges":[]}',
    workspaceId: WS,
    apikeyid
})

beforeAll(() => {
    mockStored.set(STORED_ID, {
        id: STORED_ID,
        workspaceId: WS,
        apiSecret: generateSecretHash(PRESENTED),
        harnesses: ['bakery-team']
    })
    mockDb.chatflows.set(HARNESS_ID, canvas(HARNESS_ID, 'bakery-team', 'HARNESS', STORED_ID))
    mockDb.chatflows.set(OPEN_ID, canvas(OPEN_ID, 'bakery-open', 'HARNESS', ''))
    mockDb.chatflows.set(CHAT_ID, canvas(CHAT_ID, 'greeter', 'CHATFLOW', ''))
})

afterEach(() => resetSessionOwnershipForTests())

beforeEach(() => {
    configureSessionOwnershipForTests({ secret: 'prediction-test-secret', grants: createMemoryGrantStore() })
    mockBuildChatflow.mockClear()
    mockStartCanvasRun.mockClear()
    mockChatImages.mockClear()
    mockStreamingChecks.length = 0
    mockStartCanvasRun.mockImplementation(
        async (_flow: unknown, _body: { chatId: string }, opts?: { onEvent?: (event: { type: string }) => void }) => {
            opts?.onEvent?.({ type: 'route' })
            return { chatId: _body.chatId, run: { id: 'run-1' }, payload: { text: 'from the harness', artifacts: [] } }
        }
    )
})

describe('POST /api/v1/prediction/:id', () => {
    test('a HARNESS canvas returns the harness result and does not build the graph', async () => {
        const res = await request(app)
            .post(`/api/v1/prediction/${HARNESS_ID}`)
            .set('Authorization', `Bearer ${PRESENTED}`)
            .send({ question: 'hi' })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({
            chatId: expect.any(String),
            sessionToken: expect.any(String),
            run: { id: 'run-1' },
            text: 'from the harness',
            artifacts: []
        })
        expect(mockStartCanvasRun).toHaveBeenCalledWith(
            expect.objectContaining({ id: HARNESS_ID, name: 'bakery-team', type: 'HARNESS' }),
            { question: 'hi', chatId: res.body.chatId },
            {
                source: 'playground',
                canvas: 'live',
                caller: { via: 'api_key', apiKeyId: STORED_ID, harnesses: ['bakery-team'] }
            }
        )
        expect(mockBuildChatflow).not.toHaveBeenCalled()
        expect(mockStreamingChecks).toEqual([])
    })

    test('a HARNESS canvas with nothing bound uses the flow caller and the harness path', async () => {
        const res = await request(app).post(`/api/v1/prediction/${OPEN_ID}`).send({ question: 'hi' })
        expect(res.status).toBe(200)
        expect(res.body).toEqual(
            expect.objectContaining({ text: 'from the harness', chatId: expect.any(String), sessionToken: expect.any(String) })
        )
        expect(mockStartCanvasRun).toHaveBeenCalledWith(
            expect.objectContaining({ id: OPEN_ID, name: 'bakery-open', type: 'HARNESS' }),
            { question: 'hi', chatId: res.body.chatId },
            { source: 'playground', canvas: 'live', caller: { via: 'flow' } }
        )
        expect(mockBuildChatflow).not.toHaveBeenCalled()
    })

    test('public harness sessions require their token to continue the bound chat id', async () => {
        const first = await request(app).post(`/api/v1/prediction/${OPEN_ID}`).send({ question: 'hi' })
        const { chatId, sessionToken } = first.body
        expect(chatId).toMatch(/^[0-9a-f-]{36}$/)
        expect(sessionToken).toEqual(expect.any(String))
        expect(sessionToken.length).toBeGreaterThan(0)
        for (const token of [sessionToken, undefined, 'wrong-token']) {
            const res = await request(app).post(`/api/v1/prediction/${OPEN_ID}`).send({ question: 'again', chatId, sessionToken: token })
            expect(res.status).toBe(200)
            if (token === sessionToken) {
                expect(res.body.chatId).toBe(chatId)
                expect(res.body.sessionToken).toBe(sessionToken)
            } else {
                expect(res.body.chatId).not.toBe(chatId)
                expect(res.body.chatId).toMatch(/^[0-9a-f-]{36}$/)
            }
            expect(mockStartCanvasRun.mock.calls.at(-1)?.[1].chatId).toBe(res.body.chatId)
        }
    })

    test('a protected HARNESS canvas is refused before the harness run', async () => {
        const res = await request(app).post(`/api/v1/prediction/${HARNESS_ID}`).send({ question: 'hi' })
        expect(res.status).toBe(401)
        expect(res.body.message).toBe('Unauthorized')
        expect(mockStartCanvasRun).not.toHaveBeenCalled()
        expect(mockBuildChatflow).not.toHaveBeenCalled()
    })

    test('a chatflow still builds through the prediction service', async () => {
        const res = await request(app).post(`/api/v1/prediction/${CHAT_ID}`).send({ question: 'hi' })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ text: 'ok', chatId: 'chat-1' })
        expect(mockBuildChatflow).toHaveBeenCalledTimes(1)
        expect(mockStartCanvasRun).not.toHaveBeenCalled()
        expect(mockStreamingChecks).toEqual([CHAT_ID])
    })

    test('a streamed HARNESS canvas uses the same events as the in-app route', async () => {
        const first = await request(app).post(`/api/v1/prediction/${OPEN_ID}`).send({ question: 'hi' })
        const { chatId, sessionToken } = first.body
        mockStartCanvasRun.mockClear()
        const res = await request(app).post(`/api/v1/prediction/${OPEN_ID}`).send({ question: 'hi', streaming: true, chatId, sessionToken })
        expect(res.status).toBe(200)
        expect(res.headers['content-type']).toMatch(/text\/event-stream/)
        expect(res.text).toContain(`message:\ndata:${JSON.stringify({ event: 'harness.route', data: { type: 'route' } })}\n\n`)
        expect(res.text).toContain(
            `message:\ndata:${JSON.stringify({ event: 'harness.recorded', data: { run: { id: 'run-1' }, chatId, sessionToken } })}\n\n`
        )
        expect(res.text).toContain(`message:\ndata:${JSON.stringify({ event: 'end', data: {} })}\n\n`)
        expect(mockBuildChatflow).not.toHaveBeenCalled()
        const opts = mockStartCanvasRun.mock.calls[0][2] as { source: string; caller: unknown; onEvent: unknown; signal: unknown }
        expect(opts.source).toBe('playground')
        expect(mockStartCanvasRun.mock.calls[0][2].canvas).toBe('live')
        expect(opts.caller).toEqual({ via: 'flow' })
        expect(typeof opts.onEvent).toBe('function')
        expect(opts.signal).toBeInstanceOf(AbortSignal)
    })
})
