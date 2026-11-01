const mockEdges = { current: [] }
jest.mock('reactflow', () => ({ useEdges: () => mockEdges.current }))
jest.mock('@/store/constant', () => ({ baseURL: 'http://localhost' }))
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }))

import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import axios from 'axios'

import NodeLinkNotes from './NodeLinkNotes'
import { flowContext } from '@/store/context/ReactFlowContext'
import { resetAnalystModeCache } from '@/utils/analystStatus'

// A made-up harness: one Postgres tool wired into an analyst specialist, one wired into a plain agent.
const flowNodes = () => [
    { id: 'pg_1', data: { id: 'pg_1', name: 'postgreSQLMCP', label: 'PostgreSQL MCP', inputs: {} } },
    { id: 'pg_2', data: { id: 'pg_2', name: 'postgreSQLMCP', label: 'PostgreSQL MCP', inputs: {} } },
    { id: 'spec_1', data: { id: 'spec_1', name: 'harnessSpecialist', label: 'Harness Specialist', inputs: { specialistName: 'analyst' } } },
    { id: 'agent_1', data: { id: 'agent_1', name: 'toolAgent', label: 'Tool Agent', inputs: {} } }
]

async function render(nodeId, nodes) {
    const instance = { getNodes: () => nodes }
    const data = nodes.find((node) => node.id === nodeId).data
    let tree
    await act(async () => {
        tree = TestRenderer.create(
            createElement(flowContext.Provider, { value: { reactFlowInstance: instance } }, createElement(NodeLinkNotes, { data }))
        )
    })
    await act(async () => {})
    return tree
}

const text = (tree, id) => tree.root.findAll((node) => node.props['data-testid'] === id && typeof node.type === 'string')

describe.each([
    ['analyst storage off', 'unavailable'],
    ['analyst storage on', 'sandbox']
])('link notes with %s', (_, mode) => {
    beforeEach(() => {
        resetAnalystModeCache()
        axios.post.mockReset()
        axios.post.mockResolvedValue({ data: [{ label: 'x', name: mode }] })
        mockEdges.current = [
            { source: 'pg_1', target: 'spec_1' },
            { source: 'pg_2', target: 'agent_1' }
        ]
    })

    it('the Postgres tool says who uses it and never shows the turned-off note', async () => {
        const nodes = flowNodes()
        const before = JSON.stringify(nodes)
        const tree = await render('pg_1', nodes)
        expect(text(tree, 'link-note').map((node) => node.children.join(''))).toEqual(['Used by: Analyst'])
        expect(text(tree, 'analyst-off-note')).toHaveLength(0)
        expect(JSON.stringify(nodes)).toBe(before)
    })

    it('a Postgres tool wired only to a plain agent shows nothing', async () => {
        const tree = await render('pg_2', flowNodes())
        expect(tree.toJSON()).toBeNull()
    })

    it('the specialist names its data and shows the note only when the server has no storage', async () => {
        const nodes = flowNodes()
        const before = JSON.stringify(nodes)
        const tree = await render('spec_1', nodes)
        expect(text(tree, 'link-note').map((node) => node.children.join(''))).toEqual(['Data: Postgres (MCP)'])
        expect(text(tree, 'analyst-off-note')).toHaveLength(mode === 'unavailable' ? 1 : 0)
        expect(JSON.stringify(nodes)).toBe(before)
    })
})

describe('link notes when the server cannot be read', () => {
    it('shows no turned-off note on a guess', async () => {
        resetAnalystModeCache()
        axios.post.mockReset()
        axios.post.mockRejectedValue(new Error('offline'))
        mockEdges.current = [{ source: 'pg_1', target: 'spec_1' }]
        const tree = await render('spec_1', flowNodes())
        expect(text(tree, 'analyst-off-note')).toHaveLength(0)
        expect(text(tree, 'link-note')).toHaveLength(1)
    })

    it('a specialist whose tool has its own credential never asks the server', async () => {
        resetAnalystModeCache()
        axios.post.mockReset()
        const nodes = flowNodes()
        nodes[0].data.credential = 'zz-fake-cred'
        mockEdges.current = [{ source: 'pg_1', target: 'spec_1' }]
        const tree = await render('spec_1', nodes)
        expect(text(tree, 'analyst-off-note')).toHaveLength(0)
        expect(axios.post).not.toHaveBeenCalled()
    })
})
