// The external runs route stays on the saved harness. The canvas and Try it use startCanvasRun.
const startRun = jest.fn(async () => ({ chatId: 'c1', run: null, payload: { text: 'live' } }))
const startCanvasRun = jest.fn()
const assertRunRequest = jest.fn(async () => ({}))
jest.mock('../../services/harnesses', () => ({
    __esModule: true,
    default: {
        assertRunRequest: (...args: any[]) => (assertRunRequest as (...a: any[]) => any)(...args),
        startRun: (...args: any[]) => (startRun as (...a: any[]) => any)(...args),
        startCanvasRun: (...args: any[]) => (startCanvasRun as (...a: any[]) => any)(...args)
    }
}))
jest.mock('../../services/harnesses/chatImages', () => ({ chatImages: () => [] }))
jest.mock('../../utils/clientAbort', () => ({ watchClientDisconnect: () => undefined }))
jest.mock('../../utils/streaming', () => ({ isStreamingRequest: () => false }))

import controller from './index'

test('POST /api/v1/harnesses/:name/runs does not receive a draft roster', async () => {
    const res: any = { json: jest.fn() }
    await controller.createRun(
        { params: { name: 'bakery-team' }, body: { question: 'hi' }, get: () => undefined, user: { activeWorkspaceId: 'team-a' } } as any,
        res,
        jest.fn()
    )
    expect(assertRunRequest).toHaveBeenCalledWith('bakery-team', { question: 'hi' }, 'team-a')
    expect(startRun).toHaveBeenCalledWith('bakery-team', { question: 'hi' }, { source: 'api', workspaceId: 'team-a' })
    expect((startRun.mock.calls[0] as any[])[2]).not.toHaveProperty('record')
    expect(startCanvasRun).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ text: 'live' }))
})
