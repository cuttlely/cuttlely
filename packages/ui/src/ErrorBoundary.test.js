/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import ErrorBoundary from './ErrorBoundary'
import { NO_ANSWER_MESSAGE, errorSummary, errorSummaryText, requestFailureMessage } from '@/utils/errorSummary'
import fs from 'node:fs'
import path from 'node:path'

describe('ErrorBoundary card', () => {
    let root
    let container
    beforeEach(() => {
        container = document.createElement('div')
        document.body.append(container)
        root = createRoot(container)
    })
    afterEach(async () => {
        await act(async () => root.unmount())
        document.body.innerHTML = ''
    })

    const render = (error) =>
        act(async () => root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(ErrorBoundary, { error }))))

    test('renders a request that got no answer instead of throwing', async () => {
        const networkError = Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} })
        await render(networkError)
        expect(container.textContent).toContain('No response')
        expect(container.textContent).toContain(NO_ANSWER_MESSAGE)
    })

    test('renders a plain error with no response', async () => {
        await render(new TypeError("Cannot read properties of undefined (reading 'status')"))
        expect(container.textContent).toContain("Cannot read properties of undefined (reading 'status')")
    })

    test('still shows the status and server message of an API error', async () => {
        await render({ response: { status: 500, data: { message: 'Database is busy' } } })
        expect(container.textContent).toContain('Status: 500')
        expect(container.textContent).toContain('Database is busy')
    })
})

describe('errorSummary', () => {
    test('covers every shape without throwing', () => {
        expect(errorSummary(undefined)).toEqual({ status: 'Error', message: NO_ANSWER_MESSAGE })
        expect(errorSummary('Unexpected Error!')).toEqual({ status: 'Error', message: 'Unexpected Error!' })
        expect(errorSummary({ response: { status: 404, data: 'Not here' } })).toEqual({ status: 'Status: 404', message: 'Not here' })
        expect(errorSummary({ response: { status: 502 } })).toEqual({ status: 'Status: 502', message: '' })
        expect(errorSummaryText({ response: { status: 502 } })).toBe('Status: 502')
        expect(errorSummaryText({ response: { status: 400, data: { message: 'Bad' } } })).toBe('Status: 400\nBad')
    })
})

describe('requestFailureMessage', () => {
    test('says the server could not be reached when a request got no answer', () => {
        const noAnswer = Object.assign(new Error('Network Error'), { isAxiosError: true, request: {}, response: undefined })
        expect(requestFailureMessage(noAnswer)).toBe(NO_ANSWER_MESSAGE)
        expect(requestFailureMessage(undefined)).toBe(NO_ANSWER_MESSAGE)
    })

    test('keeps the server message when there is one', () => {
        expect(requestFailureMessage({ response: { status: 409, data: { message: 'Saved by someone else' } } })).toBe(
            'Saved by someone else'
        )
        expect(requestFailureMessage({ response: { status: 500, data: 'Busy' } })).toBe('Busy')
        expect(requestFailureMessage(new Error('Request failed with status code 500'))).toBe('Request failed with status code 500')
    })
})

// A failed load or save on these pages is reported from an effect. Reading the server message
// without a guard throws when the request got no answer, and the route then shows its error page.
describe('pages that report a failed request from an effect', () => {
    const pages = [
        'views/canvas/index.jsx',
        'views/agentflowsv2/Canvas.jsx',
        'views/assistants/custom/CustomAssistantConfigurePreview.jsx',
        'views/auth/forgotPassword.jsx'
    ]
    test.each(pages)('%s does not read a missing response', (page) => {
        const source = fs.readFileSync(path.join(__dirname, page), 'utf8')
        expect(source).not.toMatch(/Api\.error\.response\.(data|status)/)
    })
})
