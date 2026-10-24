import { NextFunction, Request, Response } from 'express'
import { isRunRequest } from '../../settings/runs'

/** How long a client should wait before it tries a chat or prediction again. */
export const BOOT_RETRY_AFTER_SECONDS = 30
/** Default blocking wait for the boot compile, a few minutes. */
export const BOOT_PASS_DEFAULT_SECONDS = 180
/**
 * Hard cap on that wait. Render cancels a deploy that is not healthy within about 15 minutes.
 * The compile can keep going after this; it must not hold the deploy open.
 */
export const BOOT_PASS_CAP_SECONDS = 300

export const PROFILES_COMPILING = 'profiles compiling'
export const PROFILES_COMPILING_MESSAGE = 'Cuttlely is compiling agent profiles. Try again in a minute.'

export type BootPhase = 'idle' | 'running' | 'background' | 'incomplete' | 'done'

let phase: BootPhase = 'idle'

export function bootPassPhase(): BootPhase {
    return phase
}

/** The boot compile has started and has not finished or moved to the background. */
export function beginBootPass(): void {
    if (phase === 'running' || phase === 'background') return
    phase = 'running'
}

/** The blocking wait is over. The compile continues, and startup is no longer held. */
export function backgroundBootPass(): void {
    if (phase === 'running') phase = 'background'
}

/** The pass ended without a compile the runtime can load. Health stays down. */
export function markBootIncomplete(): void {
    phase = 'incomplete'
}

export function finishBootPass(): void {
    phase = 'done'
}

export function resetBootPass(): void {
    phase = 'idle'
}

/**
 * Render's health check (/api/v1/ping) stays 503 while the compile is the startup gate, and when the pass
 * did not finish. Once the wait cap is hit the compile continues in the background and ping may answer 200.
 */
export function bootPassBlocksPing(): boolean {
    return phase === 'running' || phase === 'incomplete'
}

/** Chat and prediction stay 503 until the compile has actually finished. */
export function bootPassBlocksRuns(): boolean {
    return phase === 'running' || phase === 'background' || phase === 'incomplete'
}

/** Seconds the boot compile may block startup. CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS, default 180, at most 300. */
export function bootPassCapMs(env: Record<string, string | undefined> = process.env): number {
    const raw = Number(env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS)
    const seconds = Number.isFinite(raw) && raw >= 0 ? raw : BOOT_PASS_DEFAULT_SECONDS
    return Math.min(seconds, BOOT_PASS_CAP_SECONDS) * 1000
}

/**
 * Express middleware on the API router: chat and prediction answer 503 with Retry-After while the boot
 * compile has not finished. Other routes, including the health check, are left to their own handlers.
 */
export function refuseRunsWhileBootPass(req: Request, res: Response, next: NextFunction): void {
    if (!bootPassBlocksRuns()) return next()
    const path = `${req.baseUrl || ''}${req.path || ''}` || (req.url || '').split('?')[0]
    if (!isRunRequest(req.method, path)) return next()
    res.setHeader('Retry-After', String(BOOT_RETRY_AFTER_SECONDS))
    res.status(503).json({
        statusCode: 503,
        success: false,
        message: PROFILES_COMPILING_MESSAGE,
        code: 'PROFILES_COMPILING'
    })
}
