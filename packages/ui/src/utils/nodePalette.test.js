import { RETIRED_PALETTE_NODES, visibleInPalette } from './nodePalette'
import { normalizeCanvasFlow } from './normalizeCanvasFlow'

// The node list the server sends. The palette filters it; loading a saved flow uses all of it.
const openAILLMSpec = {
    name: 'openAI',
    label: 'OpenAI',
    version: 4,
    type: 'OpenAI',
    category: 'LLMs',
    badge: 'DEPRECATING',
    baseClasses: ['OpenAI', 'BaseLLM'],
    inputs: [
        { label: 'Cache', name: 'cache', type: 'BaseCache', optional: true },
        { label: 'Model Name', name: 'modelName', type: 'asyncOptions', loadMethod: 'listModels', freeSolo: true },
        { label: 'Temperature', name: 'temperature', type: 'number', optional: true }
    ]
}
const nodeList = [
    openAILLMSpec,
    { name: 'azureOpenAI', label: 'Azure OpenAI', category: 'LLMs', badge: 'DEPRECATING' },
    { name: 'cohere', label: 'Cohere', category: 'LLMs', badge: 'DEPRECATING' },
    { name: 'togetherAI', label: 'TogetherAI', category: 'LLMs', badge: 'DEPRECATING' },
    { name: 'chatOpenAI', label: 'ChatOpenAI', category: 'Chat Models' },
    { name: 'llmChain', label: 'LLM Chain', category: 'Chains' }
]

describe('node palette', () => {
    it('leaves the three retired completion cards out, even on an exact search', () => {
        expect([...RETIRED_PALETTE_NODES].sort()).toEqual(['azureOpenAI', 'cohere', 'openAI'])
        for (const node of nodeList.filter((nd) => RETIRED_PALETTE_NODES.has(nd.name))) {
            expect(visibleInPalette(node, '')).toBe(false)
            expect(visibleInPalette(node, node.name)).toBe(false)
            expect(visibleInPalette(node, node.label)).toBe(false)
        }
    })

    it('keeps the other rules: current cards show, other deprecated cards only on an exact search', () => {
        const chatOpenAI = nodeList.find((nd) => nd.name === 'chatOpenAI')
        const together = nodeList.find((nd) => nd.name === 'togetherAI')
        expect(visibleInPalette(chatOpenAI, '')).toBe(true)
        expect(visibleInPalette(together, '')).toBe(false)
        expect(visibleInPalette(together, 'togetherai')).toBe(true)
        expect(visibleInPalette(together, 'TogetherAI')).toBe(true)
    })

    it('a saved flow with the OpenAI LLM card still loads with its saved model', () => {
        const saved = {
            nodes: [
                {
                    id: 'openAI_0',
                    position: { x: 100, y: 100 },
                    data: {
                        id: 'openAI_0',
                        name: 'openAI',
                        label: 'OpenAI',
                        version: 4,
                        category: 'LLMs',
                        inputs: { modelName: 'gpt-3.5-turbo-instruct', temperature: 0.4 }
                    }
                },
                {
                    id: 'llmChain_0',
                    position: { x: 500, y: 100 },
                    data: { id: 'llmChain_0', name: 'llmChain', label: 'LLM Chain', inputs: { model: '{{openAI_0.data.instance}}' } }
                }
            ],
            edges: [{ id: 'openAI_0-llmChain_0', source: 'openAI_0', target: 'llmChain_0' }]
        }
        const flow = normalizeCanvasFlow(JSON.parse(JSON.stringify(saved)), nodeList)
        const card = flow.nodes.find((node) => node.id === 'openAI_0').data
        expect(card.cuttlelyRawNode).toBeUndefined()
        expect(card.inputs.modelName).toBe('gpt-3.5-turbo-instruct')
        expect(card.inputs.temperature).toBe(0.4)
        expect(card.inputParams.map((param) => param.name)).toEqual(['modelName', 'temperature'])
        expect(card.inputAnchors.map((anchor) => anchor.name)).toEqual(['cache'])
        expect(flow.edges).toHaveLength(1)
        expect(flow.nodes.find((node) => node.id === 'llmChain_0').data.inputs.model).toBe('{{openAI_0.data.instance}}')
    })

    it('a saved flow that stored the full OpenAI LLM card loads unchanged', () => {
        const data = {
            id: 'openAI_0',
            name: 'openAI',
            version: 4,
            inputs: { modelName: 'gpt-3.5-turbo-instruct' },
            inputParams: [{ name: 'modelName', type: 'asyncOptions', id: 'openAI_0-input-modelName-asyncOptions' }],
            inputAnchors: [],
            outputAnchors: [{ id: 'openAI_0-output-openAI-OpenAI|BaseLLM', name: 'openAI', type: 'OpenAI | BaseLLM' }]
        }
        const before = JSON.parse(JSON.stringify(data))
        const flow = normalizeCanvasFlow({ nodes: [{ id: 'openAI_0', data }], edges: [] }, nodeList)
        expect(flow.nodes[0].data).toEqual(before)
    })
})
