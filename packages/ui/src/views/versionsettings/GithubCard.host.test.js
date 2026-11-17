/* eslint-disable react/prop-types -- Lightweight MUI adapters for the Node test renderer. */
jest.mock('@/api/flowVersions', () => ({
    __esModule: true,
    default: {
        getGithub: jest.fn(),
        listIncoming: jest.fn(),
        listGithubRepos: jest.fn(),
        listGithubBranches: jest.fn(),
        connectGithub: jest.fn()
    }
}))
jest.mock('@/api/credentials', () => ({ __esModule: true, default: { getCredentialsByName: jest.fn() } }))

// Exercise the card's requests and selection without MUI's browser-only menu portal.
jest.mock('@mui/material', () => {
    const actual = jest.requireActual('@mui/material')
    const React = require('react')
    return {
        ...actual,
        Popover: () => null,
        Collapse: (props) => (props.in ? props.children : null),
        TextField: (props) =>
            props.select
                ? React.createElement('select', { value: props.value, onChange: props.onChange, disabled: props.disabled }, props.children)
                : React.createElement(actual.TextField, props)
    }
})

import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import GithubCard from './GithubCard'
import flowVersionsApi from '@/api/flowVersions'

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
        await act(async () => renderer.unmount())
    })
})

describe('GithubCard branch selection', () => {
    test('loads repository branches, changes the selection and sends it with Connect', async () => {
        flowVersionsApi.listGithubRepos.mockResolvedValue({
            data: {
                account: 'acme',
                repos: [
                    { repo: 'acme/flows', empty: true },
                    { repo: 'acme/other', empty: false }
                ]
            }
        })
        flowVersionsApi.listGithubBranches.mockRejectedValueOnce(new Error('Branches unavailable')).mockResolvedValue({
            data: {
                defaultBranch: 'trunk',
                branches: [
                    { name: 'trunk', protected: true },
                    { name: 'teams/versions', protected: false }
                ]
            }
        })
        flowVersionsApi.connectGithub.mockResolvedValue({ data: { ...status, connected: false } })
        const warnings = jest.spyOn(console, 'error').mockImplementation(() => {})
        let renderer
        try {
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
            await act(async () => {
                renderer.root.findAll((node) => node.props.type === 'password')[0].props.onChange({ target: { value: 'example-token' } })
            })
            await act(async () => {
                buttonNamed(renderer, 'Continue').props.onClick()
            })
            expect(flowVersionsApi.listGithubBranches).toHaveBeenCalledWith({
                token: 'example-token',
                host: 'github.com',
                repo: 'acme/flows'
            })
            expect(buttonNamed(renderer, 'Connect').props.disabled).toBe(true)
            await act(async () => {
                buttonNamed(renderer, 'Retry').props.onClick()
            })
            const select = () => renderer.root.findAll((node) => node.props.select && node.props.label === 'Branch')[0]
            expect(select().props.value).toBe('trunk')
            expect(texts(renderer)).toContain('(protected)')
            await act(async () => {
                select().props.onChange({ target: { value: 'teams/versions' } })
            })
            let finishOldRequest
            flowVersionsApi.listGithubBranches.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishOldRequest = resolve
                    })
            )
            const chooseRepo = (repo) => renderer.root.findAll((node) => node.props.item?.repo === repo)[0].props.onSelect()
            await act(async () => {
                chooseRepo('acme/other')
            })
            expect(buttonNamed(renderer, 'Connect').props.disabled).toBe(true)
            await act(async () => {
                chooseRepo('acme/flows')
            })
            await act(async () => {
                finishOldRequest({ data: { defaultBranch: 'other-only', branches: [{ name: 'other-only' }] } })
            })
            expect(select().props.value).toBe('trunk')
            expect(texts(renderer)).not.toContain('other-only')
            await act(async () => {
                select().props.onChange({ target: { value: 'teams/versions' } })
            })
            await act(async () => {
                buttonNamed(renderer, 'Connect').props.onClick()
            })
            expect(flowVersionsApi.connectGithub).toHaveBeenCalledWith({
                token: 'example-token',
                host: 'github.com',
                repo: 'acme/flows',
                branch: 'teams/versions'
            })
        } finally {
            if (renderer) await act(async () => renderer.unmount())
            warnings.mockRestore()
        }
    })
})
