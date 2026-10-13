// Draft storage: the draft lives beside Live and never changes it.
const rows: any[] = []
const chats: any[] = []
const fakeRepo = {
    findOneBy: jest.fn(async (where: any) => rows.find((row) => row.chatflowId === where.chatflowId) || null),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (row: any) => {
        const index = rows.findIndex((item) => item.chatflowId === row.chatflowId)
        const saved = { id: row.id || `state-${rows.length + 1}`, ...row }
        if (index >= 0) rows[index] = saved
        else rows.push(saved)
        return saved
    }),
    update: jest.fn(async (where: any, patch: any) => {
        const matches = rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
        for (const row of matches) Object.assign(row, patch)
        return { affected: matches.length }
    }),
    delete: jest.fn(async (where: any) => {
        const index = rows.findIndex((row) => row.chatflowId === where.chatflowId)
        if (index >= 0) rows.splice(index, 1)
    })
}
const chatRepo = {
    findOneBy: jest.fn(async (where: any) => chats.find((row) => row.id === where.id) || null)
}
const repositoryFor = (entity: { name?: string }) => (entity?.name === 'ChatFlow' ? chatRepo : fakeRepo)
const manager = { getRepository: repositoryFor }
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: { getRepository: repositoryFor, transaction: async (fn: any) => fn(manager) },
        usageCacheManager: {}
    })
}))
const updateFlowDataWithFilePaths = jest.fn(async (_id: string, flowData: string) => flowData)
jest.mock('../../utils/fileRepository', () => ({
    containsBase64File: (flow: any) => flow.flowData.includes(';base64,'),
    updateFlowDataWithFilePaths: (...args: any[]) => (updateFlowDataWithFilePaths as any)(...args)
}))

import {
    canvasHash,
    deleteStateFor,
    discardDraft,
    flowDataForTestChat,
    getDraftStatus,
    isDraftsEnabled,
    afterLiveSet,
    clearDraftIfStill,
    draftBase,
    draftToPublish,
    draftWriteHooks,
    saveDraft,
    setPublishInstantly,
    updateDraftSettings,
    recordPublishGateResult,
    typeHasDrafts,
    uniqueUploadNames
} from './index'

const canvas = (label: string) => JSON.stringify({ nodes: [{ id: 'chatOpenAI_0', data: { label } }], edges: [] })
const LIVE = canvas('Live')
const flow = (overrides: Record<string, unknown> = {}) => ({
    id: 'flow-1',
    type: 'CHATFLOW',
    flowData: LIVE,
    workspaceId: 'team-a',
    ...overrides
})
const context = { userId: 'user-1', orgId: 'org-1', subscriptionId: 'sub-1' }

const original = process.env.CUTTLELY_DRAFTS
beforeEach(() => {
    rows.length = 0
    chats.length = 0
    chats.push({ id: 'flow-1', type: 'CHATFLOW', workspaceId: 'team-a' })
    draftWriteHooks.beforeDraftWrite = null
    jest.clearAllMocks()
    process.env.CUTTLELY_DRAFTS = 'on'
})
afterAll(() => {
    if (original === undefined) delete process.env.CUTTLELY_DRAFTS
    else process.env.CUTTLELY_DRAFTS = original
})

describe('the drafts switch', () => {
    test('is on unless CUTTLELY_DRAFTS turns it off', () => {
        delete process.env.CUTTLELY_DRAFTS
        expect(isDraftsEnabled()).toBe(true)
        for (const value of ['on', 'TRUE', ' 1 ', 'yes', 'maybe', '']) {
            process.env.CUTTLELY_DRAFTS = value
            expect(isDraftsEnabled()).toBe(true)
        }
        for (const value of ['off', 'OFF', ' false ', '0', 'no']) {
            process.env.CUTTLELY_DRAFTS = value
            expect(isDraftsEnabled()).toBe(false)
        }
    })

    test('with CUTTLELY_DRAFTS unset, a chatflow saves to a draft', async () => {
        delete process.env.CUTTLELY_DRAFTS
        const status = await getDraftStatus(flow())
        expect(status).toMatchObject({ enabled: true, mode: 'draft', reason: null })
    })

    test('chatflows, agentflows and harnesses get drafts; ETL and assistants save to Live', () => {
        expect(['CHATFLOW', 'MULTIAGENT', 'AGENTFLOW', 'HARNESS', undefined].map(typeHasDrafts)).toEqual([true, true, true, true, true])
        expect(['ETL', 'ASSISTANT'].map(typeHasDrafts)).toEqual([false, false])
    })

    test('with drafts off, the status says Live and saving a draft is refused', async () => {
        process.env.CUTTLELY_DRAFTS = 'off'
        expect(await getDraftStatus(flow())).toEqual({
            enabled: false,
            mode: 'live',
            reason: 'off',
            publishInstantly: false,
            publishGate: { enabled: false, datasetId: null, evaluatorIds: [], threshold: null, result: null, block: null },
            draft: null,
            lastPublished: null
        })
        await expect(saveDraft(flow(), canvas('Draft'), context)).rejects.toMatchObject({ statusCode: 409 })
        expect(rows).toEqual([])
    })
})

describe('an existing harness', () => {
    const live = canvas('Live instructions')
    const harness = () => flow({ id: 'flow-1', type: 'HARNESS', flowData: live, name: 'bakery-team' })

    beforeEach(() => {
        chats[0].type = 'HARNESS'
    })

    test('stays Live with no draft and no data change until the first edit', async () => {
        const existing = harness()
        expect(await getDraftStatus(existing)).toMatchObject({
            enabled: true,
            mode: 'draft',
            reason: null,
            publishInstantly: false,
            draft: null,
            lastPublished: null
        })
        expect(existing.flowData).toBe(live)
        expect(rows).toEqual([])
    })

    test('the first edit stores a draft and leaves Live untouched', async () => {
        const existing = harness()
        const status = await saveDraft(existing, canvas('Draft instructions'), context)
        expect(existing.flowData).toBe(live)
        expect(status.draft).toMatchObject({ flowData: canvas('Draft instructions'), stale: false })
        expect(rows[0].draftBaseHash).toMatch(/^HARNESS:[0-9a-f]{48}$/)
        expect(await draftToPublish(existing)).toBe(canvas('Draft instructions'))
    })

    test('Publish bookkeeping clears the draft after Live is set to it', async () => {
        const existing = harness()
        await saveDraft(existing, canvas('Draft instructions'), context)
        expect(await flowDataForTestChat(existing)).toBe(canvas('Draft instructions'))
        const published = harness()
        published.flowData = canvas('Draft instructions')
        const status = await afterLiveSet(published, 'a'.repeat(40), canvas('Draft instructions'))
        expect(status.draft).toBeNull()
        expect(status.lastPublished?.sha).toBe('a'.repeat(40))
    })
})

describe('an existing flow', () => {
    test('has no row, so Live is its canvas and there is no draft', async () => {
        expect(await getDraftStatus(flow())).toEqual({
            enabled: true,
            mode: 'draft',
            reason: null,
            publishInstantly: false,
            publishGate: { enabled: false, datasetId: null, evaluatorIds: [], threshold: null, result: null, block: null },
            draft: null,
            lastPublished: null
        })
        expect(await flowDataForTestChat(flow())).toBe(LIVE)
    })
})

describe('saving a draft', () => {
    test('stores the canvas beside Live and leaves the flow untouched', async () => {
        const live = flow()
        const status = await saveDraft(live, canvas('Draft'), context)
        expect(live.flowData).toBe(LIVE)
        expect(status.mode).toBe('draft')
        expect(status.draft).toMatchObject({ flowData: canvas('Draft'), updatedBy: 'user-1', stale: false })
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ chatflowId: 'flow-1', workspaceId: 'team-a', draftBaseHash: draftBase(flow()) })
        expect(rows[0].draftBaseHash).toMatch(/^CHATFLOW:[0-9a-f]{48}$/)
    })

    test('a second save keeps where the draft started', async () => {
        await saveDraft(flow(), canvas('Draft 1'), context)
        await saveDraft(flow(), canvas('Draft 2'), { ...context, userId: 'user-2' })
        expect(rows[0]).toMatchObject({ draftFlowData: canvas('Draft 2'), draftUpdatedBy: 'user-2', draftBaseHash: draftBase(flow()) })
    })

    test('Live changing under the draft, for example through the API, marks it stale', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        const status = await getDraftStatus(flow({ flowData: canvas('Changed by API') }))
        expect(status.draft?.stale).toBe(true)
    })

    test('a canvas that matches Live clears the draft instead', async () => {
        expect((await saveDraft(flow(), LIVE, context)).draft).toBeNull()
        expect(rows).toEqual([])
        await saveDraft(flow(), canvas('Draft'), context)
        const status = await saveDraft(flow(), JSON.stringify(JSON.parse(LIVE), null, 2), context)
        expect(status.draft).toBeNull()
        expect(rows[0].draftFlowData).toBeNull()
    })

    test('a matching canvas is not kept as a draft when stamping would be the only write', async () => {
        const live = JSON.stringify({
            nodes: [{ id: 'serpAPI_0', position: { x: 1, y: 2 }, data: { name: 'serpAPI', label: 'Serp API', inputs: {} } }],
            edges: []
        })
        const status = await saveDraft(flow({ flowData: live }), live, context)
        expect(status.draft).toBeNull()
        expect(rows).toEqual([])
    })

    test('an API key save records no user', async () => {
        const status = await saveDraft(flow(), canvas('Draft'), { ...context, userId: null })
        expect(status.draft?.updatedBy).toBeNull()
    })

    test('uploaded files in the draft are stored under their own name, so the Live file is never overwritten', async () => {
        const upload = 'data:text/plain;base64,QQ==,filename:a.txt'
        const withFile = JSON.stringify({
            nodes: [{ id: 'txt_0', data: { category: 'Document Loaders', inputs: { txtFile: upload, many: JSON.stringify([upload]) } } }],
            edges: []
        })
        await saveDraft(flow(), withFile, context)
        const [id, stored, org, workspace, subscription] = updateFlowDataWithFilePaths.mock.calls[0] as any[]
        expect([id, org, workspace, subscription]).toEqual(['flow-1', 'org-1', 'team-a', 'sub-1'])
        const inputs = JSON.parse(stored).nodes[0].data.inputs
        expect(inputs.txtFile).toMatch(/^data:text\/plain;base64,QQ==,filename:draft-[0-9a-f]{8}-a\.txt$/)
        expect(JSON.parse(inputs.many)[0]).toMatch(/,filename:draft-[0-9a-f]{8}-a\.txt$/)
    })

    test('only Document Loader uploads are renamed, and other text is kept', () => {
        const data = JSON.stringify({
            nodes: [
                { id: 'a', data: { category: 'Document Loaders', inputs: { note: 'plain text', list: '[not json' } } },
                { id: 'b', data: { category: 'Chat Models', inputs: { file: 'data:text/plain;base64,QQ==,filename:a.txt' } } }
            ],
            edges: []
        })
        expect(JSON.parse(uniqueUploadNames(data, 'abcd1234'))).toEqual(JSON.parse(data))
    })

    test.each([
        [undefined, 'flowData is required.'],
        ['not json', 'flowData is not valid JSON.'],
        ['{"nodes":[]}', 'flowData needs a nodes list and an edges list.'],
        [42, 'flowData is required.']
    ])('refuses %p', async (value, message) => {
        await expect(saveDraft(flow(), value, context)).rejects.toMatchObject({ statusCode: 400, message })
        expect(rows).toEqual([])
    })

    test('an ETL pipeline or assistant saves to Live, so a draft is refused', async () => {
        for (const type of ['ETL', 'ASSISTANT']) {
            await expect(saveDraft(flow({ type }), canvas('Draft'), context)).rejects.toMatchObject({
                statusCode: 409,
                message: 'This kind of flow saves straight to Live.'
            })
            expect((await getDraftStatus(flow({ type }))).reason).toBe('type')
        }
    })
})

describe('publishing', () => {
    test('hands over the draft canvas', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))
    })

    test('is refused with drafts off or nothing to publish', async () => {
        await expect(draftToPublish(flow())).rejects.toMatchObject({
            statusCode: 409,
            message: 'There are no unpublished changes to publish.'
        })
        await saveDraft(flow(), canvas('Draft'), context)
        process.env.CUTTLELY_DRAFTS = 'off'
        await expect(draftToPublish(flow())).rejects.toMatchObject({ statusCode: 409, message: 'Drafts are off on this server.' })
    })

    test('a draft whose Live changed underneath needs overwriteLiveChanges: true', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        const changed = flow({ flowData: canvas('Changed by API') })
        await expect(draftToPublish(changed)).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('overwriteLiveChanges')
        })
        await expect(draftToPublish(changed, 'yes')).rejects.toMatchObject({ statusCode: 409 })
        expect(await draftToPublish(changed, true)).toBe(canvas('Draft'))
    })

    test('a type change that lands before the draft is written is refused, and nothing is stored', async () => {
        chats[0].type = 'AGENTFLOW'
        draftWriteHooks.beforeDraftWrite = async () => {
            chats[0].type = 'CHATFLOW'
        }
        await expect(saveDraft(flow({ type: 'AGENTFLOW' }), canvas('Agent canvas'), context)).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining("can't be saved")
        })
        expect(rows).toEqual([])
    })

    test('a draft started on another kind of flow is never published, even with overwriteLiveChanges', async () => {
        chats[0].type = 'AGENTFLOW'
        await saveDraft(flow({ type: 'AGENTFLOW' }), canvas('Agentflow draft'), context)
        // The type changed to CHATFLOW after the draft started (the canvas did not).
        const changed = flow()
        expect((await getDraftStatus(changed)).draft?.stale).toBe(true)
        for (const overwrite of [undefined, true]) {
            await expect(draftToPublish(changed, overwrite)).rejects.toMatchObject({
                statusCode: 409,
                message: expect.stringContaining('another kind of flow')
            })
        }
        // Not rebased onto the new type either.
        await afterLiveSet(changed, 'e'.repeat(40))
        expect(rows[0].draftBaseHash).toMatch(/^AGENTFLOW:/)
    })

    test('a base saved before the type was kept: its type is unknown, so it can only be discarded', async () => {
        rows.push({ chatflowId: 'flow-1', draftFlowData: canvas('Old'), draftBaseHash: canvasHash(LIVE), publishInstantly: false })
        // Still compared as a canvas hash for the stale flag.
        expect((await getDraftStatus(flow())).draft?.stale).toBe(false)
        expect((await getDraftStatus(flow({ flowData: canvas('Changed') }))).draft?.stale).toBe(true)
        await expect(draftToPublish(flow(), true)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Discard') })
        await afterLiveSet(flow(), 'f'.repeat(40))
        expect(rows[0].draftBaseHash).toBe(canvasHash(LIVE))
    })

    test('a draft left from before Publish instantly can still be published', async () => {
        rows.push({ chatflowId: 'flow-1', draftFlowData: canvas('Old draft'), draftBaseHash: draftBase(flow()), publishInstantly: true })
        expect(await draftToPublish(flow())).toBe(canvas('Old draft'))
    })

    test('after publishing, the draft is cleared and the Live version and time are recorded', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        const status = await afterLiveSet(flow({ flowData: canvas('Draft') }), 'a'.repeat(40), canvas('Draft'))
        expect(status.draft).toBeNull()
        expect(status.lastPublished).toEqual({ sha: 'a'.repeat(40), date: expect.any(String) })
        expect(rows[0]).toMatchObject({ draftFlowData: null, draftBaseHash: null, liveSha: 'a'.repeat(40) })
        expect(rows[0].publishedDate).toBeInstanceOf(Date)
    })

    test('a newer draft saved while publishing is kept, and starts from the new Live', async () => {
        await saveDraft(flow(), canvas('Draft 2'), context)
        const live = flow({ flowData: canvas('Draft 1') })
        const status = await afterLiveSet(live, null, canvas('Draft 1'))
        expect(status.draft).toMatchObject({ flowData: canvas('Draft 2'), stale: false })
        expect(rows[0].draftBaseHash).toBe(draftBase(live))
        expect(status.lastPublished?.sha).toBeNull()
    })

    test('Promote keeps a draft as it is: still started from the old Live, so Publish asks before replacing it', async () => {
        await saveDraft(flow(), canvas('Prod draft'), context)
        const promoted = flow({ flowData: canvas('From Dev') })
        const status = await afterLiveSet(promoted, 'b'.repeat(40), undefined, { keepDraftBase: true })
        expect(status.draft).toMatchObject({ flowData: canvas('Prod draft'), stale: true })
        expect(rows[0].draftBaseHash).toBe(draftBase(flow()))
        expect(status.lastPublished?.sha).toBe('b'.repeat(40))
        await expect(draftToPublish(promoted)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Live changed') })
        expect(await draftToPublish(promoted, true)).toBe(canvas('Prod draft'))
    })

    test('a draft that already matches Live is cleared only while it is the one that was checked', async () => {
        await saveDraft(flow(), canvas('Checked'), context)
        await saveDraft(flow(), canvas('Newer'), context)
        expect((await clearDraftIfStill(flow(), canvas('Checked'))).draft?.flowData).toBe(canvas('Newer'))
        expect((await clearDraftIfStill(flow(), canvas('Newer'))).draft).toBeNull()
        expect(rows[0]).toMatchObject({ draftFlowData: null, draftBaseHash: null, draftUpdatedBy: null, draftUpdatedDate: null })
    })

    test('the Publish bookkeeping writes only its own columns', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        await afterLiveSet(flow({ flowData: canvas('Draft') }), 'd'.repeat(40), canvas('Draft'))
        const updates = (fakeRepo.update.mock.calls as any[]).map(([where, patch]) => [
            Object.keys(where).sort(),
            Object.keys(patch).sort()
        ])
        expect(updates).toEqual([
            [
                ['chatflowId', 'draftFlowData'],
                ['draftBaseHash', 'draftFlowData', 'draftUpdatedBy', 'draftUpdatedDate']
            ],
            [['chatflowId'], ['liveSha', 'publishedDate']]
        ])
    })

    test('rolling back keeps the draft and does not flag it stale', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        const rolledBack = flow({ flowData: canvas('Older version') })
        const status = await afterLiveSet(rolledBack, 'b'.repeat(40))
        expect(status.draft).toMatchObject({ flowData: canvas('Draft'), stale: false })
        expect(rows[0].liveSha).toBe('b'.repeat(40))
    })

    test('rolling back a flow with no row creates one', async () => {
        const status = await afterLiveSet(flow(), 'c'.repeat(40))
        expect(status.draft).toBeNull()
        expect(rows[0]).toMatchObject({ chatflowId: 'flow-1', workspaceId: 'team-a', publishInstantly: false, liveSha: 'c'.repeat(40) })
    })
})

describe('discarding a draft', () => {
    test('drops the draft and keeps Live and the setting', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        const status = await discardDraft(flow())
        expect(status.draft).toBeNull()
        expect(rows[0]).toMatchObject({ draftFlowData: null, draftBaseHash: null, draftUpdatedBy: null, publishInstantly: false })
    })

    test('with no draft is a no-op', async () => {
        expect((await discardDraft(flow())).draft).toBeNull()
        expect(fakeRepo.save).not.toHaveBeenCalled()
    })
})

describe('Publish instantly', () => {
    test('turns the flow back to saving straight to Live', async () => {
        const status = await setPublishInstantly(flow(), true)
        expect(status).toMatchObject({ mode: 'live', reason: 'publish-instantly', publishInstantly: true })
        await expect(saveDraft(flow(), canvas('Draft'), context)).rejects.toMatchObject({
            statusCode: 409,
            message: 'This flow publishes instantly. Save it to Live instead.'
        })
        expect((await setPublishInstantly(flow(), false)).mode).toBe('draft')
    })

    test('is refused while there are unpublished changes', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        await expect(setPublishInstantly(flow(), true)).rejects.toMatchObject({ statusCode: 409 })
        expect(rows[0].publishInstantly).toBe(false)
    })

    test('needs true or false', async () => {
        await expect(setPublishInstantly(flow(), 'yes')).rejects.toMatchObject({ statusCode: 400 })
    })

    test('turning it off with no row writes nothing', async () => {
        await setPublishInstantly(flow(), false)
        expect(rows).toEqual([])
    })
})

describe('what the canvas test chat runs', () => {
    test('the draft when there is one', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        expect(await flowDataForTestChat(flow())).toBe(canvas('Draft'))
    })

    test('Live when drafts are off, the type has no drafts, or Publish instantly is on', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        process.env.CUTTLELY_DRAFTS = 'off'
        expect(await flowDataForTestChat(flow())).toBe(LIVE)
        process.env.CUTTLELY_DRAFTS = 'on'
        expect(await flowDataForTestChat(flow({ type: 'ETL' }))).toBe(LIVE)
        rows[0].publishInstantly = true
        expect(await flowDataForTestChat(flow())).toBe(LIVE)
    })
})

describe('a passing test set before Publish', () => {
    const gate = { enabled: true, datasetId: 'ds-1', evaluatorIds: ['ev-1'], threshold: 100 }
    const pass = {
        draftHash: '',
        datasetId: 'ds-1',
        evaluatorIds: ['ev-1'],
        threshold: 100,
        passRate: 100,
        passed: 2,
        failed: 0,
        errored: 0,
        verdict: 'passed' as const
    }

    async function arm(extra: Record<string, unknown> = {}) {
        await saveDraft(flow(), canvas('Draft'), context)
        await updateDraftSettings(flow(), { publishGate: { ...gate, ...extra } })
    }

    test('stays off, and Publish is unchanged', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))
        expect((await getDraftStatus(flow())).publishGate.enabled).toBe(false)
    })

    test('is refused when drafts are off, Publish instantly is on, or the flow is not a chatflow or agentflow', async () => {
        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, threshold: 101 } })).rejects.toMatchObject({ statusCode: 400 })
        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, threshold: -1 } })).rejects.toMatchObject({ statusCode: 400 })
        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, threshold: 1.5 } })).rejects.toMatchObject({ statusCode: 400 })
        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, threshold: 0 } })).resolves.toMatchObject({
            publishGate: { enabled: true, threshold: 0 }
        })
        rows.length = 0
        process.env.CUTTLELY_DRAFTS = 'off'
        await expect(updateDraftSettings(flow(), { publishGate: gate })).rejects.toMatchObject({
            statusCode: 400,
            message: 'Drafts are off on this server.'
        })
        process.env.CUTTLELY_DRAFTS = 'on'
        await setPublishInstantly(flow(), true)
        await expect(updateDraftSettings(flow(), { publishGate: gate })).rejects.toMatchObject({
            statusCode: 400,
            message: 'Turn off Publish instantly before requiring a passing test set.'
        })
        rows.length = 0
        await expect(updateDraftSettings(flow({ type: 'HARNESS' }), { publishGate: gate })).rejects.toMatchObject({
            statusCode: 400,
            message: 'A passing test set before Publish is for chatflows and agentflows.'
        })
        await expect(updateDraftSettings(flow({ type: 'MULTIAGENT' }), { publishGate: gate })).rejects.toMatchObject({ statusCode: 400 })
        await expect(updateDraftSettings(flow({ type: 'ETL' }), { publishGate: gate })).rejects.toMatchObject({ statusCode: 400 })
    })

    test('refuses Publish instantly while the gate is on', async () => {
        await arm()
        await expect(setPublishInstantly(flow(), true)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Turn off the passing test set before turning on Publish instantly.'
        })
        expect(rows[0].publishInstantly).toBe(false)
        expect(rows[0].publishGate).toBe(true)
    })

    test('refuses Publish with no result, a failing result, or a stale result, and allows a current pass', async () => {
        await arm()
        await expect(draftToPublish(flow())).rejects.toMatchObject({
            statusCode: 409,
            message: 'Publish needs a passing test set at 100%. There is no result for this draft yet.'
        })
        const hash = canvasHash(canvas('Draft'))
        await recordPublishGateResult(flow(), { ...pass, draftHash: hash, passRate: 75, passed: 3, failed: 1, verdict: 'failed' })
        await expect(draftToPublish(flow())).rejects.toMatchObject({
            statusCode: 409,
            message: 'Publish needs a passing test set at 100%. The last result was 75% and failed.'
        })
        await recordPublishGateResult(flow(), { ...pass, draftHash: hash })
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))
        await saveDraft(flow(), canvas('Edited'), context)
        await expect(draftToPublish(flow())).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('The draft has changed since that check.')
        })
        await saveDraft(flow(), canvas('Draft'), context)
        await updateDraftSettings(flow(), { publishGate: { ...gate, threshold: 90 } })
        await expect(draftToPublish(flow())).rejects.toMatchObject({
            statusCode: 409,
            message:
                'Publish needs a passing test set at 90%. The last result was 100% and passed. The test set settings have changed since that check.'
        })
    })

    test('a stored pass still allows Publish after the check is gone from memory', async () => {
        await arm()
        const hash = canvasHash(canvas('Draft'))
        await recordPublishGateResult(flow(), { ...pass, draftHash: hash })
        const stored = JSON.parse(rows[0].publishGateResult)
        expect(stored).toMatchObject({ draftHash: hash, verdict: 'passed', passRate: 100, threshold: 100 })
        expect(JSON.stringify(stored)).not.toMatch(/answer|question|expected/i)
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))
    })

    test('a harness that shares the Publish route is not blocked by a stored flag', async () => {
        chats[0].type = 'HARNESS'
        const harness = flow({ type: 'HARNESS' })
        await saveDraft(harness, canvas('Draft'), context)
        rows[0].publishGate = true
        rows[0].publishGateDatasetId = 'ds-1'
        rows[0].publishGateEvaluatorIds = JSON.stringify(['ev-1'])
        rows[0].publishGateThreshold = 100
        expect(await draftToPublish(harness)).toBe(canvas('Draft'))
    })

    test('roll back bookkeeping still records Live while the gate is on', async () => {
        await arm()
        const rolled = flow({ flowData: canvas('Older') })
        const status = await afterLiveSet(rolled, 'b'.repeat(40))
        expect(status.publishGate.enabled).toBe(true)
        expect(rows[0].liveSha).toBe('b'.repeat(40))
        expect(status.draft?.flowData).toBe(canvas('Draft'))
    })
})

test('deleting a flow removes its row', async () => {
    await saveDraft(flow(), canvas('Draft'), context)
    await deleteStateFor('flow-1')
    expect(rows).toEqual([])
})
