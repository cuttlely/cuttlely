import {
    CHUNK_RELOAD_KEY,
    CHUNK_RELOAD_WINDOW_MS,
    chunkReloadStarted,
    isChunkLoadError,
    reloadOnceForChunkError,
    resetChunkReloadForTests
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
})
