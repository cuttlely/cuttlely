/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import ReviewDialog from './ReviewDialog'

const sections = [
    { id: 'integrations', label: 'Versions' },
    { id: 'advanced', label: 'Advanced' }
]

const limit = {
    key: 'CUTTLELY_CHECK_CONCURRENCY',
    label: 'Questions at once',
    section: 'integrations',
    risk: 'low',
    from: '2',
    to: '4',
    runtime: true
}

const restart = {
    key: 'LOG_LEVEL',
    label: 'Log level',
    section: 'advanced',
    risk: 'low',
    from: 'info',
    to: 'debug',
    runtime: false
}

const renderDialog = async (rows) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            createElement(
                ThemeProvider,
                { theme: createTheme() },
                createElement(ReviewDialog, {
                    open: true,
                    rows,
                    sections,
                    saving: false,
                    onClose: () => {},
                    onSave: () => {}
                })
            )
        )
    })
    return root
}

describe('ReviewDialog', () => {
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

    it('says every runtime limit applies on the next use', async () => {
        root = await renderDialog([limit])
        expect(document.body.textContent).toContain('These limits apply on the next use.')
        expect(document.body.textContent).not.toContain('next start')
        expect(document.querySelector('[data-testid="review-CUTTLELY_CHECK_CONCURRENCY"]')).toBeTruthy()
    })

    it('says limits apply now and the rest at restart when the review is mixed', async () => {
        root = await renderDialog([limit, restart])
        expect(document.body.textContent).toContain('Limits apply now. The rest apply at restart.')
    })

    it('keeps the restart sentence when no row is a runtime limit', async () => {
        root = await renderDialog([restart])
        expect(document.body.textContent).toContain(
            'Saving keeps them for the next start. The server keeps running with its current settings until it restarts.'
        )
    })
})
