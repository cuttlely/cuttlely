/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import axios from 'axios'
import { createElement, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

jest.mock('@/store/constant', () => ({
    baseURL: 'http://localhost',
    ErrorMessage: { TOKEN_EXPIRED: 'Token Expired', INVALID_MISSING_TOKEN: 'Invalid or Missing token' }
}))
jest.mock('@/utils/authUtils', () => ({ __esModule: true, default: { removeCurrentUser: jest.fn() } }))

import apiClient, { resetClientState, setRetrySleep } from '@/api/client'
import { getReconnectCount, resetReconnectState } from '@/api/connectionState'
import chatflowsApi from '@/api/chatflows'
import flowDraftsApi from '@/api/flowDrafts'
import CanvasLoadGuard from '@/views/canvas/CanvasLoadGuard'
import useCanvasOpenRequest from './useCanvasOpenRequest'

const networkError = (config) => Object.assign(new Error('Network Error'), { isAxiosError: true, request: {}, config })

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
    const originalAdapter = apiClient.defaults.adapter
    let root

    beforeEach(() => {
        resetClientState()
        resetReconnectState()
    })

    afterEach(async () => {
        if (root) await act(async () => root.unmount())
        root = null
        document.body.innerHTML = ''
        apiClient.defaults.adapter = originalAdapter
        resetClientState()
        resetReconnectState()
    })

    test.each([
        ['saved-flow', chatflowsApi.getSpecificChatflow],
        ['draft-status', flowDraftsApi.getStatus]
    ])('Back aborts the shared client %s retry', async (_name, read) => {
        let retryStarted
        const started = new Promise((resolve) => (retryStarted = resolve))
        let requestSignal
        setRetrySleep(
            (_delay, signal) =>
                new Promise((_resolve, reject) => {
                    retryStarted()
                    signal.addEventListener('abort', () => reject(new axios.CanceledError()), { once: true })
                })
        )
        apiClient.defaults.adapter = jest.fn(async (config) => {
            requestSignal = config.signal
            throw networkError(config)
        })

        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(BackProbe, { read })))
        })
        await started
        expect(getReconnectCount()).toBe(1)

        const back = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Back')
        await act(async () => back.dispatchEvent(new MouseEvent('click', { bubbles: true })))

        expect(document.body.textContent).toContain('destination')
        expect(requestSignal.aborted).toBe(true)
        expect(apiClient.defaults.adapter).toHaveBeenCalledTimes(1)
        expect(getReconnectCount()).toBe(0)
    })
})
