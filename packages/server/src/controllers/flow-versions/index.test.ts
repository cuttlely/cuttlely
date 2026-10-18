const getChatflowByIdForWorkspace = jest.fn()
const updateChatflow = jest.fn()
jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowByIdForWorkspace: (...args: any[]) => getChatflowByIdForWorkspace(...args),
        updateChatflow: (...args: any[]) => updateChatflow(...args)
    }
}))

const EMPTY_DIFF = { added: [], removed: [], changed: [], moved: [], edgesChanged: false, renamed: null }
const versions = {
    isVersioningEnabled: jest.fn(() => true),
    getVersion: jest.fn(),
    listVersions: jest.fn(),
    diffVersion: jest.fn(),
    hasChanges: jest.fn(
        (diff: any) => diff.added.length + diff.removed.length + diff.changed.length + diff.moved.length > 0 || diff.edgesChanged
    ),
    hiddenInputsDiffer: jest.fn(() => false),
    lastErrorFor: jest.fn(() => null as string | null),
    restoreTitle: jest.fn((sha: string, title?: string, verb = 'Restored') => `${verb}: ${title} (${sha.slice(0, 7)})`),
    liveVersionSha: jest.fn(async (): Promise<string | null> => null)
}
jest.mock('../../services/flow-versions', () => ({ __esModule: true, default: versions }))
const drafts = {
    getDraftStatus: jest.fn(async (): Promise<any> => ({ mode: 'live', lastPublished: null })),
    draftToPublish: jest.fn(),
    saveDraft: jest.fn(async (): Promise<any> => ({ mode: 'draft', draft: { flowData: '{"nodes":[1],"edges":[]}' } }))
}
jest.mock('../../services/flow-drafts', () => {
    const { redactDraftStatus } = jest.requireActual('../../services/flow-drafts/gate')
    return { __esModule: true, default: drafts, redactDraftStatus }
})
jest.mock('../../database/entities/ChatFlow', () => ({ ChatFlow: class ChatFlow {} }))

const granted = new Set<string>()
jest.mock('../../identity/rbac', () => ({
    hasAnyPermission: jest.fn(async (_req: any, ...permissions: string[]) => permissions.some((item) => granted.has(item)))
}))

import controller, { putVersionLive } from './index'

const FLOW = {
    id: '0b5c3a1e-1111-2222-3333-444455556666',
    name: 'Sales Desk',
    type: 'CHATFLOW',
    flowData: '{"nodes":[],"edges":[]}',
    workspaceId: 'team-a'
}

function request(sha = 'abcdef1') {
    return {
        params: { chatflowId: FLOW.id, sha },
        query: {},
        user: {
            id: 'user-1',
            name: 'Dana',
            email: 'dana@example.com',
            activeWorkspaceId: 'team-a',
            activeOrganizationId: 'org-1',
            activeOrganizationSubscriptionId: 'sub-1'
        }
    } as any
}

function response() {
    const res: any = {}
    res.json = jest.fn(() => res)
    return res
}

// updateChatflow as the service runs it: it hands this save's own history result to onVersionQueued.
function savesAndRecords(sha: string | null) {
    updateChatflow.mockImplementation(async (_flow: any, update: any, _o: any, _w: any, _s: any, options: any) => {
        options?.onVersionQueued?.(Promise.resolve(sha))
        return { ...FLOW, ...update, updatedDate: '2026-10-08T07:00:00.000Z' }
    })
}

describe('restore a version', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        drafts.getDraftStatus.mockResolvedValue({ mode: 'live', lastPublished: null })
        granted.clear()
        granted.add('chatflows:update')
        versions.isVersioningEnabled.mockReturnValue(true)
        versions.lastErrorFor.mockReturnValue(null)
        versions.hiddenInputsDiffer.mockReturnValue(false)
        getChatflowByIdForWorkspace.mockResolvedValue({ ...FLOW })
        versions.getVersion.mockResolvedValue({
            sha: 'abcdef1',
            name: 'Sales Desk',
            type: 'CHATFLOW',
            flowData: '{"nodes":[1],"edges":[]}',
            missingCredentials: []
        })
        versions.diffVersion.mockResolvedValue({ ...EMPTY_DIFF, changed: [{ id: 'n1', label: 'Harness Prime', fields: ['instructions'] }] })
        versions.listVersions.mockResolvedValue({
            versions: [
                { sha: '1234567aaaa', kind: 'restore', title: 'Restored: Changed instructions (abcdef1)' },
                { sha: 'abcdef1234', title: 'Changed instructions' }
            ]
        })
        savesAndRecords('1234567aaaa')
    })

    it('passes on where secret-looking text was hidden in the restored version', async () => {
        const hidden = [{ node: 'n1', label: 'Harness Prime', input: 'instructions', inputLabel: 'Instructions', count: 1 }]
        versions.getVersion.mockResolvedValue({
            sha: 'abcdef1',
            name: 'Sales Desk',
            type: 'CHATFLOW',
            flowData: '{"nodes":[1],"edges":[]}',
            missingCredentials: [],
            ambiguousCredentials: [],
            hiddenSecrets: hidden
        })
        const res = response()
        await controller.restoreVersion(request(), res, jest.fn())
        expect(res.json.mock.calls[0][0].hiddenSecrets).toEqual(hidden)
    })

    it('passes on which credential was picked when several share a name', async () => {
        const ambiguous = [{ name: 'OpenAI main', credentialName: 'openAIApi', count: 2, using: 'current' }]
        versions.getVersion.mockResolvedValue({
            sha: 'abcdef1',
            name: 'Sales Desk',
            type: 'CHATFLOW',
            flowData: '{"nodes":[1],"edges":[]}',
            missingCredentials: [],
            ambiguousCredentials: ambiguous
        })
        const res = response()
        await controller.restoreVersion(request(), res, jest.fn())
        expect(res.json.mock.calls[0][0].ambiguousCredentials).toEqual(ambiguous)
    })

    it('puts the version Live without asking the publish gate', async () => {
        drafts.getDraftStatus.mockResolvedValue({
            mode: 'live',
            reason: 'publish-instantly',
            publishGate: { enabled: true, block: 'Publish needs a passing test set at 100%. There is no result for this draft yet.' }
        })
        const res = response()
        await controller.restoreVersion(request(), res, jest.fn())
        expect(updateChatflow).toHaveBeenCalled()
        expect(drafts.saveDraft).not.toHaveBeenCalled()
        expect(drafts.draftToPublish).not.toHaveBeenCalled()
        expect(res.json.mock.calls[0][0].restoredTo).toBe('live')
    })

    it('saves the version through the normal update path, labeling that one save as a restore', async () => {
        const res = response()
        const next = jest.fn()
        await controller.restoreVersion(request(), res, next)
        expect(next).not.toHaveBeenCalled()
        expect(getChatflowByIdForWorkspace).toHaveBeenCalledWith(FLOW.id, 'team-a')
        const [current, update, orgId, workspaceId, subscriptionId, options] = updateChatflow.mock.calls[0]
        expect(current.id).toBe(FLOW.id)
        expect(update).toMatchObject({ id: FLOW.id, name: 'Sales Desk', type: 'CHATFLOW', flowData: '{"nodes":[1],"edges":[]}' })
        expect([orgId, workspaceId, subscriptionId]).toEqual(['org-1', 'team-a', 'sub-1'])
        expect(options.versionRecord).toEqual({ kind: 'restore', title: 'Restored: Changed instructions (abcdef1)' })
        expect(options.expectedFlowData).toBe(FLOW.flowData)
        // The restoring user is the author; the email is not passed on.
        expect(options.actor).toEqual({ id: 'user-1', name: 'Dana' })
        const body = res.json.mock.calls[0][0]
        expect(body).toMatchObject({ restoredFrom: 'abcdef1', restoredTo: 'live', unchanged: false, recorded: true, historyError: null })
        expect(body.ambiguousCredentials).toEqual([])
        expect(body.hiddenSecrets).toEqual([])
        expect(body.version.sha).toBe('1234567aaaa')
        expect(Object.keys(body.chatflow).sort()).toEqual(['id', 'name', 'type', 'updatedDate'])
        expect(body.chatflow.flowData).toBeUndefined()
    })

    it('brings the saved type back, and needs permission for both types', async () => {
        versions.getVersion.mockResolvedValue({
            sha: 'abcdef1',
            name: 'Sales Desk',
            type: 'AGENTFLOW',
            flowData: '{"nodes":[1],"edges":[]}',
            missingCredentials: []
        })
        versions.diffVersion.mockResolvedValue({ ...EMPTY_DIFF })
        const denied = jest.fn()
        await controller.restoreVersion(request(), response(), denied)
        expect(denied.mock.calls[0][0].statusCode).toBe(403)
        expect(updateChatflow).not.toHaveBeenCalled()

        granted.add('agentflows:update')
        const res = response()
        await controller.restoreVersion(request(), res, jest.fn())
        expect(updateChatflow.mock.calls[0][1].type).toBe('AGENTFLOW')
        expect(res.json.mock.calls[0][0]).toMatchObject({ unchanged: false, chatflow: { type: 'AGENTFLOW' } })
    })

    it('a view-only user cannot restore', async () => {
        granted.clear()
        const next = jest.fn()
        await controller.restoreVersion(request(), response(), next)
        expect(next.mock.calls[0][0].statusCode).toBe(403)
        expect(updateChatflow).not.toHaveBeenCalled()
    })

    it('says unchanged, without saving, when the flow already matches the version', async () => {
        versions.diffVersion.mockResolvedValue({ ...EMPTY_DIFF })
        const res = response()
        await controller.restoreVersion(request(), res, jest.fn())
        expect(updateChatflow).not.toHaveBeenCalled()
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ unchanged: true, recorded: false, version: null }))
    })

    it('saves when the only difference is a live secret where the version holds a placeholder', async () => {
        versions.diffVersion.mockResolvedValue({ ...EMPTY_DIFF })
        versions.hiddenInputsDiffer.mockReturnValue(true)
        const res = response()
        await controller.restoreVersion(request(), res, jest.fn())
        expect(updateChatflow).toHaveBeenCalled()
        expect(res.json.mock.calls[0][0]).toMatchObject({ unchanged: false, recorded: true })
    })

    it('a saved restore whose history write failed is not reported as unchanged', async () => {
        savesAndRecords(null)
        versions.lastErrorFor.mockReturnValue('git was not found on PATH. Version history is off until git is installed.')
        const res = response()
        await controller.restoreVersion(request(), res, jest.fn())
        expect(updateChatflow).toHaveBeenCalled()
        expect(res.json.mock.calls[0][0]).toMatchObject({
            unchanged: false,
            recorded: false,
            version: null,
            historyError: 'git was not found on PATH. Version history is off until git is installed.'
        })
    })

    it('a flow from another workspace is not found and nothing is saved', async () => {
        getChatflowByIdForWorkspace.mockRejectedValue(Object.assign(new Error('Chatflow not found'), { statusCode: 404 }))
        const next = jest.fn()
        await controller.restoreVersion(request(), response(), next)
        expect(next).toHaveBeenCalled()
        expect(updateChatflow).not.toHaveBeenCalled()
    })

    it('rejects a bad version id before any lookup', async () => {
        const next = jest.fn()
        await controller.restoreVersion(request('not-a-sha'), response(), next)
        expect(next.mock.calls[0][0].statusCode).toBe(400)
        expect(getChatflowByIdForWorkspace).not.toHaveBeenCalled()
    })

    it('an unknown version is a 404, and a failed save is passed on', async () => {
        versions.getVersion.mockResolvedValueOnce(null)
        const next = jest.fn()
        await controller.restoreVersion(request(), response(), next)
        expect(next.mock.calls[0][0].statusCode).toBe(404)
        expect(updateChatflow).not.toHaveBeenCalled()

        updateChatflow.mockRejectedValueOnce(new Error('Harness Prime needs a chat model'))
        const failed = jest.fn()
        await controller.restoreVersion(request(), response(), failed)
        expect(failed.mock.calls[0][0].message).toBe('Harness Prime needs a chat model')
    })

    it('refuses when history is off', async () => {
        versions.isVersioningEnabled.mockReturnValue(false)
        const next = jest.fn()
        await controller.restoreVersion(request(), response(), next)
        expect(next.mock.calls[0][0].statusCode).toBe(409)
        expect(updateChatflow).not.toHaveBeenCalled()
    })
})

describe('restore while the canvas saves to a draft', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        granted.clear()
        granted.add('chatflows:update')
        versions.isVersioningEnabled.mockReturnValue(true)
        getChatflowByIdForWorkspace.mockResolvedValue({ ...FLOW })
        drafts.getDraftStatus.mockResolvedValue({ mode: 'draft', lastPublished: null })
        versions.getVersion.mockResolvedValue({
            sha: 'abcdef1',
            name: 'Old name',
            type: 'CHATFLOW',
            flowData: '{"nodes":[1],"edges":[]}',
            missingCredentials: []
        })
    })

    it('opens the version as a draft when the publish gate is on, and leaves Live alone', async () => {
        drafts.getDraftStatus.mockResolvedValue({
            mode: 'draft',
            publishGate: { enabled: true, block: 'Publish needs a passing test set at 100%. There is no result for this draft yet.' }
        })
        const res = response()
        await controller.restoreVersion(request(), res, jest.fn())
        expect(updateChatflow).not.toHaveBeenCalled()
        expect(drafts.draftToPublish).not.toHaveBeenCalled()
        expect(drafts.saveDraft).toHaveBeenCalled()
        expect(res.json.mock.calls[0][0].restoredTo).toBe('draft')
    })

    it('puts the version in the draft and leaves Live alone', async () => {
        const res = response()
        await controller.restoreVersion(request(), res, jest.fn())
        expect(updateChatflow).not.toHaveBeenCalled()
        expect(drafts.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), '{"nodes":[1],"edges":[]}', {
            userId: 'user-1',
            orgId: 'org-1',
            subscriptionId: 'sub-1',
            caller: { via: 'session' }
        })
        const body = res.json.mock.calls[0][0]
        expect(body).toMatchObject({ restoredFrom: 'abcdef1', restoredTo: 'draft', unchanged: false, recorded: false, version: null })
        // The draft holds the canvas only: the name stays.
        expect(body.chatflow.name).toBe('Sales Desk')
    })

    it('says unchanged when the version matches Live, so there is nothing to publish', async () => {
        drafts.saveDraft.mockResolvedValueOnce({ mode: 'draft', draft: null })
        const res = response()
        await controller.restoreVersion(request(), res, jest.fn())
        expect(res.json.mock.calls[0][0]).toMatchObject({ restoredTo: 'draft', unchanged: true })
    })

    it('a version of another kind of flow cannot become the draft', async () => {
        granted.add('agentflows:update')
        versions.getVersion.mockResolvedValue({ sha: 'abcdef1', name: 'x', type: 'AGENTFLOW', flowData: '{}', missingCredentials: [] })
        const next = jest.fn()
        await controller.restoreVersion(request(), response(), next)
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 409, message: expect.stringContaining('Roll back Live') })
        expect(drafts.saveDraft).not.toHaveBeenCalled()
    })

    it('still needs the update permission', async () => {
        granted.clear()
        granted.add('chatflows:view')
        const next = jest.fn()
        await controller.restoreVersion(request(), response(), next)
        expect(next.mock.calls[0][0].statusCode).toBe(403)
        expect(drafts.saveDraft).not.toHaveBeenCalled()
    })
})

describe('the version list', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        getChatflowByIdForWorkspace.mockResolvedValue({ ...FLOW })
    })

    it('says which version is Live and when Live was last published', async () => {
        const list = { enabled: true, versions: [{ sha: 'f'.repeat(40), kind: 'publish', published: true }], lastError: null }
        versions.listVersions.mockResolvedValue(list)
        versions.liveVersionSha.mockResolvedValue('f'.repeat(40))
        const lastPublished = { sha: 'f'.repeat(40), date: '2026-10-08T17:00:00.000Z' }
        drafts.getDraftStatus.mockResolvedValue({ mode: 'draft', lastPublished })
        const res = response()
        await controller.listVersions(request(), res, jest.fn())
        expect(versions.liveVersionSha).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW.id }), list.versions)
        expect(res.json).toHaveBeenCalledWith({ ...list, liveSha: 'f'.repeat(40), lastPublished })
    })

    it('has no Live marker when history is off', async () => {
        versions.listVersions.mockResolvedValue({ enabled: false, versions: [], lastError: null })
        drafts.getDraftStatus.mockResolvedValue({ mode: 'live', lastPublished: null })
        const res = response()
        await controller.listVersions(request(), res, jest.fn())
        expect(versions.liveVersionSha).not.toHaveBeenCalled()
        expect(res.json.mock.calls[0][0]).toMatchObject({ liveSha: null, lastPublished: null })
    })
})

describe('a version from Dev put Live by Promote', () => {
    const SHA40 = 'd'.repeat(40)
    beforeEach(() => {
        jest.clearAllMocks()
        granted.clear()
        granted.add('chatflows:update')
        versions.isVersioningEnabled.mockReturnValue(true)
        versions.hiddenInputsDiffer.mockReturnValue(false)
        versions.diffVersion.mockResolvedValue({ ...EMPTY_DIFF, changed: [{ id: 'n1', label: 'Chat model', fields: ['systemMessage'] }] })
        versions.getVersion.mockResolvedValue({
            sha: SHA40,
            name: 'Sales Desk',
            type: 'CHATFLOW',
            flowData: '{"nodes":[2],"edges":[]}',
            missingCredentials: []
        })
        savesAndRecords('e'.repeat(40))
    })

    it('records it as promoted from Dev, with the title it had on Dev and its full id', async () => {
        const result = await putVersionLive(request(), FLOW as any, SHA40, {
            kind: 'promote',
            verb: 'Promoted from Dev',
            title: 'Published: Changed instructions',
            promotedFrom: SHA40
        })
        const options = updateChatflow.mock.calls[0][5]
        expect(options.versionRecord).toEqual({
            kind: 'promote',
            title: 'Promoted from Dev: Published: Changed instructions (ddddddd)',
            promotedFrom: SHA40
        })
        expect(options.expectedFlowData).toBe(FLOW.flowData)
        // The title comes from Dev, so this server's own history is not searched for it.
        expect(versions.listVersions).toHaveBeenCalledTimes(1)
        expect(result.sha).toBe('e'.repeat(40))
    })

    it.each([
        ['promote', { kind: 'promote', verb: 'Promoted from Dev', title: 'x', promotedFrom: SHA40 }],
        ['restore', { kind: 'restore', verb: 'Restored' }],
        ['rollback', { kind: 'rollback', verb: 'Rolled back Live to' }]
    ])("%s brings the version's category with it, even when that is the only change", async (_kind, record) => {
        versions.diffVersion.mockResolvedValue({ ...EMPTY_DIFF })
        versions.getVersion.mockResolvedValue({
            sha: SHA40,
            name: FLOW.name,
            type: 'CHATFLOW',
            category: 'Front desk',
            flowData: FLOW.flowData,
            missingCredentials: []
        })
        const result = await putVersionLive(request(), FLOW as any, SHA40, record as any)
        expect(updateChatflow).toHaveBeenCalledTimes(1)
        expect(updateChatflow.mock.calls[0][1].category).toBe('Front desk')
        expect(result.body).toMatchObject({ unchanged: false })
    })

    it('a version with no category clears it, and one with the same category is unchanged', async () => {
        versions.diffVersion.mockResolvedValue({ ...EMPTY_DIFF })
        versions.getVersion.mockResolvedValue({
            sha: SHA40,
            name: FLOW.name,
            type: 'CHATFLOW',
            category: '',
            flowData: FLOW.flowData,
            missingCredentials: []
        })
        await putVersionLive(request(), { ...FLOW, category: 'Front desk' } as any, SHA40, { kind: 'restore', verb: 'Restored' })
        expect(updateChatflow.mock.calls[0][1].category).toBeNull()

        updateChatflow.mockClear()
        const same = await putVersionLive(request(), FLOW as any, SHA40, { kind: 'restore', verb: 'Restored' })
        expect(updateChatflow).not.toHaveBeenCalled()
        expect(same.body).toMatchObject({ unchanged: true })
    })

    it('is refused, and nothing is saved, while a credential it uses is missing on this server', async () => {
        versions.getVersion.mockResolvedValue({
            sha: SHA40,
            name: 'Sales Desk',
            type: 'CHATFLOW',
            flowData: '{}',
            missingCredentials: [{ name: 'OpenAI key', credentialName: 'openAIApi' }]
        })
        await expect(
            putVersionLive(request(), FLOW as any, SHA40, { kind: 'promote', verb: 'Promoted from Dev', title: 'x' })
        ).rejects.toMatchObject({
            statusCode: 409,
            message: 'Add this credential on this server first: "OpenAI key" (openAIApi). Then promote again.'
        })
        expect(updateChatflow).not.toHaveBeenCalled()
    })

    it('restore with a missing credential still goes ahead, as before', async () => {
        versions.getVersion.mockResolvedValue({
            sha: 'abcdef1',
            name: 'Sales Desk',
            type: 'CHATFLOW',
            flowData: '{}',
            missingCredentials: [{ name: 'OpenAI key', credentialName: 'openAIApi' }]
        })
        versions.listVersions.mockResolvedValue({ versions: [] })
        const result = await putVersionLive(request(), FLOW as any, 'abcdef1', { kind: 'restore', verb: 'Restored' })
        expect(updateChatflow).toHaveBeenCalled()
        expect(result.body.missingCredentials).toHaveLength(1)
    })
})
