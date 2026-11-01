import { cloneDeep, omit } from 'lodash'
import {
    TIDY_CLEARANCE,
    canUndoTidy,
    estimateNodeSize,
    layoutSize,
    positionSnapshot,
    tidyHarnessLayout,
    tidyStep,
    undoTidy
} from './tidyHarnessLayout'

// A made-up, messy harness: cards dropped on top of each other, a tool far away, an unwired card and a sticky note.
const card = (id, name, category, x, y, extra = {}) => ({
    id,
    type: 'customNode',
    position: { x, y },
    positionAbsolute: { x, y },
    width: 300,
    height: 420,
    selected: false,
    data: { id, name, category, label: id, inputs: { note: `${id} settings` } },
    ...extra
})

const messy = () => ({
    nodes: [
        card('specialist_summarizer', 'harnessSpecialist', 'Harness', 30, 20),
        card('chief_0', 'harnessChief', 'Harness', 40, 30),
        card('model_0', 'chatXAI', 'Chat Models', 2100, -400),
        card('specialist_research', 'harnessSpecialist', 'Harness', 35, 25),
        card('search_0', 'requestsGet', 'Tools', -900, 1600),
        card('calc_0', 'calculator', 'Tools', 50, 40),
        card('store_0', 'memoryVectorStore', 'Vector Stores', 1300, 900),
        card('embed_0', 'localHashEmbeddings', 'Embeddings', 60, 50),
        card('loose_0', 'calculator', 'Tools', 70, 60),
        {
            id: 'note_0',
            type: 'stickyNote',
            position: { x: 10, y: 10 },
            width: 240,
            height: 160,
            data: { id: 'note_0', inputs: { note: 'Research Chief notes' } }
        },
        card('iter_child', 'calculator', 'Tools', 12, 34, { parentNode: 'iter_parent', positionAbsolute: { x: 999, y: 999 } })
    ],
    edges: [
        { id: 'e1', source: 'model_0', target: 'chief_0', sourceHandle: 'model_0-output', targetHandle: 'chief_0-input-model' },
        { id: 'e2', source: 'specialist_research', target: 'chief_0', sourceHandle: 's', targetHandle: 't' },
        { id: 'e3', source: 'specialist_summarizer', target: 'chief_0', sourceHandle: 's', targetHandle: 't' },
        { id: 'e4', source: 'search_0', target: 'specialist_research', sourceHandle: 's', targetHandle: 't' },
        { id: 'e5', source: 'store_0', target: 'specialist_research', sourceHandle: 's', targetHandle: 't' },
        { id: 'e6', source: 'embed_0', target: 'store_0', sourceHandle: 's', targetHandle: 't' },
        { id: 'e7', source: 'calc_0', target: 'specialist_summarizer', sourceHandle: 's', targetHandle: 't' }
    ]
})

const withoutPositions = (nodes) => nodes.map((node) => omit(node, ['position', 'positionAbsolute']))

const overlaps = (nodes) => {
    const boxes = nodes.filter((node) => !node.parentNode).map((node) => ({ id: node.id, ...node.position, ...layoutSize(node) }))
    const hits = []
    for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i]
            const b = boxes[j]
            const apartX = a.x + a.width <= b.x || b.x + b.width <= a.x
            const apartY = a.y + a.height <= b.y || b.y + b.height <= a.y
            if (!apartX && !apartY) hits.push(`${a.id}/${b.id}`)
        }
    }
    return hits
}

describe('tidyHarnessLayout', () => {
    it('changes only position and positionAbsolute; ids, data, order, other fields and edges stay identical', () => {
        const flow = messy()
        const before = cloneDeep(flow)
        const { nodes } = tidyStep(flow.nodes, flow.edges)
        expect(flow).toEqual(before)
        expect(nodes.map((node) => node.id)).toEqual(before.nodes.map((node) => node.id))
        expect(withoutPositions(nodes)).toEqual(withoutPositions(before.nodes))
        nodes.forEach((node, index) => expect(node.data).toBe(flow.nodes[index].data))
        expect(flow.edges).toEqual(before.edges)
    })

    it('puts the model, then the Prime, then one row per Specialist with its wired cards to its right', () => {
        const flow = messy()
        const { nodes } = tidyStep(flow.nodes, flow.edges)
        const at = Object.fromEntries(nodes.map((node) => [node.id, node.position]))
        expect(at.model_0.x).toBeLessThan(at.chief_0.x)
        expect(at.model_0.y).toBe(at.chief_0.y)
        expect(at.specialist_research.x).toBeGreaterThan(at.chief_0.x)
        expect(at.specialist_summarizer.x).toBe(at.specialist_research.x)
        expect(at.search_0.x).toBeGreaterThan(at.specialist_research.x)
        expect(at.store_0.x).toBe(at.search_0.x)
        expect(at.embed_0.x).toBeGreaterThan(at.store_0.x)
        expect(at.calc_0.y).toBe(at.specialist_summarizer.y)
        // Rows keep the Specialists' old top-to-bottom order, and each row is as tall as its tallest column.
        expect(at.specialist_research.y).toBe(at.specialist_summarizer.y + 420 + TIDY_CLEARANCE)
        expect(at.search_0.y).toBe(at.store_0.y + 420 + TIDY_CLEARANCE)
        // A card wired into a card further right starts level with it.
        expect(at.embed_0.y).toBe(at.store_0.y)
        expect(overlaps(nodes)).toEqual([])
    })

    it('starts a deeper card level with the card it is wired into and pushes it down only to clear overlaps', () => {
        const flow = messy()
        // A second embeddings card wired into search_0, the lower card of the research row, and a third wired into
        // store_0 that has to sit below embed_0.
        flow.nodes.push(
            card('embed_1', 'localHashEmbeddings', 'Embeddings', 80, 70),
            card('embed_2', 'localHashEmbeddings', 'Embeddings', 90, 80)
        )
        flow.edges.push(
            { id: 'e8', source: 'embed_1', target: 'search_0', sourceHandle: 's', targetHandle: 't' },
            { id: 'e9', source: 'embed_2', target: 'store_0', sourceHandle: 's', targetHandle: 't' }
        )
        const { nodes } = tidyStep(flow.nodes, flow.edges)
        const at = Object.fromEntries(nodes.map((node) => [node.id, node.position]))
        expect(at.embed_0.y).toBe(at.store_0.y)
        expect(at.embed_2.x).toBe(at.embed_0.x)
        expect(at.embed_2.y).toBe(at.embed_0.y + 420 + TIDY_CLEARANCE)
        expect(at.embed_1.x).toBe(at.embed_0.x)
        expect(at.embed_1.y).toBe(Math.max(at.search_0.y, at.embed_2.y + 420 + TIDY_CLEARANCE))
        expect(overlaps(nodes)).toEqual([])
    })

    it('parks sticky notes and unwired cards in a last column and drops nothing', () => {
        const flow = messy()
        const positions = tidyHarnessLayout(flow.nodes, flow.edges)
        expect(positions.has('note_0')).toBe(true)
        expect(positions.has('loose_0')).toBe(true)
        const rightmost = Math.max(...[...positions.entries()].filter(([id]) => !['note_0', 'loose_0'].includes(id)).map(([, p]) => p.x))
        expect(positions.get('note_0').x).toBeGreaterThan(rightmost)
        expect(positions.get('loose_0').x).toBe(positions.get('note_0').x)
        expect(Math.abs(positions.get('note_0').y - positions.get('loose_0').y)).toBeGreaterThanOrEqual(160 + TIDY_CLEARANCE)
    })

    it('leaves a card inside a parent where it is', () => {
        const flow = messy()
        const { nodes } = tidyStep(flow.nodes, flow.edges)
        const child = nodes.find((node) => node.id === 'iter_child')
        expect(child).toBe(flow.nodes.find((node) => node.id === 'iter_child'))
    })

    it('is idempotent', () => {
        const flow = messy()
        const once = tidyStep(flow.nodes, flow.edges).nodes
        const twice = tidyStep(once, flow.edges)
        expect(twice.undo).toBeNull()
        expect(twice.nodes).toBe(once)
        expect(positionSnapshot(tidyStep(cloneDeep(once), flow.edges).nodes)).toEqual(positionSnapshot(once))
    })

    it("uses a card's measured size and the template estimate only for a side not measured yet", () => {
        const node = { id: 'a', data: { inputParams: [{ type: 'string' }], inputAnchors: [{}], outputAnchors: [{}] } }
        const estimate = estimateNodeSize(node.data)
        expect(layoutSize(node)).toEqual(estimate)
        expect(layoutSize({ ...node, width: 0, height: 0 })).toEqual(estimate)
        expect(layoutSize({ ...node, width: 280, height: 130 })).toEqual({ width: 280, height: 130 })
        expect(layoutSize({ ...node, width: 900, height: 1500 })).toEqual({ width: 900, height: 1500 })
        expect(layoutSize({ ...node, width: 280 })).toEqual({ width: 280, height: estimate.height })
    })

    const measured = (nodes, width, height) => nodes.map((node) => (node.parentNode ? node : { ...node, width, height }))
    const topOf = (nodes, id) => nodes.find((node) => node.id === id).position.y

    it('packs compact cards into tight rows', () => {
        const flow = messy()
        const tidied = tidyStep(measured(flow.nodes, 240, 190), flow.edges).nodes
        expect(overlaps(tidied)).toEqual([])
        const tops = ['specialist_research', 'specialist_summarizer'].map((id) => topOf(tidied, id)).sort((a, b) => a - b)
        // The research row holds two stacked cards, so no row is taller than two cards plus their gaps.
        expect(tops[1] - tops[0]).toBeLessThanOrEqual(2 * (190 + TIDY_CLEARANCE))
        const bottom = Math.max(...tidied.filter((node) => !node.parentNode).map((node) => node.position.y + 190))
        expect(bottom).toBeLessThan(2000)
    })

    it('gives tall measured classic cards the room they measure', () => {
        const flow = messy()
        const classic = measured(flow.nodes, 360, 1100)
        const tidied = tidyStep(classic, flow.edges).nodes
        expect(overlaps(tidied)).toEqual([])
        const tops = ['specialist_research', 'specialist_summarizer'].map((id) => topOf(tidied, id))
        expect(Math.abs(tops[0] - tops[1])).toBeGreaterThanOrEqual(1100 + TIDY_CLEARANCE)
    })

    it('clears overlaps when a layout tidied with compact cards is tidied again with classic cards', () => {
        const flow = messy()
        const compact = tidyStep(measured(flow.nodes, 240, 190), flow.edges).nodes
        const classic = measured(compact, 360, 1100)
        const retidied = tidyStep(classic, flow.edges).nodes
        expect(overlaps(retidied)).toEqual([])
    })
})

describe('tidy undo', () => {
    it('restores the exact previous position fields, including a missing positionAbsolute', () => {
        const flow = messy()
        delete flow.nodes[0].positionAbsolute
        const before = cloneDeep(flow.nodes)
        const step = tidyStep(flow.nodes, flow.edges)
        expect(canUndoTidy(step.undo, step.nodes)).toBe(true)
        const restored = undoTidy(step.undo, step.nodes)
        expect(restored).toEqual(before)
        expect('positionAbsolute' in restored[0]).toBe(false)
    })

    it('is one level: after a card moves, or a card is added or removed, undo does nothing', () => {
        const flow = messy()
        const step = tidyStep(flow.nodes, flow.edges)
        const moved = step.nodes.map((node) => (node.id === 'chief_0' ? { ...node, position: { x: 5, y: 5 } } : node))
        expect(canUndoTidy(step.undo, moved)).toBe(false)
        expect(undoTidy(step.undo, moved)).toBe(moved)
        const added = [...step.nodes, card('extra', 'calculator', 'Tools', 0, 0)]
        expect(canUndoTidy(step.undo, added)).toBe(false)
        expect(canUndoTidy(step.undo, step.nodes.slice(1))).toBe(false)
        expect(canUndoTidy(null, step.nodes)).toBe(false)
    })

    it('also ends when a card inside another card moves, is added or is removed', () => {
        const flow = messy()
        const step = tidyStep(flow.nodes, flow.edges)
        const movedChild = step.nodes.map((node) => (node.id === 'iter_child' ? { ...node, position: { x: 50, y: 60 } } : node))
        expect(canUndoTidy(step.undo, movedChild)).toBe(false)
        expect(undoTidy(step.undo, movedChild)).toBe(movedChild)
        const addedChild = [...step.nodes, card('child_2', 'calculator', 'Tools', 1, 2, { parentNode: 'iter_parent' })]
        expect(canUndoTidy(step.undo, addedChild)).toBe(false)
        const removedChild = step.nodes.filter((node) => node.id !== 'iter_child')
        expect(canUndoTidy(step.undo, removedChild)).toBe(false)
    })

    it('keeps data edits made after Tidy when it undoes', () => {
        const flow = messy()
        const step = tidyStep(flow.nodes, flow.edges)
        const edited = step.nodes.map((node) =>
            node.id === 'chief_0' ? { ...node, data: { ...node.data, label: 'Research Chief' } } : node
        )
        const restored = undoTidy(step.undo, edited)
        expect(restored.find((node) => node.id === 'chief_0').data.label).toBe('Research Chief')
        expect(positionSnapshot(restored)).toEqual(positionSnapshot(flow.nodes))
    })
})
