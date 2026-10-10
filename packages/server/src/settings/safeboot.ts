// Safe boot: when the settings file changed and two starts in a row did not finish, the last settings that
// worked come back. A start counts as finished when the server is listening (markStartFinished).
import fs from 'fs'
import path from 'path'
import { appendHistory, describeChanges } from './history'
import { LAST_GOOD_FILE, SETTINGS_FILE, readSettingsFile, writeFileAtomic } from './store'

export const BOOT_FILE = 'boot.json'
export const ROLLED_BACK_FILE = 'server.rolled-back.json'
export const MAX_FAILED_STARTS = 2

interface BootState {
    /** Starts that began and have not finished yet. */
    pending: number
    startedAt?: string
}

function readText(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

export function readBootState(dir: string): BootState {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, BOOT_FILE), 'utf8'))
        return { pending: Number.isFinite(parsed.pending) ? Number(parsed.pending) : 0, startedAt: parsed.startedAt }
    } catch {
        return { pending: 0 }
    }
}

function writeBootState(dir: string, state: BootState): void {
    writeFileAtomic(dir, BOOT_FILE, JSON.stringify(state) + '\n')
}

export interface BeginResult {
    rolledBack: boolean
    /** A plain-language line for the log (no values), when something happened. */
    message?: string
}

/**
 * Call once per start, before the file is applied. Rolls back when the file differs from the last good copy and
 * MAX_FAILED_STARTS starts in a row did not finish. Does nothing when there is no settings folder.
 */
export function beginStart(dir: string, key: string | null, now = new Date()): BeginResult {
    const settingsPath = path.join(dir, SETTINGS_FILE)
    if (!fs.existsSync(dir)) return { rolledBack: false }
    const state = readBootState(dir)
    let result: BeginResult = { rolledBack: false }
    const current = readText(settingsPath)
    const lastGood = readText(path.join(dir, LAST_GOOD_FILE))
    if (state.pending >= MAX_FAILED_STARTS && current !== null && current !== lastGood) {
        const before = readSettingsFile(dir, key).values
        writeFileAtomic(dir, ROLLED_BACK_FILE, current)
        if (lastGood !== null) writeFileAtomic(dir, SETTINGS_FILE, lastGood)
        else fs.rmSync(settingsPath, { force: true })
        const after = lastGood !== null ? readSettingsFile(dir, key).values : {}
        appendHistory(dir, {
            at: now.toISOString(),
            kind: 'rollback',
            by: 'safe boot',
            changes: describeChanges(before, after),
            note: `The last ${state.pending} starts did not finish, so the last settings that worked were restored.`,
            outcome: 'ok'
        })
        result = {
            rolledBack: true,
            message: `Server settings: the last ${state.pending} starts did not finish, so the last settings that worked were restored. The settings that did not start are kept in ${ROLLED_BACK_FILE}.`
        }
        state.pending = 0
    }
    writeBootState(dir, { pending: state.pending + 1, startedAt: now.toISOString() })
    return result
}

export type StartOutcome = 'finished' | 'stop' | 'stay'

/**
 * Decides what a start means for safe boot. A start that got ready makes the current file the last good copy.
 * A start that could not get ready (the database did not open, for example) never does: with settings that differ
 * from the last good copy it is 'stop' (exit, so the next start counts it and safe boot can roll back); with the
 * settings that last worked it is 'stay', the behavior from before server settings existed.
 */
export function finishStart(dir: string, ready: boolean): StartOutcome {
    if (ready) {
        markStartFinished(dir)
        return 'finished'
    }
    if (!fs.existsSync(dir)) return 'stay'
    const current = readText(path.join(dir, SETTINGS_FILE))
    const lastGood = readText(path.join(dir, LAST_GOOD_FILE))
    return current !== null && current !== lastGood ? 'stop' : 'stay'
}

/** The server is up: the current file becomes the last good copy and the failed-start count resets. */
export function markStartFinished(dir: string): void {
    if (!fs.existsSync(dir)) return
    const current = readText(path.join(dir, SETTINGS_FILE))
    if (current !== null) writeFileAtomic(dir, LAST_GOOD_FILE, current)
    else fs.rmSync(path.join(dir, LAST_GOOD_FILE), { force: true })
    writeBootState(dir, { pending: 0 })
}
