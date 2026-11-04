// A page left open across a deploy or a server restart can fail to load one of its code chunks:
// the file was replaced, or the server was not answering for a few seconds. The browser and
// React.lazy keep that failure for the life of the page, so every visit to the route fails again
// until a full reload. These helpers reload the page once, and a time stamp in sessionStorage
// stops a chunk that keeps failing from reloading the page over and over.

export const CHUNK_RELOAD_KEY = 'cuttlely:chunk-reload-at'
export const CHUNK_RELOAD_WINDOW_MS = 60_000

// Chrome and Edge, Firefox, Safari, and Vite's CSS preload.
const CHUNK_ERROR_PATTERNS = [
    /Failed to fetch dynamically imported module/i,
    /error loading dynamically imported module/i,
    /Importing a module script failed/i,
    /Unable to preload CSS/i
]

let reloadStarted = false

export const isChunkLoadError = (error) => {
    const message = typeof error === 'string' ? error : error?.message
    return typeof message === 'string' && CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

/** True once this page has asked for a reload, so a second report of the same failure does not show an error. */
export const chunkReloadStarted = () => reloadStarted

const browserStorage = () => {
    try {
        return window.sessionStorage
    } catch {
        return null
    }
}

/**
 * Reloads the page for a chunk-load error, at most once per CHUNK_RELOAD_WINDOW_MS in this tab.
 * Returns true when it started a reload. Without sessionStorage it never reloads, so it cannot loop.
 */
export const reloadOnceForChunkError = (
    error,
    { storage = browserStorage(), reload = () => window.location.reload(), now = Date.now() } = {}
) => {
    if (reloadStarted || !isChunkLoadError(error) || !storage) return false
    try {
        const last = Number(storage.getItem(CHUNK_RELOAD_KEY))
        if (last > 0 && last <= now && now - last < CHUNK_RELOAD_WINDOW_MS) return false
        storage.setItem(CHUNK_RELOAD_KEY, String(now))
    } catch {
        return false
    }
    reloadStarted = true
    reload()
    return true
}

/** For tests only. */
export const resetChunkReloadForTests = () => {
    reloadStarted = false
}
