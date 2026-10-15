/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import ReadOnlyRows from './ReadOnlyRows'

describe('ReadOnlyRows', () => {
    let root

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root.unmount()
            })
        }
        root = null
        document.body.innerHTML = ''
    })

    it('shows set or not set and never a value', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(ReadOnlyRows, {
                        rows: [
                            { key: 'PORT', set: true, source: 'env', readOnly: true, value: 'should-not-render' },
                            { key: 'REDIS_PASSWORD', set: false, source: 'unset', readOnly: true, value: 'also-hidden' }
                        ]
                    })
                )
            )
        })
        expect(document.body.textContent).toContain('PORT')
        expect(document.body.textContent).toContain('Set')
        expect(document.body.textContent).toContain('REDIS_PASSWORD')
        expect(document.body.textContent).toContain('Not set')
        expect(document.body.textContent).not.toContain('should-not-render')
        expect(document.body.textContent).not.toContain('also-hidden')
    })
})
