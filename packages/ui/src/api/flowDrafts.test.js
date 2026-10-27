jest.mock('./client', () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
        post: jest.fn()
    }
}))

import client from './client'
import flowDrafts from './flowDrafts'

describe('flowDrafts api', () => {
    const flowData = '{"nodes":[],"edges":[]}'

    test('calls the draft routes', () => {
        flowDrafts.getStatus('a b')
        flowDrafts.saveDraft('id', flowData)
        flowDrafts.discardDraft('id')
        flowDrafts.updateSettings('id', true)
        flowDrafts.publish('id', { overwriteLiveChanges: true })
        flowDrafts.rollback('id', 'abc1234')

        expect(client.get).toHaveBeenCalledWith('/flow-drafts/a%20b')
        expect(client.put).toHaveBeenCalledWith('/flow-drafts/id', { flowData })
        expect(client.delete).toHaveBeenCalledWith('/flow-drafts/id')
        expect(client.put).toHaveBeenCalledWith('/flow-drafts/id/settings', { publishInstantly: true })
        expect(client.post).toHaveBeenCalledWith('/flow-drafts/id/publish', { overwriteLiveChanges: true })
        expect(client.post).toHaveBeenCalledWith('/flow-drafts/id/rollback', { sha: 'abc1234' })
    })

    test('publish sends an empty body when nothing extra is asked', () => {
        flowDrafts.publish('id')
        expect(client.post).toHaveBeenCalledWith('/flow-drafts/id/publish', {})
    })

    test('ZZ-TEST-save sends the loaded draft hash and overwrite only when asked', () => {
        const flowData = '{"nodes":[],"edges":[]}'
        client.put.mockClear()
        flowDrafts.saveDraft('id', flowData)
        flowDrafts.saveDraft('id', flowData, {})
        flowDrafts.saveDraft('id', flowData, { overwriteDraftChanges: false })
        flowDrafts.saveDraft('id', flowData, { overwriteDraftChanges: 'true' })
        expect(client.put).toHaveBeenCalledTimes(4)
        for (const call of client.put.mock.calls) {
            expect(call).toEqual(['/flow-drafts/id', { flowData }])
        }
        client.put.mockClear()
        flowDrafts.saveDraft('id', flowData, { expectedDraftHash: 'abc123' })
        expect(client.put).toHaveBeenCalledWith('/flow-drafts/id', { flowData, expectedDraftHash: 'abc123' })
        flowDrafts.saveDraft('id', flowData, { expectedDraftHash: null })
        expect(client.put).toHaveBeenCalledWith('/flow-drafts/id', { flowData, expectedDraftHash: null })
        flowDrafts.saveDraft('id', flowData, { expectedDraftHash: 'abc123', overwriteDraftChanges: true })
        expect(client.put).toHaveBeenCalledWith('/flow-drafts/id', {
            flowData,
            expectedDraftHash: 'abc123',
            overwriteDraftChanges: true
        })
        flowDrafts.saveDraft('id', flowData, { expectedDraftHash: 5, overwriteDraftChanges: 1 })
        expect(client.put).toHaveBeenLastCalledWith('/flow-drafts/id', { flowData })
    })
})
