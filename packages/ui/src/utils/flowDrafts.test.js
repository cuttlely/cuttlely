import { kindLabel, relativeTime, restoreMessage, versionMarkers } from './versionHistory'
import {
    STALE_DRAFT_WARNING,
    apiErrorMessage,
    badgeText,
    canvasAfterDiscard,
    canvasAfterPublish,
    canvasAfterRollback,
    canvasFlowText,
    canvasTextToApply,
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

describe('publish and rollback keep the Live canvas', () => {
    const published = (label, path) =>
        JSON.stringify({
            nodes: [{ id: 'src', data: { label, inputs: { paths: path } } }],
            edges: []
        })
    const withExtra = (label, path) =>
        JSON.stringify({
            nodes: [
                { id: 'src', data: { label, inputs: { paths: path } } },
                { id: 'added', data: { label: 'Clean & Transform', inputs: {} } }
            ],
            edges: []
        })

    test.each(['CHATFLOW', 'AGENTFLOW', 'ETL'])(
        'a %s publish keeps the published canvas when the summary omits it, and Discard puts that canvas back',
        (type) => {
            const before = published('Streaming Files', 'outdoor-catalog.csv')
            const draft = withExtra('Streaming Files', 'outdoor-catalog-2026.csv')
            const later = published('Streaming Files', 'outdoor-catalog-2027.csv')
            const previous = { id: 'f1', name: 'Upgrade catalog', type, flowData: before, chatbotConfig: '{}' }
            const summary = { id: 'f1', name: 'Upgrade catalog', type, updatedDate: '2026-10-13T00:00:00.000Z' }
            const next = canvasAfterPublish(previous, { chatflow: summary, status: { mode: 'draft', draft: null } }, draft)

            expect(next.chatflow.flowData).toBe(draft)
            expect(next.chatflow.chatbotConfig).toBe('{}')
            expect(next.chatflow.type).toBe(type)
            expect(next.apply).toBe(draft)
            expect(publishChangeLines(next.chatflow.flowData, later).length).toBeGreaterThan(0)
            expect(canvasAfterDiscard(next.chatflow)).toBe(draft)
            expect(canvasAfterDiscard({ ...next.chatflow, flowData: '' })).toBeNull()
            expect(canvasAfterDiscard({ ...next.chatflow, flowData: undefined })).toBeNull()
        }
    )

    test.each(['CHATFLOW', 'AGENTFLOW', 'ETL'])('a %s publish prefers the canvas the server saved', (type) => {
        const draft = published('Conversation Chain', 'Hello')
        const saved = published('Conversation Chain', 'Welcome')
        const previous = { id: 'f1', name: 'Desk', type, flowData: published('Conversation Chain', 'Old') }
        const next = canvasAfterPublish(
            previous,
            { chatflow: { id: 'f1', name: 'Desk', type, flowData: saved }, status: { draft: null } },
            draft
        )
        expect(next.chatflow.flowData).toBe(saved)
        expect(next.apply).toBe(saved)
    })

    test('a newer draft saved during publish stays on the canvas, and the record is the canvas that went Live', () => {
        const live = published('Streaming Files', 'a.csv')
        const publishedDraft = published('Streaming Files', 'b.csv')
        const newer = withExtra('Streaming Files', 'b.csv')
        const next = canvasAfterPublish(
            { id: 'f1', type: 'ETL', flowData: live },
            {
                chatflow: { id: 'f1', type: 'ETL', flowData: publishedDraft },
                status: { draft: { flowData: newer } }
            },
            publishedDraft
        )
        expect(next.chatflow.flowData).toBe(publishedDraft)
        expect(next.apply).toBe(newer)
        expect(publishChangeLines(next.chatflow.flowData, newer).map((line) => line.text)).toContain('Added Clean & Transform')
    })

    test.each(['CHATFLOW', 'AGENTFLOW', 'ETL'])(
        'a %s roll back with no draft applies the version canvas from the response or a refetch',
        (type) => {
            const before = published('Streaming Files', 'a.csv')
            const version = published('Streaming Files', 'b.csv')
            const previous = { id: 'f1', name: 'Upgrade catalog', type, flowData: before }
            const summary = { id: 'f1', name: 'Upgrade catalog', type, updatedDate: 'd' }

            const fromServer = canvasAfterRollback(previous, { chatflow: { ...summary, flowData: version }, status: { draft: null } }, '')
            expect(fromServer.chatflow.flowData).toBe(version)
            expect(fromServer.apply).toBe(version)

            const fromRefetch = canvasAfterRollback(previous, { chatflow: summary, status: { draft: null } }, version)
            expect(fromRefetch.chatflow.flowData).toBe(version)
            expect(fromRefetch.apply).toBe(version)
            expect(publishChangeLines(fromRefetch.chatflow.flowData, withExtra('Streaming Files', 'b.csv')).length).toBeGreaterThan(0)
            expect(canvasAfterDiscard(fromRefetch.chatflow)).toBe(version)
        }
    )

    test('a roll back that keeps a draft updates Live on the record and leaves the open canvas alone', () => {
        const before = published('Streaming Files', 'a.csv')
        const version = published('Streaming Files', 'b.csv')
        const openDraft = withExtra('Streaming Files', 'c.csv')
        const next = canvasAfterRollback(
            { id: 'f1', type: 'ETL', flowData: before },
            { chatflow: { id: 'f1', type: 'ETL', flowData: version }, status: { draft: { flowData: openDraft } } },
            before
        )
        expect(next.chatflow.flowData).toBe(version)
        expect(next.apply).toBeNull()
    })

    test('a blank or unreadable canvas is not applied', () => {
        expect(canvasTextToApply('')).toBeNull()
        expect(canvasTextToApply('   ')).toBeNull()
        expect(canvasTextToApply(undefined)).toBeNull()
        expect(canvasTextToApply(null)).toBeNull()
        expect(canvasTextToApply('not json')).toBeNull()
        expect(canvasTextToApply('{"foo":1}')).toBeNull()
        const previous = { id: 'f1', type: 'CHATFLOW', name: 'Desk' }
        const wiped = canvasAfterPublish(previous, { chatflow: { id: 'f1', type: 'CHATFLOW' }, status: { draft: null } }, '')
        expect(wiped.chatflow.flowData).toBeUndefined()
        expect(wiped.apply).toBeNull()
        const rolled = canvasAfterRollback(previous, { chatflow: { id: 'f1', type: 'CHATFLOW' }, status: { draft: null } }, '')
        expect(rolled.apply).toBeNull()
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
