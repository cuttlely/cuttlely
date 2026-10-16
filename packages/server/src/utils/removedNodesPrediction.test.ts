/**
 * A saved chatflow with a Harness node and a loose card from the removed configuration-only nodes still chats.
 *
 * The real prediction and chatflows-streaming routes, their controllers, chatflowsService.checkIfChatflowIsValidForStreaming,
 * and the graph helpers in ./index run behind supertest. The database is a map and buildChatflow is a stand-in for the model run.
 */
import express from 'express'
import request from 'supertest'

jest.setTimeout(30_000)

jest.mock('./logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

jest.mock('./index', () => {
    const multer = require('multer')
    return { ...jest.requireActual('./index'), getMulterStorage: () => multer({ storage: multer.memoryStorage() }) }
})

const mockDb = { chatflows: new Map<string, any>() }
jest.mock('./getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: (entity: { name: string }) => ({
                findOneBy: async ({ id }: { id: string }) => (entity.name === 'ChatFlow' ? mockDb.chatflows.get(id) ?? null : null)
            })
        },
        sseStreamer: { addExternalClient: jest.fn(), streamMetadataEvent: jest.fn(), streamErrorEvent: jest.fn(), removeClient: jest.fn() }
    })
}))

jest.mock('../services/chatflows', () => {
    const actual = jest.requireActual('../services/chatflows')
    const { AppError } = jest.requireActual('../errors/appError')
    return {
        __esModule: true,
        ...actual,
        default: {
            ...actual.default,
            getChatflowById: async (id: string) => {
                const flow = mockDb.chatflows.get(id)
                if (!flow) throw new AppError(404, `Chatflow ${id} not found in the database!`)
                return flow
            }
        }
    }
})

const mockBuild = { calls: 0 }
jest.mock('../services/predictions', () => ({
    __esModule: true,
    default: {
        buildChatflow: async () => {
            mockBuild.calls += 1
            return { text: 'ok', chatId: 'chat-1' }
        }
    }
}))

import predictionsRouter from '../routes/predictions'
import chatflowsStreamingRouter from '../routes/chatflows-streaming'
import errorHandlerMiddleware from '../middlewares/errors'

const WITH_REMOVED = '55555555-5555-4555-8555-555555555555'
const WITH_UNKNOWN = '66666666-6666-4666-8666-666666666666'
const CANNOT_CHAT = 'This chatflow cannot chat yet. Add a Chain, Agent, or Engine, connect the model to it, and save.'

const card = (id: string, name: string, category: string) => ({
    id,
    type: 'customNode',
    position: { x: 0, y: 0 },
    data: { id, name, label: name, category, inputs: {}, outputs: {}, inputParams: [], inputAnchors: [], outputAnchors: [] }
})

const harnessWith = (looseName: string) =>
    JSON.stringify({
        nodes: [card('harness_0', 'harness', 'Harness'), card(`${looseName}_0`, looseName, 'Analytic')],
        edges: []
    })

const app = express()
app.use(express.json())
app.use('/api/v1/prediction', predictionsRouter)
app.use('/api/v1/chatflows-streaming', chatflowsStreamingRouter)
app.use(errorHandlerMiddleware)

beforeAll(() => {
    for (const [id, loose] of [
        [WITH_REMOVED, 'langFuse'],
        [WITH_UNKNOWN, 'someTracer']
    ]) {
        mockDb.chatflows.set(id, { id, workspaceId: 'ws-1', apikeyid: '', type: 'CHATFLOW', flowData: harnessWith(loose) })
    }
})

beforeEach(() => {
    mockBuild.calls = 0
})

describe('Harness chatflow with a loose removed card', () => {
    it('GET /chatflows-streaming/:id answers 200 and does not report a missing ending node', async () => {
        const res = await request(app).get(`/api/v1/chatflows-streaming/${WITH_REMOVED}`)
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ isStreaming: expect.any(Boolean) })
    })

    it('POST /prediction/:id reaches the flow run and returns its answer', async () => {
        const res = await request(app).post(`/api/v1/prediction/${WITH_REMOVED}`).send({ question: 'hi' })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ text: 'ok', chatId: 'chat-1' })
        expect(mockBuild.calls).toBe(1)
    })

    it('a loose card that is not one of the removed nodes still blocks the chat', async () => {
        const streaming = await request(app).get(`/api/v1/chatflows-streaming/${WITH_UNKNOWN}`)
        expect(streaming.status).toBe(500)
        expect(streaming.body.message).toContain(CANNOT_CHAT)
        const prediction = await request(app).post(`/api/v1/prediction/${WITH_UNKNOWN}`).send({ question: 'hi' })
        expect(prediction.status).toBe(500)
        expect(prediction.body.message).toContain(CANNOT_CHAT)
        expect(mockBuild.calls).toBe(0)
    })
})
