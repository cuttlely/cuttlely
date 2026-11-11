/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement, StrictMode } from 'react'
import PropTypes from 'prop-types'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'

import { CREATE_STATUS_NOTICE, SAVE_AGAIN_NOTICE, SAVE_RETRY_NOTICE } from '@/utils/saveQueue'
import useSaveQueue from './useSaveQueue'

const mockDispatch = jest.fn()
const ENQUEUE_SNACKBAR = 'test/enqueue'
const CLOSE_SNACKBAR = 'test/close'
const enqueueSnackbar = (notification) => ({ type: ENQUEUE_SNACKBAR, notification })
const closeSnackbar = (key) => ({ type: CLOSE_SNACKBAR, key })

jest.mock('react-redux', () => ({
    useSelector: (select) => select({ auth: { user: { id: 'me' } } })
}))

jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { getStatus: jest.fn() }
}))

jest.mock('@/api/connectionState', () => ({ beginReconnect: jest.fn(), endReconnect: jest.fn() }))

const FLOW = JSON.stringify({ nodes: [{ id: 'a', data: { name: 'card' } }], edges: [] })
const BASE = {
    draft: {
        hash: 'base',
        flowData: FLOW,
        updatedBy: 'me',
        updatedDate: '2026-11-10T12:00:00.000Z'
    }
}

const noResponse = () => ({ request: {}, response: undefined })
const deferred = () => {
    let resolve
    const promise = new Promise((done) => {
        resolve = done
    })
    return { promise, resolve }
}

function Harness({ apiRef, dependencies }) {
    apiRef.current = useSaveQueue(dependencies)
    return createElement('div')
}

Harness.propTypes = { apiRef: PropTypes.shape({ current: PropTypes.object }), dependencies: PropTypes.object }

describe('save queue hook lifecycle', () => {
    let root
    let apiRef
    let chatflowsApi
    let flowDraftsApi
    let dependencies

    beforeEach(() => {
        jest.useFakeTimers()
        mockDispatch.mockReset()
        flowDraftsApi = { saveDraft: jest.fn(), getStatus: jest.fn() }
        chatflowsApi = { updateChatflow: jest.fn(), getSpecificChatflow: jest.fn() }
        dependencies = { chatflowsApi, flowDraftsApi, dispatch: mockDispatch, enqueueSnackbar, closeSnackbar }
        apiRef = { current: null }
    })

    afterEach(async () => {
        if (root) {
            await act(async () => root.unmount())
        }
        root = null
        jest.useRealTimers()
        document.body.innerHTML = ''
    })

    const settleTimers = async () => {
        for (let index = 0; index < 8; index += 1) {
            await act(async () => {
                jest.runOnlyPendingTimers()
                await Promise.resolve()
                await Promise.resolve()
            })
        }
    }

    test('shows one notice, resumes on online, and removes its listener on unmount', async () => {
        const onAck = jest.fn()
        flowDraftsApi.saveDraft.mockRejectedValue(noResponse())
        flowDraftsApi.getStatus.mockResolvedValue({ data: BASE })

        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => root.render(createElement(Harness, { apiRef, dependencies })))
        apiRef.current.record(BASE, FLOW)
        await act(async () => {
            apiRef.current.saveDraft({ id: 'flow-1', rev: 1, flowData: FLOW, liveFlowData: '{}', onAck })
        })
        await settleTimers()

        const notices = mockDispatch.mock.calls
            .map(([action]) => action)
            .filter((action) => action.type === ENQUEUE_SNACKBAR && action.notification.message === SAVE_RETRY_NOTICE)
        expect(notices).toHaveLength(1)
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(4)

        await act(async () => window.dispatchEvent(new Event('online')))
        await settleTimers()
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(8)
        expect(
            mockDispatch.mock.calls
                .map(([action]) => action)
                .filter((action) => action.type === ENQUEUE_SNACKBAR && action.notification.message === SAVE_RETRY_NOTICE)
        ).toHaveLength(1)

        flowDraftsApi.saveDraft.mockResolvedValueOnce({ data: { ...BASE, draft: { ...BASE.draft, hash: 'saved' } } })
        await act(async () => window.dispatchEvent(new Event('online')))
        await settleTimers()
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(9)
        expect(onAck).toHaveBeenCalledTimes(1)
        expect(mockDispatch.mock.calls.map(([action]) => action).filter((action) => action.type === CLOSE_SNACKBAR)).toHaveLength(1)

        await act(async () => root.unmount())
        root = null
        await act(async () => window.dispatchEvent(new Event('online')))
        await settleTimers()
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(9)
    })

    test('records a cleared draft when the sent canvas already equals Live', async () => {
        const onAck = jest.fn()
        flowDraftsApi.saveDraft.mockRejectedValue(noResponse())
        flowDraftsApi.getStatus.mockResolvedValue({ data: { mode: 'draft', draft: null } })
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => root.render(createElement(Harness, { apiRef, dependencies })))
        apiRef.current.record(BASE, FLOW)

        await act(async () => apiRef.current.saveDraft({ id: 'flow-1', rev: 1, flowData: FLOW, liveFlowData: FLOW, onAck }))
        await settleTimers()

        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(1)
        expect(onAck).toHaveBeenCalledWith(
            expect.objectContaining({ draft: null }),
            expect.objectContaining({ reconciled: true, storedFlowData: FLOW })
        )
        expect(apiRef.current.expected()).toEqual({ expectedDraftHash: null })
    })

    test('an unanswered create reports Save again without showing the retry notice', async () => {
        const onError = jest.fn()
        const send = jest.fn().mockRejectedValue(noResponse())
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => root.render(createElement(Harness, { apiRef, dependencies })))

        await act(async () => apiRef.current.saveCreate({ send, onError }))
        await settleTimers()
        expect(send).toHaveBeenCalledTimes(1)
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: SAVE_AGAIN_NOTICE }))
        expect(
            mockDispatch.mock.calls
                .map(([action]) => action)
                .filter((action) => action.type === ENQUEUE_SNACKBAR && action.notification.message === SAVE_RETRY_NOTICE)
        ).toHaveLength(0)

        await act(async () => window.dispatchEvent(new Event('online')))
        await settleTimers()
        expect(send).toHaveBeenCalledTimes(1)
    })

    test('uses the returned id for a second Save during creation', async () => {
        const request = deferred()
        const firstSend = jest.fn().mockReturnValue(request.promise)
        const secondSend = jest.fn()
        const firstAck = jest.fn()
        const latestAck = jest.fn()
        const afterCreate = jest.fn((_created, _status, details) =>
            details.fromPending ? { kind: 'draft', id: 'created-1', rev: 2, flowData: FLOW, liveFlowData: '{}', onAck: latestAck } : null
        )
        flowDraftsApi.getStatus.mockResolvedValue({ data: { ...BASE, mode: 'draft' } })
        flowDraftsApi.saveDraft.mockResolvedValue({ data: { ...BASE, mode: 'draft', draft: { ...BASE.draft, hash: 'saved' } } })

        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => root.render(createElement(Harness, { apiRef, dependencies })))
        await act(async () => {
            apiRef.current.saveCreate({ send: firstSend, onAck: firstAck, afterCreate })
            apiRef.current.saveCreate({ send: secondSend, afterCreate })
        })
        await act(async () => request.resolve({ data: { id: 'created-1', flowData: '{}', name: 'Created' } }))
        await settleTimers()

        expect(firstSend).toHaveBeenCalledTimes(1)
        expect(secondSend).not.toHaveBeenCalled()
        expect(firstAck).toHaveBeenCalledWith(expect.objectContaining({ id: 'created-1' }), { willContinue: true })
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledWith('created-1', FLOW, { expectedDraftHash: 'base' })
        expect(latestAck).toHaveBeenCalledTimes(1)
    })

    test('does not call creation follow-up callbacks after unmount', async () => {
        const statusRequest = deferred()
        const onStatus = jest.fn()
        const afterCreate = jest.fn()
        flowDraftsApi.getStatus.mockReturnValue(statusRequest.promise)

        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => root.render(createElement(Harness, { apiRef, dependencies })))
        await act(async () =>
            apiRef.current.saveCreate({
                send: jest.fn().mockResolvedValue({ data: { id: 'created-1', flowData: '{}', name: 'Created' } }),
                needsPostCreate: true,
                onStatus,
                afterCreate
            })
        )
        await act(async () => root.unmount())
        root = null
        const dispatchesAfterUnmount = mockDispatch.mock.calls.length
        await act(async () => statusRequest.resolve({ data: { ...BASE, mode: 'draft' } }))
        await settleTimers()

        expect(onStatus).not.toHaveBeenCalled()
        expect(afterCreate).not.toHaveBeenCalled()
        expect(mockDispatch).toHaveBeenCalledTimes(dispatchesAfterUnmount)
    })

    test('recreates the queue after an effect cleanup and setup', async () => {
        const onAck = jest.fn()
        flowDraftsApi.saveDraft.mockResolvedValue({ data: { ...BASE, draft: { ...BASE.draft, hash: 'saved' } } })
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => root.render(createElement(StrictMode, null, createElement(Harness, { apiRef, dependencies }))))

        apiRef.current.record(BASE, FLOW)
        await act(async () => apiRef.current.saveDraft({ id: 'flow-1', rev: 1, flowData: FLOW, liveFlowData: '{}', onAck }))
        await settleTimers()

        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(1)
        expect(onAck).toHaveBeenCalledTimes(1)
    })

    test('keeps the create id private until Retry finishes its status read', async () => {
        const send = jest.fn().mockResolvedValue({ data: { id: 'created-1', flowData: '{}', name: 'Created' } })
        const queuedSend = jest.fn()
        const onAck = jest.fn()
        const latestAck = jest.fn()
        flowDraftsApi.getStatus.mockResolvedValue({ data: {} })
        flowDraftsApi.saveDraft.mockResolvedValue({ data: { ...BASE, mode: 'draft', draft: { ...BASE.draft, hash: 'saved' } } })
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => root.render(createElement(Harness, { apiRef, dependencies })))

        await act(async () => apiRef.current.saveCreate({ send, onAck }))
        await settleTimers()
        expect(send).toHaveBeenCalledTimes(1)
        expect(onAck).not.toHaveBeenCalled()
        expect(chatflowsApi.updateChatflow).not.toHaveBeenCalled()
        expect(flowDraftsApi.getStatus).toHaveBeenCalledTimes(4)
        expect(apiRef.current.busy).toBe(false)
        const notice = mockDispatch.mock.calls
            .map(([action]) => action)
            .find((action) => action.type === ENQUEUE_SNACKBAR && action.notification.message === CREATE_STATUS_NOTICE)
        expect(notice).toBeTruthy()

        flowDraftsApi.getStatus.mockResolvedValue({ data: { ...BASE, mode: 'draft' } })
        await act(async () =>
            apiRef.current.saveCreate({
                send: queuedSend,
                afterCreate: (created) => ({
                    kind: 'draft',
                    id: created.id,
                    rev: 2,
                    flowData: FLOW,
                    liveFlowData: '{}',
                    onAck: latestAck
                })
            })
        )
        await settleTimers()
        expect(send).toHaveBeenCalledTimes(1)
        expect(queuedSend).not.toHaveBeenCalled()
        expect(flowDraftsApi.getStatus).toHaveBeenCalledTimes(5)
        expect(onAck).toHaveBeenCalledTimes(1)
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(1)
        expect(latestAck).toHaveBeenCalledTimes(1)
        expect(chatflowsApi.updateChatflow).not.toHaveBeenCalled()
    })

    test('the create Retry action repeats the status read without another create request', async () => {
        const send = jest.fn().mockResolvedValue({ data: { id: 'created-1', flowData: FLOW, name: 'Created' } })
        const onAck = jest.fn()
        flowDraftsApi.getStatus.mockResolvedValue({ data: {} })
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => root.render(createElement(Harness, { apiRef, dependencies })))

        await act(async () => apiRef.current.saveCreate({ send, onAck }))
        await settleTimers()
        const notice = mockDispatch.mock.calls
            .map(([action]) => action)
            .find((action) => action.type === ENQUEUE_SNACKBAR && action.notification.message === CREATE_STATUS_NOTICE)
        const retry = notice.notification.options.action()
        flowDraftsApi.getStatus.mockResolvedValue({ data: { ...BASE, mode: 'live' } })
        await act(async () => retry.props.onClick())
        await settleTimers()

        expect(send).toHaveBeenCalledTimes(1)
        expect(flowDraftsApi.getStatus).toHaveBeenCalledTimes(5)
        expect(onAck).toHaveBeenCalledTimes(1)
    })

    test('an online event resumes only the created flow status read', async () => {
        const send = jest.fn().mockResolvedValue({ data: { id: 'created-1', flowData: FLOW, name: 'Created' } })
        const onAck = jest.fn()
        flowDraftsApi.getStatus.mockResolvedValue({ data: {} })
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => root.render(createElement(Harness, { apiRef, dependencies })))

        await act(async () => apiRef.current.saveCreate({ send, onAck }))
        await settleTimers()
        flowDraftsApi.getStatus.mockResolvedValue({ data: { ...BASE, mode: 'live' } })
        await act(async () => window.dispatchEvent(new Event('online')))
        await settleTimers()

        expect(send).toHaveBeenCalledTimes(1)
        expect(flowDraftsApi.getStatus).toHaveBeenCalledTimes(5)
        expect(onAck).toHaveBeenCalledTimes(1)
    })

    test('reports busy until the queued write settles', async () => {
        const request = deferred()
        flowDraftsApi.saveDraft.mockReturnValue(request.promise)
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => root.render(createElement(Harness, { apiRef, dependencies })))
        apiRef.current.record(BASE, FLOW)

        await act(async () => apiRef.current.saveDraft({ id: 'flow-1', rev: 1, flowData: FLOW, liveFlowData: '{}', onAck: jest.fn() }))
        expect(apiRef.current.busy).toBe(true)
        await act(async () => request.resolve({ data: { ...BASE, draft: { ...BASE.draft, hash: 'saved' } } }))
        await settleTimers()
        expect(apiRef.current.busy).toBe(false)
    })
})
