const findOneBy = jest.fn()

jest.mock('./getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({ AppDataSource: { getRepository: () => ({ findOneBy }) } })
}))

import { utilGetUploadsConfig } from './getUploadsConfig'

const harnessNode = (inputs: Record<string, unknown>) => ({
    id: 'harness_0',
    data: { id: 'harness_0', name: 'harness', category: 'Harness', inputs, inputParams: [] }
})

const flow = (nodes: unknown[], edges: unknown[] = []) => ({ id: 'flow-1', flowData: JSON.stringify({ nodes, edges }) })

describe('utilGetUploadsConfig with a Harness node', () => {
    beforeEach(() => findOneBy.mockReset())

    it('allows image uploads when a Harness node that answers the chat has Allow Image Uploads on', async () => {
        findOneBy.mockResolvedValue(flow([harnessNode({ harnessName: 'demo', allowImageUploads: true })]))
        const config = await utilGetUploadsConfig('flow-1')
        expect(config.isImageUploadAllowed).toBe(true)
        expect(config.imgUploadSizeAndTypes).toEqual([
            { fileTypes: ['image/gif', 'image/jpeg', 'image/png', 'image/webp', ''], maxUploadSize: 5 }
        ])
    })

    it('keeps image uploads off when Allow Image Uploads is off', async () => {
        findOneBy.mockResolvedValue(flow([harnessNode({ harnessName: 'demo' })]))
        const config = await utilGetUploadsConfig('flow-1')
        expect(config.isImageUploadAllowed).toBe(false)
        expect(config.imgUploadSizeAndTypes).toEqual([])
    })

    it('leaves images to the agent when the Harness node is attached as a tool', async () => {
        const agent = { id: 'toolAgent_0', data: { id: 'toolAgent_0', name: 'toolAgent', category: 'Agents', inputs: {}, inputParams: [] } }
        findOneBy.mockResolvedValue(
            flow(
                [harnessNode({ harnessName: 'demo', allowImageUploads: true }), agent],
                [{ id: 'e1', source: 'harness_0', target: 'toolAgent_0', sourceHandle: 'a', targetHandle: 'b' }]
            )
        )
        const config = await utilGetUploadsConfig('flow-1')
        expect(config.isImageUploadAllowed).toBe(false)
    })
})
