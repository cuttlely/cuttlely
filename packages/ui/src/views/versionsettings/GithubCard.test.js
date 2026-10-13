jest.mock('@/api/flowVersions', () => ({ __esModule: true, default: { getGithub: jest.fn(), listIncoming: jest.fn() } }))
jest.mock('@/api/credentials', () => ({ __esModule: true, default: { getCredentialsByName: jest.fn() } }))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { repairListBody, SAVED_REPAIR_ROWS } from '@/utils/githubSync'
import GithubCard, { repoPickAfterLoad } from './GithubCard'

const wrap = (status, extra) =>
    renderToStaticMarkup(
        createElement(
            MemoryRouter,
            null,
            createElement(ThemeProvider, { theme: createTheme() }, createElement(GithubCard, { initialStatus: status, ...extra }))
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

    test('before connect, a three-environment Prod server names the previous environment', () => {
        const html = wrap(
            status({
                connected: false,
                role: 'read',
                promotes: true,
                environment: 'prod',
                environments: chain,
                state: 'not-connected',
                message: 'Not connected. Connect the repository Staging copies to, to see its new versions here.'
            })
        )
        expect(html).toContain('your Staging server copies to')
        expect(html).not.toContain('your Dev server')
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

    test('an unset environment on a named list asks for a choice and does not say versions are waiting', () => {
        const html = wrap(
            status({
                role: 'copy',
                environment: null,
                state: 'stopped',
                waiting: null,
                message: "Pick this server's environment. Nothing is copied until you do.",
                environments: chain
            })
        )
        expect(html).toContain('Pick this server')
        expect(html).not.toContain('waiting to be copied')
        expect(html).toContain('value="dev"')
        expect(html).toContain('value="staging"')
        expect(html).toContain('value="prod"')
    })

    test('an unreadable environment list can be saved again and does not describe Dev and Prod', () => {
        const html = wrap(
            status({
                connected: true,
                role: 'copy',
                environment: null,
                environments: [],
                state: 'stopped',
                message: 'The environment list could not be read. Save it again.'
            })
        )
        expect(html).toContain('The environment list could not be read. Save it again.')
        expect(html).toContain('data-testid="environment-repair"')
        expect(html).toContain('Which row is this server')
        expect(html).toContain('Save the list')
        expect(html).toContain('disabled')
        expect(html).toContain('value="dev"')
        expect(html).toContain('value="prod"')
        expect(html).not.toContain('value="Dev"')
        expect(html).not.toContain('Dev copies its published versions to GitHub')
        expect(html).not.toContain('>Not set<')
        expect(repairListBody(SAVED_REPAIR_ROWS, 'prod')).toEqual({
            environment: 'prod',
            environments: [
                { name: 'dev', branch: 'main', server: 'dev' },
                { name: 'prod', branch: 'main', server: 'prod' }
            ]
        })
    })

    test('a saved pair repair and a three-environment repair include the chosen server', () => {
        expect(repairListBody(SAVED_REPAIR_ROWS, 'dev')).toEqual({
            environment: 'dev',
            environments: SAVED_REPAIR_ROWS
        })
        const three = [
            { name: 'Dev', branch: 'main', server: 'dev' },
            { name: 'Staging', branch: 'staging', server: 'staging' },
            { name: 'Prod', branch: 'prod', server: 'prod' }
        ]
        expect(repairListBody(three, 'prod')).toEqual({ environment: 'prod', environments: three })
        expect(repairListBody(three, 'staging').environment).toBe('staging')
        expect(repairListBody(three, null).error).toBe('Pick which row is this server.')
    })

    test('loadRepos leaves a middle environment with nothing picked', () => {
        const empty = [{ repo: 'acme/empty', private: true, empty: true }]
        expect(repoPickAfterLoad(empty, true)).toBe('')
        expect(repoPickAfterLoad([], true)).toBe('')
        expect(repoPickAfterLoad(empty, false)).toBe('acme/empty')
        expect(repoPickAfterLoad([], false)).toBe('__new_repo__')
    })

    test('connect follows the previous environment for Dev, Staging and Prod', () => {
        const base = {
            connected: false,
            state: 'not-connected',
            environments: chain,
            message: ''
        }
        const dev = wrap(status({ ...base, role: 'copy', promotes: false, environment: 'dev' }), { initialStep: 'repo' })
        expect(dev).toContain('Pick an empty repository, or make a new private one')
        expect(dev).toContain('Make a new private repository')
        expect(dev).toContain('Dev copies its published versions')
        expect(dev).toContain('Staging reads Dev and copies what it publishes')

        const staging = wrap(status({ ...base, role: 'copy', promotes: true, environment: 'staging' }), { initialStep: 'repo' })
        expect(staging).toContain('your Dev server copies to')
        expect(staging).not.toContain('Make a new private repository')
        expect(staging).not.toContain('Pick an empty repository')

        const prod = wrap(status({ ...base, role: 'read', promotes: true, environment: 'prod' }), { initialStep: 'repo' })
        expect(prod).toContain('your Staging server copies to')
        expect(prod).not.toContain('Make a new private repository')
        expect(prod).not.toContain('your Dev server')
    })

    test('the environment hint and the disconnect line follow a two- and three-environment list', () => {
        const pair = wrap(
            status({
                connected: true,
                role: 'copy',
                environment: 'dev',
                environments: [
                    { name: 'dev', branch: 'main', server: 'dev' },
                    { name: 'prod', branch: 'main', server: 'prod' }
                ]
            })
        )
        expect(pair).toContain('Dev copies its published versions to GitHub. Prod reads them from there')
        expect(pair).toContain('Prod reads Dev')
        expect(pair).toContain('Disconnect GitHub before changing what this server reads or copies')
        expect(pair).not.toContain('To switch between Dev and Prod')

        const three = wrap(status({ connected: true, role: 'copy', promotes: true, environment: 'staging', environments: chain }))
        expect(three).toContain('Staging reads Dev and copies what it publishes')
        expect(three).toContain('Prod reads Staging')
        expect(three).toContain('Staging reads Dev, and Prod reads Staging')
        expect(three).toContain('Disconnect GitHub before changing what this server reads or copies')
    })
})
