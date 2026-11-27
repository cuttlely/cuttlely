// The external runs route stays on the saved harness. The canvas and Try it use startCanvasRun.
const startRun = jest.fn<Promise<any>, any[]>(async () => ({ chatId: 'c1', run: null, payload: { text: 'live' } }))
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

    test.each(['ready', 'missing', 'expired'])(
        'settles a %s verified result before writing the named SSE and JSON answers',
        async (condition) => {
            const text = 'Verified report.csv'
            const payload = {
                text,
                trustedOutput: true,
                trustedOutputDeadlineAt: Date.now() + (condition === 'expired' ? -1000 : 60000),
                artifacts: [{ type: 'csv', mime: 'text/csv', ...(condition === 'missing' ? {} : { base64: 'YSwxCg==' }) }]
            }
            for (const streaming of [true, false]) {
                startRun.mockImplementationOnce(async (_name, _body, opts) => {
                    opts.onEvent?.({ type: 'route', phase: 'done' })
                    opts.onEvent?.({ type: 'partial', phase: 'answer', text, trustedOutput: true })
                    opts.onEvent?.({ type: 'final', text, trustedOutput: true })
                    return { chatId: 'c1', run: null, payload }
                })
                const req: any = { params: { name: 'bakery-team' }, body: { question: 'report', streaming }, get: jest.fn(), user }
                const res: any = {
                    status: jest.fn().mockReturnThis(),
                    json: jest.fn(),
                    setHeader: jest.fn(),
                    flushHeaders: jest.fn(),
                    write: jest.fn(),
                    end: jest.fn()
                }
                const next = jest.fn()
                await controller.createRun(req, res, next)
                if (streaming) {
                    const frames = res.write.mock.calls.map(([wire]: [string]) => JSON.parse(wire.slice(wire.indexOf('data:') + 5)))
                    expect(frames.map((frame: any) => frame.event)).toEqual(
                        condition === 'ready'
                            ? ['harness.route', 'harness.partial', 'harness.final', 'artifacts', 'harness.recorded']
                            : ['harness.route', 'error']
                    )
                    if (condition !== 'ready') expect(JSON.stringify(frames)).not.toContain(text)
                    else expect(frames[3].data[0].data).toBe('data:text/csv;base64,YSwxCg==')
                } else if (condition === 'ready') {
                    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ text, artifacts: payload.artifacts }))
                } else {
                    expect(res.json).not.toHaveBeenCalled()
                    expect(next.mock.calls[0][0].message).toMatch(
                        condition === 'expired' ? /budget expired/ : /attachments could not be delivered/
                    )
                }
            }
        }
    )

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
