/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
jest.mock('react-redux', () => ({
    useDispatch: () => () => {},
    useSelector: (pick) => pick({ auth: { user: { email: 'owner@example.com' } } })
}))
jest.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
jest.mock('@/utils/useNotifier', () => () => {})
jest.mock('@/api/serverSettings', () => ({
    __esModule: true,
    default: { getSettings: jest.fn(() => new Promise(() => {})) }
}))
jest.mock('./RestartScreen', () => ({
    RestartChoice: () => null,
    RestartScreen: () => null,
    RestartSteps: () => null
}))

import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import ServerSettings from './index'

describe('Server settings subtitle', () => {
    let root

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root.unmount()
            })
        }
        root = null
        document.body.innerHTML = ''
    })

    it('says runtime limits apply on the next use and the other settings wait for a restart', async () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(ThemeProvider, { theme: createTheme() }, createElement(ServerSettings)))
        })
        expect(document.body.textContent).toContain(
            'How this server runs. Runtime limits apply on the next use. The other settings wait for a restart.'
        )
        expect(document.body.textContent).not.toContain('Changes apply when Cuttlely restarts.')
    })
})
