jest.mock('reactflow', () => ({
    Handle: ({ id, type }) => require('react').createElement('span', { 'data-testid': `handle-${type}`, 'data-handle-id': id }),
    Position: { Left: 'left', Right: 'right' },
    useUpdateNodeInternals: () => () => {}
}))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import MissingNodeCard from './MissingNodeCard'

describe('placeholder card for a missing node', () => {
    test('names the pack', () => {
        const html = renderToStaticMarkup(
            createElement(
                ThemeProvider,
                { theme: createTheme() },
                createElement(MissingNodeCard, {
                    data: {
                        id: 'pack',
                        label: 'Sample Pack Node',
                        name: 'samplePackNode',
                        nodePack: 'sample-pack',
                        inputAnchors: [{ id: 'pack-in' }],
                        outputAnchors: [{ id: 'pack-out' }]
                    },
                    edges: [
                        { source: 'other', target: 'pack', sourceHandle: 'other-out', targetHandle: 'pack-in' },
                        { source: 'pack', target: 'down', sourceHandle: 'pack-out', targetHandle: 'down-in' }
                    ],
                    message: 'Sample Pack Node is not installed. Install the sample-pack pack.'
                })
            )
        )
        expect(html).toContain('data-testid="missing-node-card"')
        expect(html).toContain('Sample Pack Node')
        expect(html).toContain('Install the sample-pack pack.')
        expect(html).toContain('data-handle-id="pack-in"')
        expect(html).toContain('data-handle-id="pack-out"')
        expect(html).toContain('data-testid="handle-target"')
        expect(html).toContain('data-testid="handle-source"')
    })
})
