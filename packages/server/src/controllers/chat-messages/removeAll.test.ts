const getChatflowByIdForWorkspace = jest.fn()
const utilGetChatMessage = jest.fn()

jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: { getChatflowByIdForWorkspace: (...args: unknown[]) => getChatflowByIdForWorkspace(...args) }
}))
jest.mock('../../services/chat-messages', () => ({ __esModule: true, default: {} }))
jest.mock('../../utils', () => ({ aMonthAgo: jest.fn(), clearSessionMemory: jest.fn() }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn(() => ({})) }))
jest.mock('../../utils/getChatMessage', () => ({ utilGetChatMessage: (...args: unknown[]) => utilGetChatMessage(...args) }))

import chatMessagesController from './index'

const user = { activeOrganizationId: 'org-1', activeWorkspaceId: 'ws-1' }

async function remove(query: Record<string, unknown>) {
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
    const next = jest.fn()
    await chatMessagesController.removeAllChatMessages({ params: { id: 'flow-1' }, query, user } as any, res as any, next)
    return { res, next }
}

describe('removeAllChatMessages feedbackType', () => {
    beforeEach(() => jest.clearAllMocks())

    it.each([[{ THUMBS_UP: 'x' }], [[{ includes: () => true }]], ['SOMETHING_ELSE'], ['']])(
        'answers 400 for %j and deletes nothing',
        async (feedbackType) => {
            const { next } = await remove({ feedbackType })

            expect(next).toHaveBeenCalledTimes(1)
            expect(next.mock.calls[0][0].statusCode).toBe(400)
            expect(getChatflowByIdForWorkspace).not.toHaveBeenCalled()
            expect(utilGetChatMessage).not.toHaveBeenCalled()
        }
    )

    it('filters by a known rating', async () => {
        getChatflowByIdForWorkspace.mockResolvedValue({ flowData: JSON.stringify({ nodes: [], edges: [] }) })
        utilGetChatMessage.mockResolvedValue([])

        const { res, next } = await remove({ feedbackType: 'THUMBS_UP' })

        expect(next).not.toHaveBeenCalled()
        expect(utilGetChatMessage).toHaveBeenCalledWith(expect.objectContaining({ feedback: true, feedbackTypes: ['THUMBS_UP'] }))
        expect(res.json).toHaveBeenCalledWith({ raw: [], affected: 0 })
    })
})
