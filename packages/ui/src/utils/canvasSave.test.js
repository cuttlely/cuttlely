import { canvasSaveDocument } from './canvasSave'
import { planCanvasSave } from './flowDrafts'
import { missingNodeInfo } from './missingNode'
import { normalizeCanvasFlow } from './normalizeCanvasFlow'

const catalog = [{ name: 'chatOpenAI', version: 2 }]

const missingData = {
    id: 'pack',
    label: 'Sample Pack Node',
    name: 'samplePackNode',
    version: 1,
    nodePack: 'sample-pack',
    inputAnchors: [{ id: 'pack-in', name: 'input' }],
    inputParams: [],
    outputAnchors: [{ id: 'pack-out', name: 'output', options: [{ id: 'pack-out-json', name: 'json', isAnchor: true }] }],
    inputs: { samplePackApi_CREDENTIAL_ID: 'cred-1', note: 'keep me' },
    extra: { untouched: true },
    selected: false
}

const original = {
    nodes: [
        {
            id: 'prompt',
            type: 'customNode',
            position: { x: 0, y: 0 },
            data: {
                id: 'prompt',
                label: 'Prompt',
                name: 'chatOpenAI',
                version: 2,
                inputAnchors: [],
                inputParams: [{ name: 'model', type: 'string' }],
                outputAnchors: [{ id: 'prompt-out', name: 'output' }],
                inputs: { model: 'gpt' },
                selected: false
            }
        },
        {
            id: 'pack',
            type: 'customNode',
            position: { x: 220, y: 0 },
            data: missingData
        },
        {
            id: 'down',
            type: 'customNode',
            position: { x: 480, y: 0 },
            data: {
                id: 'down',
                label: 'Down',
                name: 'chatOpenAI',
                version: 2,
                inputAnchors: [{ id: 'down-in', name: 'input' }],
                inputParams: [],
                outputAnchors: [],
                inputs: {},
                selected: false
            }
        }
    ],
    edges: [
        { id: 'e-in', source: 'prompt', target: 'pack', sourceHandle: 'prompt-out', targetHandle: 'pack-in' },
        { id: 'e-out', source: 'pack', target: 'down', sourceHandle: 'pack-out-json', targetHandle: 'down-in' }
    ],
    viewport: { x: 0, y: 0, zoom: 1 }
}

const touching = (flow, id) => flow.edges.filter((edge) => edge.source === id || edge.target === id)

const instanceFor = (flow) => {
    const state = JSON.parse(JSON.stringify(flow))
    return {
        getNodes: () => state.nodes,
        toObject: () => ({ nodes: state.nodes, edges: state.edges, viewport: state.viewport })
    }
}

const missingNode = (flow) => flow.nodes.find((node) => node.id === 'pack')

describe('saving a canvas that has a node which is not installed', () => {
    const loaded = normalizeCanvasFlow(JSON.parse(JSON.stringify(original)), catalog)

    test('load leaves the missing node and its lines as they were saved', () => {
        expect(JSON.stringify(missingNode(loaded).data)).toBe(JSON.stringify(missingData))
        expect(JSON.stringify(touching(loaded, 'pack'))).toBe(JSON.stringify(touching(original, 'pack')))
        expect(missingNodeInfo(missingNode(loaded).data, catalog).message).toBe(
            'Sample Pack Node is not installed. Install the sample-pack pack.'
        )
    })

    test('a save with no changes keeps that node and every line touching it', () => {
        const saved = canvasSaveDocument(instanceFor(loaded))
        expect(JSON.stringify(missingNode(saved).data)).toBe(JSON.stringify(missingData))
        expect(JSON.stringify(touching(saved, 'pack'))).toBe(JSON.stringify(touching(original, 'pack')))
        const flowData = JSON.stringify(saved)
        expect(planCanvasSave({ mode: 'draft', name: 'A', savedName: 'A', flowData, hasId: true }).draft.flowData).toBe(flowData)
        expect(planCanvasSave({ mode: 'live', name: 'A', savedName: 'A', flowData, hasId: true }).live.flowData).toBe(flowData)
    })

    test('editing another node and saving still keeps the missing node and its lines', () => {
        const instance = instanceFor(loaded)
        const prompt = instance.getNodes().find((node) => node.id === 'prompt')
        prompt.position = { x: 80, y: 40 }
        prompt.data = { ...prompt.data, inputs: { ...prompt.data.inputs, model: 'changed' } }
        const saved = canvasSaveDocument(instance)
        expect(JSON.stringify(missingNode(saved).data)).toBe(JSON.stringify(missingData))
        expect(JSON.stringify(touching(saved, 'pack'))).toBe(JSON.stringify(touching(original, 'pack')))
        expect(saved.nodes.find((node) => node.id === 'prompt').position).toEqual({ x: 80, y: 40 })
        expect(saved.nodes.find((node) => node.id === 'prompt').data.inputs.model).toBe('changed')
        const flowData = JSON.stringify(saved)
        const draft = JSON.parse(planCanvasSave({ mode: 'draft', name: 'A', savedName: 'A', flowData, hasId: true }).draft.flowData)
        expect(JSON.stringify(missingNode(draft).data)).toBe(JSON.stringify(missingData))
        expect(JSON.stringify(touching(draft, 'pack'))).toBe(JSON.stringify(touching(original, 'pack')))
    })

    test('once the pack is loaded the node is no longer a placeholder and the same lines still match its anchors', () => {
        const saved = canvasSaveDocument(instanceFor(loaded))
        const data = missingNode(saved).data
        expect(missingNodeInfo(data, [...catalog, { name: 'samplePackNode', version: 1 }])).toBeNull()
        const lines = touching(saved, 'pack')
        expect(lines.map((edge) => edge.targetHandle)).toContain(data.inputAnchors[0].id)
        expect(lines.map((edge) => edge.sourceHandle)).toContain(data.outputAnchors[0].options[0].id)
    })
})
