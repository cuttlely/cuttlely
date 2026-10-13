jest.mock('@/api/flowVersions', () => ({ __esModule: true, default: { getGithub: jest.fn(), listIncoming: jest.fn() } }))
jest.mock('@/api/credentials', () => ({ __esModule: true, default: { getCredentialsByName: jest.fn() } }))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import GithubCard from './GithubCard'

const wrap = (status) =>
    renderToStaticMarkup(
        createElement(
            MemoryRouter,
            null,
            createElement(ThemeProvider, { theme: createTheme() }, createElement(GithubCard, { initialStatus: status }))
        )
    )

const chain = [
    { name: 'Dev', branch: 'main', server: 'dev' },
    { name: 'Staging', branch: 'staging', server: 'staging' },
    { name: 'Prod', branch: 'prod', server: 'prod' }
]

const status = (extra) => ({
    enabled: true,
    connected: true,
    role: 'read',
    state: 'up-to-date',
    environment: 'prod',
    repo: 'acme/flows',
    url: 'https://github.com/acme/flows',
    credential: { id: 'c1', name: 'GitHub' },
    lastCheckedAt: '2026-10-08T11:58:00Z',
    message: '',
    ...extra
})

describe('GithubCard environment names', () => {
    test('a two-environment Prod server still names Dev', () => {
        const html = wrap(
            status({
                environments: [
                    { name: 'dev', branch: 'main', server: 'dev' },
                    { name: 'prod', branch: 'main', server: 'prod' }
                ]
            })
        )
        expect(html).toContain('Get new versions from your Dev server through your GitHub repository.')
        expect(html).toContain('Looked for new versions from Dev')
    })

    test('a three-environment Prod server names the previous environment', () => {
        const html = wrap(status({ environments: chain }))
        expect(html).toContain('Get new versions from your Staging server through your GitHub repository.')
        expect(html).toContain('Looked for new versions from Staging')
        expect(html).not.toContain('from your Dev server')
        expect(html).not.toContain('from Dev')
    })

    test('a two-entry list that is not Dev and Prod uses those server identities', () => {
        const html = wrap(
            status({
                role: 'copy',
                environment: 'qa',
                environments: [
                    { name: 'QA', branch: 'qa', server: 'qa' },
                    { name: 'Live', branch: 'live', server: 'live' }
                ]
            })
        )
        expect(html).toContain('value="qa"')
        expect(html).toContain('value="live"')
        expect(html).not.toContain('value="dev"')
        expect(html).not.toContain('value="prod"')
    })
})
