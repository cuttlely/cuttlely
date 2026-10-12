jest.mock('@/store/constant', () => ({ baseURL: 'http://localhost' }))
jest.mock('./NodeInputHandler', () => () => null)
jest.mock('./NodeOutputHandler', () => () => null)
jest.mock('./CompactCardBody', () => () => null)
jest.mock('@/ui-component/dialog/AdditionalParamsDialog', () => () => null)
jest.mock('@/ui-component/dialog/NodeInfoDialog', () => () => null)
jest.mock(
    '@/ui-component/tooltip/NodeTooltip',
    () =>
        ({ children }) =>
            children
)
jest.mock(
    '@/ui-component/cards/NodeCardWrapper',
    () =>
        ({ children }) =>
            children
)

jest.mock('react-redux', () => ({
    useSelector: (selector) =>
        selector({
            canvas: {
                componentNodes: [{ name: 'chatOpenAI', version: 1 }],
                canvasDialogShow: false
            },
            customization: { isDarkMode: false }
        })
}))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import CanvasNode from './CanvasNode'

const theme = createTheme({
    palette: { card: { main: '#fff' }, asyncSelect: { main: '#eee' } },
    customization: { isDarkMode: false }
})

describe('canvas node that is not installed', () => {
    test('opens as a placeholder that names the pack', () => {
        const html = renderToStaticMarkup(
            createElement(
                ThemeProvider,
                { theme },
                createElement(CanvasNode, {
                    data: {
                        id: 'n1',
                        label: 'Sample Pack Node',
                        name: 'samplePackNode',
                        version: 1,
                        nodePack: 'sample-pack',
                        inputParams: [],
                        inputAnchors: [],
                        outputAnchors: [],
                        inputs: { samplePackApi_CREDENTIAL_ID: 'cred-1' }
                    }
                })
            )
        )
        expect(html).toContain('data-testid="missing-node-card"')
        expect(html).toContain('Install the sample-pack pack.')
        expect(html).not.toContain('cred-1')
    })
})
