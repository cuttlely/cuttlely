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
let duringDatasetLookup: null | (() => Promise<void>) = null
const datasets = new Map<string, any>()
const datasetRows: any[] = []
const evaluators = new Map<string, any>()
const repositoryFor = (entity: { name?: string }) => {
    const name = entity?.name
    if (name === 'ChatFlow') return chatRepo
    if (name === 'Dataset') {
        return {
            findOneBy: async (where: any) => {
                if (duringDatasetLookup) {
                    const run = duringDatasetLookup
                    duringDatasetLookup = null
                    await run()
                }
                const row = where?.id ? datasets.get(where.id) : null
                if (!row || row.workspaceId !== where.workspaceId) return null
                return row
            }
        }
    }
    if (name === 'DatasetRow') {
        return {
            find: async (opts: any) => datasetRows.filter((row) => row.datasetId === opts?.where?.datasetId)
        }
    }
    if (name === 'Evaluator') {
        return {
            findOneBy: async (where: any) => {
                const row = where?.id ? evaluators.get(where.id) : null
                if (!row || row.workspaceId !== where.workspaceId) return null
                return row
            }
        }
    }
    return fakeRepo
}
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
    clearPublishGateResult,
    noteGateCheck,
    clearGateCheckNotes,
    typeHasDrafts,
    uniqueUploadNames
} from './index'
import { currentTestSetHash } from '../flow-check/score'
import { postProcessHash } from './gate'

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
    datasets.clear()
    datasetRows.length = 0
    evaluators.clear()
    duringDatasetLookup = null
    clearGateCheckNotes()
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

    test('chatflows, agentflows, harnesses and pipelines get drafts; assistants save to Live', () => {
        expect(['CHATFLOW', 'MULTIAGENT', 'AGENTFLOW', 'HARNESS', 'ETL', undefined].map(typeHasDrafts)).toEqual([
            true,
            true,
            true,
            true,
            true,
            true
        ])
        expect(['ASSISTANT'].map(typeHasDrafts)).toEqual([false])
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

describe('an existing pipeline', () => {
    const live = canvas('Live collection')
    const pipeline = () => flow({ id: 'flow-1', type: 'ETL', flowData: live, name: 'Outdoor Catalog' })

    beforeEach(() => {
        chats[0].type = 'ETL'
    })

    test('stays Live with no draft and no data change until the first edit', async () => {
        const existing = pipeline()
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
        const existing = pipeline()
        const status = await saveDraft(existing, canvas('Draft collection'), context)
        expect(existing.flowData).toBe(live)
        expect(status.draft).toMatchObject({ flowData: canvas('Draft collection'), stale: false })
        expect(rows[0].draftBaseHash).toMatch(/^ETL:[0-9a-f]{48}$/)
        expect(await flowDataForTestChat(existing)).toBe(canvas('Draft collection'))
        expect(await draftToPublish(existing)).toBe(canvas('Draft collection'))
    })

    test('Publish bookkeeping clears the draft after Live is set to it', async () => {
        const existing = pipeline()
        await saveDraft(existing, canvas('Draft collection'), context)
        const published = pipeline()
        published.flowData = canvas('Draft collection')
        const status = await afterLiveSet(published, 'a'.repeat(40), canvas('Draft collection'))
        expect(status.draft).toBeNull()
        expect(status.lastPublished?.sha).toBe('a'.repeat(40))
        expect(await flowDataForTestChat(published)).toBe(canvas('Draft collection'))
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

    test('an assistant saves to Live, so a draft is refused', async () => {
        await expect(saveDraft(flow({ type: 'ASSISTANT' }), canvas('Draft'), context)).rejects.toMatchObject({
            statusCode: 409,
            message: 'This kind of flow saves straight to Live.'
        })
        expect((await getDraftStatus(flow({ type: 'ASSISTANT' }))).reason).toBe('type')
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
        expect(await flowDataForTestChat(flow({ type: 'ASSISTANT' }))).toBe(LIVE)
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

    const sampleEval = (id = 'ev-1', config = { operator: 'Contains', value: 'Yes' }) => ({
        id,
        workspaceId: 'team-a',
        type: 'text',
        config: JSON.stringify(config)
    })

    function seed(
        nextRows = [{ id: 'r1', datasetId: 'ds-1', input: 'Do you have rye?', output: 'Yes', sequenceNo: 1 }],
        evals = [sampleEval()]
    ) {
        datasets.clear()
        datasetRows.length = 0
        evaluators.clear()
        datasets.set('ds-1', { id: 'ds-1', workspaceId: 'team-a' })
        datasetRows.push(...nextRows)
        for (const item of evals) evaluators.set(item.id, item)
    }

    async function arm(extra: Record<string, unknown> = {}) {
        seed()
        await saveDraft(flow(), canvas('Draft'), context)
        await updateDraftSettings(flow(), { publishGate: { ...gate, ...extra } })
    }

    async function recordPass(extra: Record<string, unknown> = {}) {
        seed()
        const contentHash = await currentTestSetHash('ds-1', ['ev-1'], 'team-a')
        const draftHash = canvasHash(canvas('Draft'))
        await recordPublishGateResult(flow(), {
            ...pass,
            draftHash,
            contentHash: contentHash || '',
            postProcessHash: postProcessHash(chats[0]?.chatbotConfig),
            ...extra
        })
        return { contentHash, draftHash }
    }

    test('a publish-instantly save during target validation keeps the gate off', async () => {
        seed()
        rows.push({
            id: 'state-1',
            chatflowId: 'flow-1',
            workspaceId: 'team-a',
            publishInstantly: false,
            publishGate: false
        })
        duringDatasetLookup = async () => {
            rows[0].publishInstantly = true
        }
        await expect(updateDraftSettings(flow(), { publishGate: gate })).rejects.toMatchObject({
            statusCode: 400,
            message: 'Turn off Publish instantly before requiring a passing test set.'
        })
        expect(rows[0].publishInstantly).toBe(true)
        expect(rows[0].publishGate).toBe(false)
        expect(rows[0].publishGateDatasetId).toBeUndefined()
    })

    test('an older pass cannot publish when this check failed to replace it', async () => {
        await arm()
        await recordPass()
        noteGateCheck('flow-1', 'check-2')
        await expect(draftToPublish(flow())).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('The test set result could not be saved.')
        })
        clearGateCheckNotes()
        await recordPublishGateResult(flow(), {
            ...(JSON.parse(rows[0].publishGateResult) as Record<string, unknown>),
            checkId: 'check-2'
        })
        noteGateCheck('flow-1', 'check-2')
        await expect(draftToPublish(flow())).resolves.toContain('Draft')
    })

    test('a draft save during target validation survives the settings write', async () => {
        seed()
        rows.push({
            id: 'state-1',
            chatflowId: 'flow-1',
            workspaceId: 'team-a',
            publishInstantly: false,
            publishGate: false,
            draftFlowData: null,
            liveSha: 'abc123',
            publishedDate: new Date('2026-10-01T00:00:00Z')
        })
        duringDatasetLookup = async () => {
            await saveDraft(flow(), canvas('Saved during validation'), context)
        }
        const status = await updateDraftSettings(flow(), { publishGate: gate })
        expect(rows).toHaveLength(1)
        expect(rows[0].draftFlowData).toEqual(expect.stringContaining('Saved during validation'))
        expect(rows[0].liveSha).toBe('abc123')
        expect(rows[0].publishGate).toBe(true)
        expect(rows[0].publishGateDatasetId).toBe('ds-1')
        expect(rows[0].publishGateEvaluatorIds).toBe(JSON.stringify(['ev-1']))
        expect(rows[0].publishGateThreshold).toBe(100)
        const settingsWrite = fakeRepo.update.mock.calls.find((call) => call[1]?.publishGate === true)
        expect(settingsWrite?.[1]).toEqual({
            publishGate: true,
            publishGateDatasetId: 'ds-1',
            publishGateEvaluatorIds: JSON.stringify(['ev-1']),
            publishGateThreshold: 100
        })
        expect(status.publishGate.enabled).toBe(true)
        expect(status.draft?.flowData).toEqual(expect.stringContaining('Saved during validation'))
    })

    test('clearing a stored gate result leaves the draft in place', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        rows[0].publishGate = true
        rows[0].publishGateResult = JSON.stringify({ verdict: 'passed' })
        const saves = fakeRepo.save.mock.calls.length
        await clearPublishGateResult(flow())
        expect(rows[0].publishGateResult).toBeNull()
        expect(rows[0].draftFlowData).toEqual(expect.stringContaining('Draft'))
        expect(rows[0].publishGate).toBe(true)
        expect(fakeRepo.save.mock.calls.length).toBe(saves)
    })

    test('stays off, and Publish is unchanged', async () => {
        await saveDraft(flow(), canvas('Draft'), context)
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))
        expect((await getDraftStatus(flow())).publishGate.enabled).toBe(false)
    })

    test('is refused when drafts are off, Publish instantly is on, or the flow is not a chatflow or agentflow', async () => {
        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, threshold: 101 } })).rejects.toMatchObject({ statusCode: 400 })
        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, threshold: -1 } })).rejects.toMatchObject({ statusCode: 400 })
        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, threshold: 1.5 } })).rejects.toMatchObject({ statusCode: 400 })
        seed()
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

    test('a form, webhook, or schedule start cannot turn the gate on, and an existing gate stays blocking', async () => {
        seed()
        chats[0].type = 'AGENTFLOW'
        const agent = (start: string) =>
            JSON.stringify({
                nodes: [{ id: 'start', data: { name: 'startAgentflow', inputs: { startInputType: start } } }],
                edges: []
            })
        for (const [start, named] of [
            ['formInput', 'a form'],
            ['webhookTrigger', 'a webhook'],
            ['scheduleInput', 'a schedule']
        ]) {
            await expect(
                updateDraftSettings(flow({ type: 'AGENTFLOW', flowData: agent(start) }), { publishGate: gate })
            ).rejects.toMatchObject({
                statusCode: 400,
                message: expect.stringContaining(`This flow starts with ${named}, so it cannot use a dataset.`)
            })
        }
        expect(rows.some((row) => row.publishGate)).toBe(false)

        const chat = flow({ type: 'AGENTFLOW', flowData: agent('chatInput') })
        await saveDraft(chat, agent('chatInput'), context)
        await updateDraftSettings(chat, { publishGate: gate })
        expect(rows[0].publishGate).toBe(true)
        await saveDraft(chat, agent('formInput'), context)
        const status = await getDraftStatus(chat)
        expect(status.publishGate.enabled).toBe(true)
        expect(status.publishGate.block).toEqual(expect.stringContaining('starts with a form, so it cannot use a dataset.'))
        expect(status.publishGate.block).toEqual(expect.stringContaining('Turn off the passing test set before you publish.'))
        await expect(draftToPublish(chat)).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('Turn off the passing test set before you publish.')
        })
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
        await recordPass()
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
        const { draftHash, contentHash } = await recordPass()
        const stored = JSON.parse(rows[0].publishGateResult)
        expect(stored).toMatchObject({ draftHash, verdict: 'passed', passRate: 100, threshold: 100, contentHash })
        expect(JSON.stringify(stored)).not.toMatch(/answer|question|expected|Do you have rye/i)
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))
    })

    test('a pass goes stale when the rows or evaluators change, and an unchanged test set still publishes', async () => {
        const stale = 'The test set has changed since that check.'
        await arm()
        await recordPass()
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))

        datasetRows[0].output = 'No'
        await expect(draftToPublish(flow())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(stale) })

        datasetRows[0].output = 'Yes'
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))

        datasetRows.push({ id: 'r2', datasetId: 'ds-1', input: 'Is it burnt?', output: 'No', sequenceNo: 2 })
        await expect(draftToPublish(flow())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(stale) })
        datasetRows.pop()
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))

        evaluators.get('ev-1').config = JSON.stringify({ operator: 'Contains', value: 'No' })
        await expect(draftToPublish(flow())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(stale) })
        evaluators.set('ev-1', sampleEval())
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))

        datasets.delete('ds-1')
        await expect(draftToPublish(flow())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(stale) })
        datasets.set('ds-1', { id: 'ds-1', workspaceId: 'team-a' })
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))

        evaluators.delete('ev-1')
        await expect(draftToPublish(flow())).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(stale) })
    })

    test('a missing dataset, a missing evaluator, or an id from another workspace is not stored', async () => {
        seed()
        datasets.delete('ds-1')
        await expect(updateDraftSettings(flow(), { publishGate: gate })).rejects.toMatchObject({
            statusCode: 404,
            message: 'Dataset ds-1 not found'
        })
        expect(rows).toEqual([])
        seed()
        evaluators.delete('ev-1')
        await expect(updateDraftSettings(flow(), { publishGate: gate })).rejects.toMatchObject({
            statusCode: 404,
            message: 'Evaluator ev-1 not found'
        })
        expect(rows).toEqual([])

        await arm()
        const stored = () => ({
            publishGate: rows[0].publishGate,
            datasetId: rows[0].publishGateDatasetId,
            evaluatorIds: rows[0].publishGateEvaluatorIds,
            threshold: rows[0].publishGateThreshold
        })
        const before = stored()

        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, datasetId: 'missing-ds' } })).rejects.toMatchObject({
            statusCode: 404,
            message: 'Dataset missing-ds not found'
        })
        expect(stored()).toEqual(before)

        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, evaluatorIds: ['missing-ev'] } })).rejects.toMatchObject({
            statusCode: 404,
            message: 'Evaluator missing-ev not found'
        })
        expect(stored()).toEqual(before)

        datasets.set('ds-other', { id: 'ds-other', workspaceId: 'team-b' })
        evaluators.set('ev-other', { ...sampleEval('ev-other'), workspaceId: 'team-b' })
        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, datasetId: 'ds-other' } })).rejects.toMatchObject({
            statusCode: 404,
            message: 'Dataset ds-other not found'
        })
        expect(stored()).toEqual(before)
        await expect(updateDraftSettings(flow(), { publishGate: { ...gate, evaluatorIds: ['ev-other'] } })).rejects.toMatchObject({
            statusCode: 404,
            message: 'Evaluator ev-other not found'
        })
        expect(stored()).toEqual(before)
    })

    test('evaluator order does not change the test set hash', async () => {
        seed(
            [{ id: 'r1', datasetId: 'ds-1', input: 'Do you have rye?', output: 'Yes', sequenceNo: 1 }],
            [sampleEval('ev-b'), sampleEval('ev-a')]
        )
        await saveDraft(flow(), canvas('Draft'), context)
        await updateDraftSettings(flow(), { publishGate: { ...gate, evaluatorIds: ['ev-b', 'ev-a'] } })
        const forward = await currentTestSetHash('ds-1', ['ev-a', 'ev-b'], 'team-a')
        const reverse = await currentTestSetHash('ds-1', ['ev-b', 'ev-a'], 'team-a')
        expect(forward).toBe(reverse)
        await recordPublishGateResult(flow(), {
            ...pass,
            evaluatorIds: ['ev-b', 'ev-a'],
            draftHash: canvasHash(canvas('Draft')),
            contentHash: reverse || '',
            postProcessHash: postProcessHash(chats[0]?.chatbotConfig)
        })
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))
    })

    test('editing answer post-processing after a pass makes Publish refuse', async () => {
        await arm()
        await recordPass()
        expect(await draftToPublish(flow())).toBe(canvas('Draft'))
        chats[0].chatbotConfig = JSON.stringify({
            postProcessing: { enabled: true, customFunction: JSON.stringify('return "rewritten"') }
        })
        await expect(draftToPublish(flow())).rejects.toMatchObject({
            statusCode: 409,
            message: expect.stringContaining('The answer post-processing has changed since that check.')
        })
    })

    test('save, discard, and settings report a changed test set on the response', async () => {
        await arm()
        await recordPass()
        datasetRows[0].output = 'No'
        const saved = await saveDraft(flow(), canvas('Draft'), context)
        expect(saved.publishGate.block).toEqual(expect.stringContaining('The test set has changed since that check.'))
        datasetRows[0].output = 'Yes'
        const same = await updateDraftSettings(flow(), { publishGate: gate })
        expect(same.publishGate.block).toBeNull()
        evaluators.get('ev-1').config = JSON.stringify({ operator: 'Contains', value: 'No' })
        const settings = await updateDraftSettings(flow(), { publishGate: gate })
        expect(settings.publishGate.block).toEqual(expect.stringContaining('The test set has changed since that check.'))
        evaluators.set('ev-1', sampleEval())
        const ready = await updateDraftSettings(flow(), { publishGate: gate })
        expect(ready.publishGate.block).toBeNull()
        datasetRows[0].output = 'No'
        const discarded = await discardDraft(flow())
        expect(discarded.publishGate.block).toBe((await getDraftStatus(flow())).publishGate.block)
        expect(discarded.publishGate.block).toEqual(expect.stringContaining('The draft has changed since that check.'))
    })

    test('a harness check result is not stored, and a stored flag does not block Publish', async () => {
        chats[0].type = 'HARNESS'
        const harness = flow({ type: 'HARNESS' })
        await saveDraft(harness, canvas('Draft'), context)
        seed()
        await recordPublishGateResult(harness, {
            ...pass,
            draftHash: canvasHash(canvas('Draft')),
            contentHash: 'abc'
        })
        expect(rows[0].publishGateResult ?? null).toBeNull()
        rows[0].publishGate = true
        rows[0].publishGateDatasetId = 'ds-1'
        rows[0].publishGateEvaluatorIds = JSON.stringify(['ev-1'])
        rows[0].publishGateThreshold = 100
        rows[0].publishGateResult = JSON.stringify({ ...pass, contentHash: 'abc', draftHash: canvasHash(canvas('Draft')) })
        expect(await draftToPublish(harness)).toBe(canvas('Draft'))
        expect((await getDraftStatus(harness)).publishGate.enabled).toBe(false)
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
