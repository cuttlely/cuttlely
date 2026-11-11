/** @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js */
import nodesApi from '@/api/nodes'
import { fetchList } from './AsyncDropdown'

jest.mock('@/api/nodes', () => ({ __esModule: true, default: { executeNodeLoadMethod: jest.fn() } }))
jest.mock('@/api/credentials', () => ({ __esModule: true, default: { getCredentialsByName: jest.fn() } }))
jest.mock('@/store/constant', () => ({ baseURL: 'http://localhost' }))

describe('AsyncDropdown load requests', () => {
    test('fetchList uses the shared node client and passes cancellation config', async () => {
        const signal = new AbortController().signal
        nodesApi.executeNodeLoadMethod.mockResolvedValueOnce({ data: [{ name: 'one' }] })
        const nodeData = {
            name: 'exampleNode',
            credential: 'credential-id',
            inputParams: [{ name: 'choice', loadMethod: 'choices' }]
        }
        await expect(fetchList({ name: 'choice', nodeData }, { signal })).resolves.toEqual([{ name: 'one' }])
        expect(nodesApi.executeNodeLoadMethod).toHaveBeenCalledWith(
            'exampleNode',
            expect.objectContaining({ loadMethod: 'choices', credential: 'credential-id' }),
            { signal }
        )
    })
})
