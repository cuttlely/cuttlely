import path from 'path'
import { getUserHome } from './utils'

const AGENT_MEMORY_PLACEHOLDER = String.raw`C:\Users\User\.cuttlely\database.sqlite`

describe('Regression: Windows-style placeholder paths from imported flows', () => {
    const itOnNonWindows = process.platform === 'win32' ? it.skip : it

    itOnNonWindows('AgentMemory remaps the Flowise placeholder to ~/.cuttlely/database.sqlite', async () => {
        const agentMemoryModule = require('../nodes/memory/AgentMemory/AgentMemory.ts')
        const AgentMemoryClass = agentMemoryModule.nodeClass
        const node = new AgentMemoryClass()

        const nodeData = {
            inputs: {
                databaseType: 'sqlite',
                databaseFilePath: AGENT_MEMORY_PLACEHOLDER
            }
        }

        const options = {
            chatflowid: 'flow-1',
            appDataSource: {},
            databaseEntities: {},
            orgId: 'org-1'
        }

        const saver = await node.init(nodeData, '', options)
        expect(saver.config.datasourceOptions.database).toBe(path.join(getUserHome(), '.cuttlely', 'database.sqlite'))
    })
})
