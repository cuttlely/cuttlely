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

    describe('when a code chunk failed to load', () => {
        const originalFetch = globalThis.fetch
        let reload

        beforeEach(() => {
            jest.useFakeTimers()
            reload = jest.fn()
            delete window.location
            window.location = { reload }
        })

        afterEach(() => {
            jest.useRealTimers()
            globalThis.fetch = originalFetch
        })

        const advance = async (ms) => {
            await act(async () => {
                await jest.advanceTimersByTimeAsync(ms)
            })
        }

        it('waits for the server to answer, then reloads once', async () => {
            // Down, then the start-up page, then up.
            globalThis.fetch = jest
                .fn()
                .mockRejectedValueOnce(new TypeError('Failed to fetch'))
                .mockResolvedValueOnce({ status: 503 })
                .mockResolvedValue({ status: 200 })
            const container = await renderAt('/chunk')
            expect(container.textContent).toContain('Loading the latest version of this page')
            expect(reload).not.toHaveBeenCalled()

            await advance(500)
            expect(reload).not.toHaveBeenCalled()
            expect(container.textContent).toContain('Loading the latest version of this page')

            await advance(1000)
            expect(reload).toHaveBeenCalledTimes(1)
            expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/ping', expect.objectContaining({ cache: 'no-store' }))
            expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).not.toBeNull()
            expect(container.querySelector('[role="alert"]')).toBeNull()

            await advance(120_000)
            expect(reload).toHaveBeenCalledTimes(1)
        })

        it('shows the error with a Reload button when the server does not answer within a minute', async () => {
            globalThis.fetch = jest.fn().mockResolvedValue({ status: 502 })
            const container = await renderAt('/chunk')
            await advance(59_000)
            expect(container.textContent).toContain('Loading the latest version of this page')
            expect(container.querySelector('[role="alert"]')).toBeNull()

            await advance(2_000)
            expect(reload).not.toHaveBeenCalled()
            expect(container.querySelector('[role="alert"]')).not.toBeNull()
            expect(container.textContent).toContain('The server may have just restarted or been updated')
            expect(buttonNamed(container, 'Reload')).toBeDefined()
            const pings = globalThis.fetch.mock.calls.length
            await advance(120_000)
            expect(globalThis.fetch.mock.calls.length).toBe(pings)
        })

        it('shows the error with a Reload button within a minute when pings never get an answer', async () => {
            globalThis.fetch = jest.fn(() => new Promise(() => {}))
            const container = await renderAt('/chunk')
            await advance(59_000)
            expect(container.textContent).toContain('Loading the latest version of this page')

            await advance(2_000)
            expect(reload).not.toHaveBeenCalled()
            expect(container.querySelector('[role="alert"]')).not.toBeNull()
            expect(buttonNamed(container, 'Reload')).toBeDefined()
        })

        it('shows the error with a Reload button at once when the page already reloaded in the last minute', async () => {
            window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
            globalThis.fetch = jest.fn().mockResolvedValue({ status: 200 })
            const container = await renderAt('/chunk')
            await advance(0)
            expect(globalThis.fetch).not.toHaveBeenCalled()
            expect(reload).not.toHaveBeenCalled()
            expect(container.querySelector('[role="alert"]')).not.toBeNull()
            expect(buttonNamed(container, 'Reload')).toBeDefined()
        })
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
        expect(entry).toMatch(/window\.addEventListener\('vite:preloadError', \(event\) => \{\s*waitForServerThenReload\(event\.payload\)/)
        expect(entry).toMatch(/createBrowserRouter\(\[\{ element: <AppShell \/>, errorElement: <RouteErrorPage \/>, children: routes \}\]/)
    })
})
