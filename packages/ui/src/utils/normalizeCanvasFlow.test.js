import { hydrateRawCanvasNodes, normalizeCanvasFlow, normalizeNodeData, repairFlowEdges } from './normalizeCanvasFlow'

const postgresSpec = {
    name: 'postgreSQLMCP',
    type: 'PostgreSQL MCP Tool',
    baseClasses: ['Tool'],
    credential: { label: 'Connect Credential', name: 'credential', type: 'credential' },
    inputs: [{ label: 'Available Actions', name: 'mcpActions', type: 'asyncMultiOptions' }]
}

describe('raw canvas nodes', () => {
    it('gives a sample node empty arrays so the canvas can read length', () => {
        const flow = normalizeCanvasFlow({
            nodes: [{ id: 'postgreSQLMCP_0', data: { id: 'postgreSQLMCP_0', name: 'postgreSQLMCP', inputs: {} } }],
            edges: []
        })
        const data = flow.nodes[0].data
        expect(() => data.inputParams.length + data.inputAnchors.length + data.outputAnchors.length).not.toThrow()
        expect(data.inputParams).toEqual([])
        expect(data.inputAnchors).toEqual([])
        expect(data.outputAnchors).toEqual([])
        expect(data.cuttlelyRawNode).toBe(true)
        expect(data.inputs).toEqual({})
    })

    it('fills QUERY from the node spec and keeps saved inputs', () => {
        const data = normalizeNodeData({ id: 'postgreSQLMCP_0', name: 'postgreSQLMCP', inputs: { mcpActions: '["query"]' } }, postgresSpec)
        expect(data.inputParams.map((param) => param.name)).toEqual(['credential', 'mcpActions'])
        expect(data.inputAnchors).toEqual([])
        expect(data.outputAnchors.length).toBe(1)
        expect(data.inputs.mcpActions).toBe('["query"]')
        expect(data.cuttlelyRawNode).toBeUndefined()
    })

    it('leaves a missing version for the healing step', () => {
        const data = normalizeNodeData({ id: 'postgreSQLMCP_0', name: 'postgreSQLMCP', inputs: {} }, { ...postgresSpec, version: 4 })
        expect(data.version).toBeUndefined()
    })

    it('hydrates a raw node once the catalog arrives', () => {
        const flow = normalizeCanvasFlow({
            nodes: [{ id: 'postgreSQLMCP_0', data: { id: 'postgreSQLMCP_0', name: 'postgreSQLMCP', inputs: {} } }]
        })
        const hydrated = hydrateRawCanvasNodes(flow.nodes, [postgresSpec])
        expect(hydrated[0].data.inputParams.map((param) => param.name)).toEqual(['credential', 'mcpActions'])
        expect(hydrated[0].data.cuttlelyRawNode).toBeUndefined()
        expect(hydrated[0].data.inputs.mcpActions).toBe('')
    })

    it('repairs legacy handle ids that omit the type suffix', () => {
        const attached = 'BaseRetriever | Tool | VectorStore | Document | Embeddings | TextSplitter | BaseDocumentTransformer'
        const flow = normalizeCanvasFlow(
            {
                nodes: [
                    { id: 'chatXAI_0', data: { id: 'chatXAI_0', name: 'chatXAI', type: 'ChatXAI' } },
                    { id: 'chief_0', data: { id: 'chief_0', name: 'harnessChief', type: 'HarnessChief' } },
                    { id: 'plainText_0', data: { id: 'plainText_0', name: 'plainText', type: 'Document' } },
                    { id: 'memoryVectorStore_0', data: { id: 'memoryVectorStore_0', name: 'memoryVectorStore', type: 'Memory' } },
                    { id: 'analyst_0', data: { id: 'analyst_0', name: 'harnessSpecialist', type: 'HarnessSpecialist' } }
                ],
                edges: [
                    { id: 'chatXAI_0-chief_0-chatModel', source: 'chatXAI_0', target: 'chief_0', targetHandle: 'chief_0-input-chatModel' },
                    {
                        id: 'plainText_0-memoryVectorStore_0-document',
                        source: 'plainText_0',
                        target: 'memoryVectorStore_0',
                        targetHandle: 'memoryVectorStore_0-input-document-Document'
                    },
                    {
                        id: 'analyst_0-chief_0-specialists',
                        source: 'analyst_0',
                        target: 'chief_0',
                        targetHandle: 'chief_0-input-specialists'
                    }
                ]
            },
            [
                {
                    name: 'chatXAI',
                    type: 'ChatXAI',
                    baseClasses: ['ChatXAI', 'BaseChatModel'],
                    inputs: []
                },
                {
                    name: 'harnessChief',
                    type: 'HarnessChief',
                    baseClasses: ['HarnessChief'],
                    inputs: [
                        { name: 'chatModel', type: 'BaseChatModel' },
                        { name: 'specialists', type: 'HarnessSpecialist' }
                    ]
                },
                {
                    name: 'plainText',
                    type: 'Document',
                    baseClasses: ['Document'],
                    outputs: [
                        { name: 'document', label: 'Document', baseClasses: ['Document', 'json'] },
                        { name: 'text', label: 'Text', baseClasses: ['string', 'json'] }
                    ],
                    inputs: []
                },
                {
                    name: 'memoryVectorStore',
                    type: 'Memory',
                    baseClasses: ['Memory'],
                    inputs: [
                        { name: 'document', type: 'Document' },
                        { name: 'embeddings', type: 'Embeddings' }
                    ]
                },
                {
                    name: 'harnessSpecialist',
                    type: 'HarnessSpecialist',
                    baseClasses: ['HarnessSpecialist'],
                    inputs: [{ name: 'attached', type: attached }]
                }
            ]
        )
        const chat = flow.edges.find((edge) => edge.id === 'chatXAI_0-chief_0-chatModel')
        expect(chat.sourceHandle).toBe('chatXAI_0-output-chatXAI-ChatXAI|BaseChatModel')
        expect(chat.targetHandle).toBe('chief_0-input-chatModel-BaseChatModel')
        const plain = flow.edges.find((edge) => edge.source === 'plainText_0')
        expect(plain.sourceHandle).toBe('plainText_0-output-document-Document|json')
        expect(plain.targetHandle).toBe('memoryVectorStore_0-input-document-Document')
        const analyst = flow.edges.find((edge) => edge.source === 'analyst_0')
        expect(analyst.sourceHandle).toBe('analyst_0-output-harnessSpecialist-HarnessSpecialist')
        expect(analyst.targetHandle).toBe('chief_0-input-specialists-HarnessSpecialist')
        const again = repairFlowEdges(flow)
        expect(again.edges.find((edge) => edge.source === 'analyst_0').targetHandle).toBe('chief_0-input-specialists-HarnessSpecialist')
    })

    describe('edges whose saved handle the node no longer has', () => {
        const nodeSpecs = [
            { name: 'chatOpenAI', type: 'ChatOpenAI', baseClasses: ['ChatOpenAI', 'BaseChatModel'], inputs: [] },
            { name: 'bufferMemory', type: 'BufferMemory', baseClasses: ['BufferMemory', 'BaseMemory'], inputs: [] },
            {
                name: 'conversationChain',
                type: 'ConversationChain',
                baseClasses: ['ConversationChain'],
                inputs: [
                    { name: 'model', type: 'BaseChatModel' },
                    { name: 'memory', type: 'BaseMemory' }
                ]
            }
        ]
        const nodes = () => [
            { id: 'chatOpenAI_0', data: { id: 'chatOpenAI_0', name: 'chatOpenAI', type: 'ChatOpenAI' } },
            { id: 'bufferMemory_0', data: { id: 'bufferMemory_0', name: 'bufferMemory', type: 'BufferMemory' } },
            { id: 'conversationChain_0', data: { id: 'conversationChain_0', name: 'conversationChain', type: 'ConversationChain' } }
        ]
        const liveOutput = 'chatOpenAI_0-output-chatOpenAI-ChatOpenAI|BaseChatModel'
        const edge = (id, source, target, sourceHandle, targetHandle) => ({ id, source, target, sourceHandle, targetHandle })
        const repaired = (edges) => normalizeCanvasFlow({ nodes: nodes(), edges }, nodeSpecs).edges[0]

        it.each(['e-model', 'e-5'])('keeps a removed source output as written (edge id %s)', (id) => {
            const result = repaired([
                edge(
                    id,
                    'chatOpenAI_0',
                    'conversationChain_0',
                    'chatOpenAI_0-output-legacyLLM-ChatOpenAI',
                    'conversationChain_0-input-model-BaseChatModel'
                )
            ])
            expect(result.sourceHandle).toBe('chatOpenAI_0-output-legacyLLM-ChatOpenAI')
        })

        it('keeps an unknown input as written when the edge id ends in a real input name', () => {
            const result = repaired([
                edge(
                    'e-memory',
                    'bufferMemory_0',
                    'conversationChain_0',
                    'bufferMemory_0-output-bufferMemory-BufferMemory|BaseMemory',
                    'conversationChain_0-input-history-BaseMemory'
                )
            ])
            expect(result.targetHandle).toBe('conversationChain_0-input-history-BaseMemory')
        })

        it('still points a handle at the live one when only the trailing type changed', () => {
            const result = repaired([
                edge(
                    'e-model',
                    'chatOpenAI_0',
                    'conversationChain_0',
                    'chatOpenAI_0-output-chatOpenAI-ChatOpenAI|BaseLanguageModel',
                    'conversationChain_0-input-model-BaseLanguageModel'
                )
            ])
            expect(result.sourceHandle).toBe(liveOutput)
            expect(result.targetHandle).toBe('conversationChain_0-input-model-BaseChatModel')
        })

        it('still fills a missing source handle and a handle saved without its type', () => {
            const result = repaired([edge('e-model', 'chatOpenAI_0', 'conversationChain_0', undefined, 'conversationChain_0-input-model')])
            expect(result.sourceHandle).toBe(liveOutput)
            expect(result.targetHandle).toBe('conversationChain_0-input-model-BaseChatModel')
        })

        it('leaves an exact live handle alone', () => {
            const result = repaired([
                edge('e-model', 'chatOpenAI_0', 'conversationChain_0', liveOutput, 'conversationChain_0-input-model-BaseChatModel')
            ])
            expect(result.sourceHandle).toBe(liveOutput)
            expect(result.targetHandle).toBe('conversationChain_0-input-model-BaseChatModel')
        })
    })

    it('leaves a node that already has arrays alone', () => {
        const data = { inputParams: [{ name: 'keep' }], inputAnchors: [], outputAnchors: [], inputs: { a: 1 } }
        expect(normalizeNodeData(data, postgresSpec)).toBe(data)
        expect(data.inputParams).toEqual([{ name: 'keep' }])
    })

    it('copies a conversation chain system message into the current prompt field', () => {
        const data = normalizeNodeData({
            id: 'conversationChain_0',
            name: 'conversationChain',
            inputParams: [],
            inputAnchors: [],
            outputAnchors: [],
            inputs: { systemMessage: 'Be brief.' }
        })
        expect(data.inputs.systemMessagePrompt).toBe('Be brief.')
        expect(data.inputs.systemMessage).toBe('Be brief.')
    })

    it('does not overwrite a conversation prompt that is already set', () => {
        const data = normalizeNodeData({
            name: 'conversationChain',
            inputParams: [],
            inputAnchors: [],
            outputAnchors: [],
            inputs: { systemMessage: 'Old', systemMessagePrompt: 'New' }
        })
        expect(data.inputs.systemMessagePrompt).toBe('New')
    })
})
