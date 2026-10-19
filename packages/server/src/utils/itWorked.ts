import fs from 'fs'
import path from 'path'
import logger from './logger'
import { IT_WORKED_DISABLE_ENV, IT_WORKED_URL } from './constants'
import { settingsDir, writeFileAtomic } from '../settings/store'
import { withSettingsLockSync } from '../settings/lock'

let loggedThisProcess = false
const MARKER_FILE = 'it-worked.json'

function isDisabled(env: Record<string, string | undefined> = process.env): boolean {
    return String(env[IT_WORKED_DISABLE_ENV] ?? '').trim() === 'true'
}

/**
 * Logs a one-line "It worked!" message the first time a flow run finishes successfully on this install.
 * - No telemetry, no network calls.
 * - Guarded in memory per process and persisted once in the settings folder, so it prints at most once.
 * - Respects CUTTLELY_DISABLE_IT_WORKED=true.
 */
export async function maybeLogFirstSuccess(): Promise<void> {
    if (loggedThisProcess) return
    if (isDisabled()) return
    try {
        const dir = settingsDir(process.env)
        const file = path.join(dir, MARKER_FILE)
        // Synchronous lock to avoid races among parallel requests in this process (and across processes on this host).
        withSettingsLockSync(dir, () => {
            let already = false
            try {
                const raw = fs.readFileSync(file, 'utf8')
                const parsed = JSON.parse(raw) as { shown?: boolean }
                already = parsed?.shown === true
            } catch {
                already = false
            }
            if (!already) {
                // Print the message once.
                logger.info(`⭐ It worked! If Cuttlely helped, a GitHub star helps others find it: ${IT_WORKED_URL}`)
                // Persist the marker so other processes will not print it again.
                writeFileAtomic(dir, MARKER_FILE, JSON.stringify({ shown: true }) + '\n')
                loggedThisProcess = true
            }
        })
    } catch {
        // Never fail a run over this. A quiet skip is fine.
    }
}

export { IT_WORKED_URL }
