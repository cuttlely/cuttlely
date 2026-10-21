import fs from 'fs'
import path from 'path'
import { settingsDir, writeFileAtomic } from '../settings/store'
import { tryNamedLockSync } from '../settings/lock'

let loggedThisProcess = false
const MARKER_FILE = 'it-worked.json'
const LOCK_FILE = '.it-worked.lock'
const IT_WORKED_DISABLE_ENV = 'CUTTLELY_DISABLE_IT_WORKED'
export const IT_WORKED_URL = 'https://github.com/cuttlely/cuttlely'

function isDisabled(env: Record<string, string | undefined> = process.env): boolean {
    return String(env[IT_WORKED_DISABLE_ENV] ?? '').trim() === 'true'
}

function markerShown(file: string): boolean {
    try {
        const raw = fs.readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw) as { shown?: boolean }
        return parsed?.shown === true
    } catch {
        return false
    }
}

/**
 * Logs a one-line "It worked!" message the first time a flow run finishes successfully on this install.
 * - No telemetry, no network calls.
 * - Cheap unlocked read first; lock only to write the marker, and skip immediately if the lock is held.
 * - Guarded in memory per process and persisted once in the settings folder, so it prints at most once.
 * - Respects CUTTLELY_DISABLE_IT_WORKED=true.
 */
export function maybeLogFirstSuccess(): void {
    if (loggedThisProcess) return
    if (isDisabled()) return
    try {
        const dir = settingsDir(process.env)
        const file = path.join(dir, MARKER_FILE)
        if (markerShown(file)) {
            loggedThisProcess = true
            return
        }
        // Own lock file so this never waits on (or holds) the settings lock. Skip immediately if busy.
        tryNamedLockSync(dir, LOCK_FILE, () => {
            if (markerShown(file)) {
                loggedThisProcess = true
                return
            }
            try {
                writeFileAtomic(dir, MARKER_FILE, JSON.stringify({ shown: true }) + '\n')
            } catch {
                // Persist failed. Skip the log so a later success cannot repeat it.
                loggedThisProcess = true
                return
            }
            if (!markerShown(file)) {
                loggedThisProcess = true
                return
            }
            console.info(`⭐ It worked! If Cuttlely helped, a GitHub star helps others find it: ${IT_WORKED_URL}`)
            loggedThisProcess = true
        })
    } catch {
        // Never fail a run over this. A quiet skip is fine.
    }
}

/** Fire-and-forget wrapper so a successful run never waits on the prompt. The marker is written after this returns. */
export function notifyFirstSuccess(): void {
    try {
        setImmediate(() => {
            try {
                maybeLogFirstSuccess()
            } catch {
                // never fail the run on this
            }
        })
    } catch {
        // never fail the run on this
    }
}
