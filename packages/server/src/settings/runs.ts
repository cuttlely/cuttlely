// Runs in progress, for Restart: chat predictions and agent team runs are counted while their request is open.
// Before a restart the owner can let them finish, up to the turn time limit; while Cuttlely waits, new runs get a
// short "restarting" answer instead of starting and being cut off.
import { NextFunction, Request, Response } from 'express'

const RUN_PATHS = [/^\/api\/v1\/prediction(\/|$)/, /^\/api\/v1\/internal-prediction(\/|$)/, /^\/api\/v1\/harnesses\/[^/]+\/runs\/?$/]
export const DEFAULT_WAIT_MS = 45000

let inProgress = 0
let draining = false

export function isRunRequest(method: string, path: string): boolean {
    return method === 'POST' && RUN_PATHS.some((pattern) => pattern.test(path))
}

export function runsInProgress(): number {
    return inProgress
}

export function isDraining(): boolean {
    return draining
}

/** The turn time limit, which is also the longest Restart waits for runs to finish. */
export function waitLimitMs(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.CUTTLELY_HARNESS_TURN_BUDGET_MS)
    return Number.isFinite(value) && value > 0 ? Math.min(value, 10 * 60 * 1000) : DEFAULT_WAIT_MS
}

/** Express middleware: counts run requests, and turns new ones away while a restart waits. */
export function trackRuns(req: Request, res: Response, next: NextFunction): void {
    const path = (req.originalUrl || req.url || '').split('?')[0]
    if (!isRunRequest(req.method, path)) return next()
    if (draining) {
        res.setHeader('Retry-After', '30')
        res.status(503).json({ message: 'Cuttlely is restarting to apply new settings. Try again in a minute.' })
        return
    }
    inProgress += 1
    let done = false
    const finish = () => {
        if (done) return
        done = true
        inProgress = Math.max(0, inProgress - 1)
    }
    res.once('finish', finish)
    res.once('close', finish)
    next()
}

/** Stops new runs and waits for the ones in progress, up to limitMs. Resolves with how many were still running. */
export async function drainRuns(limitMs: number, pollMs = 250): Promise<number> {
    draining = true
    const until = Date.now() + limitMs
    while (inProgress > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, pollMs))
    return inProgress
}

/** Tests only. */
export function resetRuns(): void {
    inProgress = 0
    draining = false
}
