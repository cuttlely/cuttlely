import { ensureAgentToolRowIds } from './agentToolRowId'

describe('ensureAgentToolRowIds', () => {
    it('keeps numeric id 0 as a real id', () => {
        const tools = [{ id: 0, agentSelectedTool: 'harness', agentSelectedToolConfig: { label: 'Team', harnessName: 'team' } }]
        const result = ensureAgentToolRowIds(tools)
        expect(result).toEqual({ ids: ['0'], changed: false })
        expect(tools[0].id).toBe(0)

        const fromConfig = [{ agentSelectedTool: 'harness', agentSelectedToolConfig: { id: 0 } }]
        expect(ensureAgentToolRowIds(fromConfig)).toEqual({ ids: ['0'], changed: false })
        expect(fromConfig[0]).not.toHaveProperty('id')
    })
})
