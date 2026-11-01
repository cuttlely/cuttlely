import { NEW_POSTGRES_ACTIONS, withNewNodeDefaults } from './newNodeDefaults'
import { normalizeCanvasFlow } from './normalizeCanvasFlow'

describe('new card defaults', () => {
    it('a new Postgres (MCP) card starts with the query tool, saved as the picker saves it', () => {
        const next = withNewNodeDefaults({ name: 'postgreSQLMCP', inputs: { mcpActions: '' } })
        expect(next.inputs.mcpActions).toBe(NEW_POSTGRES_ACTIONS)
        expect(JSON.parse(next.inputs.mcpActions)).toEqual(['query'])
    })

    it('keeps a choice the card already has and leaves other cards alone', () => {
        const picked = { name: 'postgreSQLMCP', inputs: { mcpActions: '["list_tables"]' } }
        expect(withNewNodeDefaults(picked)).toBe(picked)
        const other = { name: 'githubMCP', inputs: { mcpActions: '' } }
        expect(withNewNodeDefaults(other)).toBe(other)
    })

    it('a saved card keeps its tools when a flow loads, including none', () => {
        const flow = {
            nodes: [
                { id: 'pg_a', data: { id: 'pg_a', name: 'postgreSQLMCP', inputs: { mcpActions: ['ops_status'] } } },
                { id: 'pg_b', data: { id: 'pg_b', name: 'postgreSQLMCP', inputs: {} } }
            ],
            edges: []
        }
        const loaded = normalizeCanvasFlow(JSON.parse(JSON.stringify(flow)), [])
        expect(loaded.nodes[0].data.inputs.mcpActions).toEqual(['ops_status'])
        expect(loaded.nodes[1].data.inputs.mcpActions).toBeUndefined()
    })
})
