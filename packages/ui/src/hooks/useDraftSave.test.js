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
    default: { saveDraft: jest.fn() }
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

    test('ZZ-TEST-a DRAFT_CHANGED 409 returns the conflict and sets it', async () => {
        flowDraftsApi.saveDraft.mockRejectedValueOnce(conflictError())
        await mount()
        apiRef.current.record({ draft: { hash: 'h1' } })
        const result = await save('zz-test-flow', FLOW)
        const conflict = {
            savedBy: { id: 'zz-test-rosa', name: 'ZZ-TEST-Rosa' },
            savedAt: SAVED_AT
        }
        expect(result).toEqual({ conflict })
        expect(apiRef.current.conflict).toEqual(conflict)
        expect(document.body.textContent).toContain('conflict')
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
