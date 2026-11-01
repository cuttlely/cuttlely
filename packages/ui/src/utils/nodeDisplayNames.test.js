import { displayLabel, docsLink, linkNote, nodeSearchTerms, regroupForPalette, wiredPostgres } from './nodeDisplayNames'
import { searchNodes } from './nodeSearch'

// Made-up palette entries shaped like the node list the server sends.
const postgres = () => ({ name: 'postgreSQLMCP', label: 'PostgreSQL MCP', category: 'Tools (MCP)', type: 'PostgreSQL MCP Tool' })
const palette = () => [
    postgres(),
    { name: 'githubMCP', label: 'Github MCP', category: 'Tools (MCP)' },
    { name: 'harnessSpecialist', label: 'Harness Specialist', category: 'Harness' },
    { name: 'chatOpenAI', label: 'ChatOpenAI', category: 'Chat Models' }
]

describe('display labels', () => {
    it('draws the stock saved label as Postgres (MCP) and keeps a custom saved label', () => {
        expect(displayLabel({ name: 'postgreSQLMCP', label: 'PostgreSQL MCP' })).toBe('Postgres (MCP)')
        expect(displayLabel({ name: 'postgreSQLMCP', label: 'Sales replica' })).toBe('Sales replica')
        expect(displayLabel({ name: 'chatOpenAI', label: 'ChatOpenAI' })).toBe('ChatOpenAI')
    })

    it('opens the analyst guide without changing the saved documentation link', () => {
        const data = { name: 'postgreSQLMCP', documentation: 'https://example.invalid/old' }
        expect(docsLink(data)).toMatch(/docs\/how-to\/analyst\.md$/)
        expect(data.documentation).toBe('https://example.invalid/old')
        expect(docsLink({ name: 'chatOpenAI', documentation: 'https://example.invalid/x' })).toBe('https://example.invalid/x')
    })
})

describe('Add Nodes search', () => {
    it.each(['postgres', 'mcp', 'database', 'PostgreSQL MCP', 'sql'])('typing %s finds the Postgres tool', (query) => {
        const found = searchNodes(palette(), query)
        expect(found.map((node) => node.name)).toContain('postgreSQLMCP')
    })

    it('puts the Postgres tool first for postgres and keeps the node object as sent', () => {
        const nodes = palette()
        const before = JSON.stringify(nodes)
        const found = searchNodes(nodes, 'postgres')
        expect(found[0]).toBe(nodes[0])
        expect(JSON.stringify(nodes)).toBe(before)
        expect(found[0].category).toBe('Tools (MCP)')
    })

    it('still finds other MCP tools for mcp', () => {
        expect(searchNodes(palette(), 'mcp').map((node) => node.name)).toEqual(expect.arrayContaining(['githubMCP', 'postgreSQLMCP']))
    })

    it('search terms include the saved label and the shown label', () => {
        expect(nodeSearchTerms(postgres())).toEqual(expect.arrayContaining(['PostgreSQL MCP', 'Postgres (MCP)', 'postgres', 'mcp']))
    })
})

describe('Add Nodes groups', () => {
    it('lists the Postgres tool under Database without changing its category', () => {
        const nodes = palette()
        const grouped = { 'Tools (MCP)': [nodes[0], nodes[1]], Harness: [nodes[2]] }
        const { nodes: shown, expanded } = regroupForPalette(grouped, { 'Tools (MCP)': true })
        expect(shown.Database).toEqual([nodes[0]])
        expect(shown['Tools (MCP)']).toEqual([nodes[1]])
        expect(shown.Harness).toEqual([nodes[2]])
        expect(expanded.Database).toBe(true)
        expect(nodes[0].category).toBe('Tools (MCP)')
    })
})

describe('link notes from edges', () => {
    const nodes = [
        { id: 'pg_1', data: { name: 'postgreSQLMCP', label: 'PostgreSQL MCP' } },
        { id: 'pg_2', data: { name: 'postgreSQLMCP', label: 'PostgreSQL MCP' } },
        { id: 'spec_1', data: { name: 'harnessSpecialist', label: 'Harness Specialist', inputs: { specialistName: 'analyst' } } },
        { id: 'agent_1', data: { name: 'toolAgent', label: 'Tool Agent' } }
    ]

    it('says Used by only when the tool is wired to a specialist', () => {
        const edges = [
            { source: 'pg_1', target: 'spec_1' },
            { source: 'pg_2', target: 'agent_1' }
        ]
        expect(linkNote('pg_1', nodes, edges)).toBe('Used by: Analyst')
        expect(linkNote('pg_2', nodes, edges)).toBe('')
        expect(linkNote('spec_1', nodes, edges)).toBe('Data: Postgres (MCP)')
        expect(linkNote('agent_1', nodes, edges)).toBe('')
        expect(linkNote('pg_1', nodes, [])).toBe('')
    })

    it('reads without writing to the nodes or edges', () => {
        const edges = [{ source: 'pg_1', target: 'spec_1' }]
        const before = JSON.stringify({ nodes, edges })
        linkNote('pg_1', nodes, edges)
        linkNote('spec_1', nodes, edges)
        expect(wiredPostgres('spec_1', nodes, edges).map((node) => node.id)).toEqual(['pg_1'])
        expect(JSON.stringify({ nodes, edges })).toBe(before)
    })
})
