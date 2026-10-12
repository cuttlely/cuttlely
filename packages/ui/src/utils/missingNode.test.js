import { exportKnownNodeNames, missingNodeInfo } from './missingNode'

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

    test('leaves a loaded node and an empty catalog alone', () => {
        expect(missingNodeInfo({ name: 'chatOpenAI', label: 'ChatOpenAI' }, catalog)).toBeNull()
        expect(missingNodeInfo({ name: 'samplePackNode', label: 'Sample Pack Node', nodePack: 'sample-pack' }, [])).toBeNull()
        expect(missingNodeInfo({ name: 'samplePackNode' }, undefined)).toBeNull()
    })

    test('export learns names only after the catalog loads', () => {
        expect(exportKnownNodeNames(catalog)).toEqual(['chatOpenAI'])
        expect(exportKnownNodeNames([])).toBeUndefined()
        expect(exportKnownNodeNames(undefined)).toBeUndefined()
    })
})
