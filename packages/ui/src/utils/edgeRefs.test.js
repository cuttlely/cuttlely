import { readFileSync } from 'fs'
import { join } from 'path'

import { anyNeedsSync, applyEdgeRefs, fillSpecDefaults, healImportedFlow, needsSync, stageCanvasPayload, wizardHeal } from './edgeRefs'
import { scanFlowiseMigration } from './flowiseMigration.mjs'
import { showHideInputAnchors, showHideInputParams, updateOutdatedNodeData } from './genericHelper'
import { normalizeCanvasFlow, specsByName } from './normalizeCanvasFlow'

const copy = (value) => JSON.parse(JSON.stringify(value))

const fixture = (name) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'))

const specs = [
    {
        name: 'chatOpenAI',
        label: 'Model',
        version: 8.3,
        type: 'ChatOpenAI',
        category: 'Chat Models',
        baseClasses: ['ChatOpenAI', 'BaseChatModel', 'BaseLanguageModel', 'Runnable'],
        credential: { label: 'Connect Credential', name: 'credential', type: 'credential' },
        inputs: [
            { label: 'Cache', name: 'cache', type: 'BaseCache', optional: true },
            { label: 'Model Name', name: 'modelName', type: 'asyncOptions', default: 'made-up-model' },
            { label: 'Temperature', name: 'temperature', type: 'number', default: 0.9, optional: true },
            { label: 'Streaming', name: 'streaming', type: 'boolean', default: true, optional: true, additionalParams: true }
        ]
    },
    {
        name: 'conversationChain',
        label: 'Conversation',
        version: 3,
        type: 'ConversationChain',
        category: 'Chains',
        baseClasses: ['ConversationChain', 'BaseChain', 'Runnable'],
        inputs: [
            { label: 'Chat Model', name: 'model', type: 'BaseChatModel' },
            { label: 'Memory', name: 'memory', type: 'BaseMemory' },
            { label: 'Input Moderation', name: 'inputModeration', type: 'Moderation', optional: true, list: true },
            { label: 'System Message', name: 'systemMessagePrompt', type: 'string', default: 'Be helpful.', additionalParams: true }
        ]
    },
    {
        name: 'bufferMemory',
        label: 'Memory',
        version: 2,
        type: 'BufferMemory',
        category: 'Memory',
        baseClasses: ['BufferMemory', 'BaseMemory'],
        inputs: [
            { label: 'Session Id', name: 'sessionId', type: 'string', default: '', additionalParams: true },
            { label: 'Memory Key', name: 'memoryKey', type: 'string', default: 'chat_history', additionalParams: true }
        ]
    }
]

const oneTarget = (input, value) => [
    {
        id: 'target-with-hyphen',
        data: {
            id: 'target-with-hyphen',
            label: 'Target',
            inputAnchors: [input],
            inputParams: [],
            inputs: value === undefined ? {} : { [input.name]: value }
        }
    }
]

const oneEdge = (targetHandle = 'target-with-hyphen-input-model-BaseChatModel') => [
    { id: 'edge-1', source: 'source-with-hyphen', target: 'target-with-hyphen', targetHandle }
]

describe('edge-backed node references', () => {
    const model = {
        id: 'target-with-hyphen-input-model-BaseChatModel',
        label: 'Chat Model',
        name: 'model',
        type: 'BaseChatModel'
    }

    it('fills an empty single input and leaves matching values alone on a second pass', () => {
        const nodes = oneTarget(model)
        const before = copy(nodes)
        const first = applyEdgeRefs(nodes, oneEdge())
        expect(first.changed).toBe(true)
        expect(first.nodes[0].data.inputs.model).toBe('{{source-with-hyphen.data.instance}}')
        expect(nodes).toEqual(before)
        expect(applyEdgeRefs(first.nodes, oneEdge())).toEqual({ nodes: first.nodes, changed: false, unmatched: [] })
    })

    it('keeps a different single value and reports the conflict', () => {
        const result = applyEdgeRefs(oneTarget(model, '{{other.data.instance}}'), oneEdge())
        expect(result.changed).toBe(false)
        expect(result.nodes[0].data.inputs.model).toBe('{{other.data.instance}}')
        expect(result.unmatched[0]).toContain('already uses a different node')
    })

    it('overwrites a different single value for a manual connection', () => {
        const result = applyEdgeRefs(oneTarget(model, '{{other.data.instance}}'), oneEdge(), { overwrite: true })
        expect(result.changed).toBe(true)
        expect(result.unmatched).toEqual([])
        expect(result.nodes[0].data.inputs.model).toBe('{{source-with-hyphen.data.instance}}')
    })

    it('adds list values once, preserves order, and orders tools on a copy', () => {
        const list = { ...model, name: 'documents', list: true }
        const documentNodes = oneTarget(list, ['{{first.data.instance}}'])
        const added = applyEdgeRefs(documentNodes, oneEdge())
        expect(added.nodes[0].data.inputs.documents).toEqual(['{{first.data.instance}}', '{{source-with-hyphen.data.instance}}'])
        expect(applyEdgeRefs(added.nodes, oneEdge()).changed).toBe(false)

        const tools = { ...model, name: 'tools', list: true }
        const original = ['{{ordinary.data.instance}}', '{{requestsPost_0.data.instance}}']
        const toolNodes = oneTarget(tools, original)
        const ordered = applyEdgeRefs(toolNodes, [{ ...oneEdge()[0], source: 'requestsGet_0' }])
        expect(ordered.nodes[0].data.inputs.tools).toEqual([
            '{{requestsGet_0.data.instance}}',
            '{{requestsPost_0.data.instance}}',
            '{{ordinary.data.instance}}'
        ])
        expect(original).toEqual(['{{ordinary.data.instance}}', '{{requestsPost_0.data.instance}}'])
    })

    it('leaves variable inputs alone', () => {
        const variable = { ...model, acceptVariable: true }
        expect(applyEdgeRefs(oneTarget(variable, 'typed value'), oneEdge())).toEqual({
            nodes: oneTarget(variable, 'typed value'),
            changed: false,
            unmatched: []
        })
    })

    it('skips the v2 canvas type', () => {
        const nodes = oneTarget(model)
        expect(applyEdgeRefs(nodes, oneEdge(), { canvasType: 'AGENTFLOW' })).toEqual({ nodes, changed: false, unmatched: [] })
    })

    it('reports an unmatched handle without mutating the input', () => {
        const nodes = oneTarget(model)
        const before = copy(nodes)
        const result = applyEdgeRefs(nodes, oneEdge('target-with-hyphen-input-missing-string'))
        expect(result.unmatched).toHaveLength(1)
        expect(nodes).toEqual(before)
    })
})

describe('declared defaults', () => {
    const spec = {
        inputs: [
            { name: 'count', type: 'number', default: 4 },
            { name: 'enabled', type: 'boolean', default: true },
            { name: 'choice', type: 'options', default: 'first' },
            { name: 'ratio', type: 'number', default: 0.9 },
            { name: 'zeroCount', type: 'number', default: 5 },
            { name: 'off', type: 'boolean', default: true },
            { name: 'note', type: 'string', default: 'fallback' },
            { name: 'hiddenValue', type: 'string', default: 'hidden', hidden: true }
        ]
    }

    it('fills missing and typed empty values while preserving user values', () => {
        const data = {
            inputs: { count: undefined, enabled: null, choice: '', ratio: 0.2, zeroCount: 0, off: false, note: '' },
            outputs: {}
        }
        const result = fillSpecDefaults(data, spec)
        expect(result.inputs).toMatchObject({
            count: 4,
            enabled: true,
            choice: 'first',
            ratio: 0.2,
            zeroCount: 0,
            off: false,
            note: ''
        })
        expect(result.inputs.hiddenValue).toBe('hidden')
    })

    it('selects the output named by an outgoing handle and keeps an existing selection', () => {
        const data = {
            id: 'source-1',
            inputs: {},
            outputs: {},
            outputAnchors: [
                {
                    name: 'output',
                    type: 'options',
                    default: 'text',
                    options: [
                        { id: 'source-1-output-text-string', name: 'text' },
                        { id: 'source-1-output-record-json', name: 'record' }
                    ]
                }
            ]
        }
        const edge = { source: 'source-1', sourceHandle: 'source-1-output-record-json' }
        expect(fillSpecDefaults(data, spec, [edge]).outputs.output).toBe('record')
        expect(fillSpecDefaults({ ...data, outputs: { output: 'text' } }, spec, [edge]).outputs.output).toBe('text')
    })
})

describe('sync availability', () => {
    const spec = { version: 3 }

    test.each([
        [undefined, true],
        [2, true],
        [3, false],
        [4, false]
    ])('compares version %s', (version, expected) => {
        expect(needsSync({ data: { version } }, spec)).toBe(expected)
    })

    it('excludes raw nodes and a missing specification', () => {
        expect(needsSync({ data: { cuttlelyRawNode: true } }, spec)).toBe(false)
        expect(needsSync({ data: {} })).toBe(false)
    })

    it('checks the displayed nodes against the current specifications', () => {
        const nodeSpecs = [{ name: 'sampleNode', version: 3 }]
        expect(anyNeedsSync([{ data: { name: 'sampleNode', version: 2 } }], nodeSpecs)).toBe(true)
        expect(anyNeedsSync([{ data: { name: 'sampleNode', version: 3 } }], nodeSpecs)).toBe(false)
        expect(anyNeedsSync([{ data: { name: 'sampleNode', cuttlelyRawNode: true } }], nodeSpecs)).toBe(false)
    })
})

describe('healing output connections', () => {
    const chainSpec = {
        name: 'sampleChain',
        label: 'Sample Chain',
        version: 2,
        type: 'SampleChain',
        category: 'Chains',
        baseClasses: ['SampleChain'],
        inputs: [],
        outputs: [
            { label: 'Chain', name: 'llmChain', baseClasses: ['SampleChain'] },
            { label: 'Prediction', name: 'outputPrediction', baseClasses: ['string', 'json'] }
        ]
    }
    const sourceNode = {
        id: 'chain_0',
        data: {
            id: 'chain_0',
            name: 'sampleChain',
            label: 'Sample Chain',
            version: 1,
            inputs: {},
            outputs: {},
            inputParams: [],
            inputAnchors: [],
            outputAnchors: []
        }
    }
    const targetNode = {
        id: 'target_0',
        data: {
            id: 'target_0',
            name: 'targetNode',
            label: 'Target',
            inputs: {},
            inputParams: [],
            inputAnchors: [{ id: 'target_0-input-value-Value', name: 'value', type: 'Value' }],
            outputAnchors: []
        }
    }

    it('uses the outgoing non-default output after a node update', () => {
        const edge = {
            id: 'edge-1',
            source: 'chain_0',
            sourceHandle: 'chain_0-output-outputPrediction-string|json',
            target: 'target_0',
            targetHandle: 'target_0-input-value-Value'
        }
        const result = healImportedFlow([sourceNode, targetNode], [edge], [chainSpec], {
            canvasType: 'CHATFLOW',
            updateNodeData: updateOutdatedNodeData
        })
        expect(result.edges).toEqual([edge])
        expect(result.nodes.find((node) => node.id === 'chain_0').data.outputs.output).toBe('outputPrediction')
    })

    it('reports a removed source output on the source node', () => {
        const edge = {
            id: 'edge-1',
            source: 'chain_0',
            sourceHandle: 'chain_0-output-missing-string',
            target: 'target_0',
            targetHandle: 'target_0-input-value-Value'
        }
        const result = healImportedFlow([sourceNode, targetNode], [edge], [chainSpec], {
            canvasType: 'CHATFLOW',
            updateNodeData: updateOutdatedNodeData
        })
        expect(result.edges).toEqual([])
        expect(result.attention).toContain(
            'Removed the edge from Sample Chain to Target: the output it came from is no longer on Sample Chain. Connect it again.'
        )
    })
})

describe('healing conditional inputs', () => {
    it('rechecks dependent fields after filling a controller default', () => {
        const spec = {
            name: 'sampleNode',
            label: 'Sample Node',
            version: 2,
            type: 'SampleNode',
            category: 'Utilities',
            baseClasses: ['SampleNode'],
            inputs: [
                { label: 'Enabled', name: 'enabled', type: 'boolean', default: true },
                { label: 'Details', name: 'details', type: 'string', show: { enabled: true } },
                { label: 'Model', name: 'model', type: 'BaseModel', show: { enabled: true } }
            ]
        }
        const nodes = [
            {
                id: 'sample_0',
                data: {
                    id: 'sample_0',
                    name: 'sampleNode',
                    label: 'Sample Node',
                    version: 1,
                    inputs: { enabled: '' },
                    outputs: {},
                    inputParams: [],
                    inputAnchors: [],
                    outputAnchors: []
                }
            }
        ]
        const result = healImportedFlow(nodes, [], [spec], {
            canvasType: 'CHATFLOW',
            updateNodeData: updateOutdatedNodeData,
            showHide: { params: showHideInputParams, anchors: showHideInputAnchors }
        })
        const data = result.nodes[0].data
        expect(data.inputs.enabled).toBe(true)
        expect(data.inputParams.find((param) => param.name === 'details').display).toBe(true)
        expect(data.inputAnchors.find((anchor) => anchor.name === 'model').display).toBe(true)
    })
})

describe('staged canvas readiness', () => {
    it('waits for node specifications before releasing the payload', () => {
        const payload = { flow: { nodes: [{ id: 'node-1' }], edges: [] } }
        const waiting = stageCanvasPayload(payload)
        expect(waiting).toEqual({ ready: null, pending: payload })

        const released = stageCanvasPayload(waiting.pending, [])
        expect(released).toEqual({ ready: payload, pending: null })
    })
})

const prepareImport = (name, nodeSpecs = specs) => {
    const report = scanFlowiseMigration(fixture(name), { catalog: nodeSpecs })
    expect(report.ok).toBe(true)
    const normalized = normalizeCanvasFlow(report.canvas, specsByName(nodeSpecs))
    return { report, healed: healImportedFlow(normalized.nodes, normalized.edges, nodeSpecs, { canvasType: 'CHATFLOW' }) }
}

const expectHealthyImport = ({ report, healed }) => {
    const byName = Object.fromEntries(healed.nodes.map((node) => [node.data.name, node]))
    expect(byName.conversationChain.data.inputs.model).toBe('{{chatOpenAI_0.data.instance}}')
    expect(byName.conversationChain.data.inputs.memory).toBe('{{bufferMemory_0.data.instance}}')
    expect(byName.chatOpenAI.data.inputs.temperature).toBe(0.9)
    expect(byName.chatOpenAI.data.version).toBe(8.3)
    expect(byName.conversationChain.data.version).toBe(3)
    expect(byName.bufferMemory.data.version).toBe(2)
    expect(
        healed.nodes.every(
            (node) =>
                !needsSync(
                    node,
                    specs.find((spec) => spec.name === node.data.name)
                )
        )
    ).toBe(true)
    expect(report.credentials.some((item) => item.nodeId === 'chatOpenAI_0' && item.slot === 'Connect Credential')).toBe(true)
    expect(healed.edges).toHaveLength(2)
}

describe('chatflow import healing', () => {
    it.each(['chat-import-convchain-noversion.json', 'chat-import-convchain-older.json'])('heals %s', (name) => {
        expectHealthyImport(prepareImport(name))
    })

    it('adds changed-anchor-name edge removal to attention', () => {
        const changedSpecs = specs.map((spec) =>
            spec.name === 'conversationChain'
                ? { ...spec, inputs: spec.inputs.map((input) => (input.name === 'model' ? { ...input, name: 'chatModel' } : input)) }
                : spec
        )
        const { healed } = prepareImport('chat-import-convchain-older.json', changedSpecs)
        expect(healed.edges).toHaveLength(1)
        expect(healed.attention.some((message) => message.includes('input it pointed at is no longer'))).toBe(true)
    })

    it('heals a saved 1.4.8 graph once and preserves user choices', () => {
        const report = scanFlowiseMigration(fixture('chat-import-convchain-noversion.json'), { catalog: specs })
        const saved = normalizeCanvasFlow(report.canvas, specsByName(specs))
        expect(
            saved.nodes.every((node) =>
                needsSync(
                    node,
                    specs.find((spec) => spec.name === node.data.name)
                )
            )
        ).toBe(true)

        const first = healImportedFlow(saved.nodes, saved.edges, specs, { canvasType: 'CHATFLOW' })
        expectHealthyImport({ report, healed: first })
        expect(healImportedFlow(first.nodes, first.edges, specs, { canvasType: 'CHATFLOW' })).toEqual(first)

        const chosen = copy(saved)
        chosen.nodes.find((node) => node.data.name === 'chatOpenAI').data.inputs.temperature = 0.2
        chosen.nodes.find((node) => node.data.name === 'conversationChain').data.inputs.model = '{{user-model.data.instance}}'
        const kept = healImportedFlow(chosen.nodes, chosen.edges, specs, { canvasType: 'CHATFLOW' })
        expect(kept.nodes.find((node) => node.data.name === 'chatOpenAI').data.inputs.temperature).toBe(0.2)
        expect(kept.nodes.find((node) => node.data.name === 'conversationChain').data.inputs.model).toBe('{{user-model.data.instance}}')
    })

    it('leaves a raw node untouched and unversioned', () => {
        const nodes = [{ id: 'raw-1', data: { id: 'raw-1', name: 'chatOpenAI', cuttlelyRawNode: true, inputs: {} } }]
        const result = healImportedFlow(nodes, [], specs, { canvasType: 'CHATFLOW' })
        expect(result).toEqual({ nodes, edges: [], attention: [] })
        expect(result.nodes[0].data.version).toBeUndefined()
    })

    it('leaves the v2 canvas untouched', () => {
        const source = fixture('chat-import-convchain-noversion.json').flowData
        const result = healImportedFlow(source.nodes, source.edges, specs, { canvasType: 'AGENTFLOW' })
        expect(result).toEqual({ nodes: source.nodes, edges: source.edges, attention: [] })
    })

    it('reports a node newer than its available specification', () => {
        const source = fixture('chat-import-convchain-older.json').flowData
        source.nodes[0].data.version = 9
        const result = healImportedFlow(source.nodes, source.edges, specs, { canvasType: 'CHATFLOW' })
        expect(result.attention.some((message) => message.includes('newer than the available node specification'))).toBe(true)
        expect(result.nodes[0].data.version).toBe(9)
    })

    it('heals during wizard preparation when full specifications are available', () => {
        const report = scanFlowiseMigration(fixture('chat-import-convchain-noversion.json'), {
            catalog: specs,
            heal: wizardHeal(specs)
        })
        const model = report.canvas.nodes.find((node) => node.data.name === 'chatOpenAI')
        expect(model.data.version).toBe(8.3)
        expect(model.data.inputs.temperature).toBe(0.9)
    })

    it('puts a removed changed-anchor-name edge on the wizard attention list', () => {
        const changedSpecs = specs.map((spec) =>
            spec.name === 'conversationChain'
                ? { ...spec, inputs: spec.inputs.map((input) => (input.name === 'model' ? { ...input, name: 'chatModel' } : input)) }
                : spec
        )
        const report = scanFlowiseMigration(fixture('chat-import-convchain-older.json'), {
            catalog: changedSpecs,
            heal: wizardHeal(changedSpecs)
        })
        expect(report.level).toBe('attention')
        expect(report.canvas.edges).toHaveLength(1)
        expect(report.attention.some((message) => message.includes('input it pointed at is no longer'))).toBe(true)
    })
})
