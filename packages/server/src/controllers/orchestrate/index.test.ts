/**
 * HTTP contract for POST /api/v1/orchestrate/:id and /:id/chat/completions.
 * buildChatflow is mocked at the service boundary except where a test names a real helper.
 */
import express from 'express'
import http from 'http'
import { AddressInfo } from 'net'
import request from 'supertest'
import { z } from 'zod'
import { generateSecretHash } from '../../utils/apiKey'
import { MODE } from '../../Interface'

jest.setTimeout(30_000)
const REQUEST_TIMEOUT_MS = 20_000
const hangGuard = (req: request.Test) => req.timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS })

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
jest.mock('../../utils/logger', () => ({ __esModule: true, default: mockLogger }))

const mockApiKeys = new Map<string, { id: string; workspaceId: string; apiSecret: string }>()
jest.mock('../../services/apikey', () => ({
    __esModule: true,
    default: { getApiKeyById: jest.fn(async (id: string) => mockApiKeys.get(id) ?? null) }
}))

const mockDb = { chatflows: new Map<string, any>() }
const mockRedis = { subscribe: jest.fn(async () => undefined), unsubscribe: jest.fn(async () => undefined) }
const mockState: { streamer: any } = { streamer: null }

jest.mock('../../utils/getRunningExpressApp', () => {
    const { SSEStreamer } = jest.requireActual('../../utils/SSEStreamer')
    mockState.streamer = new SSEStreamer()
    return {
        getRunningExpressApp: () => ({
            AppDataSource: {
                getRepository: (entity: { name: string }) => ({
                    findOneBy: async ({ id }: { id: string }) => (entity.name === 'ChatFlow' ? mockDb.chatflows.get(id) ?? null : null)
                })
            },
            sseStreamer: mockState.streamer,
            redisSubscriber: mockRedis
        })
    }
})

jest.mock('../../services/chatflows', () => {
    const { isValidUUID } = jest.requireActual('@cuttlely/components')
    const { AppError } = jest.requireActual('../../errors/appError')
    return {
        __esModule: true,
        default: {
            getChatflowById: async (id: string) => {
                if (!isValidUUID(id)) throw new AppError(400, 'Invalid Chatflow ID')
                const flow = mockDb.chatflows.get(id)
                if (!flow) throw new AppError(404, `Chatflow ${id} not found in the database!`)
                return flow
            },
            checkIfChatflowIsValidForStreaming: async () => ({ isStreaming: true })
        }
    }
})

const mockBuildChatflow = jest.fn()
jest.mock('../../services/predictions', () => ({
    __esModule: true,
    default: { buildChatflow: (...args: unknown[]) => mockBuildChatflow(...args) }
}))

import cookieParser from 'cookie-parser'
import orchestrateRouter, { isJsonContentType, orchestrateContentTypeGuard, orchestrateJsonParser } from '../../routes/orchestrate'
import predictionsRouter from '../../routes/predictions'
import errorHandlerMiddleware from '../../middlewares/errors'
import { getClientAbortSignal } from '../../utils/clientAbort'
import { threadChatId } from '../../utils/externalThread'
import { configureSessionOwnershipForTests, createMemoryGrantStore, resetSessionOwnershipForTests } from '../../utils/sessionOwnership'
import apikeyService from '../../services/apikey'
import { RateLimiterManager } from '../../utils/rateLimit'

const WS = 'ws-1'
const SECRET = 'orchestrate-http-test-secret'
const K = '11111111-1111-4111-8111-111111111111'
const K2 = '22222222-2222-4222-8222-222222222222'
const F = '33333333-3333-4333-8333-333333333333'
const O = '44444444-4444-4444-8444-444444444444'
const M = '55555555-5555-4555-8555-555555555555'
const R = '66666666-6666-4666-8666-666666666666'
const MISSING = '77777777-7777-4777-8777-777777777777'
const KEY_K = 'key-for-flow-k-0123456789abcdef'
const KEY_K2 = 'key-for-flow-k2-0123456789abcdef'
const KEY_R = 'key-for-flow-r-0123456789abcdef'
const KEY_O = 'key-for-flow-o-0123456789abcdef'
const ALLOWED_ORIGIN = 'https://allowed.example'
const DISALLOWED_ORIGIN = 'https://other.example'
const ORIGIN_ERROR = 'This site is not allowed to call this flow'
const THREAD = 'Ada-thread-01'
const MEMORY_FLOWDATA = JSON.stringify({ nodes: [{ data: { category: 'Memory', name: 'bufferMemory' } }] })

const deltaSchema = z.object({
    id: z.string(),
    object: z.literal('thread.message.delta'),
    thread_id: z.string(),
    model: z.string(),
    created: z.number().int(),
    choices: z.array(z.object({ delta: z.object({ role: z.literal('assistant'), content: z.string() }) })).min(1)
})
const completionSchema = z.object({
    id: z.string(),
    object: z.literal('chat.completion'),
    created: z.number().int(),
    model: z.string(),
    choices: z.array(
        z.object({
            index: z.number(),
            message: z.object({ role: z.enum(['user', 'assistant']), content: z.string() }),
            finish_reason: z.string()
        })
    )
})

const messages = (turns: Array<{ role: string; content: string }>) => ({ messages: turns })
const hi = { model: 'any', messages: [{ role: 'user', content: 'Hi' }] }
const streamBody = () => ({ model: 'any', messages: [{ role: 'user', content: 'Hi' }], stream: true })

function makeApp() {
    const app = express()
    app.use('/api/v1/orchestrate', orchestrateContentTypeGuard, orchestrateJsonParser)
    app.use(express.json({ limit: '50mb' }))
    app.use(express.urlencoded({ limit: '50mb', extended: true }))
    app.use(cookieParser())
    app.use('/api/v1/orchestrate', orchestrateRouter)
    app.use('/api/v1/prediction', predictionsRouter)
    app.use(errorHandlerMiddleware)
    return app
}

const app = makeApp()

const post = (flow: string, body: object, headers: Record<string, string> = {}, path = '') => {
    const req = request(app).post(`/api/v1/orchestrate/${flow}${path}`).send(body)
    for (const [name, value] of Object.entries(headers)) req.set(name, value)
    return hangGuard(req)
}

const withKey = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${KEY_K}`, ...extra })

const expectIbmError = (res: request.Response, status: number, code: string) => {
    expect(res.status).toBe(status)
    expect(String(res.headers['content-type'] || '')).not.toMatch(/event-stream/)
    expect(res.body.error).toEqual(expect.objectContaining({ code, message: expect.any(String), type: expect.any(String) }))
}

const parseIbmFrames = (text: string) => {
    const frames: z.infer<typeof deltaSchema>[] = []
    for (const block of text.split('\n\n')) {
        if (!block.includes('thread.message.delta')) continue
        const line = block.split('\n').find((row) => row.startsWith('data:'))
        if (!line) continue
        frames.push(deltaSchema.parse(JSON.parse(line.slice(5).trim())))
    }
    return frames
}

const ibmText = (text: string) =>
    parseIbmFrames(text)
        .map((frame) => frame.choices[0].delta.content)
        .join('')

const predictionText = (text: string) => {
    const parts: string[] = []
    for (const block of text.split('\n\n')) {
        const line = block.split('\n').find((row) => row.startsWith('data:'))
        if (!line) continue
        const obj = JSON.parse(line.slice(5).trim()) as { event?: string; data?: string }
        if (obj.event === 'token') parts.push(String(obj.data ?? ''))
    }
    return parts.join('')
}

const defaultBuild = async (req: any) => {
    const chatId = req.body?.chatId
    const history = Array.isArray(req.body?.history) ? req.body.history : []
    const question = String(req.body?.question || '')
    const remembered = history.some((row: { content?: string }) => String(row.content || '').includes('Ada'))
    const text = question.includes('What is my name') && remembered ? 'Ada' : question.includes('Ada') ? 'Hello Ada' : 'Hello Ada'
    if (req.body?.streaming && chatId && mockState.streamer) {
        mockState.streamer.streamStartEvent(chatId, 'start')
        mockState.streamer.streamTokenEvent(chatId, 'Hello')
        mockState.streamer.streamTokenEvent(chatId, ' Ada')
        mockState.streamer.streamMetadataEvent(
            chatId,
            { chatId, chatMessageId: 'msg-secret', sessionToken: 'tok-secret' },
            { sessionToken: true }
        )
    }
    return { text, chatId, chatMessageId: 'msg-secret', sessionToken: 'tok-secret' }
}

const waitFor = async (fn: () => boolean, ms = 3000) => {
    const start = Date.now()
    while (!fn()) {
        if (Date.now() - start > ms) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 10))
    }
}

const streamRequest = (flow: string, body: object, headers: Record<string, string> = {}) =>
    hangGuard(
        request(app)
            .post(`/api/v1/orchestrate/${flow}`)
            .set(headers)
            .send(body)
            .buffer(true)
            .parse((res, cb) => {
                const chunks: Buffer[] = []
                res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')))
            })
    )

beforeAll(() => {
    mockApiKeys.set('apikey-k', { id: 'apikey-k', workspaceId: WS, apiSecret: generateSecretHash(KEY_K) })
    mockApiKeys.set('apikey-k2', { id: 'apikey-k2', workspaceId: WS, apiSecret: generateSecretHash(KEY_K2) })
    mockApiKeys.set('apikey-r', { id: 'apikey-r', workspaceId: WS, apiSecret: generateSecretHash(KEY_R) })
    mockApiKeys.set('apikey-o', { id: 'apikey-o', workspaceId: WS, apiSecret: generateSecretHash(KEY_O) })
    mockDb.chatflows.set(K, { id: K, workspaceId: WS, apikeyid: 'apikey-k', flowData: '{}' })
    mockDb.chatflows.set(K2, { id: K2, workspaceId: WS, apikeyid: 'apikey-k2', flowData: '{}' })
    mockDb.chatflows.set(F, { id: F, workspaceId: WS, apikeyid: '', flowData: '{}' })
    mockDb.chatflows.set(O, {
        id: O,
        workspaceId: WS,
        apikeyid: 'apikey-o',
        flowData: '{}',
        chatbotConfig: JSON.stringify({ allowedOrigins: [ALLOWED_ORIGIN], allowedOriginsError: ORIGIN_ERROR })
    })
    mockDb.chatflows.set(M, { id: M, workspaceId: WS, apikeyid: 'apikey-k', flowData: MEMORY_FLOWDATA })
    mockDb.chatflows.set(R, { id: R, workspaceId: WS, apikeyid: 'apikey-r', flowData: '{}' })
})

beforeEach(() => {
    configureSessionOwnershipForTests({ secret: SECRET, grants: createMemoryGrantStore() })
    mockBuildChatflow.mockReset()
    mockBuildChatflow.mockImplementation(defaultBuild)
    mockLogger.info.mockClear()
    mockLogger.error.mockClear()
    mockRedis.subscribe.mockClear()
    mockRedis.unsubscribe.mockClear()
    delete process.env.CUTTLELY_ORCHESTRATE_ALLOW_KEYLESS
})

afterEach(() => {
    resetSessionOwnershipForTests()
    RateLimiterManager.getInstance().removeRateLimiter(R)
})

describe('isJsonContentType', () => {
    it('compares the media type only and ignores parameters', () => {
        expect(isJsonContentType('application/json')).toBe(true)
        expect(isJsonContentType('application/json; charset=utf-8')).toBe(true)
        expect(isJsonContentType('APPLICATION/JSON; charset=UTF-8')).toBe(true)
        expect(isJsonContentType('text/plain')).toBe(false)
        expect(isJsonContentType('application/x-www-form-urlencoded')).toBe(false)
    })
})

describe('Orchestrate auth matrix', () => {
    it('keyed flow: missing, wrong, non-Bearer, and conflict; right key and equal dual headers succeed', async () => {
        expectIbmError(await post(K, hi), 401, 'unauthorized')
        expectIbmError(await post(K, hi, { Authorization: `Bearer not-the-key` }), 401, 'unauthorized')
        expectIbmError(await post(K, hi, { Authorization: KEY_K }), 401, 'unauthorized')
        expectIbmError(await post(K, hi, { Authorization: `Bearer ${KEY_K}`, 'X-API-Key': 'other' }), 400, 'credentials_conflict')
        const ok = await post(K, hi, withKey())
        expect(ok.status).toBe(200)
        expect(completionSchema.parse(ok.body).choices[0].message.content).toBe('Hello Ada')
        const dual = await post(K, hi, { Authorization: `Bearer ${KEY_K}`, 'X-API-Key': KEY_K })
        expect(dual.status).toBe(200)
        const xkey = await post(K, hi, { 'X-API-Key': KEY_K })
        expect(xkey.status).toBe(200)
    })

    it('keyless flow is 403 except header syntax, even with a key', async () => {
        expectIbmError(await post(F, hi), 403, 'keyless_flow')
        expectIbmError(await post(F, hi, withKey()), 403, 'keyless_flow')
        expectIbmError(await post(F, hi, { Authorization: 'Bearer other' }), 403, 'keyless_flow')
        expectIbmError(await post(F, hi, { Authorization: KEY_K }), 401, 'unauthorized')
        expectIbmError(await post(F, hi, { Authorization: `Bearer ${KEY_K}`, 'X-API-Key': 'other' }), 400, 'credentials_conflict')
    })

    it('lifts keyless only when the flag is set and it is not production', async () => {
        process.env.CUTTLELY_ORCHESTRATE_ALLOW_KEYLESS = 'true'
        process.env.NODE_ENV = 'test'
        expect((await post(F, hi)).status).toBe(200)
        expect((await post(F, hi, withKey())).status).toBe(200)
        expect((await post(F, hi, { Authorization: 'Bearer other' })).status).toBe(200)
        process.env.NODE_ENV = 'production'
        expectIbmError(await post(F, hi), 403, 'keyless_flow')
        process.env.NODE_ENV = 'test'
    })

    it('maps AppError statuses and a throwing key lookup, with no SSE header on a refusal', async () => {
        expectIbmError(await post('not-a-uuid', hi, withKey()), 400, 'flow_id_invalid')
        expectIbmError(await post(MISSING, hi, withKey()), 404, 'flow_not_found')
        expectIbmError(await post(K, hi, { Authorization: 'Bearer other' }), 401, 'unauthorized')
        expectIbmError(
            await post(O, streamBody(), { Authorization: `Bearer ${KEY_O}`, Origin: DISALLOWED_ORIGIN }),
            403,
            'origin_not_allowed'
        )
        ;(apikeyService.getApiKeyById as jest.Mock).mockImplementationOnce(async () => {
            throw new Error('lookup failed')
        })
        expectIbmError(await post(K, hi, withKey()), 401, 'unauthorized')
    })
})

describe('Orchestrate mapping, threads, and responses', () => {
    it('answers both paths, echoes the thread header, and never sends a session cookie or secret fields', async () => {
        const base = await post(K, hi, withKey({ 'X-IBM-THREAD-ID': THREAD }))
        const nested = await post(K, hi, withKey({ 'X-IBM-THREAD-ID': THREAD }), '/chat/completions')
        expect(base.status).toBe(200)
        expect(nested.status).toBe(200)
        expect(base.headers['x-ibm-thread-id']).toBe(THREAD)
        expect(nested.headers['x-ibm-thread-id']).toBe(THREAD)
        expect(base.headers['set-cookie']).toBeUndefined()
        expect(nested.headers['set-cookie']).toBeUndefined()
        const dumped = JSON.stringify(base.body) + JSON.stringify(nested.body)
        expect(dumped).not.toContain('tok-secret')
        expect(dumped).not.toContain('msg-secret')
        expect(dumped).not.toContain('cuttlely_session')
        const bound = threadChatId({ id: K, apikeyid: 'apikey-k' }, THREAD)
        expect(mockBuildChatflow.mock.calls[0][0].body.chatId).toBe(bound.chatId)
        expect(mockBuildChatflow.mock.calls[0][0].body.sessionToken).toBe(bound.sessionToken)
        expect(mockBuildChatflow.mock.calls[0][0].body.overrideConfig).toEqual({ sessionId: bound.chatId })
    })

    it('gives the same chat id on one thread and a fresh id when the header is missing', async () => {
        await post(K, hi, withKey({ 'X-IBM-THREAD-ID': THREAD }))
        await post(K, hi, withKey({ 'X-IBM-THREAD-ID': THREAD }))
        const a = mockBuildChatflow.mock.calls[0][0].body.chatId
        const b = mockBuildChatflow.mock.calls[1][0].body.chatId
        expect(a).toBe(b)
        await post(K, hi, withKey())
        await post(K, hi, withKey())
        const c = mockBuildChatflow.mock.calls[2][0].body.chatId
        const d = mockBuildChatflow.mock.calls[3][0].body.chatId
        expect(c).toEqual(expect.any(String))
        expect(d).toEqual(expect.any(String))
        expect(c).not.toBe(d)
        expect(c).not.toBe(a)
        expect(d).not.toBe(a)
    })

    it('gives a different chat id for another flow or another bound key', async () => {
        await post(K, hi, withKey({ 'X-IBM-THREAD-ID': THREAD }))
        await post(K2, hi, { Authorization: `Bearer ${KEY_K2}`, 'X-IBM-THREAD-ID': THREAD })
        const ids = [mockBuildChatflow.mock.calls[0][0].body.chatId, mockBuildChatflow.mock.calls[1][0].body.chatId]
        expect(new Set(ids).size).toBe(2)
    })

    it('refuses a bad or repeated thread header', async () => {
        expectIbmError(await post(K, hi, withKey({ 'X-IBM-THREAD-ID': 'has space' })), 400, 'thread_id_invalid')
        const res = await hangGuard(
            request(app)
                .post(`/api/v1/orchestrate/${K}`)
                .set('Authorization', `Bearer ${KEY_K}`)
                .set('X-IBM-THREAD-ID', [THREAD, 'other-thread'])
                .send(hi)
        )
        expectIbmError(res, 400, 'thread_id_invalid')
    })

    it('sends history without a thread and only the question when a memory flow has a thread', async () => {
        const historyBody = {
            messages: [
                { role: 'user', content: 'My name is Ada' },
                { role: 'assistant', content: 'Hello Ada' },
                { role: 'user', content: 'What is my name?' }
            ]
        }
        const noThread = await post(M, historyBody, withKey())
        expect(noThread.status).toBe(200)
        expect(mockBuildChatflow.mock.calls[0][0].body.history).toEqual([
            { role: 'userMessage', content: 'My name is Ada' },
            { role: 'apiMessage', content: 'Hello Ada' }
        ])
        expect(completionSchema.parse(noThread.body).choices[0].message.content).toBe('Ada')

        const withThread = await post(M, historyBody, withKey({ 'X-IBM-THREAD-ID': THREAD }))
        expect(withThread.status).toBe(200)
        expect(mockBuildChatflow.mock.calls[1][0].body.history).toBeUndefined()
        expect(mockBuildChatflow.mock.calls[1][0].body.question).toBe('What is my name?')
    })

    it('keeps turn 1 in a mocked memory store when the same thread is used twice', async () => {
        const store = new Map<string, string[]>()
        mockBuildChatflow.mockImplementation(async (req: any) => {
            const chatId = req.body.chatId as string
            const turns = store.get(chatId) || []
            const known = turns.some((row) => row.includes('Ada'))
            turns.push(req.body.question)
            store.set(chatId, turns)
            const text = req.body.question.includes('What is my name') && known ? 'Ada' : 'ok'
            return { text, chatId, chatMessageId: 'm1' }
        })
        const first = await post(M, messages([{ role: 'user', content: 'My name is Ada' }]), withKey({ 'X-IBM-THREAD-ID': THREAD }))
        const second = await post(M, messages([{ role: 'user', content: 'What is my name?' }]), withKey({ 'X-IBM-THREAD-ID': THREAD }))
        expect(first.status).toBe(200)
        expect(completionSchema.parse(second.body).choices[0].message.content).toBe('Ada')
        expect(mockBuildChatflow.mock.calls[0][0].body.chatId).toBe(mockBuildChatflow.mock.calls[1][0].body.chatId)
    })

    it('streams IBM frames with every required field and matches prediction token text and JSON content', async () => {
        const streamed = await hangGuard(
            request(app)
                .post(`/api/v1/orchestrate/${K}`)
                .set(withKey())
                .send(streamBody())
                .buffer(true)
                .parse((res, cb) => {
                    const chunks: Buffer[] = []
                    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                    res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')))
                })
        )
        expect(streamed.status).toBe(200)
        expect(streamed.headers['content-type']).toMatch(/text\/event-stream/)
        const ibm = String(streamed.body)
        expect(ibmText(ibm)).toBe('Hello Ada')
        for (const frame of parseIbmFrames(ibm)) expect(frame.thread_id).toBeTruthy()
        expect(ibm).not.toContain('tok-secret')
        expect(ibm).not.toContain('msg-secret')
        expect(ibm).not.toContain('event: end')

        const json = await post(K, hi, withKey())
        expect(completionSchema.parse(json.body).choices[0].message.content).toBe('Hello Ada')

        const pred = await hangGuard(
            request(app)
                .post(`/api/v1/prediction/${K}`)
                .set('Authorization', `Bearer ${KEY_K}`)
                .send({ question: 'Hi', streaming: true })
                .buffer(true)
                .parse((res, cb) => {
                    const chunks: Buffer[] = []
                    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                    res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')))
                })
        )
        expect(pred.status).toBe(200)
        expect(predictionText(String(pred.body))).toBe('Hello Ada')
    })

    it('sends one fallback frame when no token was written, and hides a mid-stream throw', async () => {
        mockBuildChatflow.mockImplementationOnce(async (req: any) => ({ text: 'plain answer', chatId: req.body.chatId }))
        const fallback = await hangGuard(
            request(app)
                .post(`/api/v1/orchestrate/${K}`)
                .set(withKey())
                .send(streamBody())
                .buffer(true)
                .parse((res, cb) => {
                    const chunks: Buffer[] = []
                    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                    res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')))
                })
        )
        expect(ibmText(String(fallback.body))).toBe('plain answer')

        mockBuildChatflow.mockImplementationOnce(async (req: any) => {
            mockState.streamer.streamTokenEvent(req.body.chatId, 'Hello')
            throw new Error('secret-raw-message-xyz')
        })
        const failed = await hangGuard(
            request(app)
                .post(`/api/v1/orchestrate/${K}`)
                .set(withKey())
                .send(streamBody())
                .buffer(true)
                .parse((res, cb) => {
                    const chunks: Buffer[] = []
                    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                    res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')))
                })
        )
        const failedText = String(failed.body)
        expect(failedText).toContain('The flow could not finish (code ')
        expect(failedText).not.toContain('secret-raw-message-xyz')
        const after = await post(K, hi, withKey({ 'X-IBM-THREAD-ID': THREAD }))
        expect(after.status).toBe(200)
    })

    it('accepts application/json with a charset parameter', async () => {
        const res = await hangGuard(
            request(app)
                .post(`/api/v1/orchestrate/${K}`)
                .set('Authorization', `Bearer ${KEY_K}`)
                .set('Content-Type', 'application/json; charset=utf-8')
                .send(JSON.stringify(hi))
        )
        expect(res.status).toBe(200)
    })

    it('tolerates a missing model field', async () => {
        const res = await post(K, messages([{ role: 'user', content: 'Hi' }]), withKey())
        expect(res.status).toBe(200)
        expect(res.body.model).toBe(`cuttlely-${K}`)
    })
})

describe('Orchestrate overlap, abort, queue, limits, and logs', () => {
    it('answers 409 for a second overlapping stream on the same thread, then 200 after the first ends', async () => {
        let release!: (value?: unknown) => void
        mockBuildChatflow.mockImplementation(defaultBuild)
        mockBuildChatflow.mockImplementationOnce(async (req: any) => {
            mockState.streamer.streamTokenEvent(req.body.chatId, 'Hello')
            await new Promise((resolve) => {
                release = resolve
            })
            return { text: 'Hello', chatId: req.body.chatId }
        })
        const bound = threadChatId({ id: K, apikeyid: 'apikey-k' }, THREAD)
        const headers = withKey({ 'X-IBM-THREAD-ID': THREAD })
        const first = streamRequest(K, streamBody(), headers)
        first.catch(() => undefined)
        try {
            await waitFor(() => mockBuildChatflow.mock.calls.length >= 1)
            const runningId = mockBuildChatflow.mock.calls[0][0].body.chatId
            expect(runningId).toBe(bound.chatId)
            await waitFor(() => mockState.streamer.hasClient(runningId))
            const second = await hangGuard(request(app).post(`/api/v1/orchestrate/${K}`).set(headers).send(streamBody()))
            expectIbmError(second, 409, 'thread_busy')
            release()
            expect((await first).status).toBe(200)
            const third = await post(K, hi, headers)
            expect(third.status).toBe(200)
        } finally {
            if (typeof release === 'function') release()
        }
    })

    it('aborts the run signal when the client disconnects and then allows the thread again', async () => {
        let sawAbort = false
        mockBuildChatflow.mockImplementation(defaultBuild)
        mockBuildChatflow.mockImplementationOnce(async (req: any) => {
            const signal = getClientAbortSignal(req)
            await new Promise((_, reject) => {
                if (signal?.aborted) {
                    sawAbort = true
                    reject(new Error('aborted'))
                    return
                }
                signal?.addEventListener('abort', () => {
                    sawAbort = true
                    reject(new Error('aborted'))
                })
            })
        })
        const bound = threadChatId({ id: K, apikeyid: 'apikey-k' }, THREAD)
        const server = http.createServer(app)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo
        const payload = JSON.stringify(streamBody())
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: `/api/v1/orchestrate/${K}`,
                agent: new http.Agent({ keepAlive: false }),
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                    authorization: `Bearer ${KEY_K}`,
                    'x-ibm-thread-id': THREAD
                }
            },
            (res) => {
                res.resume()
                res.on('error', () => undefined)
            }
        )
        req.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ECONNRESET' || err.message === 'socket hang up') return
            throw err
        })
        try {
            req.end(payload)
            await waitFor(() => mockBuildChatflow.mock.calls.length >= 1)
            expect(mockBuildChatflow.mock.calls[0][0].body.chatId).toBe(bound.chatId)
            await waitFor(() => mockState.streamer.hasClient(bound.chatId) || sawAbort)
            req.destroy()
            await waitFor(() => sawAbort)
            await waitFor(() => !mockState.streamer.hasClient(bound.chatId))
            expect(sawAbort).toBe(true)
            const again = await post(K, hi, withKey({ 'X-IBM-THREAD-ID': THREAD }))
            expect(again.status).toBe(200)
        } finally {
            req.destroy()
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
        }
    })

    it('subscribes and unsubscribes on the chat id in queue mode', async () => {
        const previous = process.env.MODE
        process.env.MODE = MODE.QUEUE
        try {
            const res = await hangGuard(
                request(app)
                    .post(`/api/v1/orchestrate/${K}`)
                    .set(withKey({ 'X-IBM-THREAD-ID': THREAD }))
                    .send(streamBody())
                    .buffer(true)
                    .parse((res, cb) => {
                        const chunks: Buffer[] = []
                        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                        res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')))
                    })
            )
            expect(res.status).toBe(200)
            const chatId = threadChatId({ id: K, apikeyid: 'apikey-k' }, THREAD).chatId
            expect(mockRedis.subscribe).toHaveBeenCalledWith(chatId)
            expect(mockRedis.unsubscribe).toHaveBeenCalledWith(chatId)
        } finally {
            process.env.MODE = previous
        }
    })

    it('answers 415 for a non-JSON body and 413 over 1 MB', async () => {
        const form = await hangGuard(
            request(app).post(`/api/v1/orchestrate/${K}`).set('Authorization', `Bearer ${KEY_K}`).type('form').send({ question: 'Hi' })
        )
        expectIbmError(form, 415, 'content_type_invalid')
        const text = await hangGuard(
            request(app)
                .post(`/api/v1/orchestrate/${K}`)
                .set('Authorization', `Bearer ${KEY_K}`)
                .set('Content-Type', 'text/plain')
                .send('Hi')
        )
        expectIbmError(text, 415, 'content_type_invalid')
        const huge = await hangGuard(
            request(app)
                .post(`/api/v1/orchestrate/${K}`)
                .set('Authorization', `Bearer ${KEY_K}`)
                .set('Content-Type', 'application/json')
                .send(`{"messages":[{"role":"user","content":"${'x'.repeat(2 * 1024 * 1024)}"}]}`)
        )
        expect(huge.status).toBe(413)
    })

    it('shares the prediction rate-limit bucket and answers 429', async () => {
        await RateLimiterManager.getInstance().addRateLimiter(R, 60, 1, 'Too many questions at once')
        const first = await hangGuard(
            request(app).post(`/api/v1/prediction/${R}`).set('Authorization', `Bearer ${KEY_R}`).send({ question: 'Hi' })
        )
        expect(first.status).toBe(200)
        const limited = await hangGuard(request(app).post(`/api/v1/orchestrate/${R}`).set('Authorization', `Bearer ${KEY_R}`).send(hi))
        expect(limited.status).toBe(429)
        expect(limited.text).toBe('Too many questions at once')
    })

    it('never logs the key or the raw thread id', async () => {
        await post(K, hi, withKey({ 'X-IBM-THREAD-ID': THREAD }))
        const lines = JSON.stringify(mockLogger.info.mock.calls)
        expect(lines).toContain('[orchestrate]')
        expect(lines).toContain(`flow=${K}`)
        expect(lines).not.toContain(KEY_K)
        expect(lines).not.toContain(THREAD)
        expect(lines).not.toContain('Authorization')
        expect(lines).not.toContain('Ada-thread')
    })
})
