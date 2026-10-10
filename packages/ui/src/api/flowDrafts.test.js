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
})
