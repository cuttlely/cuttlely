import {
    adoptImportedIdentity,
    canvasPathForImport,
    connectionNeedsChoice,
    deliverImportedDraft,
    queryReady,
    shouldReplaceDraft,
    showResume,
    statusTitle,
    IMPORT_HOLD,
    draftStatusWhenImportUnknown,
    importDraftSaveOptions,
    importFlowType,
    preserveImportHold,
    untrustFlow,
    verificationFlowId
} from './importVerify'
import { planCanvasSave } from './flowDrafts'

const pin = {
    id: 'pin-1',
    name: 'pq_revenue',
    sql: 'SELECT region FROM demo_sales LIMIT 100',
    params: [{ name: 'month', type: 'date', required: true }],
    testedStamp: 'ab'.repeat(32),
    testedAt: '2020-01-01T00:00:00.000Z',
    needsRetest: false
}

test('unreadable saved queries are left unchanged', () => {
    const bad = '{not json'
    const cleared = untrustFlow({
        nodes: [{ id: 'pg', data: { inputs: { pinnedQueries: bad } } }],
        edges: []
    })
    expect(cleared.nodes[0].data.inputs.pinnedQueries).toBe(bad)
    expect(cleared.importVerification).toBe(IMPORT_HOLD)
    const objectValue = { sql: 'SELECT 1' }
    const objectFlow = untrustFlow({
        nodes: [{ id: 'pg', data: { inputs: { pinnedQueries: objectValue } } }],
        edges: []
    })
    expect(objectFlow.nodes[0].data.inputs.pinnedQueries).toEqual(objectValue)
    for (const stored of ['null', '[null,7]', JSON.stringify([pin, 7])]) {
        const kept = untrustFlow({
            nodes: [{ id: 'pg', data: { inputs: { pinnedQueries: stored } } }],
            edges: []
        })
        expect(kept.nodes[0].data.inputs.pinnedQueries).toBe(stored)
    }
})

test('an imported stamp is not treated as ready', () => {
    expect(queryReady(pin)).toBe(true)
    const cleared = untrustFlow({
        nodes: [{ id: 'pg', data: { inputs: { pinnedQueries: JSON.stringify([pin]) } } }],
        edges: []
    })
    const saved = JSON.parse(cleared.nodes[0].data.inputs.pinnedQueries)[0]
    expect(saved.sql).toBe(pin.sql)
    expect(saved.testedStamp).toBeUndefined()
    expect(queryReady(saved)).toBe(false)
})

test('a flow id that arrives later replaces an empty one, and resume does not replace the draft', () => {
    expect(verificationFlowId('', '')).toBe('')
    expect(verificationFlowId('flow-9', '')).toBe('flow-9')
    expect(shouldReplaceDraft({ flowText: '{"nodes":[]}' })).toBe(true)
    expect(shouldReplaceDraft({ flowText: '{"nodes":[]}', resume: true })).toBe(false)
    expect(shouldReplaceDraft({ flowText: '', resume: true })).toBe(false)
    expect(showResume({ status: 'incomplete', publishOffered: false, queries: [{ state: 'pending' }], connections: [] })).toBe(true)
    expect(showResume({ status: 'attention', publishOffered: false, queries: [{ state: 'failed' }], connections: [] })).toBe(false)
    expect(
        showResume({
            status: 'attention',
            publishOffered: false,
            queries: [],
            connections: [{ status: 'empty', required: true }]
        })
    ).toBe(false)
    expect(
        showResume({
            status: 'attention',
            publishOffered: false,
            queries: [{ state: 'empty' }],
            connections: [],
            smoke: [{ id: 'csv', state: 'failed' }]
        })
    ).toBe(false)
    expect(showResume(null)).toBe(false)
    expect(showResume({ status: 'running', running: true, publishOffered: false, queries: [{ state: 'pending' }], connections: [] })).toBe(
        false
    )
    expect(showResume({ status: 'running', running: false, publishOffered: false, queries: [{ state: 'pending' }], connections: [] })).toBe(
        true
    )
    const order = []
    expect(
        deliverImportedDraft({
            status: null,
            flowText: '{"nodes":[],"edges":[]}',
            onDraftStatus: () => order.push('status'),
            onImported: () => order.push('canvas')
        })
    ).toBe(false)
    expect(order).toEqual([])
    expect(
        deliverImportedDraft({
            status: { mode: 'draft', draft: { flowData: '{"nodes":[],"edges":[]}' } },
            flowText: '{"nodes":[{"id":"old"}],"edges":[]}',
            onDraftStatus: () => order.push('status'),
            onImported: (text) => order.push(text)
        })
    ).toBe(true)
    expect(order[0]).toBe('status')
    expect(order[1]).toContain('"nodes":[]')
    const imported = '{"nodes":[{"id":"imported"}],"edges":[]}'
    expect(
        deliverImportedDraft({
            status: { mode: 'live', reason: 'publish-instantly', draft: { flowData: imported } },
            flowText: '{"nodes":[{"id":"live"}],"edges":[]}',
            onImported: (text) => order.push(text)
        })
    ).toBe(true)
    expect(order.at(-1)).toBe(imported)
    expect(connectionNeedsChoice({ status: 'empty', required: true })).toBe(true)
    expect(connectionNeedsChoice({ status: 'empty', required: false })).toBe(false)
    expect(connectionNeedsChoice({ status: 'ambiguous' })).toBe(true)
    expect(canvasPathForImport('HARNESS', 'flow-new')).toBe('/harnesscanvas/flow-new')
    const remembered = []
    const replaced = []
    expect(
        adoptImportedIdentity({
            created: { id: 'flow-new', name: 'Imported' },
            flowType: 'CHATFLOW',
            remember: (id) => remembered.push(id),
            replaceState: (...args) => replaced.push(args)
        }).id
    ).toBe('flow-new')
    expect(remembered).toEqual(['flow-new'])
    expect(replaced[0][2]).toBe('/canvas/flow-new')
    const held = untrustFlow({ nodes: [], edges: [] })
    expect(held.importVerification).toBe(IMPORT_HOLD)
    const unknown = draftStatusWhenImportUnknown('flow-1')
    expect(unknown.status.mode).toBe('unknown')
    expect(unknown.load.known).toBe(false)
    expect(planCanvasSave({ mode: unknown.status.mode, name: 'A', savedName: 'A', flowData: '{}', hasId: true }).modeUnknown).toBe(true)
    const heldText = JSON.stringify({ nodes: [{ id: 'a' }], edges: [], importVerification: IMPORT_HOLD })
    expect(preserveImportHold(heldText, { nodes: [{ id: 'a' }], edges: [] }).importVerification).toBe(IMPORT_HOLD)
    expect(preserveImportHold(JSON.stringify({ nodes: [], edges: [] }), { nodes: [], edges: [] }).importVerification).toBeUndefined()
    expect(importDraftSaveOptions({ expectedDraftHash: 'loaded' })).toEqual({ strictDraftHash: true, expectedDraftHash: 'loaded' })
    expect(importFlowType({ isAgentCanvas: true })).toBe('MULTIAGENT')
    expect(importFlowType({ isAgentflowV2: true, isAgentCanvas: true })).toBe('AGENTFLOW')
    expect(canvasPathForImport('MULTIAGENT', 'flow-1')).toBe('/agentcanvas/flow-1')
})

test('the three finished results use plain titles', () => {
    expect(statusTitle('ready')).toBe('Ready to publish')
    expect(statusTitle('attention')).toBe('Needs attention')
    expect(statusTitle('incomplete')).toBe('Could not fully verify')
})
