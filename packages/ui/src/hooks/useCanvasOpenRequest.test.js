/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import { createElement, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import CanvasLoadGuard from '@/views/canvas/CanvasLoadGuard'
import useCanvasOpenRequest from './useCanvasOpenRequest'

function OpeningCanvas({ read, onBack }) {
    const openRequest = useCanvasOpenRequest()

    useEffect(() => {
        read('flow-1', { signal: openRequest.start('flow-1') }).catch(() => {})
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return createElement(
        CanvasLoadGuard,
        {
            flowId: 'flow-1',
            loadState: { flowId: 'flow-1', known: false, loading: true, retrying: true, request: 'flow' },
            onRetry: () => {},
            onBack
        },
        createElement('div', null, 'canvas')
    )
}

OpeningCanvas.propTypes = { read: PropTypes.func.isRequired, onBack: PropTypes.func.isRequired }

function BackProbe({ read }) {
    const [open, setOpen] = useState(true)
    return open ? createElement(OpeningCanvas, { read, onBack: () => setOpen(false) }) : createElement('div', null, 'destination')
}

BackProbe.propTypes = { read: PropTypes.func.isRequired }

describe('saved canvas open cancellation', () => {
    let root

    afterEach(async () => {
        if (root) await act(async () => root.unmount())
        root = null
        document.body.innerHTML = ''
    })

    test.each(['saved-flow', 'draft-status'])('Back aborts the active %s read', async () => {
        let requestStarted
        const started = new Promise((resolve) => (requestStarted = resolve))
        let requestSignal
        const read = jest.fn((_flowId, { signal }) => {
            requestSignal = signal
            requestStarted()
            return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        })

        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(BackProbe, { read })))
        })
        await started

        const back = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Back')
        await act(async () => back.dispatchEvent(new MouseEvent('click', { bubbles: true })))

        expect(document.body.textContent).toContain('destination')
        expect(requestSignal.aborted).toBe(true)
        expect(read).toHaveBeenCalledTimes(1)
    })
})
