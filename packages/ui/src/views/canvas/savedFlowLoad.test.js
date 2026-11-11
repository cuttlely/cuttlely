/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
// Moving a mounted canvas from saved flow A to flow B: a late reply for A must not paint over B, and B's own
// failure must mark B failed so the open screen offers Retry. Both canvas views wire the saved-flow GET the same
// way: useApi with currentOnly, requestFlow to record the requested id, and flowLoadAction to decide.
import fs from 'fs'
import path from 'path'
import PropTypes from 'prop-types'
import { createElement, useEffect, useRef, useState } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import useApi from '@/hooks/useApi'
import CanvasLoadGuard, { createdFlowRouteAction, flowLoadAction } from './CanvasLoadGuard'

jest.mock('@/store/context/ErrorContext', () => ({ useError: () => ({ setError: jest.fn(), handleError: jest.fn() }) }))

const noAnswer = () => Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} })

// The load path both views share, reduced to the parts that decide what is painted.
function SavedFlowProbe({ chatflowId, getFlow, painted }) {
    const api = useApi(getFlow, { currentOnly: true })
    const requestedFlowIdRef = useRef(null)
    const [loadState, setLoadState] = useState({ flowId: null, known: false })
    const requestFlow = (id) => {
        requestedFlowIdRef.current = id
        api.request(id)
    }
    useEffect(() => {
        setLoadState({ flowId: chatflowId, known: false, loading: true, error: null, request: 'flow' })
        requestFlow(chatflowId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatflowId])
    useEffect(() => {
        const action = flowLoadAction(chatflowId, requestedFlowIdRef.current, api.data, api.error)
        if (action === 'paint') {
            painted(api.data.id)
            setLoadState({ flowId: api.data.id, known: true, error: null })
        } else if (action === 'fail') {
            setLoadState({ flowId: chatflowId, known: false, loading: false, error: api.error, request: 'flow' })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api.data, api.error])
    return createElement(
        CanvasLoadGuard,
        { flowId: chatflowId, loadState, onRetry: () => requestFlow(chatflowId), onBack: () => {} },
        createElement('button', { id: 'save' }, 'Save')
    )
}

SavedFlowProbe.propTypes = { chatflowId: PropTypes.string, getFlow: PropTypes.func, painted: PropTypes.func }

const deferred = () => {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('a canvas that moves from saved flow A to flow B', () => {
    let root
    const render = (chatflowId, getFlow, painted) =>
        act(async () => {
            root.render(
                createElement(ThemeProvider, { theme: createTheme() }, createElement(SavedFlowProbe, { chatflowId, getFlow, painted }))
            )
        })

    beforeEach(() => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })
    afterEach(async () => {
        await act(async () => root.unmount())
        document.body.innerHTML = ''
    })

    test("A's late reply after B painted is ignored and B stays open", async () => {
        const replies = { A: deferred(), B: deferred() }
        const getFlow = jest.fn((id) => replies[id].promise)
        const painted = jest.fn()
        await render('A', getFlow, painted)
        await render('B', getFlow, painted)
        await act(async () => replies.B.resolve({ data: { id: 'B' } }))
        await act(async () => replies.A.resolve({ data: { id: 'A' } }))
        expect(painted.mock.calls).toEqual([['B']])
        expect(document.body.textContent).not.toContain('Opening the saved canvas')
        expect(document.body.textContent).not.toContain('could not be opened')
    })

    test("B's failure marks B failed with Retry, even when A answers later", async () => {
        const replies = { A: deferred(), B: deferred() }
        const getFlow = jest.fn((id) => replies[id].promise)
        const painted = jest.fn()
        await render('A', getFlow, painted)
        await render('B', getFlow, painted)
        await act(async () => replies.B.reject(noAnswer()))
        await act(async () => replies.A.resolve({ data: { id: 'A' } }))
        expect(painted).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('The saved canvas could not be opened')
        expect(document.body.textContent).toContain('The server could not be reached.')
        const retry = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Retry')
        expect(retry).toBeTruthy()
        replies.B = deferred()
        await act(async () => retry.dispatchEvent(new MouseEvent('click', { bubbles: true })))
        await act(async () => replies.B.resolve({ data: { id: 'B' } }))
        expect(painted.mock.calls).toEqual([['B']])
        expect(getFlow.mock.calls.map(([id]) => id)).toEqual(['A', 'B', 'B'])
    })

    test('flowLoadAction paints only the route flow and fails only for it', () => {
        expect(flowLoadAction('B', 'B', { id: 'A' }, null)).toBe('ignore')
        expect(flowLoadAction('B', 'A', { id: 'A' }, null)).toBe('ignore')
        expect(flowLoadAction('B', 'A', null, noAnswer())).toBe('ignore')
        expect(flowLoadAction('B', 'B', { id: 'B' }, null)).toBe('paint')
        expect(flowLoadAction('B', 'B', null, noAnswer())).toBe('fail')
        expect(flowLoadAction(undefined, 'A', { id: 'A' }, null)).toBe('ignore')
    })

    test('a create-time route exemption is spent after A moves to B, so returning to A loads it', () => {
        let createdFlowId = 'A'
        expect(createdFlowRouteAction(createdFlowId, 'A')).toBe('keep-created')

        expect(createdFlowRouteAction(createdFlowId, 'B')).toBe('load')
        createdFlowId = null

        expect(createdFlowRouteAction(createdFlowId, 'A')).toBe('load')
        expect(createdFlowRouteAction(createdFlowId, undefined)).toBe('ignore')
    })

    test.each(['views/canvas/index.jsx', 'views/agentflowsv2/Canvas.jsx'])('%s routes the saved-flow GET through this path', (file) => {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8')
        expect(source).toContain('useApi(chatflowsApi.getSpecificChatflow, { currentOnly: true })')
        expect(source).toMatch(
            /flowLoadAction\(chatflowId, requestedFlowIdRef\.current, getSpecificChatflowApi\.data, getSpecificChatflowApi\.error\)/
        )
        expect(source).not.toMatch(/getSpecificChatflowApi\.request\((?!id\))/)
        expect(source).not.toMatch(/if \(getSpecificChatflowApi\.(data|error)\)/)
        // A newly created flow is exposed only by the queue's acknowledgement, after its status callback made the
        // exact id usable. The queue tests cover retrying that status read without another creation request.
        expect(source).toContain('const routeFlowId = chatflowId || createdFlowIdRef.current')
        expect(source).toContain('const canvasBlocked = canvasLoadBlocked(routeFlowId, draftStatusLoad)')
        expect(source).toMatch(/onStatus: \(status, created\) => \{\s+setDraftStatus\(status\)/)
        expect(source).toContain('setDraftStatusLoad({ flowId: created.id, known: true, loading: false, error: null })')
        expect(source).toContain('const action = createdFlowRouteAction(createdFlowIdRef.current, chatflowId)')
        expect(source).toMatch(/if \(action !== 'load'\) return\s+\/\/[\s\S]*?createdFlowIdRef\.current = null\s+setDraftStatus\(null\)/)
        expect(source).not.toContain('loadCreatedStatus')
    })
})
