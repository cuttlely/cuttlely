import { describe, it, expect } from '@jest/globals'

describe('Regression: Windows-style placeholder paths from imported flows', () => {
    it('AgentMemory accepts a Windows-style databaseFilePath on non-Windows platforms', async () => {
        if (process.platform === 'win32') {
            // The validator still rejects Windows absolute paths on Windows.
            return
        }
        // Load the Agent Memory node (CommonJS export: { nodeClass })
        const agentMemoryModule = require('../nodes/memory/AgentMemory/AgentMemory.ts')
        const AgentMemoryClass = agentMemoryModule.nodeClass
        const node = new AgentMemoryClass()

        const nodeData = {
            inputs: {
                databaseType: 'sqlite',
                // A Windows-looking placeholder value as seen in imported canvases
                databaseFilePath: 'C:\\\\Users\\\\User\\\\.cuttlely\\\\database.sqlite'
            }
        }

        const options = {
            chatflowid: 'flow-1',
            appDataSource: {} as any,
            databaseEntities: {} as any,
            orgId: 'org-1'
        }

        const saver = await node.init(nodeData, '', options)
        expect(saver).toBeDefined()
    })
})
