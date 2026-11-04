import {
    CHUNK_RELOAD_KEY,
    CHUNK_RELOAD_WINDOW_MS,
    chunkReloadStarted,
    isChunkLoadError,
    pingServer,
    reloadOnceForChunkError,
    resetChunkReloadForTests,
    SERVER_WAIT_MS,
    waitForServerThenReload
} from './chunkReload'

const memoryStorage = () => {
    const values = new Map()
    return {
        getItem: (name) => (values.has(name) ? values.get(name) : null),
        setItem: (name, value) => values.set(name, String(value))
    }
}

const chromeError = new TypeError('Failed to fetch dynamically imported module: https://app.example.test/assets/index-AbC123.js')

describe('chunk reload', () => {
    beforeEach(() => resetChunkReloadForTests())

    it('recognizes chunk-load errors from each browser and from Vite', () => {
        expect(isChunkLoadError(chromeError)).toBe(true)
        expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://app.example.test/assets/a.js'))).toBe(
            true
        )
        expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
        expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/index-AbC123.css'))).toBe(true)
        expect(isChunkLoadError('Failed to fetch dynamically imported module: /assets/x.js')).toBe(true)
        expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false)
        expect(isChunkLoadError(undefined)).toBe(false)
        expect(isChunkLoadError({ status: 404 })).toBe(false)
    })

    it('reloads once for a chunk-load error and remembers when', () => {
        const storage = memoryStorage()
        const reload = jest.fn()
        expect(reloadOnceForChunkError(chromeError, { storage, reload, now: 1_000_000 })).toBe(true)
        expect(reload).toHaveBeenCalledTimes(1)
        expect(storage.getItem(CHUNK_RELOAD_KEY)).toBe('1000000')
        expect(chunkReloadStarted()).toBe(true)
        // The same page reporting the failure again (the Vite event, then the route) does not reload twice.
        expect(reloadOnceForChunkError(chromeError, { storage, reload, now: 1_000_001 })).toBe(false)
        expect(reload).toHaveBeenCalledTimes(1)
    })

    it('does not reload again after a recent reload, so a chunk that keeps failing cannot loop', () => {
        const storage = memoryStorage()
        storage.setItem(CHUNK_RELOAD_KEY, '1000000')
        const reload = jest.fn()
        expect(reloadOnceForChunkError(chromeError, { storage, reload, now: 1_000_000 + CHUNK_RELOAD_WINDOW_MS - 1 })).toBe(false)
        expect(reload).not.toHaveBeenCalled()
        expect(chunkReloadStarted()).toBe(false)
    })

    it('reloads again once the window has passed, for a later deploy or restart', () => {
        const storage = memoryStorage()
        storage.setItem(CHUNK_RELOAD_KEY, '1000000')
        const reload = jest.fn()
        expect(reloadOnceForChunkError(chromeError, { storage, reload, now: 1_000_000 + CHUNK_RELOAD_WINDOW_MS })).toBe(true)
        expect(reload).toHaveBeenCalledTimes(1)
    })

    it('leaves other errors to the error page', () => {
        const reload = jest.fn()
        expect(reloadOnceForChunkError(new Error('render failed'), { storage: memoryStorage(), reload })).toBe(false)
        expect(reload).not.toHaveBeenCalled()
    })

    it('never reloads when sessionStorage is missing or throws', () => {
        const reload = jest.fn()
        expect(reloadOnceForChunkError(chromeError, { storage: null, reload })).toBe(false)
        const blocked = {
            getItem: () => {
                throw new Error('storage is off')
            },
            setItem: () => {
                throw new Error('storage is off')
            }
        }
        expect(reloadOnceForChunkError(chromeError, { storage: blocked, reload })).toBe(false)
        const readOnly = { getItem: () => null, setItem: blocked.setItem }
        expect(reloadOnceForChunkError(chromeError, { storage: readOnly, reload })).toBe(false)
        expect(reload).not.toHaveBeenCalled()
    })

    describe('waiting for the server', () => {
        beforeEach(() => jest.useFakeTimers())
        afterEach(() => jest.useRealTimers())

        const clock = () => Date.now()

        it('pings with backoff and reloads once after the first answer', async () => {
            const storage = memoryStorage()
            const reload = jest.fn()
            const answers = [false, false, false, true]
            const ping = jest.fn(async () => answers.shift() ?? true)
            const started = Date.now()
            const result = waitForServerThenReload(chromeError, { storage, reload, ping, clock })
            // Both reporters (the Vite event and the error page) share one wait.
            expect(waitForServerThenReload(chromeError, { storage, reload, ping, clock })).toBe(result)
            await jest.advanceTimersByTimeAsync(500 + 1000 + 2000)
            await expect(result).resolves.toBe(true)
            expect(ping).toHaveBeenCalledTimes(4)
            expect(reload).toHaveBeenCalledTimes(1)
            expect(Number(storage.getItem(CHUNK_RELOAD_KEY))).toBe(started + 3500)
        })

        it('gives up after about a minute without reloading', async () => {
            const reload = jest.fn()
            const ping = jest.fn(async () => false)
            const result = waitForServerThenReload(chromeError, { storage: memoryStorage(), reload, ping, clock })
            await jest.advanceTimersByTimeAsync(SERVER_WAIT_MS)
            await expect(result).resolves.toBe(false)
            expect(reload).not.toHaveBeenCalled()
            expect(chunkReloadStarted()).toBe(false)
            const pings = ping.mock.calls.length
            expect(pings).toBeGreaterThan(5)
            expect(pings).toBeLessThan(20)
        })

        it('does not wait for other errors or after a recent reload', async () => {
            const ping = jest.fn(async () => true)
            await expect(waitForServerThenReload(new Error('render failed'), { ping })).resolves.toBe(false)
            const storage = memoryStorage()
            storage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
            await expect(waitForServerThenReload(chromeError, { storage, ping, clock, reload: jest.fn() })).resolves.toBe(false)
            expect(ping).not.toHaveBeenCalled()
        })

        it('counts only a 200 from /api/v1/ping, asked without the HTTP cache', async () => {
            const fetchImpl = jest.fn(async () => ({ status: 200 }))
            await expect(pingServer({ fetchImpl })).resolves.toBe(true)
            expect(fetchImpl).toHaveBeenCalledWith(
                '/api/v1/ping',
                expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' })
            )
            await expect(pingServer({ fetchImpl: async () => ({ status: 503 }) })).resolves.toBe(false)
            await expect(pingServer({ fetchImpl: async () => ({ status: 502 }) })).resolves.toBe(false)
            await expect(
                pingServer({
                    fetchImpl: async () => {
                        throw new TypeError('Failed to fetch')
                    }
                })
            ).resolves.toBe(false)
        })

        it('cancels a ping that gets no answer and counts it as down', async () => {
            let signal
            const fetchImpl = jest.fn((url, init) => {
                signal = init.signal
                return new Promise(() => {})
            })
            const result = pingServer({ fetchImpl, timeoutMs: 2000 })
            await jest.advanceTimersByTimeAsync(2000)
            await expect(result).resolves.toBe(false)
            expect(signal.aborted).toBe(true)
        })

        it('still gives up after about a minute when pings never answer', async () => {
            const reload = jest.fn()
            const fetchImpl = jest.fn(() => new Promise(() => {}))
            const ping = (options) => pingServer({ ...options, fetchImpl })
            const result = waitForServerThenReload(chromeError, { storage: memoryStorage(), reload, ping, clock })
            await jest.advanceTimersByTimeAsync(SERVER_WAIT_MS)
            await expect(result).resolves.toBe(false)
            expect(reload).not.toHaveBeenCalled()
        })
    })
})
