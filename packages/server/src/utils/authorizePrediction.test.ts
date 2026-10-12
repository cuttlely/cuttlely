/**
 * POST /api/v1/prediction/:id checks the flow's API key before multer runs (key only, no session).
 * Test numbers follow cuttlely-api4b-prediction-upload-auth-spec.md v1.0 section 3.
 *
 * The real predictions route, controller, rate limiter, authorizeFlowAccess and error handler run behind supertest.
 * Storage spy (as in authorizeFlowAccess.test.ts): getMulterStorage() returns real multer over a counting
 * StorageEngine that writes into a temp dir; `multerRuns` counts each time multer's middleware is entered.
 * The predictions and chatflows services are stand-ins: buildChatflow repeats utilBuildChatflow's external key check
 * (`if (!isInternal) validateFlowAPIKey(req, chatflow)`, buildChatflow.ts:1048-1052) so the old route order
 * still answers 401 the way it did before this change. Tests 15-17 (origin rule, review condition) are numbered after the spec.
 */
import express, { NextFunction, Request, RequestHandler, Response } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { generateSecretHash } from './apiKey'

// Hang guard for in-process requests. Not an API latency budget. Jest's 5 s default is too short when the box is busy.
const REQUEST_TIMEOUT_MS = 20_000
jest.setTimeout(30_000)

const hangGuard = (req: request.Test) => req.timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS })

const mockState = {
    multerRuns: 0,
    multerWrites: [] as string[],
    uploadDir: '',
    controllerCalls: 0,
    sseClients: [] as string[]
}

jest.mock('./logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

jest.mock('./index', () => {
    const multer = require('multer')
    const nodeFs = require('fs')
    const nodePath = require('path')
    const storage = {
        _handleFile(_req: unknown, file: any, cb: (error: Error | null, info?: object) => void) {
            mockState.multerWrites.push(file.originalname)
            const target = nodePath.join(mockState.uploadDir, `${Date.now()}-${mockState.multerWrites.length}`)
            const out = nodeFs.createWriteStream(target)
            file.stream.pipe(out)
            out.on('error', cb)
            out.on('finish', () => cb(null, { path: target, size: out.bytesWritten }))
        },
        _removeFile(_req: unknown, file: any, cb: (error: Error | null) => void) {
            nodeFs.rm(file.path, { force: true }, cb)
        }
    }
    const counted = (inner: any) =>
        Object.defineProperty(
            function multerMiddleware(req: unknown, res: unknown, next: unknown) {
                mockState.multerRuns += 1
                return inner(req, res, next)
            },
            'name',
            { value: 'multerMiddleware' }
        )
    return {
        getMulterStorage: () => {
            const instance = multer({ storage })
            return { array: (field: string, max?: number) => counted(instance.array(field, max)) }
        }
    }
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
            streamErrorEvent: jest.fn(),
            // As the real SSEStreamer does, removing the client ends its response.
            removeClient: (chatId: string) => {
                mockSseResponses.get(chatId)?.end()
                mockSseResponses.delete(chatId)
            }
        }
    })
}))

// Same statuses and messages as chatflowsService.getChatflowById.
jest.mock('../services/chatflows', () => {
    const { isValidUUID } = jest.requireActual('@cuttlely/components')
    const { InternalFlowiseError } = jest.requireActual('../errors/internalFlowiseError')
    return {
        __esModule: true,
        default: {
            getChatflowById: async (id: string) => {
                if (!isValidUUID(id)) throw new InternalFlowiseError(400, 'Invalid Chatflow ID')
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
                mockState.controllerCalls += 1
                const chatflow = mockDb.chatflows.get(req.params.id)
                if (!(await validateFlowAPIKey(req, chatflow))) throw new InternalFlowiseError(401, 'Unauthorized')
                return { text: 'ok', chatId: req.body.chatId ?? 'chat-1', files: (req.files ?? []).map((f: any) => f.originalname) }
            }
        }
    }
})

// Imported after the mocks.
import predictionsRouter from '../routes/predictions'
import predictionsController from '../controllers/predictions'
import errorHandlerMiddleware from '../middlewares/errors'
import { getMulterStorage } from './index'
import { RateLimiterManager } from './rateLimit'
import { authorizeAttachmentUpload, authorizePrediction, hasFlowAccess } from './authorizeFlowAccess'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'
const K = '11111111-1111-4111-8111-111111111111'
const F = '33333333-3333-4333-8333-333333333333'
const R = '66666666-6666-4666-8666-666666666666'
const MISSING = '44444444-4444-4444-8444-444444444444'
const O = '77777777-7777-4777-8777-777777777777'
const FO = '88888888-8888-4888-8888-888888888888'
const ALLOWED_ORIGIN = 'https://allowed.example'
const DISALLOWED_ORIGIN = 'https://evil.example'
const ORIGIN_ERROR = 'Embed not allowed here'
const KEY_K = 'key-for-flow-k-0123456789abcdef'
const KEY_R = 'key-for-flow-r-0123456789abcdef'
const KEY_O = 'key-for-flow-o-0123456789abcdef'

let tmpRoot = ''

// Stands in for the session-cookie middleware: the test header becomes req.user.
const sessionStub = (req: Request, _res: Response, next: NextFunction) => {
    const ws = req.headers['x-test-session-workspace']
    if (typeof ws === 'string') (req as any).user = { activeWorkspaceId: ws, activeOrganizationId: 'org-1' }
    next()
}

// Mirrors the real app: JSON and urlencoded parsers run globally, before the router.
const makeApp = (router: express.Router) => {
    const app = express()
    app.use(express.json())
    app.use(express.urlencoded({ extended: true }))
    app.use(sessionStub)
    app.use('/api/v1/prediction', router)
    app.use(errorHandlerMiddleware)
    return app
}

const app = makeApp(predictionsRouter)

// The route as it was before the key check moved ahead of multer: multer, then the rate limiter, then the controller.
const oldRouter = express.Router()
oldRouter.post(
    ['/', '/:id'],
    getMulterStorage().array('files'),
    predictionsController.getRateLimiterMiddleware,
    predictionsController.createPrediction
)
const oldApp = makeApp(oldRouter)

const multipart = (flowPath: string, headers: Record<string, string> = {}, fields: Record<string, string> = {}, target = app) => {
    const req = request(target).post(`/api/v1/prediction/${flowPath}`)
    for (const [name, value] of Object.entries(headers)) req.set(name, value)
    req.field('question', 'hello')
    for (const [name, value] of Object.entries(fields)) req.field(name, value)
    return hangGuard(
        req
            .attach('files', Buffer.from('file one'), { filename: 'one.txt', contentType: 'text/plain' })
            .attach('files', Buffer.from('file two'), { filename: 'two.txt', contentType: 'text/plain' })
    )
}

const uploadDirEntries = () => fs.readdirSync(mockState.uploadDir)

const expectNoWritesAndNoMulter = () => {
    expect(mockState.multerRuns).toBe(0)
    expect(mockState.multerWrites).toEqual([])
    expect(uploadDirEntries()).toEqual([])
}

const resetCounters = () => {
    mockState.multerRuns = 0
    mockState.multerWrites = []
    mockState.controllerCalls = 0
    mockState.sseClients = []
    for (const entry of uploadDirEntries()) fs.rmSync(path.join(mockState.uploadDir, entry), { force: true })
}

beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'api4b-'))
    mockState.uploadDir = path.join(tmpRoot, 'uploads')
    fs.mkdirSync(mockState.uploadDir)

    mockApiKeys.set('apikey-k', { id: 'apikey-k', workspaceId: WS, apiSecret: generateSecretHash(KEY_K) })
    mockApiKeys.set('apikey-r', { id: 'apikey-r', workspaceId: WS, apiSecret: generateSecretHash(KEY_R) })
    mockApiKeys.set('apikey-o', { id: 'apikey-o', workspaceId: WS, apiSecret: generateSecretHash(KEY_O) })

    mockDb.chatflows.set(K, { id: K, workspaceId: WS, apikeyid: 'apikey-k' })
    mockDb.chatflows.set(F, { id: F, workspaceId: WS, apikeyid: '' })
    mockDb.chatflows.set(R, { id: R, workspaceId: WS, apikeyid: 'apikey-r' })
    // Key-protected and keyless flows that allow one embedding origin, with a custom refusal message.
    const chatbotConfig = JSON.stringify({ allowedOrigins: [ALLOWED_ORIGIN], allowedOriginsError: ORIGIN_ERROR })
    mockDb.chatflows.set(O, { id: O, workspaceId: WS, apikeyid: 'apikey-o', chatbotConfig })
    mockDb.chatflows.set(FO, { id: FO, workspaceId: WS, apikeyid: '', chatbotConfig })
})

afterAll(() => {
    RateLimiterManager.getInstance().removeRateLimiter(R)
    fs.rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(resetCounters)

describe('Prediction access: /prediction checks the flow key before multer', () => {
    it('1: key-protected flow, no key, multipart with 2 files -> 401, 0 writes, multer not invoked', async () => {
        const res = await multipart(K)
        expect(res.status).toBe(401)
        expect(res.body.message).toBe('Unauthorized')
        expectNoWritesAndNoMulter()
        expect(mockState.controllerCalls).toBe(0)
    })

    it('2: key-protected flow, wrong key -> 401, 0 writes', async () => {
        for (const value of ['Bearer not-the-key', `Bearer ${KEY_R}`, 'Bearer ', KEY_K.slice(0, 5)]) {
            const res = await multipart(K, { Authorization: value })
            expect(res.status).toBe(401)
        }
        expectNoWritesAndNoMulter()
    })

    it('3: key-protected flow, valid key (control) -> reaches the controller, both files written', async () => {
        const res = await multipart(K, { Authorization: `Bearer ${KEY_K}` })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ text: 'ok', chatId: 'chat-1', files: ['one.txt', 'two.txt'] })
        expect(mockState.multerRuns).toBe(1)
        expect(mockState.multerWrites).toEqual(['one.txt', 'two.txt'])
        expect(uploadDirEntries()).toHaveLength(2)
        expect(mockState.controllerCalls).toBe(1)
    })

    it('4: keyless flow, no key (control) -> passes as today', async () => {
        const res = await multipart(F)
        expect(res.status).toBe(200)
        expect(res.body.files).toEqual(['one.txt', 'two.txt'])
        expect(mockState.multerWrites).toEqual(['one.txt', 'two.txt'])
    })

    it("5: session cookie of a user in the flow's workspace, no key, key-protected flow -> 401, 0 writes (keyOnly)", async () => {
        const res = await multipart(K, { 'x-test-session-workspace': WS })
        expect(res.status).toBe(401)
        expectNoWritesAndNoMulter()
        expect(mockState.controllerCalls).toBe(0)
    })

    it('6: x-request-from: internal, no key, key-protected flow -> 401, 0 writes (the header is never consulted)', async () => {
        const res = await multipart(K, { 'x-request-from': 'internal' })
        expect(res.status).toBe(401)
        const withSession = await multipart(K, { 'x-request-from': 'internal', 'x-test-session-workspace': WS })
        expect(withSession.status).toBe(401)
        expectNoWritesAndNoMulter()
    })

    it('7: unknown flow id (valid UUID) -> 404, 0 writes', async () => {
        const res = await multipart(MISSING)
        expect(res.status).toBe(404)
        expectNoWritesAndNoMulter()
    })

    it('8: invalid id (not-a-uuid, ..%2Fx) -> 400, 0 writes', async () => {
        for (const id of ['not-a-uuid', '..%2Fx']) {
            const res = await multipart(id)
            expect(res.status).toBe(400)
        }
        expectNoWritesAndNoMulter()
    })

    it("9: missing id, POST /api/v1/prediction/ -> 412 with today's message, 0 writes", async () => {
        const res = await multipart('')
        expect(res.status).toBe(412)
        expect(res.body.message).toBe('Error: predictionsController.createPrediction - id not provided!')
        expectNoWritesAndNoMulter()
    })

    it('10: rate limit exceeded, request with files -> 429, 0 writes', async () => {
        await RateLimiterManager.getInstance().addRateLimiter(R, 60, 1, 'Too many requests, slow down')
        const first = await multipart(R, { Authorization: `Bearer ${KEY_R}` })
        expect(first.status).toBe(200)
        resetCounters()
        const limited = await multipart(R, { Authorization: `Bearer ${KEY_R}` })
        expect(limited.status).toBe(429)
        expect(limited.text).toBe('Too many requests, slow down')
        expectNoWritesAndNoMulter()
        const limitedNoKey = await multipart(R)
        expect(limitedNoKey.status).toBe(429)
        expectNoWritesAndNoMulter()
        expect(mockState.controllerCalls).toBe(0)
    })

    it('11: streaming: true, no key -> 401 JSON before any SSE header; no SSE client registered', async () => {
        const json = await hangGuard(request(app).post(`/api/v1/prediction/${K}`).send({ question: 'hi', streaming: true }))
        expect(json.status).toBe(401)
        expect(json.headers['content-type']).toMatch(/application\/json/)
        expect(json.headers['content-type']).not.toMatch(/text\/event-stream/)
        expect(json.body).toEqual({ statusCode: 401, success: false, message: 'Unauthorized', stack: {} })

        const multi = await multipart(K, {}, { streaming: 'true' })
        expect(multi.status).toBe(401)
        expect(multi.headers['content-type']).toMatch(/application\/json/)
        expect(mockState.sseClients).toEqual([])
        expectNoWritesAndNoMulter()

        // Control: with the key the same request opens the event stream.
        const ok = await hangGuard(
            request(app)
                .post(`/api/v1/prediction/${K}`)
                .set('Authorization', `Bearer ${KEY_K}`)
                .send({ question: 'hi', streaming: true, chatId: 'c-11' })
        )
        expect(ok.status).toBe(200)
        expect(ok.headers['content-type']).toMatch(/text\/event-stream/)
        expect(mockState.sseClients).toHaveLength(1)
        expect(mockState.sseClients[0]).not.toBe('c-11')
    })

    it('12: JSON (non-multipart) prediction: valid key unchanged; no key -> 401 with the same body as before the change', async () => {
        const body = { question: 'hi' }
        const okNew = await request(app).post(`/api/v1/prediction/${K}`).set('Authorization', `Bearer ${KEY_K}`).send(body)
        const okOld = await request(oldApp).post(`/api/v1/prediction/${K}`).set('Authorization', `Bearer ${KEY_K}`).send(body)
        expect(okNew.status).toBe(200)
        expect(okNew.status).toBe(okOld.status)
        expect(okNew.body).toEqual(okOld.body)
        expect(okNew.body).toEqual({ text: 'ok', chatId: 'chat-1', files: [] })

        const deniedNew = await request(app).post(`/api/v1/prediction/${K}`).send(body)
        const deniedOld = await request(oldApp).post(`/api/v1/prediction/${K}`).send(body)
        expect(deniedNew.status).toBe(401)
        expect(deniedOld.status).toBe(401)
        expect(deniedNew.body).toEqual(deniedOld.body)
        expect(deniedNew.body).toEqual({ statusCode: 401, success: false, message: 'Unauthorized', stack: {} })
    })

    it('13: order guard - POST / and POST /:id run rate limiter -> authorizePrediction -> multer -> createPrediction', () => {
        const layers = (predictionsRouter as any).stack.filter((layer: any) => layer.route?.methods?.post)
        expect(layers).toHaveLength(1)
        const route = layers[0].route
        expect(route.path).toEqual(['/', '/:id'])
        const handlers: RequestHandler[] = route.stack.map((layer: any) => layer.handle)
        expect(handlers).toHaveLength(4)
        expect(handlers[0]).toBe(predictionsController.getRateLimiterMiddleware)
        expect(handlers[1]).toBe(authorizePrediction)
        expect(handlers[2].name).toBe('multerMiddleware')
        expect(handlers[3]).toBe(predictionsController.createPrediction)
    })

    it('14: default mode is unchanged - hasFlowAccess and authorizeAttachmentUpload still accept a session; keyOnly does not', async () => {
        const flow = mockDb.chatflows.get(K)
        const req = (headers: Record<string, string> = {}, user?: object) => ({ headers, user, body: {} } as unknown as Request)
        expect(await hasFlowAccess(req({}, { activeWorkspaceId: WS }), flow)).toBe(true)
        expect(await hasFlowAccess(req({}, { activeWorkspaceId: WS }), flow, { keyOnly: true })).toBe(false)
        expect(await hasFlowAccess(req({}, { activeWorkspaceId: OTHER_WS }), flow)).toBe(false)
        expect(await hasFlowAccess(req({ authorization: `Bearer ${KEY_K}` }), flow, { keyOnly: true })).toBe(true)
        expect(await hasFlowAccess(req({ 'x-request-from': 'internal' }), flow, { keyOnly: true })).toBe(false)
        expect(await hasFlowAccess(req(), mockDb.chatflows.get(F), { keyOnly: true })).toBe(true)

        const attachments = express()
        attachments.use(sessionStub)
        attachments.post('/attachments/:chatflowId/:chatId', authorizeAttachmentUpload, (_req: Request, res: Response) =>
            res.json({ id: res.locals.chatflow.id })
        )
        attachments.use(errorHandlerMiddleware)
        const chat = '55555555-5555-4555-8555-555555555555'
        expect((await request(attachments).post(`/attachments/${K}/${chat}`).set('x-test-session-workspace', WS)).body).toEqual({ id: K })
        expect((await request(attachments).post(`/attachments/${K}/${chat}`)).status).toBe(401)
    })

    it('15: allowed origins - valid key from a disallowed Origin -> 403 with the flow message, 0 writes, controller not reached', async () => {
        const res = await multipart(O, { Authorization: `Bearer ${KEY_O}`, Origin: DISALLOWED_ORIGIN })
        expect(res.status).toBe(403)
        expect(res.body).toEqual({ statusCode: 403, success: false, message: ORIGIN_ERROR, stack: {} })
        expectNoWritesAndNoMulter()
        expect(mockState.controllerCalls).toBe(0)

        // Keyless flow: the key check passes, the origin rule still refuses before multer.
        const keyless = await multipart(FO, { Origin: DISALLOWED_ORIGIN })
        expect(keyless.status).toBe(403)
        expect(keyless.body.message).toBe(ORIGIN_ERROR)
        expectNoWritesAndNoMulter()

        // JSON body: same status and body as the older route, where the controller refused it.
        const jsonNew = await request(app)
            .post(`/api/v1/prediction/${O}`)
            .set('Authorization', `Bearer ${KEY_O}`)
            .set('Origin', DISALLOWED_ORIGIN)
            .send({ question: 'hi' })
        const jsonOld = await request(oldApp)
            .post(`/api/v1/prediction/${O}`)
            .set('Authorization', `Bearer ${KEY_O}`)
            .set('Origin', DISALLOWED_ORIGIN)
            .send({ question: 'hi' })
        expect(jsonNew.status).toBe(403)
        expect(jsonNew.body).toEqual(jsonOld.body)
        expect(jsonOld.status).toBe(403)

        // Streaming JSON body: plain-text 403 as the controller sends it; no event stream, no SSE client.
        const stream = await hangGuard(
            request(app)
                .post(`/api/v1/prediction/${O}`)
                .set('Authorization', `Bearer ${KEY_O}`)
                .set('Origin', DISALLOWED_ORIGIN)
                .send({ question: 'hi', streaming: true, chatId: 'c-15' })
        )
        expect(stream.status).toBe(403)
        expect(stream.text).toBe(ORIGIN_ERROR)
        expect(stream.headers['content-type']).not.toMatch(/text\/event-stream/)
        expect(mockState.sseClients).toEqual([])
    })

    it('16: allowed origins - no key or a wrong key from a disallowed Origin -> 401 (the key decides first), 0 writes', async () => {
        const attempts: Record<string, string>[] = [
            { Origin: DISALLOWED_ORIGIN },
            { Origin: DISALLOWED_ORIGIN, Authorization: `Bearer ${KEY_K}` }
        ]
        for (const headers of attempts) {
            const res = await multipart(O, headers)
            expect(res.status).toBe(401)
            expect(res.body.message).toBe('Unauthorized')
        }
        expectNoWritesAndNoMulter()
        expect(mockState.controllerCalls).toBe(0)

        // In the older route the controller checked the origin first, so the same keyless request got 403.
        const old = await request(oldApp).post(`/api/v1/prediction/${O}`).set('Origin', DISALLOWED_ORIGIN).send({ question: 'hi' })
        expect(old.status).toBe(403)
    })

    it('17: allowed origins - valid key from the allowed Origin, or with no Origin header -> 200, both files written', async () => {
        const res = await multipart(O, { Authorization: `Bearer ${KEY_O}`, Origin: ALLOWED_ORIGIN })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ text: 'ok', chatId: 'chat-1', files: ['one.txt', 'two.txt'] })
        expect(mockState.multerWrites).toEqual(['one.txt', 'two.txt'])
        expect(mockState.controllerCalls).toBe(1)

        resetCounters()
        const noOrigin = await multipart(O, { Authorization: `Bearer ${KEY_O}` })
        expect(noOrigin.status).toBe(200)
        expect(mockState.multerWrites).toEqual(['one.txt', 'two.txt'])
    })

    it('18: multipart streaming: true, valid key, disallowed Origin -> JSON 403 before any SSE header, 0 writes', async () => {
        const res = await multipart(
            O,
            { Authorization: `Bearer ${KEY_O}`, Origin: DISALLOWED_ORIGIN },
            { streaming: 'true', chatId: 'c-18' }
        )
        expect(res.status).toBe(403)
        expect(res.headers['content-type']).toMatch(/application\/json/)
        expect(res.body).toEqual({ statusCode: 403, success: false, message: ORIGIN_ERROR, stack: {} })
        expect(mockState.sseClients).toEqual([])
        expectNoWritesAndNoMulter()
        expect(mockState.controllerCalls).toBe(0)
    })
})
