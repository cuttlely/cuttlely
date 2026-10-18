/**
 * Client abort: a client that disconnects from a streaming prediction, through the API or an in-app internal
 * prediction, stops upstream generation.
 *
 * The counting fake chat model below behaves like a provider SDK: it produces up to 650 tokens, one every 2 ms, and
 * stops only when the `signal` in its call options aborts (as the OpenAI SDK cancels its HTTP request). It counts
 * every token produced after the abort. Flowise chatflow nodes call their chains without a signal, so on `main` the
 * model never gets one and runs to the end. The bar is 50 or fewer tokens after the abort. On an idle event loop the
 * run also stops within 2 s. A loaded box stretches each 2 ms token timer, so the wall-clock check adds that overrun
 * once (and, for a socket disconnect, a fixed slack). The token cap does not move.
 */
import express, { Request } from 'express'
import http from 'http'
import { AddressInfo } from 'net'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, BaseMessage } from '@langchain/core/messages'
import { ChatResult } from '@langchain/core/outputs'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import { StringOutputParser } from '@langchain/core/output_parsers'
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'
import { getClientAbortSignal, onAbort, runWithAbortSignal, watchClientDisconnect } from './clientAbort'

const TOTAL_TOKENS = 650
const TOKEN_INTERVAL_MS = 2
const MAX_TOKENS_AFTER_ABORT = 50
const MAX_STOP_MS = 2000
// Socket close is not a token timer. This slack is only for that delivery, and it stays far below a 650-token run on a busy loop.
const DISCONNECT_SLACK_MS = 8000

// The control cases emit 650 tokens on 2 ms timers. Jest's 5 s default fires before that finishes when the box is busy.
jest.setTimeout(30_000)

class CountingFakeChatModel extends BaseChatModel {
    produced = 0
    producedAfterAbort = 0
    abortedAt: number | undefined
    stoppedAt: number | undefined
    maxTimerOverrunMs = 0

    _llmType() {
        return 'counting-fake'
    }

    async _generate(
        _messages: BaseMessage[],
        options: this['ParsedCallOptions'],
        runManager?: CallbackManagerForLLMRun
    ): Promise<ChatResult> {
        const signal = options.signal
        signal?.addEventListener('abort', () => (this.abortedAt = Date.now()), { once: true })
        let text = ''
        try {
            for (let i = 0; i < TOTAL_TOKENS; i += 1) {
                // Like a provider SDK: the request is cancelled only through the signal it was given.
                if (signal?.aborted) throw new Error('AbortError: request aborted')
                const waitStarted = Date.now()
                await new Promise((resolve) => setTimeout(resolve, TOKEN_INTERVAL_MS))
                this.maxTimerOverrunMs = Math.max(this.maxTimerOverrunMs, Date.now() - waitStarted - TOKEN_INTERVAL_MS)
                this.produced += 1
                if (this.abortedAt !== undefined) this.producedAfterAbort += 1
                text += `t${i} `
                await runManager?.handleLLMNewToken(`t${i} `)
            }
        } finally {
            this.stoppedAt = Date.now()
        }
        return { generations: [{ text, message: new AIMessage(text) }] }
    }
}

/** How a chatflow node runs its chain: `invoke` with callbacks only, no signal. */
const runLikeAFlowiseNode = (model: CountingFakeChatModel, onToken: (token: string) => void) => {
    const chain = ChatPromptTemplate.fromMessages([['human', '{question}']])
        .pipe(model)
        .pipe(new StringOutputParser())
    return chain.invoke({ question: 'hi' }, { callbacks: [{ handleLLMNewToken: (token: string) => onToken(token) }] })
}

/** 2 s on an idle loop, plus the slowest 2 ms timer this model already waited. A missed abort still fails the token cap. */
const stopLimit = (model: CountingFakeChatModel) => MAX_STOP_MS + model.maxTimerOverrunMs

describe('Client abort: runWithAbortSignal reaches the chat model inside a node', () => {
    it('1: control (main) - a node chain run without the implicit signal ignores the abort and produces all 650 tokens', async () => {
        const model = new CountingFakeChatModel({})
        const controller = new AbortController()
        let tokens = 0
        const run = runLikeAFlowiseNode(model, () => {
            tokens += 1
            if (tokens === 3) controller.abort()
        })
        await run
        expect(controller.signal.aborted).toBe(true)
        expect(model.produced).toBe(TOTAL_TOKENS)
        expect(model.abortedAt).toBeUndefined() // the model never saw the signal
    })

    it('2: with runWithAbortSignal, an abort after 3 tokens stops the model within 2 s and at most 50 more tokens', async () => {
        const model = new CountingFakeChatModel({})
        const controller = new AbortController()
        let tokens = 0
        let abortedAt = 0
        const run = runWithAbortSignal(controller.signal, () =>
            runLikeAFlowiseNode(model, () => {
                tokens += 1
                if (tokens === 3) {
                    abortedAt = Date.now()
                    controller.abort()
                }
            })
        )
        await expect(run).rejects.toThrow(/abort/i)
        expect(model.produced).toBeLessThan(TOTAL_TOKENS)
        expect(model.producedAfterAbort).toBeLessThanOrEqual(MAX_TOKENS_AFTER_ABORT)
        expect(model.stoppedAt! - abortedAt).toBeLessThan(stopLimit(model))
    })

    it('3: a direct model.invoke inside the run (no chain) also gets the signal', async () => {
        const model = new CountingFakeChatModel({})
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 20)
        await expect(runWithAbortSignal(controller.signal, () => model.invoke('hi'))).rejects.toThrow(/abort/i)
        expect(model.produced).toBeLessThan(TOTAL_TOKENS)
        expect(model.producedAfterAbort).toBeLessThanOrEqual(MAX_TOKENS_AFTER_ABORT)
    })

    it('4: a signal the node passes itself wins (agentflow nodes pass their own)', async () => {
        const model = new CountingFakeChatModel({})
        const implicit = new AbortController()
        const own = new AbortController()
        setTimeout(() => own.abort(), 20)
        await expect(runWithAbortSignal(implicit.signal, () => model.invoke('hi', { signal: own.signal }))).rejects.toThrow(/abort/i)
        expect(implicit.signal.aborted).toBe(false)
        expect(model.producedAfterAbort).toBeLessThanOrEqual(MAX_TOKENS_AFTER_ABORT)
    })

    it('5: no signal -> the run is unchanged and completes', async () => {
        const model = new CountingFakeChatModel({})
        const text = await runWithAbortSignal(undefined, () => runLikeAFlowiseNode(model, () => undefined))
        expect(model.produced).toBe(TOTAL_TOKENS)
        expect(text).toContain('t649')
    })
})

describe('Client abort: client disconnect signal', () => {
    it('6: onAbort fires once (right away for an already-aborted signal); its cleanup stops a later abort', () => {
        const calls: string[] = []
        const a = new AbortController()
        onAbort(a.signal, () => calls.push('a'))
        a.abort()
        a.abort()
        const b = new AbortController()
        b.abort()
        onAbort(b.signal, () => calls.push('b'))
        const c = new AbortController()
        const stop = onAbort(c.signal, () => calls.push('c'))
        stop()
        c.abort()
        onAbort(undefined, () => calls.push('none'))()
        expect(calls).toEqual(['a', 'b'])
    })
})

/**
 * The real predictions controller streaming branch with a stand-in buildChatflow that does what utilBuildChatflow
 * does with the signal: link it to the run's own AbortController and run the node chain under runWithAbortSignal.
 */
describe('Client abort: streaming prediction, client disconnects after 3 tokens', () => {
    const state = {
        model: undefined as CountingFakeChatModel | undefined,
        runError: undefined as unknown,
        runSettled: undefined as Promise<void> | undefined,
        removedWhileRunning: false,
        running: false,
        clientAbortSeen: false
    }
    const responses = new Map<string, any>()

    beforeAll(() => {
        jest.resetModules()
    })

    const buildApp = () => {
        jest.doMock('./logger', () => ({
            __esModule: true,
            default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
        }))
        jest.doMock('./getRunningExpressApp', () => ({
            getRunningExpressApp: () => ({
                sseStreamer: {
                    addExternalClient: (chatId: string, res: any) => responses.set(chatId, res),
                    streamTokenEvent: (chatId: string, token: string) =>
                        responses.get(chatId)?.write(`message:\ndata:${JSON.stringify({ event: 'token', data: token })}\n\n`),
                    streamMetadataEvent: jest.fn(),
                    streamErrorEvent: jest.fn(),
                    removeClient: (chatId: string) => {
                        if (state.running) state.removedWhileRunning = true
                        responses.get(chatId)?.end()
                        responses.delete(chatId)
                    }
                }
            })
        }))
        jest.doMock('../services/chatflows', () => ({
            __esModule: true,
            default: {
                getChatflowById: async (id: string) => ({ id, workspaceId: 'ws-1', apikeyid: '' }),
                checkIfChatflowIsValidForStreaming: async () => ({ isStreaming: true })
            }
        }))
        jest.doMock('../services/predictions', () => ({
            __esModule: true,
            default: {
                buildChatflow: async (req: Request) => {
                    const clientAbort = jest.requireActual('./clientAbort')
                    const { getRunningExpressApp } = require('./getRunningExpressApp')
                    const sse = getRunningExpressApp().sseStreamer
                    const run = new AbortController()
                    const stop = clientAbort.onAbort(clientAbort.getClientAbortSignal(req), () => {
                        state.clientAbortSeen = true
                        run.abort()
                    })
                    const model = new CountingFakeChatModel({})
                    state.model = model
                    state.running = true
                    let settle: () => void = () => undefined
                    state.runSettled = new Promise((resolve) => (settle = resolve))
                    try {
                        await clientAbort.runWithAbortSignal(run.signal, () =>
                            runLikeAFlowiseNode(model, (token) => sse.streamTokenEvent(req.body.chatId, token))
                        )
                        return { chatId: req.body.chatId, text: 'done' }
                    } catch (error) {
                        state.runError = error
                        throw error
                    } finally {
                        state.running = false
                        stop()
                        settle()
                    }
                }
            }
        }))
        const predictionsController = require('../controllers/predictions').default
        const app = express()
        app.use(express.json())
        app.post('/api/v1/prediction/:id', predictionsController.createPrediction)
        app.use(require('../middlewares/errors').default)
        return app
    }

    it('7: the run stops within 2 s plus load slack, with at most 50 tokens after the disconnect; the SSE writer is removed while the run is still going', async () => {
        const app = buildApp()
        const server = http.createServer(app)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo
        try {
            let disconnectedAt = 0
            await new Promise<void>((resolve, reject) => {
                const req = http.request(
                    {
                        host: '127.0.0.1',
                        port,
                        method: 'POST',
                        path: '/api/v1/prediction/11111111-1111-4111-8111-111111111111',
                        headers: { 'content-type': 'application/json' }
                    },
                    (res) => {
                        expect(res.headers['content-type']).toMatch(/text\/event-stream/)
                        let tokens = 0
                        res.on('data', (chunk: Buffer) => {
                            tokens += (chunk.toString().match(/"event":"token"/g) || []).length
                            if (tokens >= 3 && !disconnectedAt) {
                                disconnectedAt = Date.now()
                                req.destroy()
                                resolve()
                            }
                        })
                        res.on('error', () => undefined)
                    }
                )
                req.on('error', (error: NodeJS.ErrnoException) => {
                    if (!disconnectedAt) reject(error)
                })
                req.end(JSON.stringify({ question: 'hi', streaming: true, chatId: 'c-7' }))
            })
            let guard: NodeJS.Timeout | undefined
            const settled = await Promise.race([
                state.runSettled!.then(() => true),
                new Promise<boolean>((resolve) => {
                    guard = setTimeout(() => resolve(false), 20_000)
                })
            ])
            clearTimeout(guard)
            expect(settled).toBe(true)
            const model = state.model!
            expect(state.clientAbortSeen).toBe(true)
            expect(String(state.runError)).toMatch(/abort/i)
            expect(model.produced).toBeLessThan(TOTAL_TOKENS)
            expect(model.producedAfterAbort).toBeLessThanOrEqual(MAX_TOKENS_AFTER_ABORT)
            expect(model.stoppedAt! - disconnectedAt).toBeLessThan(stopLimit(model) + DISCONNECT_SLACK_MS)
            expect(state.removedWhileRunning).toBe(true)
            expect(responses.size).toBe(0)
        } finally {
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        }
    })

    it('8: a stream that finishes normally never aborts its run', async () => {
        const res = new (require('events').EventEmitter)() as any
        res.locals = {}
        res.writableFinished = true
        const signal = watchClientDisconnect(res)
        expect(getClientAbortSignal({ res } as Request)).toBe(signal)
        expect(watchClientDisconnect(res)).toBe(signal)
        res.emit('close')
        expect(signal.aborted).toBe(false)

        const cut = new (require('events').EventEmitter)() as any
        cut.locals = {}
        cut.writableFinished = false
        const cutSignal = watchClientDisconnect(cut)
        cut.emit('close')
        expect(cutSignal.aborted).toBe(true)
    })
})

/**
 * In-app chat posts to /internal-prediction. That controller did not watch the response, so a disconnect
 * left the run's AbortController alone and the model ran to 650 tokens. Same bar as the public API.
 */
describe('Client abort: internal streaming prediction, client disconnects after 3 tokens', () => {
    const state = {
        model: undefined as CountingFakeChatModel | undefined,
        runError: undefined as unknown,
        runSettled: undefined as Promise<void> | undefined,
        removedWhileRunning: false,
        running: false,
        clientAbortSeen: false
    }
    const responses = new Map<string, any>()

    const buildApp = () => {
        jest.resetModules()
        jest.doMock('./logger', () => ({
            __esModule: true,
            default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
        }))
        jest.doMock('./getRunningExpressApp', () => ({
            getRunningExpressApp: () => ({
                sseStreamer: {
                    addClient: (chatId: string, res: any) => responses.set(chatId, res),
                    streamTokenEvent: (chatId: string, token: string) =>
                        responses.get(chatId)?.write(`message:\ndata:${JSON.stringify({ event: 'token', data: token })}\n\n`),
                    streamMetadataEvent: jest.fn(),
                    streamErrorEvent: jest.fn(),
                    removeClient: (chatId: string) => {
                        if (state.running) state.removedWhileRunning = true
                        responses.get(chatId)?.end()
                        responses.delete(chatId)
                    }
                }
            })
        }))
        jest.doMock('../Interface', () => ({
            MODE: { QUEUE: 'queue', MAIN: 'main' }
        }))
        jest.doMock('../services/chatflows', () => ({
            __esModule: true,
            default: {
                getChatflowByIdForWorkspace: async (id: string) => ({ id, workspaceId: 'ws-1' })
            }
        }))
        jest.doMock('./sessionOwnership', () => ({
            bindRequestSession: (req: Request) => {
                if (!req.body.chatId) req.body.chatId = 'c-owned'
                return { chatId: req.body.chatId, sessionId: req.body.chatId, sessionToken: 'tok', rebound: false }
            }
        }))
        jest.doMock('./buildChatflow', () => ({
            utilBuildChatflow: async (req: Request) => {
                const clientAbort = jest.requireActual('./clientAbort')
                const { getRunningExpressApp } = require('./getRunningExpressApp')
                const sse = getRunningExpressApp().sseStreamer
                const run = new AbortController()
                const stop = clientAbort.onAbort(clientAbort.getClientAbortSignal(req), () => {
                    state.clientAbortSeen = true
                    run.abort()
                })
                const model = new CountingFakeChatModel({})
                state.model = model
                state.running = true
                let settle: () => void = () => undefined
                state.runSettled = new Promise((resolve) => (settle = resolve))
                try {
                    await clientAbort.runWithAbortSignal(run.signal, () =>
                        runLikeAFlowiseNode(model, (token) => sse.streamTokenEvent(req.body.chatId, token))
                    )
                    return { chatId: req.body.chatId, text: 'done' }
                } catch (error) {
                    state.runError = error
                    throw error
                } finally {
                    state.running = false
                    stop()
                    settle()
                }
            }
        }))
        const internalController = require('../controllers/internal-predictions').default
        const app = express()
        app.use(express.json())
        // The in-app chat is a signed-in person; the controller refuses a caller without a user id as an API key.
        app.use((req: any, _res: any, next: any) => {
            req.user = { id: 'user-1' }
            next()
        })
        app.post('/api/v1/internal-prediction/:id', internalController.createInternalPrediction)
        app.use(require('../middlewares/errors').default)
        return app
    }

    it('9: a disconnect stops the in-app stream within 2 s plus load slack and at most 50 tokens after the abort', async () => {
        const app = buildApp()
        const server = http.createServer(app)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo
        try {
            let disconnectedAt = 0
            await new Promise<void>((resolve, reject) => {
                const req = http.request(
                    {
                        host: '127.0.0.1',
                        port,
                        method: 'POST',
                        path: '/api/v1/internal-prediction/11111111-1111-4111-8111-111111111111',
                        headers: { 'content-type': 'application/json', 'x-request-from': 'internal' }
                    },
                    (res) => {
                        expect(res.headers['content-type']).toMatch(/text\/event-stream/)
                        let tokens = 0
                        res.on('data', (chunk: Buffer) => {
                            tokens += (chunk.toString().match(/"event":"token"/g) || []).length
                            if (tokens >= 3 && !disconnectedAt) {
                                disconnectedAt = Date.now()
                                req.destroy()
                                resolve()
                            }
                        })
                        res.on('error', () => undefined)
                    }
                )
                req.on('error', (error: NodeJS.ErrnoException) => {
                    if (!disconnectedAt) reject(error)
                })
                req.end(JSON.stringify({ question: 'hi', streaming: true, chatId: 'c-9' }))
            })
            let guard: NodeJS.Timeout | undefined
            const settled = await Promise.race([
                state.runSettled!.then(() => true),
                new Promise<boolean>((resolve) => {
                    guard = setTimeout(() => resolve(false), 20_000)
                })
            ])
            clearTimeout(guard)
            expect(settled).toBe(true)
            const model = state.model!
            expect(state.clientAbortSeen).toBe(true)
            expect(String(state.runError)).toMatch(/abort/i)
            expect(model.produced).toBeLessThan(TOTAL_TOKENS)
            expect(model.producedAfterAbort).toBeLessThanOrEqual(MAX_TOKENS_AFTER_ABORT)
            expect(model.stoppedAt! - disconnectedAt).toBeLessThan(stopLimit(model) + DISCONNECT_SLACK_MS)
            expect(state.removedWhileRunning).toBe(true)
            expect(responses.size).toBe(0)
        } finally {
            server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        }
    })
})
