/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import Wizard from './FlowiseMigrationWizard'

const LINE = "Re-create tool 'tool-made-up-1' in Tools, then pick it on Lookup."

const graph = {
    name: 'Lookup',
    type: 'CHATFLOW',
    nodes: [
        {
            id: 'customTool_0',
            type: 'customNode',
            position: { x: 0, y: 0 },
            data: {
                id: 'customTool_0',
                label: 'Lookup',
                name: 'customTool',
                category: 'Tools',
                inputParams: [{ label: 'Select Tool', name: 'selectedTool', type: 'asyncOptions' }],
                inputAnchors: [],
                outputAnchors: [],
                inputs: { selectedTool: 'tool-made-up-1' }
            }
        }
    ],
    edges: []
}

const click = (label) => {
    const button = [...document.body.querySelectorAll('button')].find((item) => item.textContent.trim() === label)
    if (!button) throw new Error(`missing ${label}`)
    button.click()
}

describe('import wizard attention list', () => {
    let root

    beforeEach(() => {
        window.matchMedia =
            window.matchMedia ||
            (() => ({
                matches: false,
                addListener() {},
                removeListener() {},
                addEventListener() {},
                removeEventListener() {},
                dispatchEvent() {
                    return false
                }
            }))
        document.body.innerHTML = ''
    })

    afterEach(() => {
        if (root) {
            act(() => root.unmount())
            root = null
        }
        document.body.innerHTML = ''
    })

    it('shows a tool id on the scan step and the result step', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(ThemeProvider, { theme: createTheme() }, createElement(Wizard, { open: true, onClose() {}, onOpen() {} }))
            )
        })

        const input = document.body.querySelector('input[type="file"]')
        const file = new File([JSON.stringify(graph)], 'lookup.json', { type: 'application/json' })
        await act(async () => {
            Object.defineProperty(input, 'files', { configurable: true, value: [file] })
            input.dispatchEvent(new Event('change', { bubbles: true }))
            await new Promise((resolve) => setTimeout(resolve, 30))
        })

        expect(document.body.textContent).toContain(LINE)

        await act(async () => {
            click('Next')
            click('Next')
            click('Next')
        })
        expect(document.body.textContent).toContain('The canvas will open')
        expect(document.body.textContent).toContain(LINE)
    })
})
