// Applies the admin settings file to the environment at start, before any other server module reads it.
// The host always wins. When the start script already applied the file (CUTTLELY_SETTINGS_APPLIED=1), only the record is kept.
import { HOST_KEYS_VAR, hostSetKeys, fileValuesToApply } from './resolve'
import { bindRuntimeSource } from './runtime'
import fs from 'fs'
import path from 'path'
import { beginStart } from './safeboot'
import { SETTINGS_FILE, encryptionKeySync, readSettingsFile, settingsDir } from './store'

type Env = Record<string, string | undefined>

export const IGNORE_VAR = 'CUTTLELY_IGNORE_ADMIN_SETTINGS'
export const APPLIED_VAR = 'CUTTLELY_SETTINGS_APPLIED'
/** Set by the start script's helper when its safe boot put back the last good settings for this start ('1'), else empty. */
export const ROLLED_BACK_VAR = 'CUTTLELY_SETTINGS_ROLLED_BACK'

export interface StartState {
    dir: string
    ignored: boolean
    byStartScript: boolean
    hostKeys: string[]
    /** Values the file held at start (secrets included, never sent to a browser). */
    atStart: Record<string, string>
    /** Keys this start applied from the file. */
    applied: string[]
    unreadable: string[]
    problems: string[]
    /** The settings file text at start (null when there was none), so Discard can put it back exactly. Never sent to a browser. */
    rawAtStart?: string | null
    /** Safe boot restored the last good settings on this start. */
    rolledBack?: boolean
}

export function isOnValue(value: string | undefined): boolean {
    return ['1', 'true', 'yes', 'on'].includes(
        String(value ?? '')
            .trim()
            .toLowerCase()
    )
}

/** start: this is a server start (not a CLI command), so it counts toward safe boot unless the start script already counted it. */
function readRaw(dir: string): string | null {
    try {
        return fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')
    } catch {
        return null
    }
}

export function applyAdminSettings(env: Env = process.env, options: { start?: boolean } = {}): StartState {
    const dir = settingsDir(env)
    const state: StartState = {
        dir,
        ignored: false,
        byStartScript: false,
        hostKeys: [],
        atStart: {},
        applied: [],
        unreadable: [],
        problems: []
    }
    if (isOnValue(env[IGNORE_VAR])) {
        state.ignored = true
        state.hostKeys = [...hostSetKeys(env)]
        return state
    }
    state.byStartScript = env[APPLIED_VAR] === '1'
    const hostKeys = hostSetKeys(env)
    state.hostKeys = [...hostKeys]
    const key = encryptionKeySync(env)
    // The start script runs safe boot itself (env-cli.ts) and says whether it rolled back, so the safe boot banner and
    // the restart screen's failure state show on Docker, Render and the start script too, not only on a plain start.
    if (state.byStartScript) state.rolledBack = env[ROLLED_BACK_VAR] === '1'
    if (options.start && !state.byStartScript) {
        const boot = beginStart(dir, key)
        state.rolledBack = boot.rolledBack
        if (boot.message) state.problems.push(boot.message)
    }
    const read = readSettingsFile(dir, key)
    state.rawAtStart = readRaw(dir)
    state.atStart = read.values
    state.unreadable = read.unreadable
    state.problems = [...state.problems, ...read.problems]
    const toApply = fileValuesToApply(env, read.values, hostKeys)
    state.applied = Object.keys(toApply)
    if (!state.byStartScript) {
        for (const [key, value] of Object.entries(toApply)) env[key] = value
        if (env[HOST_KEYS_VAR] === undefined) env[HOST_KEYS_VAR] = state.hostKeys.join(',')
    }
    if (env === process.env) bindRuntimeSource(state.dir, state.hostKeys)
    return state
}
