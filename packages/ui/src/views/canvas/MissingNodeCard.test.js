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
                    data: { label: 'Sample Pack Node', name: 'samplePackNode', nodePack: 'sample-pack' },
                    message: 'Sample Pack Node is not installed. Install the sample-pack pack.'
                })
            )
        )
        expect(html).toContain('data-testid="missing-node-card"')
        expect(html).toContain('Sample Pack Node')
        expect(html).toContain('Install the sample-pack pack.')
    })
})
