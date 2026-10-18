/**
 * Flow access: the feedback routes (GET/POST/PUT), get-upload-file and the assistants file download accept the flow's
 * API key or a session in the flow's workspace, checked on the flow that owns the feedback, message or file.
 *
 * The real routers, controllers, services, validation and feedback utils run behind supertest. The data source is an
 * in-memory stand-in whose save() upserts by primary key, as TypeORM's does. Storage reads are counted.
 */
import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { generateSecretHash } from './apiKey'

const mockState = { storageReads: [] as string[] }

jest.mock('./logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

jest.mock('@cuttlely/components', () => {
    const actual = jest.requireActual('@cuttlely/components')
    return {
        ...actual,
        streamStorageFile: async (chatflowId: string, chatId: string, fileName: string) => {
            mockState.storageReads.push(`${chatflowId}/${chatId}/${fileName}`)
            return Buffer.from(`file body of ${fileName}`)
        }
    }
})

const mockApiKeys = new Map<string, { id: string; workspaceId: string; apiSecret: string }>()
jest.mock('../services/apikey', () => ({
    __esModule: true,
    default: { getApiKeyById: jest.fn(async (id: string) => mockApiKeys.get(id) ?? null) }
}))

const mockDb = {
    chatflows: new Map<string, any>(),
    messages: new Map<string, any>(),
    feedback: new Map<string, any>(),
    nextId: 0
}
jest.mock('./getRunningExpressApp', () => {
    const tables = (name: string): Map<string, any> | undefined =>
        ((
            { ChatFlow: mockDb.chatflows, ChatMessage: mockDb.messages, ChatMessageFeedback: mockDb.feedback } as Record<
                string,
                Map<string, any>
            >
        )[name])
    return {
        getRunningExpressApp: () => ({
            AppDataSource: {
                getRepository: (entity: { name: string }) => {
                    const table = tables(entity.name)
                    return {
                        findOneBy: async ({ id }: { id: string }) => {
                            if (entity.name === 'Workspace') return { id, organizationId: 'org-1' }
                            return table?.get(id) ?? null
                        },
                        findOne: async ({ where }: { where: { id: string } }) => table?.get(where.id) ?? null,
                        find: async ({ where }: { where: Record<string, unknown> }) =>
                            [...(table?.values() ?? [])].filter((row) =>
                                Object.entries(where).every(([field, value]) => value === undefined || row[field] === value)
                            ),
                        create: (row: any) => ({ ...row }),
                        // TypeORM's save() updates the row when the entity carries an existing primary key.
                        save: async (row: any) => {
                            const id = row.id ?? `00000000-0000-4000-8000-${String(++mockDb.nextId).padStart(12, '0')}`
                            const saved = { ...(table?.get(id) ?? {}), ...row, id }
                            table?.set(id, saved)
                            return saved
                        },
                        update: async ({ id }: { id: string }, changes: any) => {
                            const row = table?.get(id)
                            if (row) table?.set(id, { ...row, ...changes })
                        }
                    }
                }
            }
        })
    }
})

// Imported after the mocks.
import feedbackRouter from '../routes/feedback'
import getUploadFileRouter from '../routes/get-upload-file'
import openaiAssistantsFileRouter from '../routes/openai-assistants-files'
import errorHandlerMiddleware from '../middlewares/errors'
import { MAX_FEEDBACK_CONTENT_LENGTH } from '../services/feedback/validation'
import {
    authorizeAssistantFileDownload,
    authorizeFeedbackCreate,
    authorizeFeedbackRead,
    authorizeFeedbackUpdate,
    authorizeUploadFileRead,
    bindUploadFileChatId
} from './authorizeFlowAccess'
import {
    configureSessionOwnershipForTests,
    createMemoryGrantStore,
    issueSessionToken,
    resetSessionOwnershipForTests
} from './sessionOwnership'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'
const K = '11111111-1111-4111-8111-111111111111'
const K2 = '22222222-2222-4222-8222-222222222222'
const F = '33333333-3333-4333-8333-333333333333'
const MISSING = '44444444-4444-4444-8444-444444444444'
const CHAT_K = '55555555-5555-4555-8555-555555555555'
const CHAT_K2 = '66666666-6666-4666-8666-666666666666'
const CHAT_F = '77777777-7777-4777-8777-777777777777'
const MSG_K1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const MSG_K2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const MSG_K2_FLOW = 'aaaaaaaa-0000-4000-8000-000000000003'
const MSG_F = 'aaaaaaaa-0000-4000-8000-000000000004'
const FB_K = 'bbbbbbbb-0000-4000-8000-000000000001'
const FB_K2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const KEY_K = 'key-for-flow-k-0123456789abcdef'
const KEY_K2 = 'key-for-flow-k2-0123456789abcdef'
const FILE_SECRET = 'feedback-file-secret'

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })
const session = (workspaceId: string) => ({ 'x-test-session-workspace': workspaceId })
// The in-app UI sends this header on every request; a cross-site form cannot.
const appSession = (workspaceId: string) => ({ ...session(workspaceId), 'x-request-from': 'internal' })
const UNAUTHORIZED = { statusCode: 401, success: false, message: 'Unauthorized', stack: {} }

// Stands in for the session-cookie middleware, as in the attachments access test (A0 confirmed the logged-in UI's cookie fills
// req.user on whitelisted routes). The JSON parser is app-level in the server too.
const app = express()
app.use(express.json())
app.use((req: Request, _res: Response, next: NextFunction) => {
    const ws = req.headers['x-test-session-workspace']
    if (typeof ws === 'string') (req as any).user = { activeWorkspaceId: ws, activeOrganizationId: 'org-1' }
    next()
})
app.use('/api/v1/feedback', feedbackRouter)
app.use('/api/v1/get-upload-file', getUploadFileRouter)
app.use('/api/v1/openai-assistants-file', openaiAssistantsFileRouter)
app.use(errorHandlerMiddleware)

const send = (req: request.Test, headers: Record<string, string> = {}) => {
    for (const [name, value] of Object.entries(headers)) req.set(name, value)
    return req
}
const getFeedback = (flowId: string, headers: Record<string, string> = {}, query = '') =>
    send(request(app).get(`/api/v1/feedback/${flowId}${query}`), headers)
const postFeedback = (path: string, body: object, headers: Record<string, string> = {}) =>
    send(request(app).post(`/api/v1/feedback${path}`), headers).send(body)
const putFeedback = (id: string, body: object, headers: Record<string, string> = {}) =>
    send(request(app).put(`/api/v1/feedback/${id}`), headers).send(body)
const getUploadFile = (query: Record<string, string>, headers: Record<string, string> = {}) =>
    send(request(app).get('/api/v1/get-upload-file').query(query), headers)
const downloadAssistantFile = (body: object, headers: Record<string, string> = {}) =>
    send(request(app).post('/api/v1/openai-assistants-file/download'), headers).send(body)

const feedbackRows = () => [...mockDb.feedback.values()].map((row) => ({ ...row }))

beforeEach(() => {
    configureSessionOwnershipForTests({ grants: createMemoryGrantStore(), secret: FILE_SECRET })
    mockState.storageReads = []
    mockApiKeys.clear()
    mockApiKeys.set('apikey-k', { id: 'apikey-k', workspaceId: WS, apiSecret: generateSecretHash(KEY_K) })
    mockApiKeys.set('apikey-k2', { id: 'apikey-k2', workspaceId: WS, apiSecret: generateSecretHash(KEY_K2) })

    mockDb.chatflows.clear()
    mockDb.chatflows.set(K, { id: K, workspaceId: WS, apikeyid: 'apikey-k' })
    mockDb.chatflows.set(K2, { id: K2, workspaceId: WS, apikeyid: 'apikey-k2' })
    mockDb.chatflows.set(F, { id: F, workspaceId: WS, apikeyid: '' })

    mockDb.messages.clear()
    mockDb.messages.set(MSG_K1, { id: MSG_K1, chatflowid: K, chatId: CHAT_K })
    mockDb.messages.set(MSG_K2, { id: MSG_K2, chatflowid: K, chatId: CHAT_K })
    mockDb.messages.set(MSG_K2_FLOW, { id: MSG_K2_FLOW, chatflowid: K2, chatId: CHAT_K2 })
    mockDb.messages.set(MSG_F, { id: MSG_F, chatflowid: F, chatId: CHAT_F })

    mockDb.feedback.clear()
    mockDb.feedback.set(FB_K, { id: FB_K, chatflowid: K, chatId: CHAT_K, messageId: MSG_K1, rating: 'THUMBS_UP', content: 'k' })
    mockDb.feedback.set(FB_K2, { id: FB_K2, chatflowid: K2, chatId: CHAT_K2, messageId: MSG_K2_FLOW, rating: 'THUMBS_UP', content: 'k2' })
})

afterAll(() => {
    resetSessionOwnershipForTests()
})

describe('Flow access: GET /api/v1/feedback/:chatflowId', () => {
    it('1: key-protected flow, no key / wrong key (another flow of the same workspace) / non-Bearer value -> 401, no rows returned', async () => {
        for (const headers of [{}, bearer(KEY_K2), { Authorization: KEY_K.slice(0, 10) }]) {
            const res = await getFeedback(K, headers)
            expect(res.status).toBe(401)
            expect(res.body).toEqual(UNAUTHORIZED)
        }
    })

    it("2: the flow's key -> 200 with that flow's rows only; a session in the flow's workspace -> 200", async () => {
        const withKey = await getFeedback(K, bearer(KEY_K))
        expect(withKey.status).toBe(200)
        expect(withKey.body.map((row: any) => row.id)).toEqual([FB_K])
        const withSession = await getFeedback(K, session(WS))
        expect(withSession.status).toBe(200)
        expect(withSession.body.map((row: any) => row.id)).toEqual([FB_K])
    })

    it('3: a session in another workspace, or a spoofed x-request-from: internal header, without a key -> 401', async () => {
        expect((await getFeedback(K, session(OTHER_WS))).status).toBe(401)
        expect((await getFeedback(K, { 'x-request-from': 'internal' })).status).toBe(401)
    })

    it('4: keyless flow, no key -> 200 (unchanged)', async () => {
        const res = await getFeedback(F)
        expect(res.status).toBe(200)
        expect(res.body).toEqual([])
    })

    it("5: 404 before 401 for an unknown flow, 400 for an invalid id, today's 412 for a missing id", async () => {
        const missing = await getFeedback(MISSING)
        expect(missing.status).toBe(404)
        expect(missing.body.message).toBe(`Chatflow ${MISSING} not found`)
        expect((await getFeedback('not-a-uuid')).status).toBe(400)
        const noId = await send(request(app).get('/api/v1/feedback/'))
        expect(noId.status).toBe(412)
        expect(noId.body.message).toBe('Error: feedbackController.getAllChatMessageFeedback - id not provided!')
    })

    it("6: cross-flow - flow K2's key on flow K -> 401; on its own flow, K's chat id returns nothing", async () => {
        expect((await getFeedback(K, bearer(KEY_K2))).status).toBe(401)
        const own = await getFeedback(K2, bearer(KEY_K2), `?chatId=${CHAT_K}`)
        expect(own.status).toBe(200)
        expect(own.body).toEqual([])
    })
})

describe('Flow access: POST /api/v1/feedback(/:id)', () => {
    const body = { chatflowid: K, chatId: CHAT_K, messageId: MSG_K2, rating: 'THUMBS_DOWN', content: 'new' }

    it('7: key-protected flow, no key / wrong key -> 401, no row written', async () => {
        const before = feedbackRows()
        for (const headers of [{}, bearer(KEY_K2)]) {
            const res = await postFeedback(`/${K}`, body, headers)
            expect(res.status).toBe(401)
            expect(res.body).toEqual(UNAUTHORIZED)
        }
        expect(feedbackRows()).toEqual(before)
    })

    it("8: the flow's key, or a session in its workspace, without the id in the path -> 200 and the row is written", async () => {
        const res = await postFeedback(`/${K}`, body, bearer(KEY_K))
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ chatflowid: K, chatId: CHAT_K, messageId: MSG_K2, rating: 'THUMBS_DOWN' })
        expect(feedbackRows()).toHaveLength(3)
        mockDb.feedback.delete(res.body.id)
        const viaSession = await postFeedback('', { messageId: MSG_K2, rating: 'THUMBS_UP' }, appSession(WS))
        expect(viaSession.status).toBe(200)
        expect(viaSession.body).toMatchObject({ chatflowid: K, chatId: CHAT_K, messageId: MSG_K2 })
    })

    it('8b: a session without x-request-from: internal -> 401 on a key-protected flow, no row written; a keyless flow still takes it', async () => {
        const before = feedbackRows()
        const res = await postFeedback('', { messageId: MSG_K2, rating: 'THUMBS_UP' }, session(WS))
        expect(res.status).toBe(401)
        expect(res.body).toEqual(UNAUTHORIZED)
        expect(feedbackRows()).toEqual(before)
        expect((await postFeedback('', { messageId: MSG_F, rating: 'THUMBS_UP' }, session(WS))).status).toBe(200)
    })

    it("9: cross-flow - access is checked on the message's flow, not on a client-named flow", async () => {
        const before = feedbackRows()
        // K2's key, naming K2 in the path and body, on a message of flow K -> 401.
        const viaPath = await postFeedback(`/${K2}`, { ...body, chatflowid: K2, chatId: undefined }, bearer(KEY_K2))
        expect(viaPath.status).toBe(401)
        // K's key on its own message, but naming K2 in the body -> the existing consistency check refuses it (400).
        const viaBody = await postFeedback(`/${K}`, { ...body, chatflowid: K2 }, bearer(KEY_K))
        expect(viaBody.status).toBe(400)
        expect(viaBody.body.message).toMatch(/^Inconsistent chatflow ID/)
        expect(feedbackRows()).toEqual(before)
    })

    it("10: a create carrying a foreign row's id makes a new row; the foreign row is unchanged (no overwrite through save())", async () => {
        const res = await postFeedback(`/${K}`, { ...body, id: FB_K2 }, bearer(KEY_K))
        expect(res.status).toBe(200)
        expect(res.body.id).not.toBe(FB_K2)
        expect(feedbackRows()).toHaveLength(3)
        expect(mockDb.feedback.get(res.body.id)).toMatchObject({ chatflowid: K, chatId: CHAT_K, messageId: MSG_K2, rating: 'THUMBS_DOWN' })
        expect(mockDb.feedback.get(FB_K2)).toEqual({
            id: FB_K2,
            chatflowid: K2,
            chatId: CHAT_K2,
            messageId: MSG_K2_FLOW,
            rating: 'THUMBS_UP',
            content: 'k2'
        })
    })

    it('11: no message id -> 400, unknown message -> 404 (before 401), keyless flow without a key -> 200', async () => {
        const noMessage = await postFeedback(`/${K}`, { rating: 'THUMBS_UP' })
        expect(noMessage.status).toBe(400)
        expect(noMessage.body.message).toBe('Message ID is required')
        const unknown = await postFeedback(`/${K}`, { messageId: MISSING, rating: 'THUMBS_UP' })
        expect(unknown.status).toBe(404)
        expect(unknown.body.message).toBe(`Message with ID ${MISSING} not found`)
        const keyless = await postFeedback(`/${F}`, { messageId: MSG_F, rating: 'THUMBS_UP' })
        expect(keyless.status).toBe(200)
        expect(keyless.body).toMatchObject({ chatflowid: F, chatId: CHAT_F })
    })
})

describe('Flow access: PUT /api/v1/feedback/:feedbackId', () => {
    it('12: key-protected flow, no key / wrong key / session in another workspace -> 401, row unchanged', async () => {
        const before = feedbackRows()
        for (const headers of [{}, bearer(KEY_K2), session(OTHER_WS)]) {
            const res = await putFeedback(FB_K, { rating: 'THUMBS_DOWN', content: 'changed' }, headers)
            expect(res.status).toBe(401)
            expect(res.body).toEqual(UNAUTHORIZED)
        }
        expect(feedbackRows()).toEqual(before)
    })

    it("13: the flow's key, or a session in its workspace -> 200 and the row changes", async () => {
        const withKey = await putFeedback(FB_K, { rating: 'THUMBS_DOWN', content: 'changed' }, bearer(KEY_K))
        expect(withKey.status).toBe(200)
        expect(mockDb.feedback.get(FB_K)).toMatchObject({ chatflowid: K, rating: 'THUMBS_DOWN', content: 'changed' })
        const withSession = await putFeedback(FB_K, { content: 'again' }, appSession(WS))
        expect(withSession.status).toBe(200)
        expect(mockDb.feedback.get(FB_K).content).toBe('again')
    })

    it('13b: a session without x-request-from: internal -> 401, row unchanged', async () => {
        const before = feedbackRows()
        const res = await putFeedback(FB_K, { content: 'forged' }, session(WS))
        expect(res.status).toBe(401)
        expect(feedbackRows()).toEqual(before)
    })

    it("14: cross-flow - naming another flow's chat or message in a PUT moves nothing (only rating and content are copied)", async () => {
        const before = feedbackRows()
        const named = await putFeedback(FB_K, { chatflowid: K2, chatId: CHAT_K2, messageId: MSG_K2_FLOW }, bearer(KEY_K))
        expect(named.status).toBe(200)
        const messageOnly = await putFeedback(FB_K, { messageId: MSG_K2_FLOW }, bearer(KEY_K))
        expect(messageOnly.status).toBe(200)
        expect(feedbackRows()).toEqual(before)
    })

    it('22: PUT copies only rating and content; id, chatflowid/chatflowId, chatId, messageId and createdDate are ignored', async () => {
        const stamp = '2020-01-01T00:00:00.000Z'
        mockDb.feedback.set(FB_K, { ...mockDb.feedback.get(FB_K), createdDate: stamp })
        const res = await putFeedback(
            FB_K,
            {
                id: FB_K2,
                chatflowid: K2,
                chatflowId: K2,
                chatId: CHAT_K2,
                messageId: MSG_K2,
                createdDate: '2030-01-01T00:00:00.000Z',
                rating: 'THUMBS_DOWN',
                content: 'only this changes'
            },
            bearer(KEY_K)
        )
        expect(res.status).toBe(200)
        expect(mockDb.feedback.get(FB_K)).toEqual({
            id: FB_K,
            chatflowid: K,
            chatId: CHAT_K,
            messageId: MSG_K1,
            createdDate: stamp,
            rating: 'THUMBS_DOWN',
            content: 'only this changes'
        })
        expect(mockDb.feedback.get(FB_K2).content).toBe('k2')
        expect(feedbackRows()).toHaveLength(2)
    })

    it('23: a bad rating or over-long content gets 400 on PUT and on create, and nothing is written', async () => {
        const before = feedbackRows()
        for (const rating of ['GREAT', 'thumbs_up', 5, null]) {
            const put = await putFeedback(FB_K, { rating }, bearer(KEY_K))
            expect(put.status).toBe(400)
            expect(put.body.message).toBe('Invalid rating: must be one of THUMBS_UP, THUMBS_DOWN')
            const post = await postFeedback(`/${K}`, { messageId: MSG_K2, rating }, bearer(KEY_K))
            expect(post.status).toBe(400)
        }
        const tooLong = 'x'.repeat(MAX_FEEDBACK_CONTENT_LENGTH + 1)
        const put = await putFeedback(FB_K, { content: tooLong }, bearer(KEY_K))
        expect(put.status).toBe(400)
        expect(put.body.message).toBe(`Invalid content: at most ${MAX_FEEDBACK_CONTENT_LENGTH} characters`)
        expect((await postFeedback(`/${K}`, { messageId: MSG_K2, rating: 'THUMBS_UP', content: tooLong }, bearer(KEY_K))).status).toBe(400)
        expect((await putFeedback(FB_K, { content: { text: 'object' } }, bearer(KEY_K))).status).toBe(400)
        expect(feedbackRows()).toEqual(before)

        // At the cap is fine.
        const atCap = 'y'.repeat(MAX_FEEDBACK_CONTENT_LENGTH)
        expect((await putFeedback(FB_K, { content: atCap }, bearer(KEY_K))).status).toBe(200)
        expect(mockDb.feedback.get(FB_K).content).toBe(atCap)
    })

    it("15: unknown feedback id -> 404 (before 401); PUT without an id keeps today's 412", async () => {
        const unknown = await putFeedback(MISSING, { rating: 'THUMBS_DOWN' })
        expect(unknown.status).toBe(404)
        expect(unknown.body.message).toBe(`Feedback with ID ${MISSING} not found`)
        const noId = await send(request(app).put('/api/v1/feedback/')).send({ rating: 'THUMBS_DOWN' })
        expect(noId.status).toBe(412)
        expect(noId.body.message).toBe('Error: feedbackController.updateChatMessageFeedbackForChatflow - id not provided!')
    })
})

describe("Flow access: get-upload-file and the assistants file download check access on the file's flow", () => {
    const fileQuery = (chatflowId: string, chatId: string) => ({ chatflowId, chatId, fileName: 'canary.txt' })

    it('16: get-upload-file - no key / wrong key / other-workspace session -> 401, storage never read', async () => {
        for (const headers of [{}, bearer(KEY_K2), session(OTHER_WS)]) {
            const res = await getUploadFile(fileQuery(K, CHAT_K), headers)
            expect(res.status).toBe(401)
            expect(res.body).toEqual(UNAUTHORIZED)
        }
        expect(mockState.storageReads).toEqual([])
    })

    it("17: get-upload-file - the flow's key, a session in its workspace, or a keyless flow -> 200 with the file when the caller owns the chat id", async () => {
        const tokenK = issueSessionToken(FILE_SECRET, 'key:apikey-k', K, CHAT_K)
        const tokenF = issueSessionToken(FILE_SECRET, `public:${F}`, F, CHAT_F)
        for (const [flow, chat, headers] of [
            [K, CHAT_K, { ...bearer(KEY_K), 'x-cuttlely-session-token': tokenK }],
            [K, CHAT_K, { ...session(WS), 'x-cuttlely-session-token': tokenK }],
            [F, CHAT_F, { 'x-cuttlely-session-token': tokenF }]
        ] as [string, string, Record<string, string>][]) {
            const res = await getUploadFile(fileQuery(flow, chat), headers)
            expect(res.status).toBe(200)
            expect(Buffer.from(res.body).toString()).toBe('file body of canary.txt')
        }
        expect(mockState.storageReads).toEqual([`${K}/${CHAT_K}/canary.txt`, `${K}/${CHAT_K}/canary.txt`, `${F}/${CHAT_F}/canary.txt`])
    })

    it('17b: a caller who can open the flow but does not own the chat id gets 403 and the file is not read', async () => {
        const res = await getUploadFile(fileQuery(K, CHAT_K), bearer(KEY_K))
        expect(res.status).toBe(403)
        expect(res.body.message).toBe('Forbidden')
        expect(mockState.storageReads).toEqual([])
    })

    it('18: get-upload-file - unknown flow 404 (before 401), path characters in the chat id 400, missing chatflowId 400', async () => {
        expect((await getUploadFile(fileQuery(MISSING, CHAT_K))).status).toBe(404)
        const traversal = await getUploadFile(fileQuery(K, '..%2F..%2Fother'), bearer(KEY_K))
        expect(traversal.status).toBe(400)
        expect(traversal.body.message).toBe('Invalid path characters detected')
        expect((await getUploadFile({ chatId: CHAT_K, fileName: 'canary.txt' })).status).toBe(400)
        expect(mockState.storageReads).toEqual([])
    })

    it('19: assistants download - no key / wrong key / other-workspace session -> 401, storage never read', async () => {
        for (const headers of [{}, bearer(KEY_K2), session(OTHER_WS)]) {
            const res = await downloadAssistantFile(fileQuery(K, CHAT_K), headers)
            expect(res.status).toBe(401)
            expect(res.body).toEqual(UNAUTHORIZED)
        }
        expect(mockState.storageReads).toEqual([])
    })

    it("20: assistants download - the flow's key, a session in its workspace, or a keyless flow -> 200; unknown flow 404", async () => {
        for (const [flow, chat, headers] of [
            [K, CHAT_K, bearer(KEY_K)],
            [K, CHAT_K, session(WS)],
            [F, CHAT_F, {}]
        ] as [string, string, Record<string, string>][]) {
            const res = await downloadAssistantFile(fileQuery(flow, chat), headers)
            expect(res.status).toBe(200)
            expect(Buffer.from(res.body).toString()).toBe('file body of canary.txt')
        }
        expect((await downloadAssistantFile(fileQuery(MISSING, CHAT_K))).status).toBe(404)
        expect(mockState.storageReads).toHaveLength(3)
    })

    it('21: order guard - each route runs its access check before the controller', () => {
        const handlers = (router: any, path: string, method: string) =>
            router.stack
                .filter(
                    (layer: any) => layer.route && ([] as string[]).concat(layer.route.path).includes(path) && layer.route.methods[method]
                )
                .flatMap((layer: any) => layer.route.stack.map((s: any) => s.handle))
        expect(handlers(feedbackRouter, '/:id', 'get')[0]).toBe(authorizeFeedbackRead)
        expect(handlers(feedbackRouter, '/:id', 'post')[0]).toBe(authorizeFeedbackCreate)
        expect(handlers(feedbackRouter, '/:id', 'put')[0]).toBe(authorizeFeedbackUpdate)
        expect(handlers(getUploadFileRouter, '/', 'get')[0]).toBe(authorizeUploadFileRead)
        expect(handlers(getUploadFileRouter, '/', 'get')[1]).toBe(bindUploadFileChatId)
        expect(handlers(openaiAssistantsFileRouter, '/download/', 'post')[0]).toBe(authorizeAssistantFileDownload)
    })
})
