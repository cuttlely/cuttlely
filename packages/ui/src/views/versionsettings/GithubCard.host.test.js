jest.mock('@/api/flowVersions', () => ({ __esModule: true, default: { getGithub: jest.fn(), listIncoming: jest.fn() } }))
jest.mock('@/api/credentials', () => ({ __esModule: true, default: { getCredentialsByName: jest.fn() } }))

import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import GithubCard from './GithubCard'

const status = {
    enabled: true,
    connected: false,
    role: 'copy',
    state: 'not-connected',
    environment: null,
    repo: null,
    url: null,
    host: null,
    credential: null,
    message: '',
    environments: []
}

const texts = (renderer) =>
    renderer.root
        .findAll((node) => typeof node.children?.[0] === 'string')
        .map((node) => node.children.filter((child) => typeof child === 'string').join(''))
        .join('\n')

const byTestId = (renderer, id) => renderer.root.findAll((node) => node.props['data-testid'] === id)[0]

const buttonNamed = (renderer, name) => renderer.root.findAll((node) => node.type === 'button' && node.children.includes(name))[0]

describe('GithubCard host field', () => {
    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation((...args) => {
            const text = args.map((item) => String(item)).join(' ')
            // MUI's link button warns about function refs under the test renderer. Any other error fails the test.
            if (!text.includes('Function components cannot be given refs')) throw new Error(text)
        })
    })
    afterEach(() => {
        console.error.mockRestore()
    })

    test('github.com stays the default and an enterprise host retargets the help and the token page', async () => {
        let renderer
        await act(async () => {
            renderer = TestRenderer.create(
                createElement(
                    MemoryRouter,
                    null,
                    createElement(
                        ThemeProvider,
                        { theme: createTheme() },
                        createElement(GithubCard, { initialStatus: status, initialStep: 'token' })
                    )
                )
            )
        })
        const host = byTestId(renderer, 'github-host')
        expect(host.props.value).toBe('github.com')
        expect(texts(renderer)).toContain('github.com is the default')
        const link = () => renderer.root.findAll((node) => node.props.href && String(node.props.children).includes('Create a token'))[0]
        expect(link().props.href).toContain('https://github.com/settings/personal-access-tokens/new')

        const tokenInput = renderer.root.findAll((node) => node.props.type === 'password')[0]
        await act(async () => {
            tokenInput.props.onChange({ target: { value: 'example-token' } })
        })
        expect(buttonNamed(renderer, 'Continue').props.disabled).toBe(false)

        await act(async () => {
            host.props.onChange({ target: { value: 'github.example.com' } })
        })
        expect(texts(renderer)).toContain('https://github.example.com/api/v3')
        expect(link().props.href).toBe('https://github.example.com/settings/tokens')
        expect(texts(renderer)).toContain('Use a token issued by github.example.com')
        expect(buttonNamed(renderer, 'Continue').props.disabled).toBe(false)

        await act(async () => {
            host.props.onChange({ target: { value: 'http://github.example.com' } })
        })
        expect(texts(renderer)).toContain('has to start with https')
        expect(buttonNamed(renderer, 'Continue').props.disabled).toBe(true)
    })
})
