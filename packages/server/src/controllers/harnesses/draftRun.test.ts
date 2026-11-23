// The external runs route stays on the saved harness. The canvas and Try it use startCanvasRun.
const startRun = jest.fn(async () => ({ chatId: 'c1', run: null, payload: { text: 'live' } }))
const startCanvasRun = jest.fn()
const assertRunRequest = jest.fn(async () => ({}))
const startBackgroundRun = jest.fn(async () => ({ runId: 'run-example', harness: 'bakery-team', chatId: 'c1', status: 'queued' }))
jest.mock('../../services/harnesses', () => ({
    __esModule: true,
    default: {
        assertRunRequest: (...args: any[]) => (assertRunRequest as (...a: any[]) => any)(...args),
        startRun: (...args: any[]) => (startRun as (...a: any[]) => any)(...args),
        startBackgroundRun: (...args: any[]) => (startBackgroundRun as (...a: any[]) => any)(...args),
        startCanvasRun: (...args: any[]) => (startCanvasRun as (...a: any[]) => any)(...args)
    }
}))
jest.mock('../../services/harnesses/chatImages', () => ({ chatImages: () => [] }))
jest.mock('../../utils/clientAbort', () => ({ watchClientDisconnect: () => undefined }))
jest.mock('../../utils/streaming', () => ({ isStreamingRequest: (req: any) => req.body?.streaming === true }))

import controller from './index'
import { setHarnessKeyLookup } from '../../services/harnesses/apiAccess'

beforeEach(() => {
    jest.clearAllMocks()
    setHarnessKeyLookup(async () => ({ workspaceId: 'team-a', harnesses: ['bakery-team'] }))
})
afterEach(() => setHarnessKeyLookup(null))

describe.each(['session', 'api_key'])('%s caller', (via) => {
    const user = { ...(via === 'session' ? { id: 'user-1' } : { apiKeyId: 'key-example' }), activeWorkspaceId: 'team-a' }
    const sessionUserId = via === 'session' ? 'user-1' : undefined
    const caller = via === 'session' ? { via } : { via, apiKeyId: 'key-example', harnesses: ['bakery-team'] }

    test.each([undefined, 'router', 'agent'])('POST /runs waits for mode %s and uses the saved roster', async (mode) => {
        const body = { question: 'hi', sessionUserId: 'untrusted', tryOwner: 'user:untrusted', ...(mode === undefined ? {} : { mode }) }
        const res: any = { json: jest.fn() }
        const next = jest.fn()
        await controller.createRun({ params: { name: 'bakery-team' }, body, get: () => undefined, user } as any, res, next)
        expect(next).not.toHaveBeenCalled()
        expect(assertRunRequest).toHaveBeenCalledWith('bakery-team', body, 'team-a', caller, { expectedChatflowId: undefined })
        expect(startRun).toHaveBeenCalledWith('bakery-team', body, {
            source: 'api',
            workspaceId: 'team-a',
            caller,
            expectedChatflowId: undefined,
            sessionUserId,
            signal: undefined
        })
        expect((startRun.mock.calls[0] as any[])[2]).not.toHaveProperty('record')
        expect(startCanvasRun).not.toHaveBeenCalled()
        expect(startBackgroundRun).not.toHaveBeenCalled()
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ text: 'live' }))
    })

    test('streamed runs take their nested session owner from the signed-in request', async () => {
        const body = { question: 'hi', streaming: true, sessionUserId: 'untrusted' }
        const res: any = { status: jest.fn(), setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn() }
        const next = jest.fn()
        await controller.createRun({ params: { name: 'bakery-team' }, body, get: () => undefined, user } as any, res, next)
        expect(next).not.toHaveBeenCalled()
        expect(startRun).toHaveBeenCalledWith(
            'bakery-team',
            body,
            expect.objectContaining({ caller, sessionUserId, onEvent: expect.any(Function) })
        )
        expect(res.end).toHaveBeenCalled()
    })

    test('POST /runs/async returns 202 with run and polling URLs for agent mode', async () => {
        const body = { question: 'hi', mode: 'agent', sessionUserId: 'untrusted' }
        const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() }
        const next = jest.fn()
        await controller.startBackgroundRun({ params: { name: 'bakery-team' }, body, user } as any, res, next)
        expect(next).not.toHaveBeenCalled()
        expect(startRun).not.toHaveBeenCalled()
        expect(startBackgroundRun).toHaveBeenCalledWith(
            'bakery-team',
            body,
            expect.objectContaining({ caller, workspaceId: 'team-a', sessionUserId })
        )
        expect(res.status).toHaveBeenCalledWith(202)
        expect(res.json).toHaveBeenCalledWith({
            runId: 'run-example',
            harness: 'bakery-team',
            chatId: 'c1',
            status: 'queued',
            statusUrl: '/api/v1/harnesses/bakery-team/runs/run-example',
            resultUrl: '/api/v1/harnesses/bakery-team/runs/run-example/result'
        })
    })
})
