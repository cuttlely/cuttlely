import { StatusCodes } from 'http-status-codes'
import controller from './index'

jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowByIdForWorkspace: jest.fn(async () => ({ id: 'flow-1', type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}' }))
    }
}))

jest.mock('../../services/credentials', () => ({
    __esModule: true,
    default: { getAllCredentials: jest.fn(async () => []) }
}))

jest.mock('../../services/harnesses/apiAccess', () => ({
    harnessCallerFor: jest.fn(async () => ({ via: 'session' }))
}))

jest.mock('../../services/pinned-queries', () => ({
    readOnlyRows: jest.fn(),
    testPinnedQuery: jest.fn(),
    PinnedRequestError: class PinnedRequestError extends Error {}
}))

jest.mock('../../services/pinned-queries/sql', () => ({
    pinnedQueriesEnabled: () => true
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        nodesPool: { componentNodes: {} },
        AppDataSource: { getRepository: () => ({ update: async () => undefined }) }
    })
}))

jest.mock('../../identity/rbac', () => ({
    hasAnyPermission: jest.fn(async () => true)
}))

const runningRecord = {
    version: 1,
    status: 'running',
    phase: 'Checking this flow.',
    publishOffered: false,
    queries: [],
    connections: [],
    blockers: [],
    smoke: [],
    draftHash: 'abc'
}

jest.mock('../../services/flow-drafts', () => ({
    __esModule: true,
    canvasHash: (flowData: string) => `hash:${String(flowData ?? '')}`,
    DraftChangedError: class DraftChangedError extends Error {},
    default: {
        getState: jest.fn(async () => ({
            draftFlowData: '{"nodes":[],"edges":[]}',
            importVerify: JSON.stringify(runningRecord)
        })),
        saveDraft: jest.fn()
    }
}))

jest.mock('../../services/import-verify', () => ({
    beginVerification: jest.fn(async () => null),
    recoverOrphanedRun: (record: unknown) => record,
    executeVerify: jest.fn()
}))

import { executeVerify } from '../../services/import-verify'
import chatflowsService from '../../services/chatflows'
import flowDraftsService, { DraftChangedError } from '../../services/flow-drafts'

const response = () => {
    const res = { json: jest.fn(), status: jest.fn() }
    res.status.mockReturnValue(res)
    return res
}

const request = () =>
    ({
        params: { chatflowId: 'flow-1' },
        body: {},
        user: { id: 'user-1', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-1', activeOrganizationSubscriptionId: 'sub-1' }
    } as any)

describe('import-verify start while a check is already running', () => {
    afterEach(() => {
        jest.clearAllMocks()
    })

    test('a second start says the check is still running', async () => {
        let release: (value: unknown) => void = () => undefined
        ;(executeVerify as jest.Mock).mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve
                })
        )
        const first = response()
        const started = controller.start(request(), first as any, jest.fn())
        await new Promise((resolve) => setTimeout(resolve, 20))
        const second = response()
        await controller.start(request(), second as any, jest.fn())
        expect(second.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', running: true }))
        release({ ...runningRecord, status: 'ready', publishOffered: true })
        await started
        expect(first.status).not.toHaveBeenCalledWith(StatusCodes.INTERNAL_SERVER_ERROR)
    })

    test('a draft that changes between the save and the re-read is draft-moved, not ready', async () => {
        const original = '{"nodes":[],"edges":[]}'
        const newer = '{"nodes":[{"id":"user-save"}],"edges":[]}'
        let saved = false
        ;(flowDraftsService.saveDraft as jest.Mock).mockImplementation(async (_flow, flowText: string) => {
            saved = true
            return { draft: { flowData: flowText } }
        })
        ;(flowDraftsService.getState as jest.Mock).mockImplementation(async () => ({
            draftFlowData: saved ? newer : original,
            importVerify: null
        }))
        const actual = jest.requireActual('../../services/import-verify') as { executeVerify: typeof executeVerify }
        ;(executeVerify as jest.Mock).mockImplementation((options) => actual.executeVerify(options))
        const res = response()
        await controller.start(request(), res as any, jest.fn())
        const body = res.json.mock.calls[0][0]
        expect(body.status).toBe('incomplete')
        expect(body.blockers.some((item: { id: string }) => item.id === 'draft-moved')).toBe(true)
        expect(body.publishOffered).toBe(false)
    })

    test('a second start during admission does not run a second job', async () => {
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        let lookups = 0
        ;(chatflowsService.getChatflowByIdForWorkspace as jest.Mock).mockImplementation(async () => {
            lookups += 1
            if (lookups === 1) await gate
            return { id: 'flow-1', type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}' }
        })
        let jobs = 0
        ;(executeVerify as jest.Mock).mockImplementation(async () => {
            jobs += 1
            return { ...runningRecord, status: 'incomplete', publishOffered: false }
        })
        const first = response()
        const started = controller.start(request(), first as any, jest.fn())
        const second = response()
        await controller.start(request(), second as any, jest.fn())
        expect(jobs).toBe(0)
        expect(second.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', running: true }))
        release()
        await started
        expect(jobs).toBe(1)
        ;(chatflowsService.getChatflowByIdForWorkspace as jest.Mock).mockImplementation(async () => ({
            id: 'flow-1',
            type: 'CHATFLOW',
            flowData: '{"nodes":[],"edges":[]}'
        }))
    })

    test('a prior ready record stays running with Publish off while admission is in flight', async () => {
        const readyRecord = {
            version: 1,
            status: 'ready',
            phase: 'Finished',
            publishOffered: true,
            queries: [],
            connections: [],
            blockers: [],
            smoke: [],
            draftHash: 'abc'
        }
        ;(flowDraftsService.getState as jest.Mock).mockImplementation(async () => ({
            draftFlowData: '{"nodes":[],"edges":[]}',
            importVerify: JSON.stringify(readyRecord)
        }))
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        let lookups = 0
        ;(chatflowsService.getChatflowByIdForWorkspace as jest.Mock).mockImplementation(async () => {
            lookups += 1
            if (lookups === 1) await gate
            return { id: 'flow-1', type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}' }
        })
        ;(executeVerify as jest.Mock).mockImplementation(async () => ({ ...readyRecord, status: 'incomplete', publishOffered: false }))
        const first = response()
        const started = controller.start(request(), first as any, jest.fn())
        const second = response()
        await controller.start(request(), second as any, jest.fn())
        const polled = response()
        await controller.status(request(), polled as any, jest.fn())
        expect(second.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', running: true, publishOffered: false }))
        expect(polled.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'running', running: true, publishOffered: false }))
        release()
        await started
        ;(flowDraftsService.getState as jest.Mock).mockImplementation(async () => ({
            draftFlowData: '{"nodes":[],"edges":[]}',
            importVerify: JSON.stringify(runningRecord)
        }))
        ;(chatflowsService.getChatflowByIdForWorkspace as jest.Mock).mockImplementation(async () => ({
            id: 'flow-1',
            type: 'CHATFLOW',
            flowData: '{"nodes":[],"edges":[]}'
        }))
    })

    test('a draft that appears before the first save is kept unchanged', async () => {
        const live = '{"nodes":[],"edges":[]}'
        const newer = '{"nodes":[{"id":"theirs"}],"edges":[]}'
        let stored: string | null = null
        let reads = 0
        ;(flowDraftsService.getState as jest.Mock).mockImplementation(async () => {
            reads += 1
            if (reads === 1) {
                stored = newer
                return { draftFlowData: null, importVerify: null }
            }
            return { draftFlowData: stored, importVerify: null }
        })
        ;(flowDraftsService.saveDraft as jest.Mock).mockImplementation(async (_flow, flowText: string, context) => {
            const strict = context?.strictDraftHash === true
            const expected = context?.expectedDraftHash
            if (stored && strict && expected === null && flowText !== stored) {
                throw new DraftChangedError({ id: 'other', name: 'Someone else' }, '2026-11-13T00:00:00.000Z')
            }
            stored = flowText
            return { draft: { flowData: stored } }
        })
        ;(executeVerify as jest.Mock).mockClear()
        const res = response()
        await controller.start(request(), res as any, jest.fn())
        expect(stored).toBe(newer)
        expect(executeVerify).not.toHaveBeenCalled()
        const body = res.json.mock.calls[0][0]
        expect(body.status).toBe('incomplete')
        expect(body.publishOffered).toBe(false)
        expect(body.blockers.some((item: { id: string }) => item.id === 'draft-moved')).toBe(true)
        expect(flowDraftsService.saveDraft).toHaveBeenCalledWith(
            expect.anything(),
            live,
            expect.objectContaining({ expectedDraftHash: null, strictDraftHash: true })
        )
        ;(flowDraftsService.getState as jest.Mock).mockImplementation(async () => ({
            draftFlowData: live,
            importVerify: JSON.stringify(runningRecord)
        }))
        ;(flowDraftsService.saveDraft as jest.Mock).mockReset()
    })
})
