/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import Wizard from './FlowiseMigrationWizard'

const LINE = "Custom tool tool-made-up-1 on 'Lookup'. Recreate it in Tools, then pick it in this node."

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

    it('waits for the node catalog before accepting a file', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(Wizard, { open: true, catalogPending: true, onClose() {}, onOpen() {} })
                )
            )
        })

        expect(document.body.textContent).toContain('The node catalog is loading')
        expect(document.body.querySelector('input[type="file"]').disabled).toBe(true)
        expect([...document.body.querySelectorAll('button')].some((item) => item.textContent.trim() === 'Next')).toBe(false)
    })

    it('keeps file selection off and offers a retry when the node catalog fails', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        const retry = jest.fn()
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(Wizard, { open: true, catalogFailed: true, onRetryCatalog: retry, onClose() {}, onOpen() {} })
                )
            )
        })

        expect(document.body.textContent).toContain('The node catalog did not load')
        expect(document.body.querySelector('input[type="file"]').disabled).toBe(true)
        const button = [...document.body.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Retry')
        await act(async () => {
            button.click()
        })
        expect(retry).toHaveBeenCalledTimes(1)
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

    it('stops a tool file at the upload step', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(ThemeProvider, { theme: createTheme() }, createElement(Wizard, { open: true, onClose() {}, onOpen() {} }))
            )
        })
        const tool = { name: 'made_up_tool', description: 'Made up', schema: '[]', func: 'return "ok"' }
        const input = document.body.querySelector('input[type="file"]')
        const file = new File([JSON.stringify(tool)], 'tool.json', { type: 'application/json' })
        await act(async () => {
            Object.defineProperty(input, 'files', { configurable: true, value: [file] })
            input.dispatchEvent(new Event('change', { bubbles: true }))
            await new Promise((resolve) => setTimeout(resolve, 30))
        })
        expect(document.body.textContent).toContain('This is a Flowise tool, not a flow. Open Tools > Load to import it.')
        expect(document.body.querySelector('input[type="file"]')).not.toBeNull()
        expect([...document.body.querySelectorAll('button')].some((item) => item.textContent.trim() === 'Next')).toBe(false)
    })
})
