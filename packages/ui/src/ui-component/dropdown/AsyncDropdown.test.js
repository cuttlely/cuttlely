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

    test('switching the card clears the old options and shows the new card value after its load', async () => {
        const { createElement } = require('react')
        const { act } = require('react-dom/test-utils')
        const { createRoot } = require('react-dom/client')
        const { ThemeProvider, createTheme } = require('@mui/material/styles')
        const credentialsApi = require('@/api/credentials').default
        const { AsyncDropdown } = require('./AsyncDropdown')
        const pending = {}
        credentialsApi.getCredentialsByName.mockImplementation(
            (names) =>
                new Promise((resolve) => {
                    pending[names] = resolve
                })
        )
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        const render = (id, credentialNames, value) =>
            act(async () => {
                root.render(
                    createElement(
                        ThemeProvider,
                        { theme: createTheme() },
                        createElement(AsyncDropdown, {
                            name: 'credential',
                            nodeData: { id, name: 'card', inputParams: [{ name: 'credential' }] },
                            value,
                            onSelect: () => {},
                            credentialNames
                        })
                    )
                )
            })

        await render('node-a', ['providerA'], 'a-id')
        await act(async () => pending.providerA({ data: [{ id: 'a-id', name: 'Alpha' }] }))
        expect(container.querySelector('input').value).toBe('Alpha')

        await render('node-b', ['providerB'], 'b-id')
        expect(container.querySelector('input').value).toBe('')
        await act(async () =>
            pending.providerB({
                data: [
                    { id: 'a-id', name: 'Alpha' },
                    { id: 'b-id', name: 'Beta' }
                ]
            })
        )
        expect(container.querySelector('input').value).toBe('Beta')
        await act(async () => root.unmount())
    })

    test('a failed credential load shows Retry without claiming there are no saved credentials', async () => {
        const { createElement } = require('react')
        const { act } = require('react-dom/test-utils')
        const { createRoot } = require('react-dom/client')
        const { ThemeProvider, createTheme } = require('@mui/material/styles')
        const credentialsApi = require('@/api/credentials').default
        const { AsyncDropdown } = require('./AsyncDropdown')
        credentialsApi.getCredentialsByName.mockRejectedValueOnce(Object.assign(new Error('Network Error'), { request: {} }))
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)

        await act(async () => {
            root.render(
                createElement(
                    ThemeProvider,
                    { theme: createTheme() },
                    createElement(AsyncDropdown, {
                        name: 'credential',
                        nodeData: { id: 'node-a', name: 'card', inputParams: [{ name: 'credential' }] },
                        value: '',
                        onSelect: () => {},
                        credentialNames: ['providerA']
                    })
                )
            )
        })

        expect(container.textContent).toContain('Could not load this list')
        expect(container.textContent).toContain('Retry')
        expect(container.textContent).not.toContain('No credential is saved')
        await act(async () => root.unmount())
    })
})
