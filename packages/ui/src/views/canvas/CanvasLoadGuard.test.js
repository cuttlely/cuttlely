/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import CanvasLoadGuard from './CanvasLoadGuard'

const theme = createTheme()

const renderGuard = async (loadState, flowId = 'flow-1') => {
    const onRetry = jest.fn()
    const onBack = jest.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            createElement(
                ThemeProvider,
                { theme },
                createElement(CanvasLoadGuard, { flowId, loadState, onRetry, onBack }, createElement('button', null, 'Save'))
            )
        )
    })
    return { root, onRetry, onBack }
}

const click = async (label) => {
    const button = [...document.body.querySelectorAll('button')].find((item) => item.textContent === label)
    expect(button).toBeTruthy()
    await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('CanvasLoadGuard', () => {
    afterEach(() => {
        document.body.innerHTML = ''
    })

    test('a failed status load removes canvas actions and offers retry or back', async () => {
        const view = await renderGuard({ flowId: 'flow-1', loading: false, error: new Error('offline') })

        expect(document.body.textContent).toContain('The saved canvas could not be opened')
        expect(document.body.textContent).not.toContain('Save')
        await click('Retry')
        await click('Back')
        expect(view.onRetry).toHaveBeenCalledTimes(1)
        expect(view.onBack).toHaveBeenCalledTimes(1)
        act(() => view.root.unmount())
    })

    test('a retry keeps canvas actions removed while status is unknown', async () => {
        const view = await renderGuard({ flowId: 'flow-1', loading: true, error: null })

        expect(document.querySelector('[aria-label="Opening saved canvas"]')).toBeTruthy()
        expect(document.body.textContent).not.toContain('Save')
        expect(document.body.textContent).not.toContain('Retry')
        await click('Back')
        expect(view.onBack).toHaveBeenCalledTimes(1)
        act(() => view.root.unmount())
    })

    test('a status failure from another flow does not block this flow', async () => {
        const view = await renderGuard({ flowId: 'flow-1', loading: false, error: new Error('offline') }, 'flow-2')

        expect(document.body.textContent).toContain('Save')
        expect(document.body.textContent).not.toContain('The saved canvas could not be opened')
        act(() => view.root.unmount())
    })

    test('a successful status load opens this flow again', async () => {
        const view = await renderGuard({ flowId: 'flow-1', loading: false, error: null })

        expect(document.body.textContent).toContain('Save')
        expect(document.body.textContent).not.toContain('Opening the saved canvas')
        act(() => view.root.unmount())
    })
})
