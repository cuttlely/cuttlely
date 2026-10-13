const getChatflowByIdForWorkspace = jest.fn()
const saveChatflow = jest.fn()
const getAllChatflowsCountByOrganization = jest.fn(async () => 2)
jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowByIdForWorkspace: (...args: any[]) => getChatflowByIdForWorkspace(...args),
        saveChatflow: (...args: any[]) => saveChatflow(...args),
        getAllChatflowsCountByOrganization: (...args: any[]) => (getAllChatflowsCountByOrganization as any)(...args)
    }
}))
const drafts = {
    isDraftsEnabled: jest.fn(() => true),
    getDraftStatus: jest.fn(async (): Promise<any> => ({ mode: 'draft', draft: null })),
    afterLiveSet: jest.fn(async (): Promise<any> => ({ mode: 'draft', draft: null })),
    draftToPublish: jest.fn()
}
jest.mock('../../services/flow-drafts', () => ({ __esModule: true, default: drafts }))
const versions = {
    getVersion: jest.fn(),
    restoreTitle: jest.fn((sha: string, title: string, verb: string) => `${verb}: ${title} (${sha.slice(0, 7)})`),
    listVersions: jest.fn(async (): Promise<any> => ({ versions: [] })),
    lastErrorFor: jest.fn((): string | null => null)
}
jest.mock('../../services/flow-versions', () => ({ __esModule: true, default: versions }))
const promoteService = {
    listIncoming: jest.fn(async () => ({ enabled: true, flows: [] })),
    getIncoming: jest.fn(async () => ({ flowId: 'f' })),
    promotable: jest.fn(),
    incomingCanvas: jest.fn()
}
jest.mock('../../services/flow-promote', () => ({ __esModule: true, default: promoteService }))
const checkService = {
    getCheckSetup: jest.fn(async () => ({ unavailable: null })),
    startCheck: jest.fn(async () => ({ id: 'c1', status: 'running' })),
    getCheck: jest.fn(async () => ({ id: 'c1' })),
    stopCheck: jest.fn(async () => ({ id: 'c1' }))
}
jest.mock('../../services/flow-check', () => ({ __esModule: true, default: checkService }))
jest.mock('../../database/entities/ChatFlow', () => ({ ChatFlow: class ChatFlow {} }))
const putVersionLive = jest.fn()
jest.mock('../flow-versions', () => {
    const actual = jest.requireActual('../flow-versions/message')
    return { putVersionLive: (...args: any[]) => putVersionLive(...args), missingCredentialsMessage: actual.missingCredentialsMessage }
})
const checkUsageLimit = jest.fn(async () => undefined)
jest.mock('../../utils/quotaUsage', () => ({ checkUsageLimit: (...args: any[]) => (checkUsageLimit as any)(...args) }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: () => ({ usageCacheManager: {} }) }))

import controller from './index'

const SHA = 'a'.repeat(40)
const FLOW_ID = '0b5c3a1e-1111-2222-3333-444455556666'
const ROW = { id: FLOW_ID, name: 'Support bot', type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}', workspaceId: 'team-a' }
const LATEST = { flowId: FLOW_ID, sha: SHA, name: 'Support bot', title: 'Published: Changed instructions' }

function request(body: any = {}, params: any = {}) {
    return {
        params: { chatflowId: FLOW_ID, ...params },
        body,
        protocol: 'http',
        get: (name: string) => (name === 'host' ? 'localhost:3000' : undefined),
        user: { id: 'user-1', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-1', activeOrganizationSubscriptionId: 'sub-1' }
    } as any
}
function response() {
    const res: any = {}
    res.json = jest.fn(() => res)
    res.status = jest.fn(() => res)
    return res
}

beforeEach(() => {
    jest.clearAllMocks()
    drafts.isDraftsEnabled.mockReturnValue(true)
})

test('lists and reads new versions from Dev in the caller workspace', async () => {
    const res = response()
    await controller.listIncoming(request(), res, jest.fn())
    expect(promoteService.listIncoming).toHaveBeenCalledWith('team-a')
    await controller.getIncoming(request(), res, jest.fn())
    expect(promoteService.getIncoming).toHaveBeenCalledWith(FLOW_ID, 'team-a')
})

describe('Promote', () => {
    test('puts the version Live as promoted from Dev and keeps a Prod draft marked as started from the old Live', async () => {
        promoteService.promotable.mockResolvedValue({ latest: LATEST, row: ROW })
        const saved = { ...ROW, flowData: '{"nodes":[{"id":"new"}],"edges":[]}' }
        putVersionLive.mockResolvedValue({ chatflow: saved, sha: 'b'.repeat(40), body: { unchanged: false, recorded: true } })
        drafts.afterLiveSet.mockResolvedValue({ mode: 'draft', draft: { flowData: '{}', stale: true } })
        const res = response()
        const next = jest.fn()
        await controller.promote(request({ sha: SHA }), res, next)
        expect(next).not.toHaveBeenCalled()
        expect(promoteService.promotable).toHaveBeenCalledWith(FLOW_ID, SHA, 'team-a')
        expect(putVersionLive).toHaveBeenCalledWith(expect.anything(), ROW, SHA, {
            kind: 'promote',
            verb: 'Promoted from Dev',
            title: LATEST.title,
            promotedFrom: SHA
        })
        expect(drafts.afterLiveSet).toHaveBeenCalledWith(saved, 'b'.repeat(40), undefined, { keepDraftBase: true })
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ created: false, hasDraft: true, recorded: true }))
        expect(saveChatflow).not.toHaveBeenCalled()
        expect(drafts.draftToPublish).not.toHaveBeenCalled()
    })

    test('a stale or blocked promote is passed on as the error, and nothing is saved', async () => {
        const error = Object.assign(new Error('A newer version of this flow arrived from Dev while you were looking.'), { statusCode: 409 })
        promoteService.promotable.mockRejectedValue(error)
        const next = jest.fn()
        await controller.promote(request({ sha: SHA }), response(), next)
        expect(next).toHaveBeenCalledWith(error)
        expect(putVersionLive).not.toHaveBeenCalled()
        expect(saveChatflow).not.toHaveBeenCalled()
    })

    test('a flow Prod does not have is created with the id it has on Dev and recorded as promoted', async () => {
        promoteService.promotable.mockResolvedValue({ latest: LATEST, row: null })
        versions.getVersion.mockResolvedValue({
            sha: SHA,
            name: 'Support bot',
            type: 'CHATFLOW',
            flowData: '{"nodes":[{"id":"n"}],"edges":[]}',
            missingCredentials: [],
            ambiguousCredentials: [],
            hiddenSecrets: []
        })
        saveChatflow.mockImplementation(async (flow: any, _o, _w, _s, _u, _a, record: any) => {
            record.onVersionQueued(Promise.resolve('c'.repeat(40)))
            return { ...flow, updatedDate: 'now' }
        })
        const res = response()
        const next = jest.fn()
        await controller.promote(request({ sha: SHA }), res, next)
        expect(next).not.toHaveBeenCalled()
        expect(checkUsageLimit).toHaveBeenCalledWith('flows', 'sub-1', {}, 3)
        const [flow, orgId, workspaceId, , , actor, record] = saveChatflow.mock.calls[0]
        expect(flow).toMatchObject({ id: FLOW_ID, name: 'Support bot', type: 'CHATFLOW', workspaceId: 'team-a' })
        expect([orgId, workspaceId]).toEqual(['org-1', 'team-a'])
        expect(actor).toBeTruthy()
        expect(record.versionRecord).toEqual({ kind: 'promote', title: `Promoted from Dev: ${LATEST.title} (aaaaaaa)`, promotedFrom: SHA })
        expect(drafts.afterLiveSet).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW_ID }), 'c'.repeat(40), undefined, {
            keepDraftBase: true
        })
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ created: true, recorded: true }))
    })

    test('a new flow that needs a credential Prod does not have is blocked with the list to add', async () => {
        promoteService.promotable.mockResolvedValue({ latest: LATEST, row: null })
        versions.getVersion.mockResolvedValue({
            sha: SHA,
            name: 'Support bot',
            flowData: '{}',
            missingCredentials: [
                { name: 'OpenAI key', credentialName: 'openAIApi' },
                { name: 'Search key', credentialName: 'serpApi' }
            ],
            ambiguousCredentials: [],
            hiddenSecrets: []
        })
        const next = jest.fn()
        await controller.promote(request({ sha: SHA }), response(), next)
        expect(next.mock.calls[0][0]).toMatchObject({
            statusCode: 409,
            message: 'Add these credentials on this server first: "OpenAI key" (openAIApi), "Search key" (serpApi). Then promote again.'
        })
        expect(saveChatflow).not.toHaveBeenCalled()
    })
})

describe('behavior check', () => {
    beforeEach(() => getChatflowByIdForWorkspace.mockResolvedValue({ ...ROW }))

    test('compares Live with the version from Dev, in a check of its own', async () => {
        promoteService.incomingCanvas.mockResolvedValue({ sha: SHA, flowData: '{"nodes":[{"id":"dev"}],"edges":[]}', type: 'CHATFLOW' })
        const res = response()
        await controller.startCheck(request({ questions: ['hi'] }), res, jest.fn())
        expect(getChatflowByIdForWorkspace).toHaveBeenCalledWith(FLOW_ID, 'team-a')
        expect(checkService.startCheck).toHaveBeenCalledWith(
            expect.objectContaining({ id: FLOW_ID }),
            { questions: ['hi'] },
            'http://localhost:3000',
            {
                key: `${FLOW_ID}:promote`,
                canvas: '{"nodes":[{"id":"dev"}],"edges":[]}',
                unavailable: null
            }
        )
        expect(res.status).toHaveBeenCalledWith(202)
    })

    test('refuses when the version from Dev turns the chatflow into another kind of flow', async () => {
        promoteService.incomingCanvas.mockResolvedValue({ sha: SHA, flowData: '{"nodes":[],"edges":[]}', type: 'AGENTFLOW' })
        await controller.getCheckSetup(request(), response(), jest.fn())
        expect((checkService.getCheckSetup.mock.calls[0] as any[])[1]).toMatchObject({ unavailable: { code: 'type' } })
        await controller.startCheck(request({ questions: ['hi'] }), response(), jest.fn())
        expect((checkService.startCheck.mock.calls[0] as any[])[3]).toMatchObject({ unavailable: { code: 'type' } })
    })

    test('an agentflow can be checked against the agentflow version from Dev', async () => {
        getChatflowByIdForWorkspace.mockResolvedValue({ ...ROW, type: 'AGENTFLOW' })
        promoteService.incomingCanvas.mockResolvedValue({ sha: SHA, flowData: '{"nodes":[{"id":"dev"}],"edges":[]}', type: 'AGENTFLOW' })
        await controller.getCheckSetup(request(), response(), jest.fn())
        expect((checkService.getCheckSetup.mock.calls[0] as any[])[1]).toMatchObject({ unavailable: null })
    })

    test('a legacy multi-agent flow cannot be checked', async () => {
        getChatflowByIdForWorkspace.mockResolvedValue({ ...ROW, type: 'MULTIAGENT' })
        promoteService.incomingCanvas.mockResolvedValue({ sha: SHA, flowData: '{"nodes":[],"edges":[]}', type: 'MULTIAGENT' })
        await controller.getCheckSetup(request(), response(), jest.fn())
        expect((checkService.getCheckSetup.mock.calls[0] as any[])[1]).toMatchObject({
            unavailable: { code: 'type', message: 'The check works on chatflows and agentflows.' }
        })
    })

    test('says why it cannot run: missing credentials, or nothing new', async () => {
        promoteService.incomingCanvas.mockResolvedValueOnce({ sha: SHA, flowData: null, type: 'CHATFLOW' }).mockResolvedValueOnce(null)
        await controller.getCheckSetup(request(), response(), jest.fn())
        expect((checkService.getCheckSetup.mock.calls[0] as any[])[1]).toMatchObject({ canvas: null, unavailable: { code: 'credentials' } })
        await controller.getCheck(request({}, { checkId: 'c1' }), response(), jest.fn())
        expect((checkService.getCheck.mock.calls[0] as any[])[2]).toMatchObject({ canvas: null, unavailable: { code: 'no-draft' } })
    })
})
