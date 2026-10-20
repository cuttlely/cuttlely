/**
 * HTTP contract for GET /api/v1/a2a/:id/.well-known/agent-card.json and POST /api/v1/a2a/:id.
 * buildChatflow is mocked at the service boundary.
 */
import Ajv, { ValidateFunction } from 'ajv'
import express from 'express'
import fs from 'fs'
import http from 'http'
import { AddressInfo } from 'net'
import path from 'path'
import request from 'supertest'
import { generateSecretHash } from '../../utils/apiKey'
import { MODE } from '../../Interface'
import { A2A_RPC_CODES } from '../../services/a2a/rpc'
import { A2A_TASK_CAP_PER_FLOW, insertA2aTaskForTests, isoNow, listA2aTasksForTests, resetA2aTaskStore } from '../../services/a2a/taskStore'

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
const mockAbort = jest.fn()
const mockPublishEvent = jest.fn(async () => undefined)
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
            redisSubscriber: mockRedis,
            abortControllerPool: { abort: mockAbort },
            queueManager: { getPredictionQueueEventsProducer: () => ({ publishEvent: mockPublishEvent }) }
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

import { A2AClient } from '@a2a-js/sdk/client'
import a2aRouter, { a2aBodyErrorHandler, a2aContentTypeGuard, a2aJsonParser } from '../../routes/a2a'
import predictionsRouter from '../../routes/predictions'
import errorHandlerMiddleware from '../../middlewares/errors'
import { getClientAbortSignal } from '../../utils/clientAbort'
import { threadChatId, threadLogHash } from '../../utils/externalThread'
import { configureSessionOwnershipForTests, createMemoryGrantStore, resetSessionOwnershipForTests } from '../../utils/sessionOwnership'
import apikeyService from '../../services/apikey'
import { RateLimiterManager } from '../../utils/rateLimit'
import { a2aTaskStore } from '../../services/a2a/taskStore'

const WS = 'ws-1'
const SECRET = 'a2a-http-test-secret'
const K = '33333333-3333-4333-8333-333333333333'
const K2 = '22222222-2222-4222-8222-222222222222'
const F = '11111111-1111-4111-8111-111111111111'
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
const MEMORY_FLOWDATA = JSON.stringify({ nodes: [{ data: { category: 'Memory', name: 'bufferMemory' } }] })
const QUESTION = 'SECRET_QUESTION_XYZ'
const RAW_ERROR = 'secret-raw-message-xyz'
const FLOW_UPDATED = new Date('2026-01-02T03:04:05.000Z')

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../../services/a2a/__fixtures__/a2a-v0.3.0.json'), 'utf8'))
const ajv = new Ajv({ strict: false, allErrors: true })
const schemaId = 'https://a2a.spec/v0.3.0.json'
ajv.addSchema({ ...schema, $id: schemaId })
const compile = (def: string) => ajv.compile({ $ref: `${schemaId}#/definitions/${def}` })
const validateCard = compile('AgentCard')
const validateSend = compile('SendMessageSuccessResponse')
const validateStream = compile('SendStreamingMessageSuccessResponse')
const validateGet = compile('GetTaskSuccessResponse')
const validateCancel = compile('CancelTaskSuccessResponse')
const validateError = compile('JSONRPCErrorResponse')

const expectSchema = (fn: ValidateFunction | undefined, data: unknown) => {
    expect(fn).toBeDefined()
    const ok = fn!(data)
    if (!ok) {
        throw new Error(`schema failed: ${JSON.stringify(fn!.errors, null, 2)}\nbody: ${JSON.stringify(data)}`)
    }
}

function makeApp() {
    const app = express()
    app.set('trust proxy', 1)
    app.use('/api/v1/a2a', a2aContentTypeGuard)
    app.use('/api/v1/a2a', a2aJsonParser)
    app.use('/api/v1/a2a', a2aBodyErrorHandler)
    app.use(express.json({ limit: '50mb' }))
    app.use('/api/v1/a2a', a2aRouter)
    app.use('/api/v1/prediction', predictionsRouter)
    app.use(errorHandlerMiddleware)
    return app
}

const app = makeApp()

const userMessage = (text: string, extra: Record<string, unknown> = {}) => ({
    kind: 'message',
    messageId: 'm1',
    role: 'user',
    parts: [{ kind: 'text', text }],
    ...extra
})

const rpc = (method: string, params?: unknown, id: string | number = 1) => {
    const body: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    if (params !== undefined) body.params = params
    return body
}

const sendBody = (text: string, extra: Record<string, unknown> = {}, configuration?: unknown, metadata?: unknown) =>
    rpc('message/send', {
        message: userMessage(text, extra),
        ...(configuration !== undefined ? { configuration } : {}),
        ...(metadata !== undefined ? { metadata } : {})
    })

const streamBody = (text: string, extra: Record<string, unknown> = {}) => rpc('message/stream', { message: userMessage(text, extra) })

const post = (flow: string, body: object, headers: Record<string, string> = {}) => {
    const req = request(app).post(`/api/v1/a2a/${flow}`).send(body)
    for (const [name, value] of Object.entries(headers)) req.set(name, value)
    return hangGuard(req)
}

const getCard = (flow: string, headers: Record<string, string> = {}) => {
    const req = request(app).get(`/api/v1/a2a/${flow}/.well-known/agent-card.json`)
    for (const [name, value] of Object.entries(headers)) req.set(name, value)
    return hangGuard(req)
}

const withKey = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${KEY_K}`, ...extra })

const expectIbmError = (res: request.Response, status: number, code: string) => {
    expect(res.status).toBe(status)
    expect(String(res.headers['content-type'] || '')).not.toMatch(/event-stream/)
    expect(res.body.error).toEqual(expect.objectContaining({ code, message: expect.any(String), type: expect.any(String) }))
}

const expectRpcError = (res: request.Response, code: number, id: string | number | null = 1) => {
    expect(res.status).toBe(200)
    expectSchema(validateError, res.body)
    expect(res.body.error.code).toBe(code)
    expect(res.body.id).toBe(id)
}

const parseA2aEvents = (text: string) => {
    const events: any[] = []
    for (const block of String(text).split('\n\n')) {
        const trimmed = block.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        const line = trimmed.split('\n').find((row) => row.startsWith('data:'))
        if (!line) continue
        events.push(JSON.parse(line.slice(5).trim()))
    }
    return events
}

const assembleArtifact = (events: any[]) => {
    let text = ''
    let artifactId: string | undefined
    for (const event of events) {
        if (event.result?.kind !== 'artifact-update') continue
        const part = event.result.artifact?.parts?.[0]?.text ?? ''
        artifactId = event.result.artifact.artifactId
        text = event.result.append ? text + part : part
    }
    return { artifactId, text }
}

const streamRequest = (flow: string, body: object, headers: Record<string, string> = {}) =>
    hangGuard(
        request(app)
            .post(`/api/v1/a2a/${flow}`)
            .set(headers)
            .send(body)
            .buffer(true)
            .parse((res, cb) => {
                const chunks: Buffer[] = []
                res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')))
            })
    )

const leakMock = async (req: any) => {
    const chatId = req.body?.chatId
    if (req.body?.streaming && chatId && mockState.streamer) {
        mockState.streamer.streamStartEvent(chatId, 'start')
        mockState.streamer.streamTokenEvent(chatId, 'Hello')
        mockState.streamer.streamTokenEvent(chatId, ' Ada')
        mockState.streamer.streamThinkingEvent(chatId, 'thinking')
        mockState.streamer.streamToolEvent(chatId, { name: 'lookup' })
        mockState.streamer.streamUsedToolsEvent(chatId, [{ tool: 'lookup' }])
        mockState.streamer.streamErrorEvent(chatId, RAW_ERROR)
        mockState.streamer.streamMetadataEvent(
            chatId,
            { chatId, chatMessageId: 'msg-secret', sessionToken: 'tok-secret' },
            { sessionToken: true }
        )
    }
    return { text: 'Hello Ada', chatId, chatMessageId: 'msg-secret', sessionToken: 'tok-secret' }
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

beforeAll(() => {
    mockApiKeys.set('apikey-k', { id: 'apikey-k', workspaceId: WS, apiSecret: generateSecretHash(KEY_K) })
    mockApiKeys.set('apikey-k2', { id: 'apikey-k2', workspaceId: WS, apiSecret: generateSecretHash(KEY_K2) })
    mockApiKeys.set('apikey-r', { id: 'apikey-r', workspaceId: WS, apiSecret: generateSecretHash(KEY_R) })
    mockApiKeys.set('apikey-o', { id: 'apikey-o', workspaceId: WS, apiSecret: generateSecretHash(KEY_O) })
    mockDb.chatflows.set(K, {
        id: K,
        name: 'Bakery helper',
        workspaceId: WS,
        apikeyid: 'apikey-k',
        flowData: '{}',
        updatedDate: FLOW_UPDATED
    })
    mockDb.chatflows.set(K2, {
        id: K2,
        name: 'Other helper',
        workspaceId: WS,
        apikeyid: 'apikey-k2',
        flowData: '{}',
        updatedDate: FLOW_UPDATED
    })
    mockDb.chatflows.set(F, { id: F, name: 'Keyless', workspaceId: WS, apikeyid: '', flowData: '{}', updatedDate: FLOW_UPDATED })
    mockDb.chatflows.set(O, {
        id: O,
        name: 'Origin helper',
        workspaceId: WS,
        apikeyid: 'apikey-o',
        flowData: '{}',
        updatedDate: FLOW_UPDATED,
        chatbotConfig: JSON.stringify({ allowedOrigins: [ALLOWED_ORIGIN], allowedOriginsError: ORIGIN_ERROR })
    })
    mockDb.chatflows.set(M, {
        id: M,
        name: 'Memory helper',
        workspaceId: WS,
        apikeyid: 'apikey-k',
        flowData: MEMORY_FLOWDATA,
        updatedDate: FLOW_UPDATED
    })
    mockDb.chatflows.set(R, {
        id: R,
        name: 'Limited helper',
        workspaceId: WS,
        apikeyid: 'apikey-r',
        flowData: '{}',
        updatedDate: FLOW_UPDATED
    })
})

beforeEach(() => {
    configureSessionOwnershipForTests({ secret: SECRET, grants: createMemoryGrantStore() })
    mockBuildChatflow.mockReset()
    mockBuildChatflow.mockImplementation(defaultBuild)
    mockLogger.info.mockClear()
    mockLogger.error.mockClear()
    mockLogger.debug.mockClear()
    mockRedis.subscribe.mockClear()
    mockRedis.unsubscribe.mockClear()
    mockAbort.mockClear()
    mockPublishEvent.mockClear()
    resetA2aTaskStore()
    delete process.env.CUTTLELY_ORCHESTRATE_ALLOW_KEYLESS
    delete process.env.A2A_PUBLIC_BASE_URL
    delete process.env.DEBUG
})

afterEach(() => {
    resetSessionOwnershipForTests()
    RateLimiterManager.getInstance().removeRateLimiter(R)
    resetA2aTaskStore()
})

describe('A2A agent card', () => {
    it('returns a schema-valid card and uses A2A_PUBLIC_BASE_URL when set', async () => {
        process.env.A2A_PUBLIC_BASE_URL = 'https://tunnel.example'
        const res = await getCard(K, withKey())
        expect(res.status).toBe(200)
        expectSchema(validateCard, res.body)
        expect(res.body.url).toBe(`https://tunnel.example/api/v1/a2a/${K}`)
        expect(res.body.name).toBe('Bakery helper')
        expect(res.body.protocolVersion).toBe('0.3.0')
        expect(res.headers['set-cookie']).toBeUndefined()
    })

    it('uses Host and X-Forwarded-Proto when A2A_PUBLIC_BASE_URL is unset', async () => {
        const res = await hangGuard(
            request(app)
                .get(`/api/v1/a2a/${K}/.well-known/agent-card.json`)
                .set('Authorization', `Bearer ${KEY_K}`)
                .set('Host', 'public.example')
                .set('X-Forwarded-Proto', 'https')
        )
        expect(res.status).toBe(200)
        expectSchema(validateCard, res.body)
        expect(res.body.url).toBe(`https://public.example/api/v1/a2a/${K}`)
    })

    it('answers 200 for a card GET with no Content-Type', async () => {
        const res = await hangGuard(
            request(app).get(`/api/v1/a2a/${K}/.well-known/agent-card.json`).set('Authorization', `Bearer ${KEY_K}`)
        )
        expect(res.status).toBe(200)
        expectSchema(validateCard, res.body)
    })
})

describe('A2A message/send', () => {
    it('returns one completed Task with the answer artifact', async () => {
        const res = await post(K, sendBody('Hi', { contextId: 'Ada-thread' }), withKey())
        expect(res.status).toBe(200)
        expectSchema(validateSend, res.body)
        expect(res.body.result.kind).toBe('task')
        expect(res.body.result.status.state).toBe('completed')
        expect(res.body.result.artifacts[0].parts[0].text).toBe('Hello Ada')
        expect(res.body.result.contextId).toBe('Ada-thread')
        expect(String(res.headers['content-type'] || '')).not.toMatch(/event-stream/)
        expect(JSON.stringify(res.body)).not.toContain('tok-secret')
        expect(JSON.stringify(res.body)).not.toContain('msg-secret')
        expect(mockBuildChatflow.mock.calls[0][0].body.streaming).toBe(false)
    })

    it('returns a failed task with a safe status message and no raw error text', async () => {
        mockBuildChatflow.mockImplementationOnce(async () => {
            throw new Error(RAW_ERROR)
        })
        const res = await post(K, sendBody('Hi'), withKey())
        expect(res.status).toBe(200)
        expectSchema(validateSend, res.body)
        expect(res.body.result.status.state).toBe('failed')
        expect(res.body.result.artifacts).toBeUndefined()
        expect(res.body.result.status.message.parts[0].text).toMatch(/The flow could not finish \(code /)
        expect(JSON.stringify(res.body)).not.toContain(RAW_ERROR)
    })

    it('ignores configuration, metadata, and historyLength, and refuses pushNotificationConfig', async () => {
        const ok = await post(K, sendBody('Hi', {}, { historyLength: 9, acceptedOutputModes: ['text/plain'] }, { x: 1 }), withKey())
        expect(ok.status).toBe(200)
        expectSchema(validateSend, ok.body)
        const refused = await post(K, sendBody('Hi', {}, { pushNotificationConfig: { url: 'https://x.example' } }), withKey())
        expectRpcError(refused, A2A_RPC_CODES.pushNotSupported)
    })

    it('stores a human-input pause as failed with human_input_unsupported', async () => {
        mockBuildChatflow.mockImplementationOnce(async (req: any) => ({
            text: 'please approve',
            chatId: req.body.chatId,
            action: { type: 'approve' }
        }))
        const res = await post(K, sendBody('Hi'), withKey())
        expect(res.status).toBe(200)
        expectSchema(validateSend, res.body)
        expect(res.body.result.status.state).toBe('failed')
        expect(res.body.result.status.message.parts[0].text).toContain('human_input_unsupported')
    })
})

describe('A2A message/stream', () => {
    it('writes events in order with one artifactId and matches send for tokens', async () => {
        const streamed = await streamRequest(K, streamBody('Hi'), withKey())
        expect(streamed.status).toBe(200)
        expect(streamed.headers['content-type']).toMatch(/text\/event-stream/)
        const events = parseA2aEvents(String(streamed.body))
        expect(events.length).toBeGreaterThanOrEqual(4)
        for (const event of events) expectSchema(validateStream, event)
        expect(events[0].result.kind).toBe('task')
        expect(events[0].result.status.state).toBe('submitted')
        expect(events[1].result.kind).toBe('status-update')
        expect(events[1].result.status.state).toBe('working')
        expect(events[1].result.final).toBe(false)
        const last = events[events.length - 1]
        expect(last.result.kind).toBe('status-update')
        expect(last.result.final).toBe(true)
        expect(last.result.status.state).toBe('completed')
        const assembled = assembleArtifact(events)
        const send = await post(K, sendBody('Hi'), withKey())
        expect(assembled.text).toBe(send.body.result.artifacts[0].parts[0].text)
        expect(new Set(events.filter((e) => e.result?.kind === 'artifact-update').map((e) => e.result.artifact.artifactId)).size).toBe(1)
        expect(String(streamed.body)).not.toContain('tok-secret')
        expect(String(streamed.body)).not.toContain('msg-secret')
        expect(String(streamed.body)).not.toContain('event: end')
    })

    it('sends a single lastChunk with answerText when the flow emitted no tokens', async () => {
        mockBuildChatflow.mockImplementationOnce(async (req: any) => ({ text: 'plain answer', chatId: req.body.chatId }))
        const streamed = await streamRequest(K, streamBody('Hi'), withKey())
        const events = parseA2aEvents(String(streamed.body))
        for (const event of events) expectSchema(validateStream, event)
        const artifacts = events.filter((e) => e.result?.kind === 'artifact-update')
        expect(artifacts).toHaveLength(1)
        expect(artifacts[0].result.append).toBe(false)
        expect(artifacts[0].result.lastChunk).toBe(true)
        expect(artifacts[0].result.artifact.parts[0].text).toBe('plain answer')
        mockBuildChatflow.mockImplementationOnce(async (req: any) => ({ text: 'plain answer', chatId: req.body.chatId }))
        const send = await post(K, sendBody('Hi'), withKey())
        expect(send.body.result.artifacts[0].parts[0].text).toBe('plain answer')
    })

    it('ends a failing stream with a failed status-update and no closing artifact', async () => {
        mockBuildChatflow.mockImplementationOnce(async (req: any) => {
            mockState.streamer.streamTokenEvent(req.body.chatId, 'Hello')
            throw new Error(RAW_ERROR)
        })
        const streamed = await streamRequest(K, streamBody('Hi'), withKey())
        const events = parseA2aEvents(String(streamed.body))
        for (const event of events) expectSchema(validateStream, event)
        const last = events[events.length - 1]
        expect(last.result.status.state).toBe('failed')
        expect(last.result.final).toBe(true)
        expect(last.result.status.message.parts[0].text).toMatch(/The flow could not finish \(code /)
        expect(String(streamed.body)).not.toContain(RAW_ERROR)
        expect(events.filter((e) => e.result?.kind === 'artifact-update' && e.result.lastChunk).length).toBe(0)
    })
})

describe('A2A context isolation and continuity', () => {
    it('keeps memory on a memory flow and sends stored history on a no-memory flow', async () => {
        const ctx = { contextId: 'Ada thread' }
        const firstMem = await post(M, sendBody('My name is Ada', ctx), withKey())
        expect(firstMem.status).toBe(200)
        expect(mockBuildChatflow.mock.calls[0][0].body.history).toBeUndefined()
        const secondMem = await post(M, sendBody('What is my name?', ctx), withKey())
        expect(secondMem.status).toBe(200)
        expect(mockBuildChatflow.mock.calls[1][0].body.history).toBeUndefined()
        expect(mockBuildChatflow.mock.calls[0][0].body.chatId).toBe(mockBuildChatflow.mock.calls[1][0].body.chatId)

        const firstPlain = await post(K, sendBody('My name is Ada', ctx), withKey())
        expect(firstPlain.status).toBe(200)
        const secondPlain = await post(K, sendBody('What is my name?', ctx), withKey())
        expect(secondPlain.status).toBe(200)
        expect(mockBuildChatflow.mock.calls[3][0].body.history).toEqual([
            { role: 'userMessage', content: 'My name is Ada' },
            { role: 'apiMessage', content: 'Hello Ada' }
        ])
        expect(secondPlain.body.result.artifacts[0].parts[0].text).toBe('Ada')
    })

    it('uses threadChatId even with a foreign session header or cookie, and isolates flows and keys', async () => {
        const ctx = { contextId: 'Ada-thread-01' }
        const bound = threadChatId({ id: K, apikeyid: 'apikey-k' }, 'Ada-thread-01')
        const res = await post(
            K,
            sendBody('Hi', ctx),
            withKey({ 'x-cuttlely-session-token': 'foreign-token', Cookie: 'cuttlely_session=foreign-cookie' })
        )
        expect(res.status).toBe(200)
        expect(mockBuildChatflow.mock.calls[0][0].body.chatId).toBe(bound.chatId)
        expect(mockBuildChatflow.mock.calls[0][0].body.sessionToken).toBe(bound.sessionToken)
        expect(res.headers['set-cookie']).toBeUndefined()

        await post(K2, sendBody('Hi', ctx), { Authorization: `Bearer ${KEY_K2}` })
        expect(mockBuildChatflow.mock.calls[1][0].body.chatId).not.toBe(bound.chatId)
    })

    it('reuses context from taskId and referenceTaskIds, and refuses empty or overlong contextId', async () => {
        const created = await post(K, sendBody('Hi', { contextId: 'kept-context' }), withKey())
        const taskId = created.body.result.id
        const viaTask = await post(K, sendBody('again', { taskId }), withKey())
        expect(viaTask.body.result.contextId).toBe('kept-context')
        const viaRef = await post(K, sendBody('again', { referenceTaskIds: ['missing', taskId] }), withKey())
        expect(viaRef.body.result.contextId).toBe('kept-context')
        expectRpcError(await post(K, sendBody('Hi', { contextId: '' }), withKey()), A2A_RPC_CODES.invalidParams)
        expectRpcError(await post(K, sendBody('Hi', { contextId: 'x'.repeat(201) }), withKey()), A2A_RPC_CODES.invalidParams)
    })
})

describe('A2A abort classification, get, and cancel', () => {
    it('returns canceled when cancel wins over a late success or a rejection', async () => {
        let release!: (value?: unknown) => void
        mockBuildChatflow.mockImplementationOnce(async (req: any) => {
            await new Promise((resolve) => {
                release = resolve
            })
            return { text: 'late', chatId: req.body.chatId }
        })
        const first = streamRequest(K, streamBody('Hi', { contextId: 'cancel-ctx' }), withKey())
        first.catch(() => undefined)
        try {
            await waitFor(() => mockBuildChatflow.mock.calls.length >= 1)
            const chatId = mockBuildChatflow.mock.calls[0][0].body.chatId
            await waitFor(() => mockState.streamer.hasClient(chatId))
            const taskId = listA2aTasksForTests()[0].task.id
            const canceled = await post(K, rpc('tasks/cancel', { id: taskId }), withKey())
            expect(canceled.status).toBe(200)
            expectSchema(validateCancel, canceled.body)
            expect(canceled.body.result.status.state).toBe('canceled')
            expect(mockAbort).toHaveBeenCalledWith(`${K}_${chatId}`)
            release()
            const streamed = await first
            const events = parseA2aEvents(String(streamed.body))
            const last = events[events.length - 1]
            expect(last.result.status.state).toBe('canceled')
            expect(last.result.final).toBe(true)
            expect(events.filter((e) => e.result?.kind === 'status-update' && e.result.status.state === 'canceled')).toHaveLength(1)
            const got = await post(K, rpc('tasks/get', { id: taskId }), withKey())
            expectSchema(validateGet, got.body)
            expect(got.body.result.status.state).toBe('canceled')
            expectRpcError(await post(K, rpc('tasks/cancel', { id: taskId }), withKey()), A2A_RPC_CODES.taskNotCancelable)
        } finally {
            if (typeof release === 'function') release()
        }
    })

    it('returns canceled when cancel runs before the abort controller is registered', async () => {
        let release!: (value?: unknown) => void
        mockBuildChatflow.mockImplementationOnce(async (_req: any) => {
            await new Promise((resolve) => {
                release = resolve
            })
            throw new Error('still running')
        })
        const pending = post(K, sendBody('Hi', { contextId: 'early-cancel' }), withKey())
        pending.catch(() => undefined)
        try {
            await waitFor(() => mockBuildChatflow.mock.calls.length >= 1)
            const taskId = listA2aTasksForTests()[0].task.id
            const canceled = await post(K, rpc('tasks/cancel', { id: taskId }), withKey())
            expect(canceled.body.result.status.state).toBe('canceled')
            release()
            const send = await pending
            expect(send.body.result.status.state).toBe('canceled')
        } finally {
            if (typeof release === 'function') release()
        }
    })

    it('keeps a completed task completed and answers -32002 on a later cancel', async () => {
        const done = await post(K, sendBody('Hi'), withKey())
        expect(done.body.result.status.state).toBe('completed')
        expectRpcError(await post(K, rpc('tasks/cancel', { id: done.body.result.id }), withKey()), A2A_RPC_CODES.taskNotCancelable)
        const got = await post(K, rpc('tasks/get', { id: done.body.result.id }), withKey())
        expect(got.body.result.status.state).toBe('completed')
    })

    it('stores canceled and writes nothing when the run succeeds after the client disconnects', async () => {
        let release!: (value?: unknown) => void
        mockBuildChatflow.mockImplementationOnce(async (req: any) => {
            await new Promise((resolve) => {
                release = resolve
            })
            return { text: 'late success', chatId: req.body.chatId }
        })
        const server = http.createServer(app)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo
        const payload = JSON.stringify(sendBody('Hi', { contextId: 'drop-ctx' }))
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: `/api/v1/a2a/${K}`,
                agent: new http.Agent({ keepAlive: false }),
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                    authorization: `Bearer ${KEY_K}`
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
            const expressReq = mockBuildChatflow.mock.calls[0][0]
            req.destroy()
            await waitFor(() => Boolean(getClientAbortSignal(expressReq)?.aborted))
            release()
            await waitFor(() => listA2aTasksForTests().some((row) => row.task.status.state === 'canceled'))
            expect(listA2aTasksForTests().every((row) => row.task.status.state !== 'completed')).toBe(true)
        } finally {
            if (typeof release === 'function') release()
            req.destroy()
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
        }
    })

    it('stores canceled and writes nothing when the client disconnects and the run rejects', async () => {
        let sawAbort = false
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
        const server = http.createServer(app)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo
        const payload = JSON.stringify(streamBody('Hi', { contextId: 'abort-ctx' }))
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: `/api/v1/a2a/${K}`,
                agent: new http.Agent({ keepAlive: false }),
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                    authorization: `Bearer ${KEY_K}`
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
            req.destroy()
            await waitFor(() => sawAbort)
            await waitFor(() => listA2aTasksForTests().some((row) => row.task.status.state === 'canceled'))
        } finally {
            req.destroy()
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
        }
    })

    it('returns -32001 for an unknown task and a task from another flow or key', async () => {
        const created = await post(K, sendBody('Hi'), withKey())
        expectRpcError(await post(K, rpc('tasks/get', { id: 'missing-task' }), withKey()), A2A_RPC_CODES.taskNotFound)
        expectRpcError(
            await post(K2, rpc('tasks/get', { id: created.body.result.id }), { Authorization: `Bearer ${KEY_K2}` }),
            A2A_RPC_CODES.taskNotFound
        )
        expectRpcError(
            await post(K2, rpc('tasks/cancel', { id: created.body.result.id }), { Authorization: `Bearer ${KEY_K2}` }),
            A2A_RPC_CODES.taskNotFound
        )
    })

    it('publishes the abort event in queue mode', async () => {
        const previous = process.env.MODE
        process.env.MODE = MODE.QUEUE
        let release!: (value?: unknown) => void
        mockBuildChatflow.mockImplementationOnce(async (req: any) => {
            await new Promise((resolve) => {
                release = resolve
            })
            return { text: 'ok', chatId: req.body.chatId }
        })
        const pending = streamRequest(K, streamBody('Hi', { contextId: 'queue-ctx' }), withKey())
        pending.catch(() => undefined)
        try {
            await waitFor(() => mockBuildChatflow.mock.calls.length >= 1)
            const chatId = mockBuildChatflow.mock.calls[0][0].body.chatId
            const taskId = listA2aTasksForTests()[0].task.id
            await post(K, rpc('tasks/cancel', { id: taskId }), withKey())
            expect(mockPublishEvent).toHaveBeenCalledWith({ eventName: 'abort', id: `${K}_${chatId}` })
            release()
            await pending
            expect(mockRedis.subscribe).toHaveBeenCalledWith(chatId)
            expect(mockRedis.unsubscribe).toHaveBeenCalledWith(chatId)
        } finally {
            if (typeof release === 'function') release()
            process.env.MODE = previous
        }
    })

    it('does not leak a task when queue subscribe rejects', async () => {
        const previous = process.env.MODE
        process.env.MODE = MODE.QUEUE
        mockRedis.subscribe.mockRejectedValueOnce(new Error('redis down'))
        try {
            expectRpcError(await post(K, sendBody('Hi', { contextId: 'queue-send-fail' }), withKey()), A2A_RPC_CODES.internal)
            expect(listA2aTasksForTests()).toHaveLength(0)
            mockRedis.subscribe.mockRejectedValueOnce(new Error('redis down'))
            const streamed = await streamRequest(K, streamBody('Hi', { contextId: 'queue-stream-fail' }), withKey())
            const events = parseA2aEvents(String(streamed.body))
            expect(events.some((event) => event.result?.kind === 'status-update' && event.result.status?.state === 'failed')).toBe(true)
            expect(listA2aTasksForTests()[0].task.status.state).toBe('failed')
        } finally {
            process.env.MODE = previous
        }
    })
})

describe('A2A error codes', () => {
    it('answers HTTP 200 -32700 with a null id for malformed JSON', async () => {
        const res = await hangGuard(
            request(app).post(`/api/v1/a2a/${K}`).set('Authorization', `Bearer ${KEY_K}`).set('Content-Type', 'application/json').send('{')
        )
        expectRpcError(res, A2A_RPC_CODES.parse, null)
    })

    it('answers -32600 for a bad envelope id, including 1.5, null, true, and missing params', async () => {
        expectRpcError(
            await post(K, { jsonrpc: '2.0', id: 1.5, method: 'message/send', params: { message: userMessage('Hi') } }, withKey()),
            A2A_RPC_CODES.invalidRequest,
            null
        )
        expectRpcError(
            await post(K, { jsonrpc: '2.0', id: null, method: 'message/send', params: { message: userMessage('Hi') } }, withKey()),
            A2A_RPC_CODES.invalidRequest,
            null
        )
        expectRpcError(
            await post(K, { jsonrpc: '2.0', id: true, method: 'message/send', params: { message: userMessage('Hi') } }, withKey()),
            A2A_RPC_CODES.invalidRequest,
            null
        )
        expectRpcError(await post(K, rpc('message/send'), withKey()), A2A_RPC_CODES.invalidRequest, null)
        expectRpcError(await post(K, rpc('tasks/get'), withKey()), A2A_RPC_CODES.invalidRequest, null)
        expectRpcError(await post(K, rpc('tasks/cancel'), withKey()), A2A_RPC_CODES.invalidRequest, null)
    })

    it('answers -32602 when params is present but invalid', async () => {
        expectRpcError(await post(K, rpc('tasks/get', {}), withKey()), A2A_RPC_CODES.invalidParams)
        expectRpcError(await post(K, rpc('message/send', {}), withKey()), A2A_RPC_CODES.invalidParams)
        expectRpcError(await post(K, rpc('message/send', { message: userMessage('   ') }), withKey()), A2A_RPC_CODES.invalidParams)
    })

    it('answers the remaining JSON-RPC codes and HTTP refusals', async () => {
        expectRpcError(await post(K, rpc('nope', {}), withKey()), A2A_RPC_CODES.methodNotFound)
        expectRpcError(await post(K, rpc('tasks/resubscribe', { id: 't1' }), withKey()), A2A_RPC_CODES.unsupported)
        expectRpcError(await post(K, rpc('agent/getAuthenticatedExtendedCard', {}), withKey()), A2A_RPC_CODES.extendedCard)
        expectRpcError(await post(K, rpc('tasks/pushNotificationConfig/set', {}), withKey()), A2A_RPC_CODES.pushNotSupported)
        expectRpcError(
            await post(K, rpc('message/send', { message: { ...userMessage('Hi'), parts: [{ kind: 'file', file: {} }] } }), withKey()),
            A2A_RPC_CODES.contentType
        )
        const throwing = jest.spyOn(a2aTaskStore, 'create').mockImplementationOnce(() => {
            throw new Error('store boom')
        })
        const internal = await post(K, sendBody('Hi'), withKey())
        throwing.mockRestore()
        expectRpcError(internal, A2A_RPC_CODES.internal)

        const huge = await hangGuard(
            request(app)
                .post(`/api/v1/a2a/${K}`)
                .set('Authorization', `Bearer ${KEY_K}`)
                .set('Content-Type', 'application/json')
                .send(
                    `{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"m","role":"user","parts":[{"kind":"text","text":"${'x'.repeat(
                        2 * 1024 * 1024
                    )}"}]}}}`
                )
        )
        expect(huge.status).toBe(413)
        expect(huge.body.error.code).toBe('body_too_large')

        const plain = await hangGuard(
            request(app).post(`/api/v1/a2a/${K}`).set('Authorization', `Bearer ${KEY_K}`).set('Content-Type', 'text/plain').send('Hi')
        )
        expectIbmError(plain, 415, 'content_type_invalid')

        const charset = await hangGuard(
            request(app)
                .post(`/api/v1/a2a/${K}`)
                .set('Authorization', `Bearer ${KEY_K}`)
                .set('Content-Type', 'application/json; charset=utf-8')
                .send(JSON.stringify(sendBody('Hi')))
        )
        expect(charset.status).toBe(200)
        expectSchema(validateSend, charset.body)

        expectIbmError(await post('not-a-uuid', sendBody('Hi'), withKey()), 400, 'flow_id_invalid')
        expectIbmError(
            await post(K, sendBody('Hi'), { Authorization: `Bearer ${KEY_K}`, 'X-API-Key': 'other' }),
            400,
            'credentials_conflict'
        )
    })
})

describe('A2A auth matrix', () => {
    it('keyed flow: missing, wrong, non-Bearer, and conflict; right key and equal dual headers succeed', async () => {
        expectIbmError(await post(K, sendBody('Hi')), 401, 'unauthorized')
        expectIbmError(await post(K, sendBody('Hi'), { Authorization: 'Bearer not-the-key' }), 401, 'unauthorized')
        expectIbmError(await post(K, sendBody('Hi'), { Authorization: KEY_K }), 401, 'unauthorized')
        expectIbmError(
            await post(K, sendBody('Hi'), { Authorization: `Bearer ${KEY_K}`, 'X-API-Key': 'other' }),
            400,
            'credentials_conflict'
        )
        expect((await post(K, sendBody('Hi'), withKey())).status).toBe(200)
        expect((await post(K, sendBody('Hi'), { Authorization: `Bearer ${KEY_K}`, 'X-API-Key': KEY_K })).status).toBe(200)
        expect((await post(K, sendBody('Hi'), { 'X-API-Key': KEY_K })).status).toBe(200)
        expect((await getCard(K, { 'X-API-Key': KEY_K })).status).toBe(200)
        expectIbmError(await getCard(K), 401, 'unauthorized')
    })

    it('keyless flow is 403 except header syntax, even with a key', async () => {
        expectIbmError(await post(F, sendBody('Hi')), 403, 'keyless_flow')
        expectIbmError(await post(F, sendBody('Hi'), withKey()), 403, 'keyless_flow')
        expectIbmError(await getCard(F, withKey()), 403, 'keyless_flow')
        expectIbmError(await post(F, sendBody('Hi'), { Authorization: KEY_K }), 401, 'unauthorized')
        expectIbmError(
            await post(F, sendBody('Hi'), { Authorization: `Bearer ${KEY_K}`, 'X-API-Key': 'other' }),
            400,
            'credentials_conflict'
        )
    })

    it('lifts keyless only when the flag is set and it is not production, and stores under public:flowId', async () => {
        process.env.CUTTLELY_ORCHESTRATE_ALLOW_KEYLESS = 'true'
        process.env.NODE_ENV = 'test'
        const ok = await post(F, sendBody('Hi'), {})
        expect(ok.status).toBe(200)
        expect(listA2aTasksForTests()[0].caller).toBe(`public:${F}`)
        process.env.NODE_ENV = 'production'
        expectIbmError(await post(F, sendBody('Hi')), 403, 'keyless_flow')
        process.env.NODE_ENV = 'test'
    })

    it('maps AppError statuses and a throwing key lookup, with no Set-Cookie', async () => {
        expectIbmError(await post(MISSING, sendBody('Hi'), withKey()), 404, 'flow_not_found')
        expectIbmError(
            await post(O, sendBody('Hi'), { Authorization: `Bearer ${KEY_O}`, Origin: DISALLOWED_ORIGIN }),
            403,
            'origin_not_allowed'
        )
        ;(apikeyService.getApiKeyById as jest.Mock).mockImplementationOnce(async () => {
            throw new Error('lookup failed')
        })
        expectIbmError(await post(K, sendBody('Hi'), withKey()), 401, 'unauthorized')
        const ok = await post(K, sendBody('Hi'), withKey())
        expect(ok.headers['set-cookie']).toBeUndefined()
        const card = await getCard(K, withKey())
        expect(card.headers['set-cookie']).toBeUndefined()
    })
})

describe('A2A busy context, queue, limits, and logs', () => {
    it('answers 409 for a second overlapping send or stream on the same context', async () => {
        let release!: (value?: unknown) => void
        mockBuildChatflow.mockImplementationOnce(async (req: any) => {
            mockState.streamer.streamTokenEvent(req.body.chatId, 'Hello')
            await new Promise((resolve) => {
                release = resolve
            })
            return { text: 'Hello', chatId: req.body.chatId }
        })
        const headers = withKey()
        const first = streamRequest(K, streamBody('Hi', { contextId: 'busy-ctx' }), headers)
        first.catch(() => undefined)
        try {
            await waitFor(() => mockBuildChatflow.mock.calls.length >= 1)
            await waitFor(() => mockState.streamer.hasClient(mockBuildChatflow.mock.calls[0][0].body.chatId))
            expectIbmError(
                await hangGuard(
                    request(app)
                        .post(`/api/v1/a2a/${K}`)
                        .set(headers)
                        .send(sendBody('Hi', { contextId: 'busy-ctx' }))
                ),
                409,
                'thread_busy'
            )
            release()
            expect((await first).status).toBe(200)
            expect((await post(K, sendBody('Hi', { contextId: 'busy-ctx' }), headers)).status).toBe(200)
        } finally {
            if (typeof release === 'function') release()
        }
    })

    it('answers 503 task_store_full when 1000 non-final tasks are open', async () => {
        for (let i = 0; i < A2A_TASK_CAP_PER_FLOW; i += 1) {
            insertA2aTaskForTests({
                flowId: K,
                caller: 'key:apikey-k',
                chatId: `c${i}`,
                contextId: 'ctx',
                question: 'q',
                artifactId: `a${i}`,
                cancelRequested: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                task: { kind: 'task', id: `open-${i}`, contextId: 'ctx', status: { state: 'working', timestamp: isoNow() } }
            })
        }
        const res = await post(K, sendBody('Hi'), withKey())
        expect(res.status).toBe(503)
        expect(res.body.error).toEqual({ message: 'Too many open tasks for this flow', type: 'server_error', code: 'task_store_full' })
    })

    it('shares the prediction rate-limit bucket and answers 429', async () => {
        await RateLimiterManager.getInstance().addRateLimiter(R, 60, 1, 'Too many questions at once')
        const first = await hangGuard(
            request(app).post(`/api/v1/prediction/${R}`).set('Authorization', `Bearer ${KEY_R}`).send({ question: 'Hi' })
        )
        expect(first.status).toBe(200)
        const limited = await hangGuard(request(app).post(`/api/v1/a2a/${R}`).set('Authorization', `Bearer ${KEY_R}`).send(sendBody('Hi')))
        expect(limited.status).toBe(429)
        expect(limited.text).toBe('Too many questions at once')
    })

    it('never logs the key, question text, or raw context id', async () => {
        process.env.DEBUG = 'true'
        await post(K, sendBody(QUESTION, { contextId: 'raw-context-id' }), withKey())
        const lines = JSON.stringify([...mockLogger.info.mock.calls, ...mockLogger.debug.mock.calls, ...mockLogger.error.mock.calls])
        expect(lines).toContain('[a2a]')
        expect(lines).toContain(`flow=${K}`)
        expect(lines).toContain(`context=${threadLogHash('raw-context-id')}`)
        expect(lines).not.toContain(KEY_K)
        expect(lines).not.toContain(QUESTION)
        expect(lines).not.toContain('raw-context-id')
        expect(lines).not.toContain('Authorization')
        mockLogger.info.mockClear()
        await post(K, rpc('nope\n[a2a] forged SECRET_QUESTION_XYZ', { message: userMessage('Hi') }), withKey())
        const methodLines = JSON.stringify(mockLogger.info.mock.calls)
        expect(methodLines).toContain('method=unknown')
        expect(methodLines).not.toContain('SECRET_QUESTION_XYZ')
        expect(methodLines).not.toContain('[a2a] forged')
    })
})

describe('A2A SDK client and leak scan', () => {
    it('completes card fetch, send, and stream through A2AClient with fetchImpl', async () => {
        const server = http.createServer(app)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo
        const fetchImpl: typeof fetch = (input, init) => {
            const headers = new Headers(init?.headers)
            headers.set('X-API-Key', KEY_K)
            return fetch(input, { ...init, headers })
        }
        try {
            const client = await A2AClient.fromCardUrl(`http://127.0.0.1:${port}/api/v1/a2a/${K}/.well-known/agent-card.json`, {
                fetchImpl
            })
            const sent = await client.sendMessage({ message: userMessage('Hi') as any })
            const sendResult = 'result' in sent ? sent.result : sent
            expect((sendResult as any).kind).toBe('task')
            expect((sendResult as any).status.state).toBe('completed')
            const stream: any[] = []
            for await (const event of client.sendMessageStream({ message: userMessage('Hi') as any })) {
                stream.push(event)
            }
            expect(
                stream.some((event) => event.kind === 'task' || event.kind === 'status-update' || event.kind === 'artifact-update')
            ).toBe(true)
        } finally {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
            await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
        }
    })

    it('keeps session tokens, chatMessageId, the question, and raw errors out of SSE and JSON', async () => {
        mockBuildChatflow.mockImplementation(leakMock)
        const send = await post(K, sendBody(QUESTION, { contextId: 'ctx-1' }), withKey())
        const streamed = await streamRequest(K, streamBody(QUESTION, { contextId: 'ctx-2' }), withKey())
        const dumped = JSON.stringify(send.body) + String(streamed.body)
        expect(dumped).not.toContain('tok-secret')
        expect(dumped).not.toContain('msg-secret')
        expect(dumped).not.toContain(QUESTION)
        expect(dumped).not.toContain(RAW_ERROR)
    })
})
