// Restart in place. The start script (scripts/start-cuttlely.sh) exports CUTTLELY_SUPERVISED=1 and starts the server
// again when it exits with RESTART_EXIT_CODE. Without the script, the page shows how to restart by hand.
export const RESTART_EXIT_CODE = 75
// A start that could not get ready with changed server settings exits with this code, so the start script starts it
// again and safe boot can count it (after two, the last settings that worked come back).
export const SETTINGS_FAILED_EXIT_CODE = 76
export const SUPERVISED_VAR = 'CUTTLELY_SUPERVISED'

type Env = Record<string, string | undefined>
type Handler = () => Promise<void>

let handler: Handler | null = null
let requested = false

export function restartInPlaceAvailable(env: Env = process.env): boolean {
    return env[SUPERVISED_VAR] === '1'
}

/** The start command registers how to stop cleanly and exit with RESTART_EXIT_CODE. */
export function setRestartHandler(next: Handler | null): void {
    handler = next
}

export function restartRequested(): boolean {
    return requested
}

/**
 * Stops the server and exits so the start script starts it again. Returns false when restart in place is not
 * available. delayMs lets the HTTP answer reach the browser first.
 */
export function requestRestart(options: { env?: Env; delayMs?: number; before?: () => Promise<unknown> } = {}): boolean {
    if (!restartInPlaceAvailable(options.env) || !handler || requested) return false
    requested = true
    const run = handler
    const before = options.before
    setTimeout(() => {
        // before: for example, let runs in progress finish. A failure there never blocks the restart.
        Promise.resolve(before ? before().catch(() => undefined) : undefined)
            .then(() => run())
            .catch(() => process.exit(RESTART_EXIT_CODE))
    }, options.delayMs ?? 300).unref()
    return true
}

/** Tests only. */
export function resetRestartRequest(): void {
    requested = false
}
