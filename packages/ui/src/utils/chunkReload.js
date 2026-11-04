// A page left open across a deploy or a server restart can fail to load one of its code chunks:
// the file was replaced, or the server was not answering for a few seconds. The browser and
// React.lazy keep that failure for the life of the page, so every visit to the route fails again
// until a full reload. These helpers wait until /api/v1/ping answers, then reload the page once.
// A time stamp in sessionStorage stops a chunk that keeps failing from reloading the page over and over.

export const CHUNK_RELOAD_KEY = 'cuttlely:chunk-reload-at'
export const CHUNK_RELOAD_WINDOW_MS = 60_000
/** How long to wait for the server to answer before showing the error page instead. */
export const SERVER_WAIT_MS = 60_000
/** Waits between pings, the last one repeated. */
export const PING_BACKOFF_MS = [500, 1000, 2000, 3000, 5000]

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

const recentReload = (storage, now) => {
    const last = Number(storage.getItem(CHUNK_RELOAD_KEY))
    return last > 0 && last <= now && now - last < CHUNK_RELOAD_WINDOW_MS
}

/** True when a reload for a chunk-load error is allowed now: no reload in this tab in the last minute. */
export const chunkReloadAllowed = ({ storage = browserStorage(), now = Date.now() } = {}) => {
    if (reloadStarted || !storage) return false
    try {
        return !recentReload(storage, now)
    } catch {
        return false
    }
}

/** One ping, as the restart screen does it: only a 200 means the server is up. */
export const pingServer = async (fetchImpl = globalThis.fetch) => {
    try {
        const res = await fetchImpl('/api/v1/ping', { cache: 'no-store', credentials: 'same-origin' })
        return res.status === 200
    } catch {
        return false
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let pendingWait = null

/**
 * For a chunk-load error, pings the server with backoff for up to SERVER_WAIT_MS and reloads the page once
 * after a ping succeeds. Resolves true when it started a reload, and false when the error is not a chunk-load
 * error, a reload ran in the last minute, or the server did not answer in time. Calls made while a wait is
 * running share it, so the Vite event and the error page start one wait between them.
 */
export const waitForServerThenReload = (error, options = {}) => {
    if (!isChunkLoadError(error)) return Promise.resolve(false)
    if (pendingWait) return pendingWait
    const { ping = pingServer, clock = () => Date.now(), waitMs = SERVER_WAIT_MS } = options
    if (!chunkReloadAllowed({ storage: options.storage, now: clock() })) return Promise.resolve(false)
    const run = async () => {
        const started = clock()
        for (let attempt = 0; ; attempt += 1) {
            if (await ping()) return reloadOnceForChunkError(error, { ...options, now: clock() })
            const left = waitMs - (clock() - started)
            if (left <= 0) return false
            await sleep(Math.min(PING_BACKOFF_MS[Math.min(attempt, PING_BACKOFF_MS.length - 1)], left))
        }
    }
    pendingWait = run().finally(() => {
        pendingWait = null
    })
    return pendingWait
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
        if (recentReload(storage, now)) return false
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
    pendingWait = null
}
