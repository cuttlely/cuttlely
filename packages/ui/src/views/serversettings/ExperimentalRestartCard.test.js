/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('react-redux', () => ({
    useDispatch: () => () => {},
    useSelector: (pick) => pick({ auth: { user: { email: 'owner@example.com' } } })
}))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('@/api/serverSettings', () => ({
    __esModule: true,
    default: {
        getOperator: jest.fn().mockResolvedValue({ data: {} }),
        getSettings: jest.fn(),
        restart: jest.fn()
    }
}))
jest.mock('./RestartScreen', () => {
    const React = jest.requireActual('react')
    const PropTypes = jest.requireActual('prop-types')
    const RestartScreen = ({ open }) => (open ? React.createElement('div', { 'data-testid': 'restart-screen' }) : null)
    const RestartSteps = ({ open, steps }) =>
        open ? React.createElement('div', { 'data-testid': 'restart-steps' }, 'Restart Cuttlely to apply ', ...(steps ?? [])) : null
    RestartScreen.propTypes = { open: PropTypes.bool }
    RestartSteps.propTypes = { open: PropTypes.bool, steps: PropTypes.array }
    return {
        RestartChoice: () => null,
        RestartScreen,
        RestartSteps
    }
})

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'

import serverSettingsApi from '@/api/serverSettings'
import ServerSettings from './index'

const view = (inPlace) => ({
    sections: [
        {
            id: 'experimental',
            label: 'Experimental',
            summary: 'Features that are still being tested.',
            afterRestart: 'Experimental settings apply after a restart.'
        }
    ],
    settings: [],
    restart: {
        inPlace,
        changed: [],
        steps: ['Stop Cuttlely, then start it again.']
    },
    runs: { inProgress: 0, waitSeconds: 45 },
    keptOut: [],
    readOnly: []
})

async function click(testId) {
    const node = document.querySelector(`[data-testid="${testId}"]`)
    expect(node).toBeTruthy()
    await act(async () => {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
}

describe('Experimental restart card', () => {
    let root

    async function renderPage(data) {
        globalThis.localStorage?.setItem('cuttlely.serverSettings.getStartedDismissed', '1')
        window.history.replaceState(null, '', '/?section=experimental')
        serverSettingsApi.getSettings.mockResolvedValue({ data })
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(
                createElement(MemoryRouter, null, createElement(ThemeProvider, { theme: createTheme() }, createElement(ServerSettings)))
            )
        })
        await act(async () => Promise.resolve())
        expect(document.querySelector('[data-testid="experimental-restart-card"]')).toBeTruthy()
    }

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root.unmount()
            })
        }
        root = null
        document.body.innerHTML = ''
        globalThis.localStorage?.clear()
        window.history.replaceState(null, '', '/')
        jest.clearAllMocks()
    })

    it('does not call the restart API on Cancel and does after confirmation', async () => {
        const data = view(true)
        serverSettingsApi.restart.mockResolvedValue({ data: { restarting: false, steps: [] } })
        await renderPage(data)

        expect(document.querySelector('[data-testid="experimental-restart-action"]').textContent).toContain('Restart server')
        await click('experimental-restart-action')
        expect(serverSettingsApi.restart).not.toHaveBeenCalled()
        await click('experimental-restart-cancel')
        expect(serverSettingsApi.restart).not.toHaveBeenCalled()

        await click('experimental-restart-action')
        await click('experimental-restart-confirm')
        expect(serverSettingsApi.restart).toHaveBeenCalledWith(true)
    })

    it('shows manual steps without claiming an in-place restart when supervision is unavailable', async () => {
        const data = view(false)
        serverSettingsApi.restart.mockResolvedValue({ data: { restarting: false, steps: data.restart.steps } })
        await renderPage(data)

        expect(document.querySelector('[data-testid="experimental-restart-action"]').textContent).toContain('How to restart')
        await click('experimental-restart-action')
        expect(document.body.textContent).toContain('this does not stop the server')
        await click('experimental-restart-confirm')

        expect(serverSettingsApi.restart).toHaveBeenCalledWith(true)
        expect(document.body.textContent).toContain('Restart Cuttlely to apply')
        expect(document.body.textContent).toContain(data.restart.steps[0])
        expect(document.querySelector('[data-testid="restart-screen"]')).toBeNull()
    })
})
