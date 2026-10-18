// Runs in progress, for Restart and for shutdown: chat predictions and agent team runs are counted while their request
// is open. Before a restart the owner can let them finish, up to the turn time limit; while Cuttlely waits, new runs
// get a short "restarting" answer instead of starting and being cut off. A shutdown (SIGTERM or SIGINT, as hosts send
// on every deploy) does the same for every request: see shutdownDrain.
import type { Server } from 'http'
import { NextFunction, Request, Response } from 'express'
import { runtimeNumber } from './runtime'

// Case-insensitive, as Express routing is. POST .../runs/async is a harness run too.
const HARNESS_RUN_PATH = /^\/api\/v1\/harnesses\/[^/]+\/runs(\/async)?\/?$/i
const RUN_PATHS = [/^\/api\/v1\/prediction(\/|$)/i, /^\/api\/v1\/internal-prediction(\/|$)/i, HARNESS_RUN_PATH]
export const DEFAULT_WAIT_MS = 45000
/** How long a shutdown lets requests and streams finish: inside a host's usual 30-second grace period. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 25000
export const SHUTDOWN_RETRY_AFTER_SECONDS = 30
const SHUTDOWN_MESSAGE = 'Cuttlely is restarting. Try again in a minute.'
const SHUTDOWN_CODE = 'UNAVAILABLE'

let inProgress = 0
let backgroundRuns = 0
let draining = false
let shuttingDown = false
// Each open run, and whether it is a harness run (its stream error event carries { message }).
const openRuns = new Map<Response, boolean>()

export function isRunRequest(method: string, path: string): boolean {
    const collapsed = path.replace(/\/{2,}/g, '/')
    return method === 'POST' && RUN_PATHS.some((pattern) => pattern.test(collapsed))
}

function isHarnessRun(path: string): boolean {
    return HARNESS_RUN_PATH.test(path.replace(/\/{2,}/g, '/'))
}

export function runsInProgress(): number {
    return inProgress
}

export function isDraining(): boolean {
    return draining
}

export function isShuttingDown(): boolean {
    return shuttingDown
}

/**
 * How long a shutdown waits for open requests.
 * CUTTLELY_DRAIN_TIMEOUT_MS, default 25 seconds, from 0 to 5 minutes. 0 does not wait.
 * A saved value applies without a restart. A queue worker sees it within 5 seconds.
 */
export function drainTimeoutMs(env: Record<string, string | undefined> = process.env): number {
    return runtimeNumber('CUTTLELY_DRAIN_TIMEOUT_MS', env)
}

/** The turn time limit, which is also the longest Restart waits for runs to finish. */
export function waitLimitMs(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.CUTTLELY_HARNESS_TURN_BUDGET_MS)
    return Number.isFinite(value) && value > 0 ? Math.min(value, 10 * 60 * 1000) : DEFAULT_WAIT_MS
}

/**
 * Express middleware, mounted before sign-in checks: while the server shuts down, every new request gets 503 with
 * Retry-After, the health check (/api/v1/ping) included, so a load balancer stops sending traffic here.
 */
export function refuseWhileShuttingDown(_req: Request, res: Response, next: NextFunction): void {
    if (!shuttingDown) return next()
    res.setHeader('Retry-After', String(SHUTDOWN_RETRY_AFTER_SECONDS))
    res.setHeader('Connection', 'close')
    res.status(503).json({ statusCode: 503, success: false, message: SHUTDOWN_MESSAGE, code: SHUTDOWN_CODE })
}

/**
 * The path the router matched. sanitizeMiddleware decodes req.url before routing, so `/api/v1/%70rediction` runs the
 * prediction route while req.originalUrl still holds the encoded text; Express also routes `/api/v1//prediction`.
 */
function routedPath(req: Request): string {
    return `${req.baseUrl || ''}${req.path || ''}` || (req.url || '').split('?')[0]
}

/** Express middleware: counts run requests, and turns new ones away while a restart waits. */
export function trackRuns(req: Request, res: Response, next: NextFunction): void {
    // req.originalUrl is the raw URL. Express routes on req.url, which sanitizeMiddleware has already decoded.
    const path = routedPath(req)
    if (!isRunRequest(req.method, path)) return next()
    if (draining) {
        res.setHeader('Retry-After', '30')
        res.status(503).json({ message: 'Cuttlely is restarting to apply new settings. Try again in a minute.' })
        return
    }
    inProgress += 1
    openRuns.set(res, isHarnessRun(path))
    let done = false
    const finish = () => {
        if (done) return
        done = true
        inProgress = Math.max(0, inProgress - 1)
        openRuns.delete(res)
    }
    res.once('finish', finish)
    res.once('close', finish)
    next()
}

/**
 * A run that keeps going after its request has answered, such as a harness run started with POST .../runs/async.
 * It counts as in progress until it settles, so Restart and shutdown wait for it like an open request.
 */
export function trackBackgroundRun<T>(run: Promise<T>): Promise<T> {
    inProgress += 1
    backgroundRuns += 1
    const settle = () => {
        inProgress = Math.max(0, inProgress - 1)
        backgroundRuns = Math.max(0, backgroundRuns - 1)
    }
    return run.then(
        (value) => {
            settle()
            return value
        },
        (error) => {
            settle()
            throw error
        }
    )
}

/** Stops new runs and waits for the ones in progress, up to limitMs. Resolves with how many were still running. */
export async function drainRuns(limitMs: number, pollMs = 250): Promise<number> {
    draining = true
    const until = Date.now() + limitMs
    while (inProgress > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, pollMs))
    return inProgress
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Ends a run that is still open when the drain time is up. A stream gets an error event (status 503, code
 * UNAVAILABLE) and ends; a run that has not answered yet gets 503 with Retry-After. The socket is then closed, so a
 * late write from the run goes nowhere.
 */
function endRun(res: Response, harness: boolean): void {
    if (res.writableEnded) return
    try {
        if (!res.headersSent) {
            res.setHeader('Retry-After', String(SHUTDOWN_RETRY_AFTER_SECONDS))
            res.setHeader('Connection', 'close')
            res.status(503).json({ statusCode: 503, success: false, message: SHUTDOWN_MESSAGE, code: SHUTDOWN_CODE })
        } else {
            if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) {
                const data = harness ? { message: SHUTDOWN_MESSAGE } : SHUTDOWN_MESSAGE
                res.write(`message:\ndata:${JSON.stringify({ event: 'error', data, status: 503, code: SHUTDOWN_CODE })}\n\n`)
                res.write(`message:\ndata:${JSON.stringify({ event: 'end', data: '[DONE]' })}\n\n`)
            }
            res.end()
        }
    } catch {
        // The client is already gone.
    }
}

export interface ShutdownDrainResult {
    /** Runs still open when the drain time was up; they were ended with a 503 or an error event. */
    endedRuns: number
    /** True when every connection closed by itself before the time was up. */
    closedInTime: boolean
}

/**
 * Graceful shutdown: new requests get 503 with Retry-After (the health check too), the server stops accepting
 * connections, and requests, streams, and background runs already running may finish for up to limitMs. Runs still open after that
 * end with a 503 or an error event, their model calls are aborted through the client abort signal, and the
 * remaining connections are closed. Resolves when the server is closed.
 */
export async function shutdownDrain(server: Server | undefined, limitMs: number, pollMs = 100): Promise<ShutdownDrainResult> {
    shuttingDown = true
    draining = true
    let closed = !server || !server.listening
    const whenClosed = closed
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
              server!.close(() => {
                  closed = true
                  resolve()
              })
          )
    const until = Date.now() + limitMs
    while ((!closed || backgroundRuns > 0) && Date.now() < until) {
        // Keep-alive connections that finished their request would hold the server open: close them as they go idle.
        server?.closeIdleConnections?.()
        await sleep(pollMs)
    }
    const endedRuns = openRuns.size
    const closedInTime = closed
    if (!closed) {
        for (const [res, harness] of Array.from(openRuns)) endRun(res, harness)
        // Loaded here so the commands that read drainTimeoutMs do not load the model libraries.
        const { abortClientRequests } = await import('../utils/clientAbort')
        abortClientRequests(new Error('Cuttlely is shutting down'))
        // Let the last events reach the client, then drop whatever is left.
        await sleep(Math.min(250, pollMs * 2))
        server?.closeAllConnections?.()
        await Promise.race([whenClosed, sleep(1000)])
    }
    return { endedRuns, closedInTime }
}

/** Tests only. */
export function resetRuns(): void {
    inProgress = 0
    backgroundRuns = 0
    draining = false
    shuttingDown = false
    openRuns.clear()
}
