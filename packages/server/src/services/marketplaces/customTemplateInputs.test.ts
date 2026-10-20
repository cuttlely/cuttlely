const saved: any[] = []
const mockRepo = {
    create: jest.fn((entity: any) => ({ ...entity })),
    save: jest.fn(async (entity: any) => {
        saved.push(entity)
        return entity
    })
}

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({ AppDataSource: { getRepository: () => mockRepo } })
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

describe('saveCustomTemplate input filtering', () => {
    it('keeps only defined, non-secret inputs in the saved template', async () => {
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
                }
            ],
            edges: []
        }
        ;(chatflowsService.getChatflowById as jest.Mock).mockResolvedValue({ type: 'CHATFLOW', flowData: JSON.stringify(flowData) })

        await marketplacesService.saveCustomTemplate({ chatflowId: 'flow-1', workspaceId: 'ws-1', name: 'T' })

        const stored = saved[saved.length - 1].flowData as string
        expect(stored).not.toContain('FAKE')
        const node = JSON.parse(stored).nodes[0]
        expect(node.data.inputs).toEqual({ modelName: 'gpt-4.1-mini', cache: '{{cache_0.data.instance}}' })
        expect(node.data.credential).toBeUndefined()
    })
})
