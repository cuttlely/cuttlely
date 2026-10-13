import { kindLabel, relativeTime, restoreMessage, versionMarkers } from './versionHistory'
import {
    STALE_DRAFT_WARNING,
    apiErrorMessage,
    badgeText,
    canvasFlowText,
    diffCanvases,
    draftBadge,
    planCanvasSave,
    publishBody,
    PIPELINE_PREVIEW_NOTE,
    PIPELINE_RUN_DIRTY,
    PIPELINE_RUN_DRAFT,
    publishChangeLines,
    publishInstantlyLocked,
    showsPublishCheck,
    publishResultMessage,
    showDraftChrome,
    showPublishInstantly,
    testChatFlow
} from './flowDrafts'

const live = JSON.stringify({
    nodes: [
        {
            id: 'n1',
            position: { x: 0, y: 0 },
            data: { label: 'Conversation Chain', inputs: { systemMessagePrompt: 'Hello' }, selected: false }
        }
    ],
    edges: [{ source: 'n1', sourceHandle: 'a', target: 'n2', targetHandle: 'b' }]
})

const draft = JSON.stringify({
    nodes: [
        {
            id: 'n1',
            position: { x: 40, y: 0 },
            data: { label: 'Conversation Chain', inputs: { systemMessagePrompt: 'Welcome' }, selected: true }
        },
        { id: 'n3', position: { x: 10, y: 10 }, data: { label: 'Calculator', inputs: {} } }
    ],
    edges: []
})

describe('draft chrome', () => {
    const now = Date.parse('2026-10-08T12:00:00Z')

    test('stays hidden when the server says live', () => {
        expect(showDraftChrome({ enabled: false, mode: 'live', reason: 'off' })).toBe(false)
        expect(showDraftChrome({ enabled: true, mode: 'live', reason: 'type' })).toBe(false)
        expect(showDraftChrome({ enabled: true, mode: 'live', reason: 'publish-instantly' })).toBe(false)
        expect(showDraftChrome(null)).toBe(false)
        expect(draftBadge({ mode: 'live', reason: 'off' })).toBeNull()
    })

    test('says Draft with the save time, or Live when the draft is empty', () => {
        const withDraft = {
            mode: 'draft',
            draft: { updatedDate: '2026-10-08T11:55:00Z', flowData: draft, stale: false }
        }
        const badge = draftBadge(withDraft, now)
        expect(badge.text).toBe('Draft, not live yet')
        expect(badgeText(badge, false)).toBe(`Draft, not live yet · Saved ${relativeTime('2026-10-08T11:55:00Z', now)}`)
        expect(badgeText(badge, true)).toBe(`Draft · Saved ${relativeTime('2026-10-08T11:55:00Z', now)}`)
        expect(draftBadge({ mode: 'draft', draft: null }, now)).toEqual({ tone: 'live', text: 'Live', short: 'Live', detail: '' })
    })

    test('shows Publish instantly only for a flow that has drafts', () => {
        expect(showPublishInstantly({ enabled: true, mode: 'draft', reason: null })).toBe(true)
        expect(showPublishInstantly({ enabled: true, mode: 'live', reason: 'publish-instantly' })).toBe(true)
        expect(showPublishInstantly({ enabled: false, mode: 'live', reason: 'off' })).toBe(false)
        expect(showPublishInstantly({ enabled: true, mode: 'live', reason: 'type' })).toBe(false)
        expect(publishInstantlyLocked({ draft: { flowData: '{}' } })).toBe(true)
        expect(publishInstantlyLocked({ draft: null })).toBe(false)
    })
})

describe('canvas load and save', () => {
    const chatflow = { name: 'Bakery helper', flowData: live }

    test('opens the draft on the canvas and leaves Live alone when drafts are off', () => {
        expect(canvasFlowText(chatflow, { mode: 'draft', draft: { flowData: draft } })).toBe(draft)
        expect(canvasFlowText(chatflow, { mode: 'live', reason: 'off', draft: null })).toBe(live)
        expect(canvasFlowText(chatflow, null)).toBe(live)
    })

    test('sends the canvas to the draft, and the name to Live without the canvas', () => {
        expect(planCanvasSave({ mode: 'live', name: 'Bakery helper', savedName: 'Bakery helper', flowData: draft, hasId: true })).toEqual({
            create: false,
            live: { name: 'Bakery helper', flowData: draft },
            draft: null
        })
        expect(planCanvasSave({ mode: 'draft', name: 'Bakery helper', savedName: 'Bakery helper', flowData: draft, hasId: true })).toEqual({
            create: false,
            live: null,
            draft: { flowData: draft }
        })
        expect(planCanvasSave({ mode: 'draft', name: 'Bakery', savedName: 'Bakery helper', flowData: draft, hasId: true }).live).toEqual({
            name: 'Bakery'
        })
        expect(planCanvasSave({ mode: 'draft', name: 'New', savedName: '', flowData: draft, hasId: false }).create).toBe(true)
    })
})

describe('test chat', () => {
    test('reads the draft a flow saved only as a draft will run, and Live otherwise', () => {
        const emptyLive = { id: 'f1', type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}', chatbotConfig: '{}' }
        const draft = { mode: 'draft', draft: { flowData: live } }
        expect(testChatFlow(emptyLive, draft)).toEqual({ ...emptyLive, flowData: live })
        expect(testChatFlow(emptyLive, { mode: 'live', reason: 'publish-instantly', draft: { flowData: live } }).flowData).toBe(
            emptyLive.flowData
        )
        expect(testChatFlow(emptyLive, null).flowData).toBe(emptyLive.flowData)
        expect(testChatFlow(null, draft)).toBeNull()
    })
})

describe('publish diff', () => {
    test('lists added, changed and removed pieces in the history words', () => {
        const diff = diffCanvases(live, draft)
        expect(diff.added.map((node) => node.label)).toEqual(['Calculator'])
        expect(diff.changed[0].fields).toContain('inputs.systemMessagePrompt')
        expect(diff.moved).toEqual(['n1'])
        expect(diff.edgesChanged).toBe(true)
        expect(diff.removed).toEqual([])
        const lines = publishChangeLines(live, draft).map((line) => line.text)
        expect(lines).toContain('Added Calculator')
        expect(lines.some((line) => line.startsWith('Changed Conversation Chain'))).toBe(true)
        expect(lines).toContain('Rewired connections')
    })

    test('a pipeline change list uses the same words, and a pipeline publish has no question check', () => {
        const livePipeline = JSON.stringify({
            nodes: [
                {
                    id: 'src',
                    data: { label: 'Streaming Files', inputs: { paths: '/data/catalog.csv' } }
                },
                { id: 'old', data: { label: 'Old splitter', inputs: { chunkSize: 800 } } }
            ],
            edges: []
        })
        const draftPipeline = JSON.stringify({
            nodes: [
                {
                    id: 'src',
                    data: { label: 'Streaming Files', inputs: { paths: '/data/catalog-2026.csv' } }
                },
                { id: 'added', data: { label: 'Clean & Transform', inputs: {} } }
            ],
            edges: []
        })
        const lines = publishChangeLines(livePipeline, draftPipeline).map((line) => line.text)
        expect(lines).toContain('Added Clean & Transform')
        expect(lines).toContain('Removed Old splitter')
        expect(lines.some((line) => line.startsWith('Changed Streaming Files: paths'))).toBe(true)
        expect(showsPublishCheck('ETL')).toBe(false)
        expect(showsPublishCheck('CHATFLOW')).toBe(true)
        expect(showsPublishCheck('HARNESS')).toBe(true)
        expect(PIPELINE_PREVIEW_NOTE).toContain('does not write to the store')
        expect(PIPELINE_RUN_DIRTY).toContain('stores a draft')
        expect(PIPELINE_RUN_DRAFT).toContain('published pipeline')
    })

    test('a draft that matched Live does not look changed when the only difference is nodePack', () => {
        const withPack = JSON.parse(live)
        withPack.nodes[0].data.nodePack = '@cuttlely/node-pack-tools-mcp'
        expect(diffCanvases(live, JSON.stringify(withPack)).changed).toEqual([])
        expect(publishChangeLines(live, JSON.stringify(withPack))).toEqual([])
    })

    test('ignores the selected flag and a canvas that is not JSON', () => {
        const selectedOnly = JSON.stringify({
            nodes: [
                {
                    id: 'n1',
                    position: { x: 0, y: 0 },
                    data: { label: 'Conversation Chain', inputs: { systemMessagePrompt: 'Hello' }, selected: true }
                }
            ],
            edges: [{ source: 'n1', sourceHandle: 'a', target: 'n2', targetHandle: 'b' }]
        })
        expect(publishChangeLines(live, selectedOnly)).toEqual([])
        expect(diffCanvases('nope', draft).added).toEqual([])
    })

    test('asks before replacing Live, and names the published version', () => {
        expect(STALE_DRAFT_WARNING).toContain('Live changed after you started these edits')
        expect(publishBody(true, true)).toEqual({ overwriteLiveChanges: true })
        expect(publishBody(true, false)).toEqual({})
        expect(publishBody(false, true)).toEqual({})
        expect(publishResultMessage({ version: { title: 'Published: Changed Conversation Chain' }, recorded: true })).toEqual({
            message: 'Published. Published: Changed Conversation Chain',
            variant: 'success'
        })
        expect(publishResultMessage({ unchanged: true }).variant).toBe('info')
        expect(publishResultMessage({ recorded: false, historyError: 'git was not found on PATH.' }).message).toContain(
            'git was not found on PATH.'
        )
    })

    test('shows the server message as it was sent', () => {
        expect(
            apiErrorMessage({ response: { data: { message: 'There are no unpublished changes to publish.' } } }, 'Publish failed.')
        ).toBe('There are no unpublished changes to publish.')
        expect(apiErrorMessage({ response: { data: 'Drafts are off on this server.' } }, 'Publish failed.')).toBe(
            'Drafts are off on this server.'
        )
        expect(apiErrorMessage({}, 'Publish failed.')).toBe('Publish failed.')
    })
})

describe('history markers and restore into a draft', () => {
    test('labels publish and rollback', () => {
        expect(kindLabel('publish')).toBe('Published')
        expect(kindLabel('rollback')).toBe('Rolled back')
    })

    test('marks Published, and Live only when it is not the same Current row outside draft mode', () => {
        const version = { sha: 'abc', published: true }
        expect(versionMarkers(version, { liveSha: 'abc', currentSha: 'abc', draftMode: false })).toEqual(['Published', 'Current'])
        expect(versionMarkers(version, { liveSha: 'abc', currentSha: 'abc', draftMode: true })).toEqual(['Published', 'Live'])
        expect(versionMarkers({ sha: 'abc', published: false }, { liveSha: 'older', currentSha: 'abc', draftMode: true })).toEqual([
            'Current'
        ])
        expect(versionMarkers({ sha: 'older', published: true }, { liveSha: 'older', currentSha: 'abc', draftMode: false })).toEqual([
            'Published',
            'Live'
        ])
    })

    test('says a draft restore left Live alone, without a history warning', () => {
        // The server always answers a draft restore with recorded: false and historyError: null.
        const draftRestore = { restoredTo: 'draft', version: null, recorded: false, historyError: null, unchanged: false }
        expect(restoreMessage(draftRestore)).toEqual({
            message: 'Opened this version as your draft. Live is unchanged until you publish.',
            variant: 'success'
        })
        expect(restoreMessage(draftRestore).message).not.toContain('History could not record it')
        expect(restoreMessage({ ...draftRestore, unchanged: true })).toEqual({
            message: 'This version is already live. There is nothing new to publish.',
            variant: 'info'
        })
        const withNotes = restoreMessage({
            ...draftRestore,
            missingCredentials: [{ name: 'OpenAI trial' }],
            hiddenSecrets: [{ label: 'Conversation Chain', inputLabel: 'System Message' }]
        })
        expect(withNotes.variant).toBe('warning')
        expect(withNotes.message).toBe(
            'Opened this version as your draft. Live is unchanged until you publish. Add these credentials before you publish: OpenAI trial. Replace [secret hidden] in Conversation Chain (System Message) before you publish.'
        )
        expect(restoreMessage({ unchanged: true }).message).toBe('The flow already matches this version.')
    })
})
