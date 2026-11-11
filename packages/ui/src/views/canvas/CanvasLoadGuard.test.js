/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import CanvasLoadGuard, { canvasLoadBlocked } from './CanvasLoadGuard'

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
                createElement(CanvasLoadGuard, { flowId, loadState, onRetry, onBack }, createElement('button', { id: 'save' }, 'Save'))
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

const canvasInert = () => Boolean(document.getElementById('save').closest('[aria-hidden="true"]')?.inert)

describe('CanvasLoadGuard', () => {
    afterEach(() => {
        document.body.innerHTML = ''
    })

    test('a failed status load removes canvas actions and offers retry or back', async () => {
        const view = await renderGuard({ flowId: 'flow-1', loading: false, error: new Error('offline') })

        expect(document.body.textContent).toContain('The saved canvas could not be opened')
        expect(document.getElementById('save')).toBeTruthy()
        expect(canvasInert()).toBe(true)
        await click('Retry')
        await click('Back')
        expect(view.onRetry).toHaveBeenCalledTimes(1)
        expect(view.onBack).toHaveBeenCalledTimes(1)
        act(() => view.root.unmount())
    })

    test('a retry keeps canvas actions removed while status is unknown', async () => {
        const view = await renderGuard({ flowId: 'flow-1', loading: true, retrying: true, error: null })

        expect(document.querySelector('[aria-label="Opening saved canvas"]')).toBeTruthy()
        expect(canvasInert()).toBe(true)
        expect(document.body.textContent).not.toContain('Retry')
        await click('Back')
        expect(view.onBack).toHaveBeenCalledTimes(1)
        act(() => view.root.unmount())
    })

    test('a status failure from another flow does not block this flow', async () => {
        const view = await renderGuard({ flowId: 'flow-1', loading: false, error: new Error('offline') }, 'flow-2')

        expect(canvasInert()).toBe(false)
        expect(document.body.textContent).not.toContain('The saved canvas could not be opened')
        act(() => view.root.unmount())
    })

    test('a successful status load opens this flow again', async () => {
        const view = await renderGuard({ flowId: 'flow-1', loading: false, error: null })

        expect(canvasInert()).toBe(false)
        expect(document.body.textContent).not.toContain('Opening the saved canvas')
        act(() => view.root.unmount())
    })

    test('the first status load leaves the canvas open and mounted, so it can measure and fit its cards', async () => {
        const view = await renderGuard({ flowId: 'flow-1', loading: true, error: null })

        expect(canvasInert()).toBe(false)
        expect(document.body.textContent).not.toContain('Opening the saved canvas')
        act(() => view.root.unmount())
    })

    test('canvasLoadBlocked blocks only this flow, on a failure or a retry', () => {
        expect(canvasLoadBlocked('a', { flowId: 'a', error: new Error('x') })).toBe(true)
        expect(canvasLoadBlocked('a', { flowId: 'a', loading: true, retrying: true })).toBe(true)
        expect(canvasLoadBlocked('a', { flowId: 'a', loading: true })).toBe(false)
        expect(canvasLoadBlocked('b', { flowId: 'a', error: new Error('x') })).toBe(false)
        expect(canvasLoadBlocked(undefined, { flowId: undefined, error: new Error('x') })).toBe(false)
    })
})
