// The canvas test chat runs the draft; the public prediction API runs Live.
const utilBuildChatflow = jest.fn(async () => ({ text: 'ok' }))
jest.mock('../../utils/buildChatflow', () => ({ utilBuildChatflow: (...args: any[]) => (utilBuildChatflow as any)(...args) }))
jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: { getChatflowByIdForWorkspace: jest.fn(async () => ({ id: 'flow-1', type: 'CHATFLOW' })) }
}))
const startCanvasRun = jest.fn(async () => ({ chatId: 'c1', run: null, payload: { text: 'from the draft' } }))
jest.mock('../../services/harnesses', () => ({
    __esModule: true,
    default: { startCanvasRun: (...args: any[]) => (startCanvasRun as (...a: any[]) => any)(...args) }
}))
jest.mock('../../utils/sessionOwnership', () => ({ bindRequestSession: jest.fn() }))
const sseStreamer = { addClient: jest.fn(), removeClient: jest.fn(), streamMetadataEvent: jest.fn(), streamErrorEvent: jest.fn() }
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: () => ({ sseStreamer }) }))

import controller from './index'
import predictionsService from '../../services/predictions'

const chatflows = () => jest.requireMock('../../services/chatflows').default

test('the canvas test chat asks for the draft', async () => {
    const res: any = { json: jest.fn() }
    await controller.createInternalPrediction(
        { params: { id: 'flow-1' }, body: {}, user: { activeWorkspaceId: 'team-a' } } as any,
        res,
        jest.fn()
    )
    expect(utilBuildChatflow).toHaveBeenCalledWith(expect.anything(), true, undefined, { testDraft: true })
    expect(res.json).toHaveBeenCalledWith({ text: 'ok' })
})

test('a harness canvas run uses the draft path', async () => {
    startCanvasRun.mockClear()
    utilBuildChatflow.mockClear()
    chatflows().getChatflowByIdForWorkspace.mockResolvedValueOnce({
        id: 'flow-1',
        name: 'bakery-team',
        type: 'HARNESS',
        flowData: '{"nodes":[],"edges":[]}',
        workspaceId: 'team-a'
    })
    const res: any = { json: jest.fn() }
    await controller.createInternalPrediction(
        { params: { id: 'flow-1' }, body: { question: 'hi' }, user: { activeWorkspaceId: 'team-a' } } as any,
        res,
        jest.fn()
    )
    expect(startCanvasRun).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'flow-1', name: 'bakery-team', type: 'HARNESS' }),
        { question: 'hi' },
        { source: 'playground' }
    )
    expect(utilBuildChatflow).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ text: 'from the draft' }))
})

test('the prediction API runs Live', async () => {
    utilBuildChatflow.mockClear()
    await predictionsService.buildChatflow({ params: { id: 'flow-1' }, body: {} } as any)
    expect(utilBuildChatflow.mock.calls[0]).toHaveLength(3)
    expect((utilBuildChatflow.mock.calls[0] as any[])[3]).toBeUndefined()
})

// One rule with the prediction path (utils/streaming.ts): only true or 'true' streams.
describe.each([
    [true, 'stream'],
    ['true', 'stream'],
    [1, 'JSON'],
    ['1', 'JSON'],
    ['TRUE', 'JSON'],
    [{}, 'JSON']
])('streaming %p', (streaming, answer) => {
    test(`answers as ${answer}`, async () => {
        utilBuildChatflow.mockClear()
        sseStreamer.addClient.mockClear()
        const res: any = { json: jest.fn(), setHeader: jest.fn(), flushHeaders: jest.fn(), once: jest.fn(), on: jest.fn(), locals: {} }
        await controller.createInternalPrediction(
            { params: { id: 'flow-1' }, body: { streaming, chatId: 'chat-1' }, user: { activeWorkspaceId: 'team-a' } } as any,
            res,
            jest.fn()
        )
        await new Promise((resolve) => setImmediate(resolve))
        expect(utilBuildChatflow).toHaveBeenCalledTimes(1)
        if (answer === 'stream') {
            expect(res.flushHeaders).toHaveBeenCalled()
            expect(sseStreamer.addClient).toHaveBeenCalledWith('chat-1', res)
            expect(res.json).not.toHaveBeenCalled()
        } else {
            expect(res.flushHeaders).not.toHaveBeenCalled()
            expect(res.json).toHaveBeenCalledWith({ text: 'ok' })
        }
    })
})
