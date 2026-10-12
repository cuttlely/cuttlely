import { exportKnownNodeNames, missingNodeInfo, packFromIndex, placeholderHandles } from './missingNode'

const catalog = [{ name: 'chatOpenAI' }]

describe('a node that is not in the loaded catalog', () => {
    test('names the pack once the catalog has loaded', () => {
        const data = { name: 'samplePackNode', label: 'Sample Pack Node', nodePack: 'sample-pack' }
        expect(missingNodeInfo(data, catalog)).toEqual({
            label: 'Sample Pack Node',
            pack: 'sample-pack',
            message: 'Sample Pack Node is not installed. Install the sample-pack pack.'
        })
        expect(missingNodeInfo({ name: 'gone', label: 'Gone' }, catalog)).toEqual({
            label: 'Gone',
            pack: '',
            message: 'Gone is not installed.'
        })
    })

    test('names the pack from the index when the saved node has no nodePack', () => {
        const index = [{ name: 'serpAPI', label: 'Serp API', pack: '@cuttlely/node-pack-tools-mcp' }]
        const data = { name: 'serpAPI', label: 'Serp API' }
        expect(missingNodeInfo(data, catalog, index)).toEqual({
            label: 'Serp API',
            pack: '@cuttlely/node-pack-tools-mcp',
            message: 'Serp API is not installed. Install the @cuttlely/node-pack-tools-mcp pack.'
        })
        expect(missingNodeInfo({ ...data, nodePack: 'sample-pack' }, catalog, index).pack).toBe('sample-pack')
        expect(packFromIndex(index, 'other', 'Serp API')).toBe('@cuttlely/node-pack-tools-mcp')
        expect(packFromIndex(index, 'other', 'Missing')).toBe('')
    })

    test('leaves a loaded node and an empty catalog alone', () => {
        expect(missingNodeInfo({ name: 'chatOpenAI', label: 'ChatOpenAI' }, catalog)).toBeNull()
        expect(missingNodeInfo({ name: 'samplePackNode', label: 'Sample Pack Node', nodePack: 'sample-pack' }, [])).toBeNull()
        expect(missingNodeInfo({ name: 'samplePackNode' }, undefined)).toBeNull()
    })

    test('keeps a handle for every saved anchor and every edge handle', () => {
        const data = {
            id: 'pack',
            inputAnchors: [{ id: 'pack-in' }],
            outputAnchors: [{ id: 'pack-out', options: [{ id: 'pack-out-option', isAnchor: true }] }]
        }
        const edges = [
            { source: 'other', target: 'pack', sourceHandle: 'other-out', targetHandle: 'pack-in' },
            { source: 'pack', target: 'down', sourceHandle: 'pack-edge-only', targetHandle: 'down-in' }
        ]
        expect(placeholderHandles(data, edges)).toEqual({
            targets: ['pack-in'],
            sources: ['pack-out', 'pack-out-option', 'pack-edge-only']
        })
    })

    test('export learns names only after the catalog loads', () => {
        expect(exportKnownNodeNames(catalog)).toEqual(['chatOpenAI'])
        expect(exportKnownNodeNames([])).toBeUndefined()
        expect(exportKnownNodeNames(undefined)).toBeUndefined()
    })
})
