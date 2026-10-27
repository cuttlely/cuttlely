import { applyDraftMerge, conflictKey, conflictSummary, draftMergePlan, mergeLine, nodeFields } from './flowDraftsMerge'
import { CREDENTIAL_INPUT } from './canvasSave'

const node = (id, inputs = {}, extra = {}) => ({
    id,
    type: 'customNode',
    position: { x: 0, y: 0 },
    data: { id, label: `ZZ-TEST-${id}`, name: 'chatOpenAI', inputs, inputParams: [], ...extra.data },
    ...(extra.node || {})
})
const edge = (id, source, target) => ({
    id,
    source,
    target,
    sourceHandle: `${source}-out`,
    targetHandle: `${target}-in`,
    type: 'buttonedge'
})
const canvas = (nodes, edges = [], rest = {}) => JSON.stringify({ nodes, edges, viewport: { x: 0, y: 0, zoom: 1 }, ...rest })
const parse = (text) => JSON.parse(text)
const byId = (list, id) => list.find((item) => item.id === id)

const BASE = canvas([node('a', { temperature: 0.1 }), node('b', { prompt: 'hi' })], [edge('e1', 'a', 'b')])

describe('ZZ-TEST-draft merge', () => {
    test('changes that do not overlap merge on their own: my edit, their new node and their edit to another node', () => {
        const mine = canvas([node('a', { temperature: 0.9 }), node('b', { prompt: 'hi' })], [edge('e1', 'a', 'b')])
        const theirs = canvas(
            [node('a', { temperature: 0.1 }), node('b', { prompt: 'hello' }), node('c', { prompt: 'new' })],
            [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')]
        )
        const plan = draftMergePlan(BASE, mine, theirs)
        expect(plan.conflicts).toEqual([])
        expect(plan.merged.map((entry) => mergeLine(entry, 'theirs'))).toEqual([
            'ZZ-TEST-b changed: prompt',
            'ZZ-TEST-c added',
            'Connection ZZ-TEST-b to ZZ-TEST-c added'
        ])
        const out = parse(applyDraftMerge(plan))
        expect(byId(out.nodes, 'a').data.inputs.temperature).toBe(0.9)
        expect(byId(out.nodes, 'b').data.inputs.prompt).toBe('hello')
        expect(byId(out.nodes, 'c')).toBeTruthy()
        expect(out.edges.map((item) => item.id).sort()).toEqual(['e1', 'e2'])
    })

    test('the same node changed on both sides is a conflict with the changed fields side by side, and the pick decides', () => {
        const mine = canvas([node('a', { temperature: 0.9 }), node('b', { prompt: 'hi' })], [edge('e1', 'a', 'b')])
        const theirs = canvas([node('a', { temperature: 0.5 }), node('b', { prompt: 'hi' })], [edge('e1', 'a', 'b')])
        const plan = draftMergePlan(BASE, mine, theirs)
        expect(plan.conflicts).toHaveLength(1)
        const [conflict] = plan.conflicts
        expect(conflictKey(conflict)).toBe('node:a')
        expect(conflictSummary(conflict)).toBe('You both changed it')
        expect(conflict.fields).toEqual([{ field: 'inputs.temperature', label: 'temperature', mine: '0.9', theirs: '0.5' }])
        expect(byId(parse(applyDraftMerge(plan)).nodes, 'a').data.inputs.temperature).toBe(0.9)
        expect(byId(parse(applyDraftMerge(plan, { 'node:a': 'theirs' })).nodes, 'a').data.inputs.temperature).toBe(0.5)
    })

    test('the same change on both sides is not a conflict', () => {
        const same = canvas([node('a', { temperature: 0.7 }), node('b', { prompt: 'hi' })], [edge('e1', 'a', 'b')])
        const plan = draftMergePlan(BASE, same, same)
        expect(plan.conflicts).toEqual([])
        expect(plan.merged).toEqual([])
    })

    test('a node I changed and they removed is a conflict; keeping theirs removes it and its connections', () => {
        const mine = canvas([node('a', { temperature: 0.9 }), node('b', { prompt: 'hi' })], [edge('e1', 'a', 'b')])
        const theirs = canvas([node('b', { prompt: 'hi' })], [])
        const plan = draftMergePlan(BASE, mine, theirs)
        expect(plan.conflicts.map(conflictKey)).toEqual(['node:a'])
        expect(conflictSummary(plan.conflicts[0])).toBe('You changed it, they removed it')
        expect(plan.conflicts[0].fields).toHaveLength(1)
        expect(plan.conflicts[0].fields[0]).toEqual({ field: 'inputs.temperature', label: 'temperature', mine: '0.9', theirs: 'Removed' })
        const kept = parse(applyDraftMerge(plan))
        expect(kept.nodes.map((item) => item.id)).toEqual(['a', 'b'])
        const removed = parse(applyDraftMerge(plan, { 'node:a': 'theirs' }))
        expect(removed.nodes.map((item) => item.id)).toEqual(['b'])
        expect(removed.edges).toEqual([])
    })

    test('a node they removed that I did not touch is removed, and so is the connection to it', () => {
        const theirs = canvas([node('b', { prompt: 'hi' })], [])
        const plan = draftMergePlan(BASE, BASE, theirs)
        expect(plan.conflicts).toEqual([])
        expect(plan.merged.map((entry) => mergeLine(entry, 'theirs'))).toEqual([
            'ZZ-TEST-a removed',
            'Connection ZZ-TEST-a to ZZ-TEST-b removed'
        ])
        expect(parse(applyDraftMerge(plan)).nodes.map((item) => item.id)).toEqual(['b'])
    })

    test('an unsaved node of mine is kept, and an edge they added to a node I removed is dropped', () => {
        const mine = canvas([node('b', { prompt: 'hi' }), node('m', { prompt: 'mine' })], [])
        const theirs = canvas([node('a', { temperature: 0.1 }), node('b', { prompt: 'hi' })], [edge('e1', 'a', 'b'), edge('e3', 'b', 'a')])
        const plan = draftMergePlan(BASE, mine, theirs)
        expect(plan.conflicts).toEqual([])
        const out = parse(applyDraftMerge(plan))
        expect(out.nodes.map((item) => item.id).sort()).toEqual(['b', 'm'])
        expect(out.edges).toEqual([])
    })

    test('moving a card is not a conflict with their settings edit: their settings and my position are both kept', () => {
        const mine = canvas(
            [node('a', { temperature: 0.1 }, { node: { position: { x: 500, y: 40 } } }), node('b', { prompt: 'hi' })],
            [edge('e1', 'a', 'b')]
        )
        const theirs = canvas([node('a', { temperature: 0.4 }), node('b', { prompt: 'hi' })], [edge('e1', 'a', 'b')])
        const plan = draftMergePlan(BASE, mine, theirs)
        expect(plan.conflicts).toEqual([])
        const merged = byId(parse(applyDraftMerge(plan)).nodes, 'a')
        expect(merged.data.inputs.temperature).toBe(0.4)
        expect(merged.position).toEqual({ x: 500, y: 40 })
    })

    test('editor-only fields and the credential input do not count as a change', () => {
        const editor = node(
            'a',
            { temperature: 0.1, [CREDENTIAL_INPUT]: 'cred-1' },
            { data: { selected: true, inputAnchors: [{ id: 'x' }] } }
        )
        const saved = node('a', { temperature: 0.1 }, { data: { credential: 'cred-1' } })
        expect(nodeFields(editor)).toEqual(nodeFields(saved))
    })

    test('the canvas load step runs on every side, so defaults it fills in are not a change', () => {
        const base = canvas([node('a', {})])
        const mine = canvas([node('a', { temperature: 0.7 })])
        const theirs = canvas([node('a', {}, { data: { label: 'ZZ-TEST-new label' } })])
        const fill = (flow) => ({
            nodes: flow.nodes.map((item) => ({ ...item, data: { ...item.data, inputs: { temperature: 0.7, ...item.data.inputs } } })),
            edges: flow.edges
        })
        expect(draftMergePlan(base, mine, theirs).conflicts).toHaveLength(1)
        const plan = draftMergePlan(base, mine, theirs, fill)
        expect(plan.conflicts).toEqual([])
        expect(byId(parse(applyDraftMerge(plan)).nodes, 'a').data.label).toBe('ZZ-TEST-new label')
    })

    test('other canvas settings merge one key at a time, and my viewport is kept', () => {
        const base = canvas([], [], { notes: 'one' })
        const mine = JSON.stringify({ nodes: [], edges: [], viewport: { x: 9, y: 9, zoom: 2 }, notes: 'one' })
        const theirs = canvas([], [], { notes: 'two' })
        const out = parse(applyDraftMerge(draftMergePlan(base, mine, theirs)))
        expect(out.notes).toBe('two')
        expect(out.viewport).toEqual({ x: 9, y: 9, zoom: 2 })
    })

    test('two connections joining the same handles are kept once', () => {
        const mine = canvas(
            [node('a', { temperature: 0.1 }), node('b', { prompt: 'hi' })],
            [edge('e1', 'a', 'b'), edge('mine-ab', 'b', 'a')]
        )
        const theirs = canvas(
            [node('a', { temperature: 0.1 }), node('b', { prompt: 'hi' })],
            [edge('e1', 'a', 'b'), edge('theirs-ab', 'b', 'a')]
        )
        const out = parse(applyDraftMerge(draftMergePlan(BASE, mine, theirs)))
        expect(out.edges.map((item) => item.id)).toEqual(['e1', 'mine-ab'])
    })

    test('a side that is not a canvas gives no plan', () => {
        expect(draftMergePlan(null, BASE, BASE)).toBeNull()
        expect(draftMergePlan(BASE, '{', BASE)).toBeNull()
        expect(applyDraftMerge(null)).toBeNull()
    })

    test('keeping my card that pointed at a card they deleted clears that input, as deleting it on the canvas does', () => {
        const model = node('m', {})
        const chain = (inputs) => node('c', inputs)
        const link = { ...edge('e-mc', 'm', 'c'), targetHandle: 'c-input-model-BaseLanguageModel' }
        const base = canvas([model, chain({ model: '{{m.data.instance}}', prompt: 'one' })], [link])
        const mine = canvas([model, chain({ model: '{{m.data.instance}}', prompt: 'mine' })], [link])
        const theirs = canvas([chain({ model: '', prompt: 'one' })], [])
        const plan = draftMergePlan(base, mine, theirs)
        expect(plan.conflicts.map(conflictKey)).toEqual(['node:c'])
        const out = parse(applyDraftMerge(plan))
        expect(out.nodes.map((item) => item.id)).toEqual(['c'])
        expect(out.edges).toEqual([])
        expect(out.nodes[0].data.inputs.prompt).toBe('mine')
        expect(JSON.stringify(out.nodes[0].data.inputs)).not.toContain('m.data.instance')
    })

    test('a long value is shown whole, so a change past its first lines can be read', () => {
        const long = (end) => `${'x'.repeat(600)}${end}`
        const mine = canvas([node('a', { temperature: 0.1, prompt: long('mine') }), node('b', { prompt: 'hi' })], [edge('e1', 'a', 'b')])
        const theirs = canvas(
            [node('a', { temperature: 0.1, prompt: long('theirs') }), node('b', { prompt: 'hi' })],
            [edge('e1', 'a', 'b')]
        )
        const [conflict] = draftMergePlan(BASE, mine, theirs).conflicts
        expect(conflict.fields[0].mine).toBe(long('mine'))
        expect(conflict.fields[0].theirs).toBe(long('theirs'))
    })

    test('their merged changes and my kept changes each list the changed fields, before and after', () => {
        const mine = canvas([node('a', { temperature: 0.9 }), node('b', { prompt: 'hi' })], [edge('e1', 'a', 'b')])
        const theirs = canvas([node('a', { temperature: 0.1 }), node('b', { prompt: 'hello' })], [edge('e1', 'a', 'b')])
        const plan = draftMergePlan(BASE, mine, theirs)
        expect(plan.merged.map((entry) => entry.changes)).toEqual([
            [{ field: 'inputs.prompt', label: 'prompt', before: 'hi', after: 'hello' }]
        ])
        expect(plan.kept.map((entry) => entry.changes)).toEqual([
            [{ field: 'inputs.temperature', label: 'temperature', before: '0.1', after: '0.9' }]
        ])
    })
    test('keeping my card keeps my connection to it, and keeping theirs takes their reconnect', () => {
        const chain = (inputs) =>
            node('chain', inputs, { data: { inputAnchors: [{ name: 'model', type: 'BaseChatModel' }], inputParams: [] } })
        const link = (id, source) => ({
            id,
            source,
            target: 'chain',
            sourceHandle: `${source}-output-${source}-BaseChatModel`,
            targetHandle: 'chain-input-model-BaseChatModel',
            type: 'buttonedge'
        })
        const base = canvas([node('m1'), node('m2'), chain({ model: '{{m1.data.instance}}', prompt: 'hi' })], [link('l1', 'm1')])
        const mine = canvas([node('m1'), node('m2'), chain({ model: '{{m1.data.instance}}', prompt: 'my prompt' })], [link('l1', 'm1')])
        const theirs = canvas([node('m1'), node('m2'), chain({ model: '{{m2.data.instance}}', prompt: 'hi' })], [link('l2', 'm2')])
        const plan = draftMergePlan(base, mine, theirs)
        expect(plan.conflicts.map(conflictKey)).toEqual(['node:chain'])
        const out = parse(applyDraftMerge(plan, { 'node:chain': 'mine' }))
        expect(out.edges.map((item) => item.id)).toEqual(['l1'])
        expect(byId(out.nodes, 'chain').data.inputs).toEqual({ model: '{{m1.data.instance}}', prompt: 'my prompt' })
        const theirsPicked = parse(applyDraftMerge(plan, { 'node:chain': 'theirs' }))
        expect(theirsPicked.edges.map((item) => item.id)).toEqual(['l2'])
        expect(byId(theirsPicked.nodes, 'chain').data.inputs).toEqual({ model: '{{m2.data.instance}}', prompt: 'hi' })
    })

    test('a list input only they changed gains their connection; when I changed it too, the pick decides its connections', () => {
        const agent = (tools) =>
            node('agent', { tools }, { data: { inputAnchors: [{ name: 'tools', type: 'Tool', list: true }], inputParams: [] } })
        const link = (id, source) => ({
            id,
            source,
            target: 'agent',
            sourceHandle: `${source}-output-${source}-Tool`,
            targetHandle: 'agent-input-tools-Tool',
            type: 'buttonedge'
        })
        const base = canvas([node('t1'), agent(['{{t1.data.instance}}'])], [link('k1', 't1')])
        const mine = canvas([node('t1'), agent(['{{t1.data.instance}}']), node('t9')], [link('k1', 't1')])
        const theirs = canvas(
            [node('t1'), node('t2'), agent(['{{t1.data.instance}}', '{{t2.data.instance}}'])],
            [link('k1', 't1'), link('k2', 't2')]
        )
        const out = parse(applyDraftMerge(draftMergePlan(base, mine, theirs)))
        expect(byId(out.nodes, 'agent').data.inputs.tools).toEqual(['{{t1.data.instance}}', '{{t2.data.instance}}'])
        const keepMine = canvas([node('t1'), agent(['{{t1.data.instance}}', 'x'])], [link('k1', 't1')])
        const plan = draftMergePlan(base, keepMine, theirs)
        const picked = parse(applyDraftMerge(plan, { 'node:agent': 'mine' }))
        expect(byId(picked.nodes, 'agent').data.inputs.tools).toEqual(['{{t1.data.instance}}', 'x'])
        expect(picked.edges.map((item) => item.id)).toEqual(['k1'])
    })
    test('when both drafts connected the same model input to different models, the pick for the card decides which stays', () => {
        const chain = (inputs) =>
            node('chain', inputs, { data: { inputAnchors: [{ name: 'model', type: 'BaseChatModel' }], inputParams: [] } })
        const link = (id, source) => ({
            id,
            source,
            target: 'chain',
            sourceHandle: `${source}-output-${source}-BaseChatModel`,
            targetHandle: 'chain-input-model-BaseChatModel',
            type: 'buttonedge'
        })
        const base = canvas([node('m1'), node('m2'), node('m3'), chain({ model: '{{m1.data.instance}}' })], [link('l1', 'm1')])
        const mine = canvas([node('m1'), node('m2'), node('m3'), chain({ model: '{{m3.data.instance}}' })], [link('l3', 'm3')])
        const theirs = canvas([node('m1'), node('m2'), node('m3'), chain({ model: '{{m2.data.instance}}' })], [link('l2', 'm2')])
        const plan = draftMergePlan(base, mine, theirs)
        const keepMine = parse(applyDraftMerge(plan, { 'node:chain': 'mine' }))
        expect(keepMine.edges.map((item) => item.id)).toEqual(['l3'])
        expect(byId(keepMine.nodes, 'chain').data.inputs.model).toBe('{{m3.data.instance}}')
        const keepTheirs = parse(applyDraftMerge(plan, { 'node:chain': 'theirs' }))
        expect(keepTheirs.edges.map((item) => item.id)).toEqual(['l2'])
        expect(byId(keepTheirs.nodes, 'chain').data.inputs.model).toBe('{{m2.data.instance}}')
    })
    test('keeping their card keeps its connections too: my reconnect of that card is not applied or listed', () => {
        const chain = (inputs) =>
            node('chain', inputs, { data: { inputAnchors: [{ name: 'model', type: 'BaseChatModel' }], inputParams: [] } })
        const link = (id, source) => ({
            id,
            source,
            target: 'chain',
            sourceHandle: `${source}-output-${source}-BaseChatModel`,
            targetHandle: 'chain-input-model-BaseChatModel',
            type: 'buttonedge'
        })
        const base = canvas([node('m1'), node('m2'), chain({ model: '{{m1.data.instance}}', prompt: 'hi' })], [link('l1', 'm1')])
        const mine = canvas([node('m1'), node('m2'), chain({ model: '{{m2.data.instance}}', prompt: 'hi' })], [link('l2', 'm2')])
        const theirs = canvas(
            [node('m1'), node('m2'), chain({ model: '{{m1.data.instance}}', prompt: 'their prompt' })],
            [link('l1', 'm1')]
        )
        const plan = draftMergePlan(base, mine, theirs)
        expect(plan.conflicts.map(conflictKey)).toEqual(['node:chain'])
        expect([...plan.merged, ...plan.kept].filter((entry) => entry.kind === 'edge')).toEqual([])
        const keepTheirs = parse(applyDraftMerge(plan, { 'node:chain': 'theirs' }))
        expect(keepTheirs.edges.map((item) => item.id)).toEqual(['l1'])
        expect(byId(keepTheirs.nodes, 'chain').data.inputs).toEqual({ model: '{{m1.data.instance}}', prompt: 'their prompt' })
        const keepMine = parse(applyDraftMerge(plan, { 'node:chain': 'mine' }))
        expect(keepMine.edges.map((item) => item.id)).toEqual(['l2'])
        expect(byId(keepMine.nodes, 'chain').data.inputs).toEqual({ model: '{{m2.data.instance}}', prompt: 'hi' })
    })

    test('a card we both moved to different places is a position conflict; a card only they moved is listed as moved', () => {
        const at = (id, x, y, inputs = {}) => node(id, inputs, { node: { position: { x, y } } })
        const base = canvas([at('a', 0, 0), at('b', 0, 0)])
        const mine = canvas([at('a', 100, 0), at('b', 0, 0)])
        const theirs = canvas([at('a', 0, 200, { temperature: 0.5 }), at('b', 50, 50)])
        const plan = draftMergePlan(base, mine, theirs)
        expect(plan.conflicts.map(conflictKey)).toEqual(['node:a'])
        const [moved] = plan.conflicts
        expect(conflictSummary(moved)).toBe('You both moved it')
        expect(moved.fields).toEqual([{ field: 'position', label: 'Position', mine: 'x 100, y 0', theirs: 'x 0, y 200' }])
        expect(plan.merged.map((entry) => mergeLine(entry, 'theirs'))).toEqual(['ZZ-TEST-a changed: temperature', 'ZZ-TEST-b moved'])
        const b = plan.merged.find((entry) => entry.id === 'b')
        expect(b.theirRows).toEqual([{ field: 'position', label: 'Position', before: 'x 0, y 0', after: 'x 50, y 50' }])
        const keepTheirs = parse(applyDraftMerge(plan, { 'node:a': 'theirs' }))
        expect(byId(keepTheirs.nodes, 'a').position).toEqual({ x: 0, y: 200 })
        expect(byId(keepTheirs.nodes, 'a').data.inputs.temperature).toBe(0.5)
        expect(byId(keepTheirs.nodes, 'b').position).toEqual({ x: 50, y: 50 })
        const keepMine = parse(applyDraftMerge(plan))
        expect(byId(keepMine.nodes, 'a').position).toEqual({ x: 100, y: 0 })
        expect(byId(keepMine.nodes, 'a').data.inputs.temperature).toBe(0.5)
    })
    test('a card I only moved and they removed is a conflict, and keeping mine keeps the card where I put it, with its connections', () => {
        const at = (id, x, y) => node(id, {}, { node: { position: { x, y } } })
        const base = canvas([at('a', 0, 0), at('b', 0, 0)], [edge('e1', 'a', 'b')])
        const mine = canvas([at('a', 100, 0), at('b', 0, 0)], [edge('e1', 'a', 'b')])
        const theirs = canvas([at('b', 0, 0)])
        const plan = draftMergePlan(base, mine, theirs)
        expect(plan.conflicts.map(conflictKey)).toEqual(['node:a'])
        expect(conflictSummary(plan.conflicts[0])).toBe('You moved it, they removed it')
        expect(plan.conflicts[0].fields).toEqual([{ field: 'position', label: 'Position', mine: 'x 100, y 0', theirs: 'Removed' }])
        expect(plan.kept.map((entry) => entry.id)).toEqual([])
        const kept = parse(applyDraftMerge(plan))
        expect(byId(kept.nodes, 'a').position).toEqual({ x: 100, y: 0 })
        expect(kept.edges.map((item) => item.id)).toEqual(['e1'])
        expect(byId(parse(applyDraftMerge(plan, { 'node:a': 'theirs' })).nodes, 'a')).toBeUndefined()
    })
    test('their node update and their resize of an iteration card merge with my edit to another card', () => {
        const loop = (width, height) => ({ ...node('loop'), type: 'iteration', width, height })
        const base = canvas([node('a', {}, { data: { version: 1 } }), loop(300, 250), node('b', { prompt: 'hi' })])
        const mine = canvas([node('a', {}, { data: { version: 1 } }), loop(300, 250), node('b', { prompt: 'mine' })])
        const theirs = canvas([node('a', {}, { data: { version: 2 } }), loop(600, 400), node('b', { prompt: 'hi' })])
        const plan = draftMergePlan(base, mine, theirs)
        expect(plan.conflicts).toEqual([])
        expect(plan.merged.map((entry) => entry.id)).toEqual(['a', 'loop'])
        expect(plan.merged[1].theirRows).toEqual([
            { field: 'position', label: 'Position', before: 'x 0, y 0, 300 × 250', after: 'x 0, y 0, 600 × 400' }
        ])
        const out = parse(applyDraftMerge(plan))
        expect(byId(out.nodes, 'a').data.version).toBe(2)
        expect(byId(out.nodes, 'loop')).toMatchObject({ width: 600, height: 400 })
        expect(byId(out.nodes, 'b').data.inputs.prompt).toBe('mine')
    })

    test('a measured size on an ordinary card is not a change', () => {
        const sized = (width) => ({ ...node('a'), width, height: 80 })
        const plan = draftMergePlan(canvas([sized(200)]), canvas([sized(210)]), canvas([sized(190)]))
        expect(plan.conflicts).toEqual([])
        expect([...plan.merged, ...plan.kept]).toEqual([])
    })
    test('their removal of an iteration card I changed a card inside is one conflict; the pick keeps or removes the cards inside', () => {
        const loop = { ...node('loop'), type: 'iteration' }
        const child = (id, inputs = {}) => ({ ...node(id, inputs), parentNode: 'loop' })
        const base = canvas([loop, child('c1', { prompt: 'hi' }), child('c2')])
        const mine = canvas([loop, child('c1', { prompt: 'mine' }), child('c2'), child('c3')])
        const theirs = canvas([node('other')])
        const plan = draftMergePlan(base, mine, theirs)
        expect(plan.conflicts.map(conflictKey)).toEqual(['node:loop'])
        expect(conflictSummary(plan.conflicts[0])).toBe('You changed cards inside it, they removed it with its cards')
        expect([...plan.merged, ...plan.kept].map((entry) => entry.id)).toEqual(['other'])
        const keepMine = parse(applyDraftMerge(plan))
        expect(keepMine.nodes.map((item) => item.id).sort()).toEqual(['c1', 'c2', 'c3', 'loop', 'other'])
        expect(byId(keepMine.nodes, 'c1').data.inputs.prompt).toBe('mine')
        const keepTheirs = parse(applyDraftMerge(plan, { 'node:loop': 'theirs' }))
        expect(keepTheirs.nodes.map((item) => item.id)).toEqual(['other'])
    })
    test('keeping an iteration card I changed and they removed keeps the cards inside it', () => {
        const loop = (inputs) => ({ ...node('loop', inputs), type: 'iteration' })
        const child = { ...node('c1'), parentNode: 'loop' }
        const base = canvas([loop({ items: 'a' }), child])
        const mine = canvas([loop({ items: 'b' }), child])
        const theirs = canvas([])
        const plan = draftMergePlan(base, mine, theirs)
        expect(plan.conflicts.map(conflictKey)).toEqual(['node:loop'])
        expect([...plan.merged, ...plan.kept]).toEqual([])
        expect(parse(applyDraftMerge(plan)).nodes.map((item) => item.id)).toEqual(['loop', 'c1'])
        expect(parse(applyDraftMerge(plan, { 'node:loop': 'theirs' })).nodes).toEqual([])
    })
})
