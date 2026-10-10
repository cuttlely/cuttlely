jest.mock('@/api/flowVersions', () => ({ __esModule: true, default: { listIncoming: jest.fn() } }))
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: () => true }) }))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { PromoteDetailView, PromoteListView } from './PromoteViews'
import { FromDevBannerView } from '@/ui-component/flow/FromDevBanner'

const wrap = (element) =>
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ThemeProvider, { theme: createTheme() }, element)))
const now = Date.parse('2026-10-08T12:00:00Z')
const at = '2026-10-08T11:58:00Z'
const version = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', title: 'Answer with the code word PAPAYA', author: 'Avery', date: at }
const flow = (extra) => ({ flowId: 'f1', name: 'Support bot', status: 'update', version, changes: [version], hasDraft: false, ...extra })
const noop = () => {}

describe('PromoteListView', () => {
    const list = (flows, extra) => ({ enabled: true, connected: true, flows, ...extra })
    const render = (props) => wrap(createElement(PromoteListView, { now, timeAgo: () => '2 minutes ago', onCheckNow: noop, ...props }))

    test('lists each flow with a friendly label and a summary', () => {
        const html = render({ list: list([flow(), flow({ flowId: 'f2', name: 'Intake', status: 'new', hasDraft: true })]) })
        expect(html).toContain('2 flows have a new version from Dev')
        expect(html).toContain('New version available from Dev')
        expect(html).toContain('New flow from Dev')
        expect(html).toContain('Unpublished changes here')
        expect(html).toContain('href="/promote/f1"')
        expect(html).toContain('Look now')
    })

    test('says when everything is Live, and when the server is not set up as Prod', () => {
        expect(render({ list: list([]) })).toContain('Everything from Dev is Live here')
        expect(render({ list: list([], { enabled: false }) })).toContain('server labeled Prod')
        expect(render({ list: list([], { connected: false }) })).toContain('Connect this server to the repository')
        expect(render({ list: list([]), status: { lastCheckedAt: at } })).toContain('Looked 2 minutes ago')
    })
})

describe('PromoteDetailView', () => {
    const detail = (extra) => ({
        ...flow(),
        diff: { nodes: [{ status: 'changed', label: 'Prompt', changes: [{ field: 'systemMessagePrompt' }] }], edges: [] },
        missingCredentials: [],
        ambiguousCredentials: [],
        ...extra
    })
    const render = (props) =>
        wrap(
            createElement(PromoteDetailView, {
                detail: detail(),
                onPromote: noop,
                onRollBack: noop,
                now,
                check: createElement('div', { 'data-testid': 'check-slot' }),
                ...props
            })
        )

    test('shows the version, the changes, the check and an enabled Promote button', () => {
        const html = render()
        expect(html).toContain('Support bot')
        expect(html).toContain('Answer with the code word PAPAYA')
        expect(html).toContain('What changes on this server')
        expect(html).toContain('check-slot')
        expect(html).toContain('Every credential it uses is on this server')
        expect(html).toMatch(/<button[^>]*data-testid="promote-button"(?![^>]*disabled)[^>]*>/)
    })

    test('blocks Promote with the list of missing credentials and a link to Credentials', () => {
        const html = render({ detail: detail({ missingCredentials: [{ name: 'Prod OpenAI', credentialName: 'openAIApi' }] }) })
        expect(html).toContain('Prod OpenAI (openAIApi)')
        expect(html).toContain('href="/credentials"')
        expect(html).toContain('Promote is waiting for the credentials above.')
        expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="promote-button"|<button[^>]*data-testid="promote-button"[^>]*disabled/)
    })

    test('warns that unpublished changes here are kept, and explains a new flow', () => {
        expect(render({ detail: detail({ hasDraft: true }) })).toContain('promote-draft')
        const html = render({ detail: detail({ status: 'new' }) })
        expect(html).toContain('New flow from Dev')
        expect(html).toContain('What it adds here')
    })

    test('shows why the check cannot run instead of the check', () => {
        const html = render({
            detail: detail({ checkUnavailable: { code: 'new-flow', message: 'Nothing is Live here to compare with yet.' } })
        })
        expect(html).toContain('Nothing is Live here to compare with yet.')
        expect(html).not.toContain('check-slot')
    })

    test('after Promote: the message, Open the flow and Roll back', () => {
        const html = render({ result: { recorded: true }, canRollBack: true, openPath: '/canvas/f1' })
        expect(html).toContain('Promoted. This version is now Live on this server.')
        expect(html).toContain('href="/canvas/f1"')
        expect(html).toContain('Roll back')
        expect(render({ result: { recorded: true }, canRollBack: true, rolledBack: true })).toContain('The previous version is Live again')
    })
})

describe('FromDevBannerView', () => {
    test('shows nothing without new versions', () => {
        expect(wrap(createElement(FromDevBannerView, { flows: [] }))).toBe('')
    })

    test('names each flow and links to review it', () => {
        const html = wrap(createElement(FromDevBannerView, { flows: [flow(), flow({ flowId: 'f2', name: 'Intake', status: 'new' })] }))
        expect(html).toContain('from-dev-banner')
        expect(html).toContain('Support bot')
        expect(html).toContain('Intake')
        expect(html).toContain('/promote/f1')
    })
})
