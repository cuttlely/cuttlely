jest.mock('@/views/versionsettings/GithubCard', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/extended/Logo', () => ({ __esModule: true, default: () => null }))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { GithubStepView } from './GithubStep'

const render = (props) =>
    renderToStaticMarkup(
        createElement(
            MemoryRouter,
            null,
            createElement(ThemeProvider, { theme: createTheme() }, createElement(GithubStepView, { onDone: () => {}, ...props }))
        )
    )

describe('GithubStepView', () => {
    test('offers the GitHub card as an optional step that can be skipped', () => {
        const html = render({ connected: false, card: createElement('div', { 'data-testid': 'the-card' }) })
        expect(html).toContain('Keep a copy in GitHub')
        expect(html).toContain('Optional last step')
        expect(html).toContain('data-testid="the-card"')
        expect(html).toContain('Skip for now')
        expect(html).not.toContain('Continue')
        expect(html).toContain('any time in Version History')
    })

    test('once connected, the way on is Continue', () => {
        const html = render({ connected: true })
        expect(html).toContain('Continue')
        expect(html).not.toContain('Skip for now')
    })
})
