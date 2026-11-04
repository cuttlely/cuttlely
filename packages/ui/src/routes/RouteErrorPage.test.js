/**
 * @jest-environment <rootDir>/src/__mocks__/jsdomCanvasEnvironment.js
 */
import fs from 'fs'
import path from 'path'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom'

import RouteErrorPage from './RouteErrorPage'
import { CHUNK_RELOAD_KEY, resetChunkReloadForTests } from '@/utils/chunkReload'

// jsdom has no fetch Request, which the router builds for each route change. These routes have no loaders,
// so a stand-in with the URL, method and signal is enough.
if (typeof globalThis.Request === 'undefined') {
    globalThis.Request = class {
        constructor(url, init = {}) {
            this.url = String(url)
            this.method = init.method || 'GET'
            this.signal = init.signal
        }
    }
}

const Home = () => createElement('p', { 'data-testid': 'home' }, 'Home page')
const Broken = () => {
    throw new Error('Sample render failure')
}

const ChunkMissing = () => {
    throw new TypeError('Failed to fetch dynamically imported module: https://app.example.test/assets/index-AbC123.js')
}

const buttonNamed = (container, name) => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === name)

describe('RouteErrorPage', () => {
    let root
    let router
    const originalLocation = window.location

    beforeEach(() => {
        // React and the router log the thrown error; the test expects it.
        jest.spyOn(console, 'error').mockImplementation(() => {})
        jest.spyOn(console, 'warn').mockImplementation(() => {})
        window.sessionStorage.clear()
        resetChunkReloadForTests()
    })

    afterEach(async () => {
        if (root) {
            await act(async () => {
                root.unmount()
            })
        }
        root = null
        router = null
        document.body.innerHTML = ''
        window.location = originalLocation
        jest.restoreAllMocks()
    })

    async function renderAt(entry) {
        router = createMemoryRouter(
            [
                {
                    path: '/',
                    element: createElement(Outlet),
                    errorElement: createElement(RouteErrorPage),
                    children: [
                        { index: true, element: createElement(Home) },
                        { path: 'broken', element: createElement(Broken) },
                        { path: 'chunk', element: createElement(ChunkMissing) }
                    ]
                }
            ],
            { initialEntries: [entry] }
        )
        const container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
        await act(async () => {
            root.render(createElement(RouterProvider, { router }))
        })
        return container
    }

    it('shows a friendly message with collapsible details when a child route throws', async () => {
        const container = await renderAt('/broken')
        expect(container.querySelector('[role="alert"]')).not.toBeNull()
        expect(container.textContent).toContain('Something went wrong')
        expect(buttonNamed(container, 'Reload')).toBeDefined()
        expect(buttonNamed(container, 'Go home')).toBeDefined()

        const toggle = buttonNamed(container, 'Show details')
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        await act(async () => {
            toggle.click()
        })
        expect(buttonNamed(container, 'Hide details').getAttribute('aria-expanded')).toBe('true')
        expect(container.querySelector('#route-error-details').textContent).toContain('Sample render failure')
    })

    it('reloads the page from Reload', async () => {
        const container = await renderAt('/broken')
        // jsdom cannot reload, so the location is swapped for this click only.
        const reload = jest.fn()
        delete window.location
        window.location = { reload }
        await act(async () => {
            buttonNamed(container, 'Reload').click()
        })
        window.location = originalLocation
        expect(reload).toHaveBeenCalledTimes(1)
    })

    it('reloads once by itself when a code chunk failed to load', async () => {
        const reload = jest.fn()
        delete window.location
        window.location = { reload }
        const container = await renderAt('/chunk')
        window.location = originalLocation
        expect(reload).toHaveBeenCalledTimes(1)
        expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).not.toBeNull()
        expect(container.textContent).toContain('Loading the latest version of this page')
        expect(container.querySelector('[role="alert"]')).toBeNull()
    })

    it('shows the error with a Reload button when the chunk still fails right after a reload', async () => {
        window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
        const reload = jest.fn()
        delete window.location
        window.location = { reload }
        const container = await renderAt('/chunk')
        window.location = originalLocation
        expect(reload).not.toHaveBeenCalled()
        expect(container.querySelector('[role="alert"]')).not.toBeNull()
        expect(container.textContent).toContain('The server may have just restarted or been updated')
        expect(buttonNamed(container, 'Reload')).toBeDefined()
    })

    it('goes to the home route from Go home and shows it', async () => {
        const container = await renderAt('/broken')
        await act(async () => {
            buttonNamed(container, 'Go home').click()
        })
        expect(router.state.location.pathname).toBe('/')
        expect(container.querySelector('[data-testid="home"]')).not.toBeNull()
        expect(container.querySelector('[role="alert"]')).toBeNull()
    })

    it('says the page was not found for an unknown path', async () => {
        const container = await renderAt('/no-such-page')
        expect(container.textContent).toContain('Page not found')
        expect(buttonNamed(container, 'Go home')).toBeDefined()
    })

    it('is the error element of the root route in the app entry', () => {
        const entry = fs.readFileSync(path.join(__dirname, '../index.jsx'), 'utf8')
        expect(entry).toContain("import RouteErrorPage from '@/routes/RouteErrorPage'")
        expect(entry).toMatch(/window\.addEventListener\('vite:preloadError', \(event\) => \{\s*reloadOnceForChunkError\(event\.payload\)/)
        expect(entry).toMatch(/createBrowserRouter\(\[\{ element: <AppShell \/>, errorElement: <RouteErrorPage \/>, children: routes \}\]/)
    })
})
