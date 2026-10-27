/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import { createElement } from 'react'
import PropTypes from 'prop-types'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'

import flowDraftsApi from '@/api/flowDrafts'
import useDraftSave from './useDraftSave'

jest.mock('@/api/flowDrafts', () => ({
    __esModule: true,
    default: { saveDraft: jest.fn(), getStatus: jest.fn() }
}))

const FLOW = '{"nodes":[],"edges":[]}'
const SAVED_AT = '2026-10-27T12:00:00.000Z'

function conflictError() {
    return {
        response: {
            status: 409,
            data: {
                code: 'DRAFT_CHANGED',
                message: 'ZZ-TEST-Rosa saved this draft after you opened it.',
                savedBy: { id: 'zz-test-rosa', name: 'ZZ-TEST-Rosa' },
                savedAt: SAVED_AT
            }
        }
    }
}

function Harness({ apiRef }) {
    const draftSave = useDraftSave()
    apiRef.current = draftSave
    return createElement('div', null, draftSave.conflict ? 'conflict' : 'clear')
}

Harness.propTypes = {
    apiRef: PropTypes.shape({ current: PropTypes.object })
}

describe('ZZ-TEST-useDraftSave sends the recorded draft version', () => {
    let root
    let apiRef

    beforeEach(() => {
        flowDraftsApi.saveDraft.mockReset()
        flowDraftsApi.getStatus.mockReset()
        flowDraftsApi.getStatus.mockResolvedValue({ data: { draft: null } })
        apiRef = { current: null }
    })

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root.unmount()
            })
        }
        root = null
        document.body.innerHTML = ''
    })

    async function mount() {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(Harness, { apiRef }))
        })
    }

    async function save(...args) {
        let result
        await act(async () => {
            result = await apiRef.current.save(...args)
        })
        return result
    }

    test('ZZ-TEST-no expectedDraftHash until record, then the hash, then null', async () => {
        flowDraftsApi.saveDraft.mockResolvedValue({ data: { draft: { hash: 'later' } } })
        await mount()
        await save('zz-test-flow', FLOW)
        expect(flowDraftsApi.saveDraft).toHaveBeenLastCalledWith('zz-test-flow', FLOW, {})

        apiRef.current.record({ draft: { hash: 'h1' } })
        await save('zz-test-flow', FLOW)
        expect(flowDraftsApi.saveDraft).toHaveBeenLastCalledWith('zz-test-flow', FLOW, { expectedDraftHash: 'h1' })

        apiRef.current.record({ draft: null })
        await save('zz-test-flow', FLOW)
        expect(flowDraftsApi.saveDraft).toHaveBeenLastCalledWith('zz-test-flow', FLOW, { expectedDraftHash: null })
    })

    test('ZZ-TEST-a successful save records the response draft hash for the next save', async () => {
        flowDraftsApi.saveDraft
            .mockResolvedValueOnce({ data: { draft: { hash: 'h-next' } } })
            .mockResolvedValueOnce({ data: { draft: { hash: 'h-after' } } })
        await mount()
        apiRef.current.record({ draft: { hash: 'h1' } })
        await save('zz-test-flow', FLOW)
        await save('zz-test-flow', FLOW)
        expect(flowDraftsApi.saveDraft).toHaveBeenLastCalledWith('zz-test-flow', FLOW, { expectedDraftHash: 'h-next' })
    })

    test('ZZ-TEST-a DRAFT_CHANGED 409 returns the conflict, then reads their saved draft for the review screen', async () => {
        const THEIRS = '{"nodes":[{"id":"zz-test-theirs"}],"edges":[]}'
        const BASE = '{"nodes":[],"edges":[],"base":true}'
        flowDraftsApi.saveDraft.mockRejectedValueOnce(conflictError())
        flowDraftsApi.getStatus.mockResolvedValueOnce({ data: { draft: { hash: 'h-theirs', flowData: THEIRS } } })
        await mount()
        apiRef.current.record({ draft: { hash: 'h1', flowData: BASE } })
        const result = await save('zz-test-flow', FLOW)
        const found = {
            savedBy: { id: 'zz-test-rosa', name: 'ZZ-TEST-Rosa' },
            savedAt: SAVED_AT
        }
        expect(result).toEqual({ conflict: found })
        expect(flowDraftsApi.getStatus).toHaveBeenCalledWith('zz-test-flow')
        expect(apiRef.current.conflict).toEqual({
            ...found,
            mine: FLOW,
            base: BASE,
            loading: false,
            theirs: { flowData: THEIRS, hash: 'h-theirs', status: { draft: { hash: 'h-theirs', flowData: THEIRS } } }
        })
        expect(document.body.textContent).toContain('conflict')
    })

    test('ZZ-TEST-after a discard records Live, the next save sends no hash and a 409 reviews against Live', async () => {
        const DISCARDED = '{"nodes":[{"id":"zz-test-old"}],"edges":[]}'
        const LIVE = '{"nodes":[{"id":"zz-test-live"}],"edges":[]}'
        flowDraftsApi.saveDraft.mockRejectedValueOnce(conflictError())
        flowDraftsApi.getStatus.mockResolvedValueOnce({ data: { draft: { hash: 'h-theirs', flowData: FLOW } } })
        await mount()
        apiRef.current.record({ draft: { hash: 'h1', flowData: DISCARDED } })
        apiRef.current.record({ draft: null }, LIVE)
        await save('zz-test-flow', FLOW)
        expect(flowDraftsApi.saveDraft).toHaveBeenLastCalledWith('zz-test-flow', FLOW, { expectedDraftHash: null })
        expect(apiRef.current.conflict.base).toBe(LIVE)
    })

    test('ZZ-TEST-after the merge is applied, the next save and publish send their draft hash', async () => {
        flowDraftsApi.saveDraft.mockResolvedValue({ data: { draft: { hash: 'h-saved' } } })
        await mount()
        expect(apiRef.current.expected()).toEqual({})
        apiRef.current.record({ draft: { hash: 'h1' } })
        expect(apiRef.current.expected()).toEqual({ expectedDraftHash: 'h1' })
        apiRef.current.adopt({ flowData: FLOW, hash: 'h-theirs' })
        expect(apiRef.current.expected()).toEqual({ expectedDraftHash: 'h-theirs' })
        await save('zz-test-flow', FLOW)
        expect(flowDraftsApi.saveDraft).toHaveBeenLastCalledWith('zz-test-flow', FLOW, { expectedDraftHash: 'h-theirs' })
    })

    test('ZZ-TEST-a review screen closed before their draft arrives stays closed', async () => {
        let resolve
        flowDraftsApi.getStatus.mockReturnValueOnce(new Promise((done) => (resolve = done)))
        await mount()
        let pending
        await act(async () => {
            pending = apiRef.current.openConflict('zz-test-flow', { savedBy: null, savedAt: null }, FLOW)
        })
        expect(apiRef.current.conflict.loading).toBe(true)
        await act(async () => {
            apiRef.current.dismiss()
        })
        await act(async () => {
            resolve({ data: { draft: { hash: 'late', flowData: FLOW } } })
            await pending
        })
        expect(apiRef.current.conflict).toBeNull()
    })

    test('ZZ-TEST-overwriteDraftChanges true is passed only when asked', async () => {
        flowDraftsApi.saveDraft.mockResolvedValue({ data: { draft: { hash: 'h1' } } })
        await mount()
        apiRef.current.record({ draft: { hash: 'h1' } })
        await save('zz-test-flow', FLOW)
        expect(flowDraftsApi.saveDraft).toHaveBeenLastCalledWith('zz-test-flow', FLOW, { expectedDraftHash: 'h1' })

        await save('zz-test-flow', FLOW, { overwriteDraftChanges: false })
        expect(flowDraftsApi.saveDraft).toHaveBeenLastCalledWith('zz-test-flow', FLOW, { expectedDraftHash: 'h1' })

        await save('zz-test-flow', FLOW, { overwriteDraftChanges: true })
        expect(flowDraftsApi.saveDraft).toHaveBeenLastCalledWith('zz-test-flow', FLOW, {
            expectedDraftHash: 'h1',
            overwriteDraftChanges: true
        })
    })
})
