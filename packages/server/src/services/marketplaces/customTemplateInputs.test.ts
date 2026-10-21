const saved: any[] = []
const mockComponentNodes: Record<string, unknown> = {}
const mockRepo = {
    create: jest.fn((entity: any) => ({ ...entity })),
    save: jest.fn(async (entity: any) => {
        saved.push(entity)
        return entity
    })
}

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: { getRepository: () => mockRepo },
        nodesPool: { componentNodes: mockComponentNodes }
    })
}))
jest.mock('../../database/entities/CustomTemplate', () => ({ CustomTemplate: class CustomTemplate {} }))
jest.mock('../../identity/workspaceScope', () => ({ getWorkspaceSearchOptions: jest.fn(), WorkspaceService: class {} }))
jest.mock('./sampleTemplates', () => ({ marketplaceFlowTemplates: [], normalizeTemplateFlow: (f: unknown) => f }))
jest.mock('../chatflows', () => ({
    __esModule: true,
    default: { getChatflowById: jest.fn() }
}))

import chatflowsService from '../chatflows'
import marketplacesService from '.'

// Seven credential shapes a saved node can carry. All values are fake.
const variantParams = [
    { name: 'config', type: 'json' },
    { name: 'list', type: 'array' },
    { name: 'prompt', type: 'string' },
    { name: 'note', type: 'string' },
    { name: 'googleKey', type: 'string' },
    { name: 'credentialId', type: 'string' },
    { name: 'headers', type: 'array' },
    { name: 'temperature', type: 'number' }
]
const variantInputs = {
    config: { a: { b: 'sk-FAKE-NESTED-1' }, keep: 'ok' },
    list: ['fine', 'sk-FAKE-ARRAY-1'],
    prompt: 'Use the key sk-FAKE-SENTENCE-1 when asked',
    note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.FAKEsig',
    googleKey: 'AIzaFAKEFAKEFAKEFAKE123',
    credentialId: 'cred-FAKE-ID-1',
    headers: [
        { key: 'X-Custom-Auth', value: 'FAKE-HDR-1' },
        { key: 'Accept', value: 'application/json' }
    ],
    temperature: 0.2
}
const variantSamples = ['FAKE-NESTED', 'FAKE-ARRAY', 'FAKE-SENTENCE', 'FAKEsig', 'AIzaFAKE', 'cred-FAKE-ID', 'FAKE-HDR']
const variantKept = {
    temperature: 0.2
}

describe('saveCustomTemplate input filtering', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockComponentNodes)) delete mockComponentNodes[key]
    })

    it('keeps only defined, non-secret inputs in the saved template', async () => {
        mockComponentNodes.chatOpenAI = {
            name: 'chatOpenAI',
            label: 'chatOpenAI',
            inputs: [
                { name: 'modelName', type: 'string' },
                { name: 'secretField', type: 'password' },
                { name: 'note', type: 'string' },
                { name: 'cache', type: 'BaseCache' }
            ]
        }
        mockComponentNodes.cache = { name: 'cache', label: 'Cache', inputs: [] }
        const flowData = {
            nodes: [
                {
                    id: 'chatOpenAI_0',
                    data: {
                        id: 'chatOpenAI_0',
                        name: 'chatOpenAI',
                        credential: 'cred-FAKE-0001',
                        inputParams: [
                            { name: 'modelName', type: 'string' },
                            { name: 'secretField', type: 'password' },
                            { name: 'note', type: 'string' }
                        ],
                        inputAnchors: [{ name: 'cache', type: 'BaseCache' }],
                        inputs: {
                            modelName: 'gpt-4.1-mini',
                            secretField: 'sk-FAKE-PW-1',
                            note: 'sk-FAKE-NOTE-1',
                            cache: '{{cache_0.data.instance}}',
                            openAIApiKey: 'sk-FAKE-ORPHAN-1'
                        }
                    }
                },
                { id: 'cache_0', data: { id: 'cache_0', name: 'cache', inputs: {} } }
            ],
            edges: []
        }
        ;(chatflowsService.getChatflowById as jest.Mock).mockResolvedValue({ type: 'CHATFLOW', flowData: JSON.stringify(flowData) })

        await marketplacesService.saveCustomTemplate({ chatflowId: 'flow-1', workspaceId: 'ws-1', name: 'T' })

        const stored = saved[saved.length - 1].flowData as string
        expect(stored).not.toContain('FAKE')
        const parsed = JSON.parse(stored)
        const node = parsed.nodes[0]
        expect(node.data.inputs).toEqual({ cache: '{{cache_0.data.instance}}' })
        expect(node.data.credential).toBeUndefined()
        expect(parsed.droppedSettings).toEqual([
            {
                nodeId: 'chatOpenAI_0',
                label: 'chatOpenAI',
                inputs: ['modelName', 'secretField', 'note', 'openAIApiKey', 'credential']
            }
        ])
    })

    it('removes each of the seven credential shapes from a saved template', async () => {
        mockComponentNodes.customNode = {
            name: 'customNode',
            label: 'customNode',
            inputParams: variantParams
        }
        const flowData = {
            nodes: [
                { id: 'customNode_0', data: { id: 'customNode_0', name: 'customNode', inputParams: variantParams, inputs: variantInputs } }
            ],
            edges: []
        }
        ;(chatflowsService.getChatflowById as jest.Mock).mockResolvedValue({ type: 'CHATFLOW', flowData: JSON.stringify(flowData) })

        await marketplacesService.saveCustomTemplate({ chatflowId: 'flow-1', workspaceId: 'ws-1', name: 'T' })

        const stored = saved[saved.length - 1].flowData as string
        for (const sample of variantSamples) expect(stored).not.toContain(sample)
        const parsed = JSON.parse(stored)
        expect(parsed.nodes[0].data.inputs).toEqual(variantKept)
        expect(parsed.droppedSettings).toEqual([
            {
                nodeId: 'customNode_0',
                label: 'customNode',
                inputs: ['config', 'list', 'prompt', 'note', 'googleKey', 'credentialId', 'headers']
            }
        ])
    })
})
