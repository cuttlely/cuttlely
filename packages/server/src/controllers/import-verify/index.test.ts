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
    canvasHash: () => 'abc',
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
})
