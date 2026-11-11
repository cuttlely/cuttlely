/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import CanvasLoadGuard, { canvasLoadBlocked, canvasLoadFailureReason, canvasLoadRetryRequest } from './CanvasLoadGuard'

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
        jest.useRealTimers()
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

    test('a failed saved-canvas request offers the same retry screen with an accurate message', async () => {
        const view = await renderGuard({ flowId: 'flow-1', request: 'flow', error: new Error('offline') })

        expect(document.body.textContent).toContain('The saved canvas could not be loaded')
        expect(document.body.textContent).toContain('Retry')
        expect(canvasInert()).toBe(true)
        act(() => view.root.unmount())
    })

    test('a status state from another flow keeps this flow blocked', async () => {
        jest.useFakeTimers()
        const view = await renderGuard({ flowId: 'flow-1', loading: false, error: new Error('offline') }, 'flow-2')

        expect(canvasInert()).toBe(true)
        expect(document.body.textContent).not.toContain('The saved canvas could not be opened')
        expect(document.body.textContent).not.toContain('Opening the saved canvas')
        await act(async () => jest.advanceTimersByTime(400))
        expect(document.body.textContent).toContain('Opening the saved canvas')
        act(() => view.root.unmount())
    })

    test('a successful status load opens this flow again', async () => {
        const view = await renderGuard({ flowId: 'flow-1', known: true, loading: false, error: null })

        expect(canvasInert()).toBe(false)
        expect(document.body.textContent).not.toContain('Opening the saved canvas')
        act(() => view.root.unmount())
    })

    test('the first status load is inert immediately but delays its visible opening screen', async () => {
        jest.useFakeTimers()
        const view = await renderGuard({ flowId: 'flow-1', loading: true, error: null })

        expect(canvasInert()).toBe(true)
        expect(document.body.textContent).not.toContain('Opening the saved canvas')
        await act(async () => jest.advanceTimersByTime(399))
        expect(document.body.textContent).not.toContain('Opening the saved canvas')
        await act(async () => jest.advanceTimersByTime(1))
        expect(document.body.textContent).toContain('Opening the saved canvas')
        expect(document.querySelector('[aria-label="Opening saved canvas"]')).toBeTruthy()
        act(() => view.root.unmount())
    })

    test('canvasLoadBlocked waits for known status for this exact flow id', () => {
        expect(canvasLoadBlocked('a', { flowId: 'a', known: false })).toBe(true)
        expect(canvasLoadBlocked('a', { flowId: 'a', known: true })).toBe(false)
        expect(canvasLoadBlocked('b', { flowId: 'a', known: true })).toBe(true)
        expect(canvasLoadBlocked('a', null)).toBe(true)
        expect(canvasLoadBlocked(undefined, { flowId: undefined, error: new Error('x') })).toBe(false)
    })

    test('retry reloads the flow after its GET failed and otherwise reloads draft status', () => {
        expect(canvasLoadRetryRequest('a', { flowId: 'a', request: 'flow' }, undefined)).toBe('flow')
        expect(canvasLoadRetryRequest('a', { flowId: 'a', request: 'status' }, 'a')).toBe('status')
        expect(canvasLoadRetryRequest('b', { flowId: 'a', request: 'status' }, 'a')).toBe('flow')
    })
})

describe('canvasLoadFailureReason', () => {
    test('a request with no answer is reported as a connection problem', () => {
        const noAnswer = Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} })
        expect(canvasLoadFailureReason(noAnswer)).toBe('The server could not be reached. Select Retry when the connection is back.')
    })

    test('an exhausted gateway response does not expose its proxy body', () => {
        for (const status of [502, 503, 504]) {
            expect(canvasLoadFailureReason({ response: { status, data: '<html>gateway</html>' } })).toBe(
                'The server could not be reached. Select Retry when the connection is back.'
            )
        }
    })

    test("an answered failure keeps the server's reason or status", () => {
        expect(canvasLoadFailureReason({ response: { status: 404, data: { message: 'Chatflow not found' } } })).toBe(
            'The server answered: Chatflow not found'
        )
        expect(canvasLoadFailureReason({ response: { status: 500, data: 'Internal failure' } })).toBe(
            'The server answered: Internal failure'
        )
        expect(canvasLoadFailureReason({ response: { status: 500, data: {} } })).toBe('The server answered with status 500.')
    })
})
