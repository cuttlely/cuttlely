import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import controller from './index'
import service, { setHarnessModuleLoader } from '../../services/harnesses'

jest.mock('../../utils/runtimeAvailability', () => ({ assertRuntimeAvailable: jest.fn() }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../metrics/tracing', () => ({ openHarnessRunTrace: () => ({ event: jest.fn(), finish: jest.fn(), fail: jest.fn() }) }))
jest.mock('../../services/usage', () => ({ recordCompletedRun: jest.fn() }))
jest.mock('../../utils/nestedFlowCall', () => ({ nestedFlowCallerFromHarness: () => undefined }))

// Node 24 can load the real ESM runner outside Jest's CommonJS transformer.
const nativeRequire = process.getBuiltinModule('module').createRequire(__filename)
const runtimeEnv = process.getBuiltinModule('process').env
const realStartRun = service.startRun
const name = 'disconnect-fixture'
let dir: string
let engine: any
let history: any
let sessions: any
let lock: any
const envKeys = ['HOME', 'DATABASE_PATH', 'CUTTLELY_DATA_DIR', 'CUTTLELY_HERMES_HOME'] as const
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
const previousRuntimeEnv = Object.fromEntries(envKeys.map((key) => [key, runtimeEnv[key]]))

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-client-disconnect-'))
    for (const key of envKeys) {
        process.env[key] = runtimeEnv[key] = key === 'CUTTLELY_HERMES_HOME' ? path.join(dir, 'runtime') : dir
    }
    engine = nativeRequire('../../../../harness/run.mjs')
    history = nativeRequire('../../../../harness/history.mjs')
    sessions = nativeRequire('../../../../harness/session.mjs')
    lock = nativeRequire('../../../../harness/lock.mjs')
    nativeRequire('../../../../harness/store.mjs').saveHarness({
        name,
        workspaceId: 'team-a',
        chief: { model: { nodeName: 'fixtureChat', inputs: { modelName: 'chief-model' } } },
        specialists: [{ name: 'worker' }]
    })
})

afterEach(() => {
    jest.restoreAllMocks()
    setHarnessModuleLoader(null)
})

afterAll(() => {
    sessions?.closeSessions()
    lock?.closeQueueDb()
    fs.rmSync(dir, { recursive: true, force: true })
    for (const key of envKeys) {
        if (previousEnv[key] === undefined) delete process.env[key]
        else process.env[key] = previousEnv[key]
        if (previousRuntimeEnv[key] === undefined) delete runtimeEnv[key]
        else runtimeEnv[key] = previousRuntimeEnv[key]
    }
})

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => (resolve = done))
    return { promise, resolve }
}

function synchronousRun(chatId: string) {
    const chiefStarted = deferred<void>()
    const chiefFinished = deferred<void>()
    let chiefSignal: AbortSignal | undefined
    const fetchImpl = jest.fn(async (url: string, options: any) => {
        if (url.endsWith('/stop')) return new Response(JSON.stringify({ status: 'cancelled' }))
        if (url.endsWith('/events')) {
            chiefSignal = options.signal
            return new Promise<Response>((resolve, reject) => {
                const abort = () => reject(Object.assign(new Error('Client disconnected'), { name: 'AbortError' }))
                chiefSignal?.addEventListener('abort', abort, { once: true })
                void chiefFinished.promise.then(() => {
                    chiefSignal?.removeEventListener('abort', abort)
                    resolve(new Response(''))
                })
                chiefStarted.resolve()
            })
        }
        return new Response(
            JSON.stringify(
                url.endsWith('/runs') ? { status: 'running', run_id: 'chief-run' } : { status: 'completed', output: 'Chief answer.' }
            )
        )
    })
    setHarnessModuleLoader(async (file) => {
        if (file === 'store.mjs') return nativeRequire('../../../../harness/store.mjs')
        if (file === 'history.mjs') return history
        if (file === 'run.mjs') return { runHarness: (options: any) => engine.runHarness({ ...options, fetchImpl, budgetMs: 0 }) }
        throw new Error(`Unexpected harness module: ${file}`)
    })
    // Supply an in-process runtime without booting the application.
    const startRun = jest
        .spyOn(service, 'startRun')
        .mockImplementation((harness, body, options) =>
            realStartRun(harness, body, { ...options, runtime: { componentNodes: {}, appDataSource: {} } as any })
        )
    const req: any = Object.assign(new EventEmitter(), {
        params: { name },
        body: { question: 'Check the order.', mode: 'agent', chatId },
        get: () => undefined,
        user: { id: 'author-example', activeWorkspaceId: 'team-a' }
    })
    const res: any = Object.assign(new EventEmitter(), { locals: {}, writableFinished: false })
    res.json = jest.fn(() => {
        res.writableFinished = true
        res.emit('close')
    })
    const next = jest.fn()
    const running = controller.createRun(req, res, next)
    const started = Promise.race([
        chiefStarted.promise,
        running.then(() => {
            throw next.mock.calls[0]?.[0] || new Error('Run ended before chief execution.')
        })
    ])
    return { req, res, next, running, startRun, fetchImpl, started, chiefFinished, signal: () => chiefSignal }
}

it('cancels and records a synchronous agent run when the client disconnects before the response finishes', async () => {
    const run = synchronousRun('disconnected-chat')
    try {
        await run.started
        const signal = run.startRun.mock.calls[0][2].signal
        expect(signal).toBeInstanceOf(AbortSignal)
        expect(signal?.aborted).toBe(false)
        run.res.emit('close')
        expect(signal?.aborted).toBe(true)
        expect(run.signal()?.aborted).toBe(true)
        await run.running
        expect(run.fetchImpl.mock.calls.filter(([url]) => url.endsWith('/chief-run/stop'))).toHaveLength(1)
        expect(run.res.json).not.toHaveBeenCalled()
        expect(run.next).toHaveBeenCalledWith(expect.objectContaining({ harnessRun: expect.objectContaining({ status: 'cancelled' }) }))
        const recorded = history.listRuns(name).find((row: any) => row.chatId === 'disconnected-chat')
        expect(recorded).toMatchObject({
            mode: 'agent',
            status: 'cancelled',
            trace: { status: 'cancelled', chief: { status: 'cancelled' } }
        })
    } finally {
        run.chiefFinished.resolve()
        await run.running
    }
})

it('keeps a synchronous agent run successful on normal request and response completion', async () => {
    const run = synchronousRun('completed-chat')
    try {
        await run.started
        // Finishing the incoming request body is not a client disconnect.
        run.req.emit('close')
        expect(run.signal()?.aborted).toBe(false)
        run.chiefFinished.resolve()
        await run.running
        expect(run.next).not.toHaveBeenCalled()
        expect(run.startRun.mock.calls[0][2].signal?.aborted).toBe(false)
        expect(run.fetchImpl.mock.calls.filter(([url]) => url.endsWith('/stop'))).toHaveLength(0)
        expect(run.res.json).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'Chief answer.', run: expect.objectContaining({ status: 'succeeded' }) })
        )
        expect(history.listRuns(name).find((row: any) => row.chatId === 'completed-chat')).toMatchObject({ status: 'succeeded' })
    } finally {
        run.chiefFinished.resolve()
        await run.running
    }
})
