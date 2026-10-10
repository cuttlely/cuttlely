import { AsyncLocalStorage } from 'async_hooks'
import { Request, Response } from 'express'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'

// LangChain falls back to a no-op store until something initializes it (importing `@langchain/core/context` does,
// but nodes load lazily). Initializing here is idempotent and makes `runWithAbortSignal` work from the first request.
AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage())

const CLIENT_ABORT_KEY = 'clientAbortSignal'
// Requests whose work is still running, so a shutdown can abort their model calls (abortClientRequests).
const openControllers = new Set<AbortController>()

/**
 * Returns a signal that aborts when the client disconnects before the response is complete (the response's
 * `close` fires while `writableFinished` is still false). A normal end never aborts it. The signal is also kept on
 * `res.locals`, so code further down the request (`utilBuildChatflow`) can find it with `getClientAbortSignal`.
 */
export const watchClientDisconnect = (res: Response): AbortSignal => {
    const existing = res.locals?.[CLIENT_ABORT_KEY] as AbortSignal | undefined
    if (existing) return existing
    const controller = new AbortController()
    openControllers.add(controller)
    res.once('close', () => {
        openControllers.delete(controller)
        if (!res.writableFinished) controller.abort(new Error('Client disconnected'))
    })
    res.locals[CLIENT_ABORT_KEY] = controller.signal
    return controller.signal
}

/** Aborts the work of every request still being answered, as if each client had disconnected. Used at shutdown. */
export const abortClientRequests = (reason: Error): number => {
    const open = Array.from(openControllers)
    openControllers.clear()
    for (const controller of open) controller.abort(reason)
    return open.length
}

/** The signal set by `watchClientDisconnect` for this request, if any. */
export const getClientAbortSignal = (req: Request): AbortSignal | undefined =>
    req.res?.locals?.[CLIENT_ABORT_KEY] as AbortSignal | undefined

/**
 * Calls `onAbort` once when `signal` aborts (right away if it already has). Returns a function that removes the
 * listener; call it when the work is done so a later disconnect does nothing.
 */
export const onAbort = (signal: AbortSignal | undefined, handler: () => void): (() => void) => {
    if (!signal) return () => {}
    if (signal.aborted) {
        handler()
        return () => {}
    }
    signal.addEventListener('abort', handler, { once: true })
    return () => signal.removeEventListener('abort', handler)
}

/**
 * Runs `fn` with `signal` as the implicit LangChain run config. Every LangChain runnable called inside (chains,
 * retrievers, chat models) merges the implicit config in `ensureConfig`, and chat models pass the signal to the
 * provider request and stop reading the stream once it aborts. Node code that sets its own `signal` keeps it.
 */
export const runWithAbortSignal = <T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> => {
    if (!signal) return fn()
    return AsyncLocalStorageProviderSingleton.runWithConfig({ signal }, fn) as Promise<T>
}
