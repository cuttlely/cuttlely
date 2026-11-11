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

jest.mock('react-redux', () => ({ useSelector: (select) => select({ customization: { isDarkMode: false } }) }))

describe('AsyncDropdown reused for another card', () => {
    test('switching the card aborts the previous credential load and loads for the new card', async () => {
        const { createElement } = require('react')
        const { act } = require('react-dom/test-utils')
        const { createRoot } = require('react-dom/client')
        const { ThemeProvider, createTheme } = require('@mui/material/styles')
        const credentialsApi = require('@/api/credentials').default
        const { AsyncDropdown } = require('./AsyncDropdown')
        const signals = []
        credentialsApi.getCredentialsByName.mockImplementation((names, config) => {
            signals.push({ names, signal: config?.signal })
            return new Promise(() => {})
        })
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        const render = (id, credentialNames) =>
            act(async () => {
                root.render(
                    createElement(
                        ThemeProvider,
                        { theme: createTheme() },
                        createElement(AsyncDropdown, {
                            name: 'credential',
                            nodeData: { id, name: 'card', inputParams: [{ name: 'credential' }] },
                            value: '',
                            onSelect: () => {},
                            credentialNames
                        })
                    )
                )
            })
        await render('node-a', ['openAIApi'])
        await render('node-b', ['anthropicApi'])
        expect(signals.map((call) => call.names)).toEqual(['openAIApi', 'anthropicApi'])
        expect(signals[0].signal.aborted).toBe(true)
        expect(signals[1].signal.aborted).toBe(false)
        await act(async () => root.unmount())
    })
})
