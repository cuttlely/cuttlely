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

    it('leaves a node that already has arrays alone', () => {
        const data = { inputParams: [{ name: 'keep' }], inputAnchors: [], outputAnchors: [], inputs: { a: 1 } }
        expect(normalizeNodeData(data, postgresSpec)).toBe(data)
        expect(data.inputParams).toEqual([{ name: 'keep' }])
    })
})
