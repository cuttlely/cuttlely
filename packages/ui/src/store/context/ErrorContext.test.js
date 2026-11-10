/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement, useEffect } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useNavigate } from 'react-router-dom'

jest.mock('@/store/constant', () => ({ ErrorMessage: { INVALID_MISSING_TOKEN: 'Invalid or Missing token' } }))
jest.mock('@/store', () => ({ store: { dispatch: jest.fn() } }))
jest.mock('@/store/reducers/authSlice', () => ({ logoutSuccess: () => ({ type: 'logout' }) }))
jest.mock('@/utils/genericHelper', () => ({ redirectWhenUnauthorized: jest.fn() }))

import { ErrorProvider, useError } from './ErrorContext'

let api
const Probe = () => {
    const context = useError()
    const navigate = useNavigate()
    useEffect(() => {
        api = { ...context, navigate }
    })
    return createElement('p', { 'data-testid': 'error' }, context.error ? String(context.error.message) : 'none')
}

describe('ErrorProvider page errors', () => {
    let root
    let container
    beforeEach(async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {})
        container = document.createElement('div')
        document.body.append(container)
        root = createRoot(container)
        await act(async () =>
            root.render(
                createElement(
                    MemoryRouter,
                    { initialEntries: ['/canvas/flow-1'] },
                    createElement(ErrorProvider, null, createElement(Probe))
                )
            )
        )
    })
    afterEach(async () => {
        await act(async () => root.unmount())
        document.body.innerHTML = ''
        console.error.mockRestore()
    })

    const shown = () => container.querySelector('[data-testid=error]').textContent

    test('a request that fails on the canvas does not show on the next page', async () => {
        const failed = Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} })
        const handleOnCanvas = api.handleError
        await act(async () => handleOnCanvas(failed))
        expect(shown()).toBe('Network Error')
        await act(async () => api.navigate('/chatflows'))
        expect(shown()).toBe('none')
    })

    test('an error from this page still shows, and a success from another page does not clear it', async () => {
        const clearFromCanvas = api.setError
        await act(async () => api.navigate('/chatflows'))
        await act(async () => api.setError(new Error('List failed')))
        expect(shown()).toBe('List failed')
        await act(async () => clearFromCanvas(null))
        expect(shown()).toBe('List failed')
        await act(async () => api.setError(null))
        expect(shown()).toBe('none')
    })

    test('a canvas request that fails after you leave does not replace the next page error', async () => {
        const handleOnCanvas = api.handleError
        await act(async () => api.navigate('/chatflows'))
        await act(async () => api.setError(new Error('List failed')))
        expect(shown()).toBe('List failed')
        const late = Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} })
        await act(async () => handleOnCanvas(late))
        expect(shown()).toBe('List failed')
    })

    test('an old canvas error does not come back when you return to the canvas', async () => {
        const handleOnCanvas = api.handleError
        await act(async () => api.navigate('/chatflows'))
        const late = Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} })
        await act(async () => handleOnCanvas(late))
        await act(async () => api.navigate('/chatflows/other'))
        await act(async () => api.navigate('/canvas/flow-1'))
        expect(shown()).toBe('none')
    })
})
