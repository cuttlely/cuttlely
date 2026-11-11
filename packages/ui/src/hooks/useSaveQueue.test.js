/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement } from 'react'
import PropTypes from 'prop-types'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'

import chatflowsApi from '@/api/chatflows'
import flowDraftsApi from '@/api/flowDrafts'
import { ENQUEUE_SNACKBAR } from '@/store/actions'
import { SAVE_RETRY_NOTICE } from '@/utils/saveQueue'
import useSaveQueue from './useSaveQueue'

const mockDispatch = jest.fn()

jest.mock('react-redux', () => ({
    useDispatch: () => mockDispatch,
    useSelector: (select) => select({ auth: { user: { id: 'me' } } })
}))

jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { saveDraft: jest.fn(), getStatus: jest.fn() }
}))

jest.mock('@/api/chatflows', () => ({
    __esModule: true,
    default: { updateChatflow: jest.fn(), getSpecificChatflow: jest.fn() }
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

function Harness({ apiRef }) {
    apiRef.current = useSaveQueue()
    return createElement('div')
}

Harness.propTypes = { apiRef: PropTypes.shape({ current: PropTypes.object }) }

describe('save queue hook lifecycle', () => {
    let root
    let apiRef

    beforeEach(() => {
        jest.useFakeTimers()
        mockDispatch.mockReset()
        flowDraftsApi.saveDraft.mockReset()
        flowDraftsApi.getStatus.mockReset()
        chatflowsApi.updateChatflow.mockReset()
        chatflowsApi.getSpecificChatflow.mockReset()
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
        await act(async () => root.render(createElement(Harness, { apiRef })))
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

        flowDraftsApi.saveDraft.mockResolvedValueOnce({ data: { ...BASE, draft: { ...BASE.draft, hash: 'saved' } } })
        await act(async () => window.dispatchEvent(new Event('online')))
        await settleTimers()
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(5)
        expect(onAck).toHaveBeenCalledTimes(1)

        await act(async () => root.unmount())
        root = null
        await act(async () => window.dispatchEvent(new Event('online')))
        await settleTimers()
        expect(flowDraftsApi.saveDraft).toHaveBeenCalledTimes(5)
    })
})
