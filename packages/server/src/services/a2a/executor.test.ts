jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

const mockRedis = { subscribe: jest.fn(async () => undefined), unsubscribe: jest.fn(async () => undefined) }
const mockRemoveClient = jest.fn()
const mockBuildChatflow = jest.fn(async (req?: { body?: { chatId?: string } }) => ({ text: 'ok', chatId: req?.body?.chatId }))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        sseStreamer: {
            tryAddExternalClient: () => true,
            removeClient: mockRemoveClient
        },
        redisSubscriber: mockRedis,
        abortControllerPool: { abort: jest.fn() },
        queueManager: { getPredictionQueueEventsProducer: () => ({ publishEvent: jest.fn() }) }
    })
}))

jest.mock('../../services/predictions', () => ({
    __esModule: true,
    default: { buildChatflow: (req?: { body?: { chatId?: string } }) => mockBuildChatflow(req) }
}))

jest.mock('../../utils/sessionOwnership', () => ({
    bindRequestSession: () => ({ chatId: 'chat-1', sessionId: 'chat-1', sessionToken: 'tok-1', rebound: false })
}))

jest.mock('../../utils/externalThread', () => ({
    threadChatId: () => ({ chatId: 'chat-1', sessionToken: 'tok-1' }),
    threadLogHash: () => 'abcd1234'
}))

jest.mock('../../utils/clientAbort', () => ({
    watchClientDisconnect: () => ({ aborted: false }),
    onAbort: () => () => undefined
}))

import { Request, Response } from 'express'
import { AppError } from '../../errors/appError'
import { classifyOutcome, emptyA2aLog, executeMessage, isHumanInputResult, resolveContext } from './executor'
import { a2aTaskStore, isoNow, listA2aTasksForTests, resetA2aTaskStore } from './taskStore'

const mockReq = (): Request =>
    ({
        headers: {},
        body: {},
        on: () => undefined
    } as unknown as Request)

const mockRes = (headersSent = false): Response & { body?: unknown; write: jest.Mock } => {
    const res: Record<string, unknown> = {
        headersSent,
        writableEnded: false,
        destroyed: false,
        locals: {},
        body: undefined
    }
    res.setHeader = jest.fn()
    res.removeHeader = jest.fn()
    res.flushHeaders = jest.fn(() => {
        res.headersSent = true
    })
    res.write = jest.fn(() => {
        res.headersSent = true
        return true
    })
    res.end = jest.fn(() => {
        res.writableEnded = true
    })
    res.cookie = jest.fn(() => res)
    res.status = jest.fn(() => res)
    res.json = jest.fn((body: unknown) => {
        res.headersSent = true
        res.body = body
        return res
    })
    res.once = jest.fn()
    res.on = jest.fn()
    return res as unknown as Response & { body?: unknown; write: jest.Mock }
}

const messageParams = { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'Hi' }] } }

describe('A2A executor helpers', () => {
    const previousMode = process.env.MODE

    beforeEach(() => {
        resetA2aTaskStore()
        mockRedis.subscribe.mockReset()
        mockRedis.subscribe.mockResolvedValue(undefined)
        mockRedis.unsubscribe.mockReset()
        mockRedis.unsubscribe.mockResolvedValue(undefined)
        mockRemoveClient.mockReset()
        mockBuildChatflow.mockReset()
        mockBuildChatflow.mockImplementation(async (req?: { body?: { chatId?: string } }) => ({ text: 'ok', chatId: req?.body?.chatId }))
        if (previousMode === undefined) delete process.env.MODE
        else process.env.MODE = previousMode
    })

    afterAll(() => {
        if (previousMode === undefined) delete process.env.MODE
        else process.env.MODE = previousMode
    })

    it('detects a human-input pause from waitingForApproval, not a bare action field', () => {
        expect(isHumanInputResult({ text: 'hi', action: {} })).toBe(false)
        expect(isHumanInputResult({ text: 'hi', action: { type: 'approve' } })).toBe(true)
        expect(isHumanInputResult({ text: 'hi' })).toBe(false)
    })

    it('resolves context from contextId, then taskId, then referenceTaskIds, then a new id', () => {
        const flow = { id: 'f', apikeyid: 'k' }
        const stored = a2aTaskStore.create({ flowId: 'f', caller: 'key:k', chatId: 'c', contextId: 'from-task', question: 'q' })
        expect(resolveContext({ flow, caller: 'key:k', parsed: { question: 'q', contextId: 'direct' } }).ctxSrc).toBe('context')
        expect(resolveContext({ flow, caller: 'key:k', parsed: { question: 'q', taskId: stored.task.id } })).toEqual({
            contextId: 'from-task',
            ctxSrc: 'task'
        })
        expect(
            resolveContext({
                flow,
                caller: 'key:k',
                parsed: { question: 'q', referenceTaskIds: ['missing', stored.task.id] }
            })
        ).toEqual({ contextId: 'from-task', ctxSrc: 'ref' })
        expect(resolveContext({ flow, caller: 'key:k', parsed: { question: 'q' } }).ctxSrc).toBe('new')
    })

    it('classifies cancel, disconnect, failure, and success in that order', () => {
        const row = a2aTaskStore.create({ flowId: 'f', caller: 'key:k', chatId: 'c', contextId: 'ctx', question: 'q' })
        row.cancelRequested = true
        expect(classifyOutcome({ row, result: { text: 'late' } }).kind).toBe('canceled')
        row.cancelRequested = false
        const aborted = { aborted: true } as AbortSignal
        expect(classifyOutcome({ row, signal: aborted, result: { text: 'late' } }).kind).toBe('disconnected')
        expect(classifyOutcome({ row, error: new AppError(500, 'secret-raw') }).kind).toBe('failed')
        expect(classifyOutcome({ row, result: { text: 'Hello', action: { type: 'approve' } } })).toEqual({
            kind: 'failed',
            text: 'This flow needs human input, which this endpoint does not support (code human_input_unsupported).'
        })
        expect(classifyOutcome({ row, result: { text: 'Hello' } })).toEqual({ kind: 'completed', text: 'Hello' })
        expect(isoNow(0)).toBe('1970-01-01T00:00:00.000Z')
    })

    it('finalizes a send task as failed when queue subscribe rejects, including from finally', async () => {
        process.env.MODE = 'queue'
        mockRedis.subscribe.mockRejectedValueOnce(new Error('redis down'))
        const res = mockRes(false)
        await expect(
            executeMessage({
                req: mockReq(),
                res,
                chatflow: { id: 'flow-1', apikeyid: 'k', flowData: '{}' },
                rpcId: 1,
                params: messageParams,
                stream: false,
                log: emptyA2aLog()
            })
        ).rejects.toThrow('redis down')
        expect(mockBuildChatflow).not.toHaveBeenCalled()
        expect(listA2aTasksForTests()).toHaveLength(1)
        expect(listA2aTasksForTests()[0].task.status.state).toBe('failed')
        expect(listA2aTasksForTests()[0].task.status.message?.parts[0].text).toMatch(/The flow could not finish/)
    })

    it('finalizes a stream task as failed when queue subscribe rejects', async () => {
        process.env.MODE = 'queue'
        mockRedis.subscribe.mockRejectedValueOnce(new Error('redis down'))
        const res = mockRes(false)
        await executeMessage({
            req: mockReq(),
            res,
            chatflow: { id: 'flow-1', apikeyid: 'k', flowData: '{}' },
            rpcId: 1,
            params: messageParams,
            stream: true,
            log: emptyA2aLog()
        })
        expect(mockBuildChatflow).not.toHaveBeenCalled()
        expect(listA2aTasksForTests()).toHaveLength(1)
        expect(listA2aTasksForTests()[0].task.status.state).toBe('failed')
        expect(res.write).toHaveBeenCalled()
    })
})

describe('completedWithLinks', () => {
    const { completedWithLinks } = jest.requireActual('./executor')
    const utf8 = (s: string) => Buffer.byteLength(s)
    const { makeArtifactLinker } = jest.requireActual('../orchestrate/fileLinks')
    const { setFileLinkSecretForTests } = jest.requireActual('../../utils/fileLinkSignature')
    const ctx = { baseURL: 'https://navi.example', orgId: 'org-1', chatflowId: 'flow-1', chatId: 'chat-1', ttlSeconds: 3600 }
    const result = { artifacts: [{ type: 'pdf', data: 'FILE-STORAGE::deck.pdf' }] }
    beforeEach(() => setFileLinkSecretForTests('a2a-links-secret'))
    afterEach(() => setFileLinkSecretForTests(undefined))

    it('keeps the links whole when a long answer is cut to the task text limit', () => {
        const out = completedWithLinks('x'.repeat(5000), result, makeArtifactLinker(ctx), false, '', 1024)
        expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(1024)
        expect(out.text).toMatch(
            /\[truncated\]\n\n\[Download deck\.pdf\]\(https:\/\/navi\.example\/api\/v1\/get-upload-file\?[^)]+signature=[^)]+\)$/
        )
        expect(out.tail).toBeUndefined()
    })

    it('sends held text and unsent links as the tail of a streamed run, and drops attachment: links', () => {
        const linker = makeArtifactLinker(ctx)
        const out = completedWithLinks('Done ![d](attachment:d.pdf)', result, linker, true, 'held')
        expect(out.text).toMatch(/^Done\n\n\[Download deck\.pdf\]/)
        expect(out.tail).toMatch(/^held\n\n\[Download deck\.pdf\]/)
    })

    it('uses the room a short answer leaves, beyond half the limit, and keeps later links that fit', () => {
        const linker = makeArtifactLinker(ctx)
        const many = {
            artifacts: [
                { type: 'pdf', data: 'FILE-STORAGE::deck.pdf' },
                { type: 'pdf', data: 'FILE-STORAGE::' + 'r'.repeat(200) + '.pdf' }
            ]
        }
        const one = utf8(completedWithLinks('', { artifacts: [many.artifacts[0]] }, makeArtifactLinker(ctx), false, '', 100000).text)
        const limit = one + 10
        expect(one).toBeGreaterThan(limit / 2)
        const out = completedWithLinks('Done', many, linker, false, '', limit)
        expect(out.text).toMatch(/^Done\n\n\[Download deck\.pdf\]/)
        expect(utf8(out.text)).toBeLessThanOrEqual(limit)
    })

    it('links files from streamed artifacts frames in the tail and the stored answer', () => {
        const linker = makeArtifactLinker(ctx)
        linker.collect([{ type: 'png', data: 'FILE-STORAGE::chart.png' }])
        const out = completedWithLinks('Done', result, linker, true, '')
        expect(out.tail).toMatch(/^\n\n!\[Image: chart\.png\]\([^)]+\)\n\n\[Download deck\.pdf\]/)
        expect(out.text).toMatch(/^Done\n\n!\[Image: chart\.png\][^\n]+\n\n\[Download deck\.pdf\]/)
    })
})
