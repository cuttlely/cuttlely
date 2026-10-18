const getChatflowByIdForWorkspace = jest.fn()
const updateChatflow = jest.fn()
jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowByIdForWorkspace: (...args: any[]) => getChatflowByIdForWorkspace(...args),
        updateChatflow: (...args: any[]) => updateChatflow(...args)
    }
}))
const drafts = {
    isDraftsEnabled: jest.fn(() => true),
    getDraftStatus: jest.fn(async () => ({ mode: 'draft' })),
    saveDraft: jest.fn(async () => ({ mode: 'draft' })),
    discardDraft: jest.fn(async () => ({ mode: 'draft', draft: null })),
    setPublishInstantly: jest.fn(async () => ({ mode: 'live' })),
    updateDraftSettings: jest.fn(async () => ({ mode: 'draft', publishGate: { enabled: true } })),
    draftToPublish: jest.fn(async (): Promise<string> => '{"nodes":[{"id":"draft"}],"edges":[]}'),
    sameCanvas: jest.fn((a: string, b: string) => a === b),
    afterLiveSet: jest.fn(async () => ({ mode: 'draft', draft: null, lastPublished: { sha: 'x', date: 'd' } })),
    clearDraftIfStill: jest.fn(async () => ({ mode: 'draft', draft: null }))
}
const versions = {
    listVersions: jest.fn(async (): Promise<any> => ({ versions: [] })),
    lastErrorFor: jest.fn((): string | null => null)
}
jest.mock('../../services/flow-versions', () => ({ __esModule: true, default: versions }))
jest.mock('../../database/entities/ChatFlow', () => ({ ChatFlow: class ChatFlow {} }))
const putVersionLive = jest.fn()
jest.mock('../flow-versions', () => ({ putVersionLive: (...args: any[]) => putVersionLive(...args) }))
jest.mock('../../services/flow-drafts', () => {
    const { redactDraftStatus } = jest.requireActual('../../services/flow-drafts/gate')
    return { __esModule: true, default: drafts, redactDraftStatus }
})
const checkService = {
    getCheckSetup: jest.fn(async () => ({ unavailable: null, questions: [] })),
    startCheck: jest.fn(async () => ({ id: 'c1', status: 'running' })),
    getCheck: jest.fn(async () => ({ id: 'c1', status: 'done' })),
    stopCheck: jest.fn(async () => ({ id: 'c1', status: 'stopped' }))
}
jest.mock('../../services/flow-check', () => ({ __esModule: true, default: checkService }))
const listQuestionHistory = jest.fn(
    async (): Promise<{ items: any[]; nextCursor: string | null }> => ({
        items: [],
        nextCursor: null
    })
)
jest.mock('../../services/flow-check/history', () => ({
    listQuestionHistory: (...args: any[]) => (listQuestionHistory as (...values: any[]) => any)(...args)
}))
const granted = new Set<string>()
jest.mock('../../identity/rbac', () => ({
    hasAnyPermission: jest.fn(async (_req: any, ...permissions: string[]) => permissions.some((item) => granted.has(item)))
}))

import controller from './index'
import { BadQuestionIdsError } from '../../services/flow-check/question-ids-error'
import { resetRuntimeLimitsForTests } from '../../settings/runtime'

const FLOW = { id: '0b5c3a1e-1111-2222-3333-444455556666', type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}', workspaceId: 'team-a' }

function request(body: any = {}) {
    return {
        params: { chatflowId: FLOW.id },
        body,
        user: { id: 'user-1', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-1', activeOrganizationSubscriptionId: 'sub-1' }
    } as any
}
function response() {
    const res: any = {}
    res.json = jest.fn(() => res)
    res.status = jest.fn(() => res)
    res.setHeader = jest.fn(() => res)
    return res
}

beforeEach(() => {
    jest.clearAllMocks()
    granted.clear()
    getChatflowByIdForWorkspace.mockResolvedValue({ ...FLOW })
    drafts.isDraftsEnabled.mockReturnValue(true)
})

test('reads the draft of a flow in the caller workspace', async () => {
    granted.add('chatflows:view')
    const res = response()
    await controller.getDraft(request(), res, jest.fn())
    expect(getChatflowByIdForWorkspace).toHaveBeenCalledWith(FLOW.id, 'team-a')
    expect(res.json).toHaveBeenCalledWith({ mode: 'draft' })
})

test('saves the canvas as a draft with the user, org and subscription', async () => {
    granted.add('chatflows:update')
    await controller.saveDraft(request({ flowData: '{"nodes":[],"edges":[]}', name: 'ignored' }), response(), jest.fn())
    expect(drafts.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), '{"nodes":[],"edges":[]}', {
        userId: 'user-1',
        orgId: 'org-1',
        subscriptionId: 'sub-1',
        caller: { via: 'session' }
    })
})

test('turning the passing test set on needs dataset and evaluator view', async () => {
    granted.add('chatflows:update')
    const gate = { enabled: true, datasetId: 'ds-1', evaluatorIds: ['ev-1'], threshold: 100 }
    const missingDatasets = jest.fn()
    await controller.updateSettings(request({ publishGate: gate }), response(), missingDatasets)
    expect(missingDatasets.mock.calls[0][0]).toMatchObject({ statusCode: 403, message: 'You do not have permission to view datasets.' })
    expect(drafts.updateDraftSettings).not.toHaveBeenCalled()
    granted.add('datasets:view')
    const missingEvaluators = jest.fn()
    await controller.updateSettings(request({ publishGate: gate }), response(), missingEvaluators)
    expect(missingEvaluators.mock.calls[0][0]).toMatchObject({ statusCode: 403, message: 'You do not have permission to view evaluators.' })
    granted.add('evaluators:view')
    const res = response()
    await controller.updateSettings(request({ publishGate: gate }), res, jest.fn())
    expect(drafts.updateDraftSettings).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), { publishGate: gate })
    expect(res.json).toHaveBeenCalled()
    drafts.updateDraftSettings.mockClear()
    await controller.updateSettings(request({ publishGate: { enabled: false } }), response(), jest.fn())
    expect(drafts.updateDraftSettings).toHaveBeenCalled()
})

test('a caller without dataset or evaluator view does not receive those ids', async () => {
    const gate = {
        enabled: false,
        datasetId: 'ds-1',
        evaluatorIds: ['ev-1'],
        threshold: 100,
        block: null,
        result: {
            draftHash: 'abc',
            datasetId: 'ds-1',
            evaluatorIds: ['ev-1'],
            threshold: 100,
            passRate: 100,
            passed: 1,
            failed: 0,
            errored: 0,
            verdict: 'passed',
            checkedAt: '2026-10-13T00:00:00.000Z',
            contentHash: 'h',
            postProcessHash: 'p'
        }
    }
    const status = { mode: 'draft', publishGate: gate }
    drafts.getDraftStatus.mockResolvedValue(status)
    drafts.saveDraft.mockResolvedValue(status)
    drafts.updateDraftSettings.mockResolvedValue(status)
    granted.add('chatflows:view')
    granted.add('chatflows:update')
    const read = response()
    await controller.getDraft(request(), read, jest.fn())
    expect(read.json.mock.calls[0][0].publishGate).toMatchObject({
        enabled: false,
        datasetId: null,
        evaluatorIds: [],
        threshold: 100,
        block: null,
        result: { datasetId: '', evaluatorIds: [], verdict: 'passed', passed: 1, failed: 0, errored: 0, passRate: 100, threshold: 100 }
    })
    expect(JSON.stringify(read.json.mock.calls[0][0])).not.toContain('ds-1')
    expect(JSON.stringify(read.json.mock.calls[0][0])).not.toContain('ev-1')
    const saved = response()
    await controller.saveDraft(request({ flowData: '{"nodes":[],"edges":[]}' }), saved, jest.fn())
    expect(saved.json.mock.calls[0][0].publishGate.datasetId).toBeNull()
    expect(saved.json.mock.calls[0][0].publishGate.result.evaluatorIds).toEqual([])
    const updated = response()
    await controller.updateSettings(request({ publishGate: { enabled: false } }), updated, jest.fn())
    expect(updated.json.mock.calls[0][0].publishGate.datasetId).toBeNull()
    expect(updated.json.mock.calls[0][0].publishGate.evaluatorIds).toEqual([])
    expect(updated.json.mock.calls[0][0].publishGate.result.verdict).toBe('passed')
    granted.add('datasets:view')
    granted.add('evaluators:view')
    const visible = response()
    await controller.getDraft(request(), visible, jest.fn())
    expect(visible.json.mock.calls[0][0].publishGate.datasetId).toBe('ds-1')
    expect(visible.json.mock.calls[0][0].publishGate.evaluatorIds).toEqual(['ev-1'])
    expect(visible.json.mock.calls[0][0].publishGate.result.evaluatorIds).toEqual(['ev-1'])
})

test('a publish gate refusal does not write Live', async () => {
    granted.add('chatflows:update')
    drafts.draftToPublish.mockRejectedValueOnce(
        Object.assign(new Error('Publish needs a passing test set at 100%. There is no result for this draft yet.'), { statusCode: 409 })
    )
    const next = jest.fn()
    await controller.publishDraft(request(), response(), next)
    expect(next.mock.calls[0][0].statusCode).toBe(409)
    expect(updateChatflow).not.toHaveBeenCalled()
})

test('discards and changes Publish instantly', async () => {
    granted.add('chatflows:update')
    await controller.discardDraft(request(), response(), jest.fn())
    expect(drafts.discardDraft).toHaveBeenCalled()
    await controller.updateSettings(request({ publishInstantly: true }), response(), jest.fn())
    expect(drafts.setPublishInstantly).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), true)
})

test("checks the flow's own type: an agentflow needs the agentflow permission", async () => {
    getChatflowByIdForWorkspace.mockResolvedValue({ ...FLOW, type: 'AGENTFLOW' })
    granted.add('chatflows:update')
    granted.add('chatflows:view')
    for (const handler of [
        controller.getDraft,
        controller.saveDraft,
        controller.discardDraft,
        controller.updateSettings,
        controller.publishDraft,
        controller.rollbackLive
    ]) {
        const next = jest.fn()
        await handler(request({ flowData: '{}' }), response(), next)
        expect(next.mock.calls[0][0].statusCode).toBe(403)
    }
    expect(drafts.saveDraft).not.toHaveBeenCalled()
    granted.add('agentflows:view')
    const res = response()
    await controller.getDraft(request(), res, jest.fn())
    expect(res.json).toHaveBeenCalled()
})

test('viewing is not enough to save', async () => {
    granted.add('chatflows:view')
    const next = jest.fn()
    await controller.saveDraft(request({ flowData: '{}' }), response(), next)
    expect(next.mock.calls[0][0].statusCode).toBe(403)
})

test('a flow outside the workspace is passed on as its 404', async () => {
    granted.add('chatflows:view')
    const missing = Object.assign(new Error('not found'), { statusCode: 404 })
    getChatflowByIdForWorkspace.mockRejectedValue(missing)
    const next = jest.fn()
    await controller.getDraft(request(), response(), next)
    expect(next).toHaveBeenCalledWith(missing)
})

test('no workspace is a 404', async () => {
    const next = jest.fn()
    await controller.getDraft({ params: { chatflowId: FLOW.id }, user: {} } as any, response(), next)
    expect(next.mock.calls[0][0].statusCode).toBe(404)
})

describe('Publish', () => {
    const SHA = 'a'.repeat(40)
    beforeEach(() => {
        granted.add('chatflows:update')
        updateChatflow.mockImplementation(async (flow: any, update: any, _o: any, _w: any, _s: any, options: any) => {
            options?.onVersionQueued?.(Promise.resolve(SHA))
            return { ...flow, ...update, name: 'Sales Desk', updatedDate: '2026-10-08T17:00:00.000Z' }
        })
        versions.listVersions.mockResolvedValue({ versions: [{ sha: SHA, kind: 'publish', published: true }] })
    })

    it('saves the draft to Live through the normal update path and records a Published version', async () => {
        const res = response()
        const next = jest.fn()
        await controller.publishDraft(request({ overwriteLiveChanges: true }), res, next)
        expect(next).not.toHaveBeenCalled()
        expect(drafts.draftToPublish).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), true)
        const [current, update, orgId, workspaceId, subscriptionId, options] = updateChatflow.mock.calls[0]
        expect(current.id).toBe(FLOW.id)
        // Only the canvas: the draft holds no name or settings.
        expect(update).toEqual({ id: FLOW.id, flowData: '{"nodes":[{"id":"draft"}],"edges":[]}' })
        expect([orgId, workspaceId, subscriptionId]).toEqual(['org-1', 'team-a', 'sub-1'])
        expect(options.versionRecord).toEqual({ kind: 'publish', titlePrefix: 'Published: ' })
        // Saved only while Live is still the canvas the stale check was made against.
        expect(options.expectedFlowData).toBe(FLOW.flowData)
        expect(options.actor).toMatchObject({ id: 'user-1' })
        expect(drafts.afterLiveSet).toHaveBeenCalledWith(
            expect.objectContaining({ flowData: '{"nodes":[{"id":"draft"}],"edges":[]}' }),
            SHA,
            '{"nodes":[{"id":"draft"}],"edges":[]}'
        )
        const body = res.json.mock.calls[0][0]
        expect(body).toMatchObject({ unchanged: false, recorded: true, historyError: null, version: { sha: SHA, published: true } })
        expect(Object.keys(body.chatflow).sort()).toEqual(['flowData', 'id', 'name', 'type', 'updatedDate'])
        expect(body.chatflow.flowData).toBe('{"nodes":[{"id":"draft"}],"edges":[]}')
    })

    it('reports why history could not record the publish', async () => {
        updateChatflow.mockImplementation(async (flow: any, update: any, _o: any, _w: any, _s: any, options: any) => {
            options?.onVersionQueued?.(Promise.resolve(null))
            return { ...flow, ...update }
        })
        versions.lastErrorFor.mockReturnValueOnce('Not saved to history: secret-shaped text')
        const res = response()
        await controller.publishDraft(request(), res, jest.fn())
        expect(drafts.afterLiveSet).toHaveBeenCalledWith(expect.anything(), null, expect.any(String))
        expect(res.json.mock.calls[0][0]).toMatchObject({
            recorded: false,
            version: null,
            historyError: 'Not saved to history: secret-shaped text'
        })
    })

    it('a draft that already matches Live is cleared once the conditional save confirms Live still matches', async () => {
        drafts.draftToPublish.mockResolvedValueOnce(FLOW.flowData)
        versions.listVersions.mockClear()
        const res = response()
        await controller.publishDraft(request(), res, jest.fn())
        // The same compare-and-swap as a real publish, so a Live change landing meanwhile is caught (409).
        expect(updateChatflow.mock.calls[0][5].expectedFlowData).toBe(FLOW.flowData)
        expect(drafts.afterLiveSet).not.toHaveBeenCalled()
        // Only the draft that was checked: a newer one saved meanwhile is kept.
        expect(drafts.clearDraftIfStill).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), FLOW.flowData)
        expect(drafts.discardDraft).not.toHaveBeenCalled()
        expect(res.json.mock.calls[0][0]).toMatchObject({ unchanged: true, recorded: false })
    })

    it('a draft that matches Live is kept when Live moved during the publish', async () => {
        drafts.draftToPublish.mockResolvedValueOnce(FLOW.flowData)
        const moved = Object.assign(new Error('Live changed while publishing, so nothing was published. Try again.'), { statusCode: 409 })
        updateChatflow.mockRejectedValueOnce(moved)
        const next = jest.fn()
        await controller.publishDraft(request(), response(), next)
        expect(next).toHaveBeenCalledWith(moved)
        expect(drafts.clearDraftIfStill).not.toHaveBeenCalled()
    })

    it('passes on a refusal, such as nothing to publish or a stale draft, and saves nothing', async () => {
        const refused = Object.assign(new Error('There are no unpublished changes to publish.'), { statusCode: 409 })
        drafts.draftToPublish.mockRejectedValueOnce(refused)
        const next = jest.fn()
        await controller.publishDraft(request(), response(), next)
        expect(next).toHaveBeenCalledWith(refused)
        expect(updateChatflow).not.toHaveBeenCalled()
    })

    it.each(['CHATFLOW', 'AGENTFLOW', 'ETL'])('returns the Live canvas after publishing a %s', async (type) => {
        const permission = type === 'AGENTFLOW' ? 'agentflows:update' : 'chatflows:update'
        granted.clear()
        granted.add(permission)
        getChatflowByIdForWorkspace.mockResolvedValue({ ...FLOW, type })
        const res = response()
        await controller.publishDraft(request(), res, jest.fn())
        expect(res.json.mock.calls[0][0].chatflow).toMatchObject({
            type,
            flowData: '{"nodes":[{"id":"draft"}],"edges":[]}'
        })
    })

    it('viewing is not enough to publish', async () => {
        granted.clear()
        granted.add('chatflows:view')
        const next = jest.fn()
        await controller.publishDraft(request(), response(), next)
        expect(next.mock.calls[0][0].statusCode).toBe(403)
        expect(drafts.draftToPublish).not.toHaveBeenCalled()
    })
})

describe('Roll back Live', () => {
    const SHA = 'b'.repeat(40)
    beforeEach(() => {
        granted.add('chatflows:update')
    })

    it('puts the version Live as a rollback and keeps the draft', async () => {
        const saved = { ...FLOW, flowData: '{"nodes":[{"id":"old"}],"edges":[]}' }
        putVersionLive.mockResolvedValue({
            chatflow: saved,
            sha: SHA,
            body: {
                chatflow: { id: FLOW.id, name: 'n', type: FLOW.type, updatedDate: 'd' },
                restoredFrom: 'abcdef1',
                restoredTo: 'live',
                unchanged: false
            }
        })
        const res = response()
        const next = jest.fn()
        await controller.rollbackLive(request({ sha: 'abcdef1' }), res, next)
        expect(next).not.toHaveBeenCalled()
        expect(drafts.draftToPublish).not.toHaveBeenCalled()
        expect(putVersionLive).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: FLOW.id }), 'abcdef1', {
            kind: 'rollback',
            verb: 'Rolled back Live to'
        })
        expect(drafts.afterLiveSet).toHaveBeenCalledWith(saved, SHA)
        expect(res.json.mock.calls[0][0]).toMatchObject({
            restoredFrom: 'abcdef1',
            restoredTo: 'live',
            status: { draft: null },
            chatflow: { flowData: saved.flowData }
        })
    })

    it('a version that already matches Live saves nothing and still returns the Live canvas', async () => {
        putVersionLive.mockResolvedValue({
            chatflow: null,
            sha: null,
            body: {
                chatflow: { id: FLOW.id, name: 'n', type: FLOW.type, updatedDate: 'd' },
                unchanged: true
            }
        })
        const res = response()
        await controller.rollbackLive(request({ sha: 'abcdef1' }), res, jest.fn())
        expect(drafts.afterLiveSet).not.toHaveBeenCalled()
        expect(drafts.getDraftStatus).toHaveBeenCalled()
        expect(res.json.mock.calls[0][0]).toMatchObject({
            unchanged: true,
            chatflow: { flowData: FLOW.flowData }
        })
    })

    it.each(['CHATFLOW', 'AGENTFLOW', 'ETL'])('returns that version canvas after rolling back a %s with no draft', async (type) => {
        const permission = type === 'AGENTFLOW' ? 'agentflows:update' : 'chatflows:update'
        granted.clear()
        granted.add(permission)
        const version = '{"nodes":[{"id":"rolled"}],"edges":[]}'
        getChatflowByIdForWorkspace.mockResolvedValue({ ...FLOW, type, flowData: FLOW.flowData })
        const saved = { ...FLOW, type, flowData: version }
        putVersionLive.mockResolvedValue({
            chatflow: saved,
            sha: SHA,
            body: {
                chatflow: { id: FLOW.id, name: 'n', type, updatedDate: 'd' },
                restoredTo: 'live',
                unchanged: false
            }
        })
        const res = response()
        await controller.rollbackLive(request({ sha: 'abcdef1' }), res, jest.fn())
        expect(res.json.mock.calls[0][0].chatflow).toMatchObject({ type, flowData: version })
    })

    it('needs a version id, and drafts on', async () => {
        for (const body of [{}, { sha: 'XYZ' }, { sha: 12345678 }]) {
            const next = jest.fn()
            await controller.rollbackLive(request(body), response(), next)
            expect(next.mock.calls[0][0].statusCode).toBe(400)
        }
        drafts.isDraftsEnabled.mockReturnValue(false)
        const next = jest.fn()
        await controller.rollbackLive(request({ sha: 'abcdef1' }), response(), next)
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 409, message: expect.stringContaining('Restore') })
        expect(putVersionLive).not.toHaveBeenCalled()
    })
})

describe('the publish check', () => {
    function checkRequest(body: any = {}, params: any = {}) {
        const req = request(body)
        req.params = { chatflowId: FLOW.id, ...params }
        req.protocol = 'http'
        req.get = (name: string) => (name === 'host' ? 'cuttlely.test:3000' : undefined)
        return req
    }
    function accepted() {
        const res = response()
        res.status = jest.fn(() => res)
        return res
    }

    it('reads the setup with view permission', async () => {
        granted.add('chatflows:view')
        const res = response()
        await controller.getCheckSetup(checkRequest(), res, jest.fn())
        expect(checkService.getCheckSetup).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), undefined, {
            datasets: false,
            evaluators: false
        })
        expect(res.json).toHaveBeenCalledWith({ unavailable: null, questions: [] })
    })

    it('refuses a new check when the publish check is off, and still lists, reads, and stops one', async () => {
        process.env.CUTTLELY_PUBLISH_CHECK = 'false'
        resetRuntimeLimitsForTests()
        granted.add('chatflows:view')
        granted.add('chatflows:update')
        checkService.getCheck.mockResolvedValueOnce({ id: 'c1', status: 'running' })
        try {
            const history = response()
            await controller.getCheckHistory(checkRequest(), history, jest.fn())
            expect(listQuestionHistory).toHaveBeenCalled()
            expect(history.json).toHaveBeenCalled()
            const startNext = jest.fn()
            await controller.startCheck(checkRequest({ questionIds: ['chat:1'] }), accepted(), startNext)
            expect(startNext.mock.calls[0][0]).toMatchObject({
                statusCode: 409,
                message: 'The publish check is turned off on this server.'
            })
            expect(checkService.startCheck).not.toHaveBeenCalled()
            const read = response()
            await controller.getCheck(checkRequest({}, { checkId: 'c1' }), read, jest.fn())
            expect(checkService.getCheck).toHaveBeenCalled()
            expect(read.status).not.toHaveBeenCalled()
            expect(read.json).toHaveBeenCalledWith({ id: 'c1', status: 'running' })
            const stop = response()
            await controller.stopCheck(checkRequest({}, { checkId: 'c1' }), stop, jest.fn())
            expect(checkService.stopCheck).toHaveBeenCalled()
            expect(stop.json).toHaveBeenCalledWith({ id: 'c1', status: 'stopped' })
        } finally {
            delete process.env.CUTTLELY_PUBLISH_CHECK
            resetRuntimeLimitsForTests()
        }
    })

    it('starts a check with update permission, answers 202, and passes the server address', async () => {
        granted.add('chatflows:update')
        const res = accepted()
        await controller.startCheck(checkRequest({ questions: ['Hi'] }), res, jest.fn())
        expect(checkService.startCheck).toHaveBeenCalledWith(
            expect.objectContaining({ id: FLOW.id }),
            { questions: ['Hi'] },
            'http://cuttlely.test:3000',
            { caller: { via: 'session' }, watch: expect.objectContaining({ closed: expect.any(Function) }) }
        )
        expect(res.status).toHaveBeenCalledWith(202)
    })

    it('a consumed body on a live socket still starts the check', async () => {
        granted.add('chatflows:update')
        checkService.startCheck.mockImplementation(async () => ({ id: 'c-live', status: 'running' }))
        const req = checkRequest({ count: 4 }) as any
        req.destroyed = true
        req.aborted = false
        req.on = jest.fn()
        req.socket = { destroyed: false, on: jest.fn() }
        const res = accepted() as any
        res.on = jest.fn()
        res.writableFinished = false
        await controller.startCheck(req, res, jest.fn())
        expect(checkService.startCheck).toHaveBeenCalled()
        expect(checkService.stopCheck).not.toHaveBeenCalled()
        expect(res.status).toHaveBeenCalledWith(202)
        expect(res.json).toHaveBeenCalledWith({ id: 'c-live', status: 'running' })
    })

    it('stops the owned check when the socket errors after the 202 is written', async () => {
        granted.add('chatflows:update')
        checkService.startCheck.mockResolvedValue({ id: 'c-reset', status: 'running' })
        const handlers = new Map<string, (...args: any[]) => void>()
        const emitter = (prefix: string) => ({
            on: (event: string, handler: (...args: any[]) => void) => handlers.set(`${prefix}:${event}`, handler),
            off: (event: string) => handlers.delete(`${prefix}:${event}`)
        })
        const req = checkRequest({ questions: ['Hi'] }) as any
        Object.assign(req, emitter('req'))
        req.aborted = false
        req.socket = { destroyed: false, ...emitter('sock') }
        const res = accepted() as any
        Object.assign(res, emitter('res'))
        res.writableFinished = false
        await controller.startCheck(req, res, jest.fn())
        expect(res.status).toHaveBeenCalledWith(202)
        res.writableFinished = true
        handlers.get('res:finish')?.()
        handlers.get('sock:error')?.(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
        expect(checkService.stopCheck).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), 'c-reset')
        expect(handlers.has('sock:error')).toBe(false)
        await new Promise((resolve) => setImmediate(resolve))
        handlers.get('sock:close')?.()
        expect(checkService.stopCheck).toHaveBeenCalledTimes(1)
    })

    it('a delivered 202 ignores a later clean close', async () => {
        granted.add('chatflows:update')
        checkService.startCheck.mockResolvedValue({ id: 'c-kept', status: 'running' })
        const handlers = new Map<string, (...args: any[]) => void>()
        const emitter = (prefix: string) => ({
            on: (event: string, handler: (...args: any[]) => void) => handlers.set(`${prefix}:${event}`, handler),
            off: (event: string) => handlers.delete(`${prefix}:${event}`)
        })
        const req = checkRequest({ questions: ['Hi'] }) as any
        Object.assign(req, emitter('req'))
        req.socket = { destroyed: false, ...emitter('sock') }
        const res = accepted() as any
        Object.assign(res, emitter('res'))
        res.writableFinished = false
        await controller.startCheck(req, res, jest.fn())
        res.writableFinished = true
        handlers.get('res:finish')?.()
        await new Promise((resolve) => setImmediate(resolve))
        expect(handlers.has('sock:error')).toBe(false)
        handlers.get('sock:close')?.()
        handlers.get('sock:error')?.(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
        expect(checkService.stopCheck).not.toHaveBeenCalled()
    })

    it('stops only the check this request created when the client is already gone', async () => {
        granted.add('chatflows:update')
        checkService.startCheck.mockResolvedValue({ id: 'cli-new', status: 'running' })
        const req = checkRequest({ count: 4 }) as any
        req.destroyed = true
        req.on = jest.fn()
        req.socket = { destroyed: true, on: jest.fn() }
        const res = accepted() as any
        res.on = jest.fn()
        res.writableFinished = false
        await controller.startCheck(req, res, jest.fn())
        expect(checkService.stopCheck).toHaveBeenCalledTimes(1)
        expect(checkService.stopCheck).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), 'cli-new')
        expect(res.status).not.toHaveBeenCalled()
    })

    it('does not stop a check when the start fails before it has an id', async () => {
        granted.add('chatflows:update')
        checkService.startCheck.mockRejectedValue(Object.assign(new Error('cancelled'), { statusCode: 400 }))
        const req = checkRequest({ count: 4 }) as any
        req.destroyed = true
        req.on = jest.fn()
        req.socket = { destroyed: true, on: jest.fn() }
        const res = accepted() as any
        res.on = jest.fn()
        const next = jest.fn()
        await controller.startCheck(req, res, next)
        expect(next).toHaveBeenCalled()
        expect(checkService.stopCheck).not.toHaveBeenCalled()
    })

    it('reads and stops a check by id', async () => {
        granted.add('chatflows:view')
        granted.add('chatflows:update')
        await controller.getCheck(checkRequest({}, { checkId: 'c1' }), response(), jest.fn())
        expect(checkService.getCheck).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), 'c1', undefined, {
            datasets: false,
            evaluators: false
        })
        await controller.stopCheck(checkRequest({}, { checkId: 'c1' }), response(), jest.fn())
        expect(checkService.stopCheck).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), 'c1', undefined, {
            datasets: false,
            evaluators: false
        })
    })

    it('a viewer cannot start or stop a check', async () => {
        granted.add('chatflows:view')
        for (const handler of [controller.startCheck, controller.stopCheck]) {
            const next = jest.fn()
            await handler(checkRequest({ questions: ['Hi'] }, { checkId: 'c1' }), accepted(), next)
            expect(next.mock.calls[0][0].statusCode).toBe(403)
        }
        expect(checkService.startCheck).not.toHaveBeenCalled()
        expect(checkService.stopCheck).not.toHaveBeenCalled()
    })

    it('a dataset needs datasets:view, and evaluators need evaluators:view', async () => {
        granted.add('chatflows:update')
        const next = jest.fn()
        await controller.startCheck(checkRequest({ datasetId: 'ds-1', evaluatorIds: ['ev-1'] }), accepted(), next)
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403, message: 'You do not have permission to view datasets.' })
        expect(checkService.startCheck).not.toHaveBeenCalled()

        granted.add('datasets:view')
        const nextEval = jest.fn()
        await controller.startCheck(checkRequest({ datasetId: 'ds-1', evaluatorIds: ['ev-1'] }), accepted(), nextEval)
        expect(nextEval.mock.calls[0][0]).toMatchObject({ statusCode: 403, message: 'You do not have permission to view evaluators.' })
        expect(checkService.startCheck).not.toHaveBeenCalled()

        granted.add('evaluators:view')
        checkService.startCheck.mockResolvedValue({ id: 'c1', status: 'running' })
        const res = accepted()
        await controller.startCheck(checkRequest({ datasetId: 'ds-1', evaluatorIds: ['ev-1'] }), res, jest.fn())
        expect(checkService.startCheck).toHaveBeenCalledWith(
            expect.objectContaining({ id: FLOW.id }),
            { datasetId: 'ds-1', evaluatorIds: ['ev-1'] },
            'http://cuttlely.test:3000',
            { caller: { via: 'session' }, watch: expect.objectContaining({ closed: expect.any(Function) }) }
        )
        expect(res.status).toHaveBeenCalledWith(202)
    })

    it('a viewer without dataset or evaluator permission polls setup and the check with those fields hidden', async () => {
        granted.add('chatflows:view')
        const setupRes = response()
        await controller.getCheckSetup(checkRequest(), setupRes, jest.fn())
        expect(checkService.getCheckSetup).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), undefined, {
            datasets: false,
            evaluators: false
        })
        const checkRes = response()
        await controller.getCheck(checkRequest({}, { checkId: 'c1' }), checkRes, jest.fn())
        expect(checkService.getCheck).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), 'c1', undefined, {
            datasets: false,
            evaluators: false
        })
        granted.add('datasets:view')
        granted.add('evaluators:view')
        await controller.getCheckSetup(checkRequest(), response(), jest.fn())
        expect(checkService.getCheckSetup).toHaveBeenLastCalledWith(expect.objectContaining({ id: FLOW.id }), undefined, {
            datasets: true,
            evaluators: true
        })
        await controller.getCheck(checkRequest({}, { checkId: 'c1' }), response(), jest.fn())
        expect(checkService.getCheck).toHaveBeenLastCalledWith(expect.objectContaining({ id: FLOW.id }), 'c1', undefined, {
            datasets: true,
            evaluators: true
        })
    })

    it('a recent-question check does not ask for dataset or evaluator permission', async () => {
        granted.add('chatflows:update')
        await controller.startCheck(checkRequest({ count: 4 }), accepted(), jest.fn())
        expect(checkService.startCheck).toHaveBeenCalledWith(expect.anything(), { count: 4 }, 'http://cuttlely.test:3000', {
            caller: { via: 'session' },
            watch: expect.objectContaining({ closed: expect.any(Function) })
        })
    })

    it('signs question history with the API key id', async () => {
        granted.add('chatflows:view')
        for (const keyId of ['key-a', 'key-b']) {
            const req = checkRequest()
            delete req.user.id
            req.user.apiKeyId = keyId
            req.user.activeWorkspaceId = 'team-a'
            req.query = { limit: '1' }
            await controller.getCheckHistory(req, response(), jest.fn())
            expect(listQuestionHistory).toHaveBeenLastCalledWith(expect.objectContaining({ id: FLOW.id }), { limit: '1' }, `key:${keyId}`)
        }
    })

    it('lists question history for a viewer and does not store the response', async () => {
        granted.add('chatflows:view')
        const req = checkRequest()
        req.query = { limit: '50' }
        const res = response()
        await controller.getCheckHistory(req, res, jest.fn())
        expect(listQuestionHistory).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), { limit: '50' }, 'user:user-1')
        expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
        expect(res.status).toHaveBeenCalledWith(200)
        expect(res.json).toHaveBeenCalledWith({ items: [], nextCursor: null })
    })

    it('sends stored question text on 200 with Cache-Control no-store', async () => {
        granted.add('chatflows:view')
        const text = 'Do you have rye loaves today?'
        listQuestionHistory.mockResolvedValueOnce({
            items: [{ id: 'chat:a', text, source: 'chat', date: '2026-10-08T16:12:03.000Z', replayable: true }],
            nextCursor: null
        })
        const res = response()
        await controller.getCheckHistory(checkRequest(), res, jest.fn())
        expect(res.status).toHaveBeenCalledWith(200)
        expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
        expect(res.json).toHaveBeenCalledWith({
            items: [{ id: 'chat:a', text, source: 'chat', date: '2026-10-08T16:12:03.000Z', replayable: true }],
            nextCursor: null
        })
        const statusOrder = res.status.mock.invocationCallOrder[0]
        const headerOrder = res.setHeader.mock.invocationCallOrder[0]
        const jsonOrder = res.json.mock.invocationCallOrder[0]
        expect(headerOrder).toBeLessThan(jsonOrder)
        expect(statusOrder).toBeLessThan(jsonOrder)
    })

    it('refuses question history when the caller can update the flow but cannot read its messages', async () => {
        granted.add('chatflows:update')
        const next = jest.fn()
        await controller.getCheckHistory(checkRequest(), response(), next)
        expect(next.mock.calls[0][0].statusCode).toBe(403)
        expect(listQuestionHistory).not.toHaveBeenCalled()
    })

    it('refuses question history for an API key that can run a check and cannot read messages', async () => {
        granted.add('chatflows:update')
        const req = checkRequest()
        delete req.user.id
        const next = jest.fn()
        await controller.getCheckHistory(req, response(), next)
        expect(next.mock.calls[0][0].statusCode).toBe(403)
        expect(listQuestionHistory).not.toHaveBeenCalled()
    })

    it('passes on the same 404 when the flow is outside the workspace', async () => {
        granted.add('chatflows:view')
        const missing = Object.assign(new Error('not found'), { statusCode: 404 })
        getChatflowByIdForWorkspace.mockRejectedValue(missing)
        const next = jest.fn()
        await controller.getCheckHistory(checkRequest(), response(), next)
        expect(next).toHaveBeenCalledWith(missing)
        expect(listQuestionHistory).not.toHaveBeenCalled()
    })

    it('treats a null questionIds list as absent for an update-only key', async () => {
        granted.add('chatflows:update')
        const req = checkRequest({ questionIds: null, count: 4 })
        delete req.user.id
        const res = accepted()
        const next = jest.fn()
        await controller.startCheck(req, res, next)
        expect(next).not.toHaveBeenCalled()
        expect(res.status).toHaveBeenCalledWith(202)
        expect(checkService.startCheck).toHaveBeenCalledWith(
            expect.objectContaining({ id: FLOW.id }),
            { questionIds: null, count: 4 },
            'http://cuttlely.test:3000',
            { caller: { via: 'api_key', apiKeyId: '', harnesses: [] }, watch: expect.objectContaining({ closed: expect.any(Function) }) }
        )
    })

    it('refuses questionIds when the caller can run a check but cannot read messages', async () => {
        for (const userId of ['user-1', undefined]) {
            granted.clear()
            granted.add('chatflows:update')
            const req = checkRequest({ questionIds: ['chat:11111111-1111-4111-8111-111111111111'] })
            if (!userId) delete req.user.id
            const next = jest.fn()
            await controller.startCheck(req, accepted(), next)
            expect(next.mock.calls[0][0].statusCode).toBe(403)
            expect(next.mock.calls[0][0].message).not.toContain('11111111')
        }
        expect(checkService.startCheck).not.toHaveBeenCalled()
    })

    it('answers bad question ids with a count and no question text', async () => {
        granted.add('chatflows:view')
        granted.add('chatflows:update')
        const secret = 'Do you have rye loaves today?'
        checkService.startCheck.mockRejectedValueOnce(new BadQuestionIdsError(2))
        const res = accepted()
        await controller.startCheck(
            checkRequest({ questionIds: ['chat:11111111-1111-4111-8111-111111111111'], questions: [secret] }),
            res,
            jest.fn()
        )
        expect(res.status).toHaveBeenCalledWith(400)
        expect(res.json).toHaveBeenCalledWith({
            code: 'CHECK_BAD_QUESTION_IDS',
            message: '2 questions cannot be checked.',
            badCount: 2,
            errors: []
        })
        checkService.startCheck.mockRejectedValueOnce(new BadQuestionIdsError(1, [{ index: 0, reason: 'files' }]))
        const detailed = accepted()
        await controller.startCheck(
            checkRequest({ questionIds: ['chat:11111111-1111-4111-8111-111111111111'], questions: [secret] }),
            detailed,
            jest.fn()
        )
        expect(detailed.json).toHaveBeenCalledWith({
            code: 'CHECK_BAD_QUESTION_IDS',
            message: 'Position 1 was sent with a file.',
            badCount: 1,
            errors: [{ index: 0, reason: 'files' }]
        })
        expect(JSON.stringify(detailed.json.mock.calls)).not.toContain(secret)
        expect(JSON.stringify(res.json.mock.calls)).not.toContain(secret)
    })
})
