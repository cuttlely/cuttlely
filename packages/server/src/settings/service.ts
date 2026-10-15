// What the Server settings page reads and writes. Owner only (routes/server-settings). Secret values never leave
// the server: a secret is shown as set or not set. A runtime limit applies on the next use. Every other change
// applies at the next start.
import fs from 'fs'
import path from 'path'
import { StartState } from './apply'
import {
    DatabaseSummary,
    describeDatabase,
    effectiveValues as effectiveOf,
    previousDatabaseSummary,
    DATABASE_KEYS
} from './database-summary'
import { AUTHKIT_KEYS, authKitComplete, authKitEnvironment, authKitTested, readAuthKitProof } from './authkit-proof'
import { HistoryEntry, appendHistory, describeChanges, readHistory } from './history'
import { KEPT_OUT, SECTIONS, SETTINGS, SettingDef, isKeptOut, settingFor } from './registry'
import { ResolvedSetting, effectiveValue, isBlank, resolveSettings } from './resolve'
import { runtimeConflict, runtimeSnapshot } from './runtime'
import { requestRestart, restartInPlaceAvailable } from './restart'
import { ROLLED_BACK_FILE } from './safeboot'
import { drainRuns, runsInProgress, waitLimitMs } from './runs'
import { SETTINGS_FILE, readSettingsFile, readStoredValues, writeFileAtomic, writeSettingsFile } from './store'
import { checkValue } from './validate'

type Env = Record<string, string | undefined>

export interface ServiceDeps {
    env: Env
    state: StartState
    /** The credential encryption key (created if missing). */
    key: () => Promise<string>
}

export type InstallKind = 'docker' | 'render' | 'source'

export interface SettingView extends Omit<SettingDef, 'defaultValue'> {
    defaultValue?: string
    source: ResolvedSetting['source'] | 'panel'
    /** Whole-number bounds for a runtime limit. */
    range?: { min: number; max: number }
    locked: boolean
    /** Plain settings: the saved or host value ('' when the default applies). Never present for secrets. */
    value?: string
    /** Plain settings: the value the server is running with. */
    running?: string
    secret?: { set: boolean; unreadable: boolean }
    /** Saved, and different from what the server started with: applies at the next restart. */
    changed: boolean
    /** The value the server behaves as if it had (plain settings only), for conditions. */
    effective?: string
}

export interface SettingsView {
    sections: typeof SECTIONS
    settings: SettingView[]
    keptOut: { group: string; why: string; keys: string[] }[]
    file: { exists: boolean; folder: string; updatedAt?: string; updatedBy?: string; problems: string[] }
    /** workers: queue mode, where each worker has to restart too. */
    restart: { inPlace: boolean; install: InstallKind; changed: string[]; steps: string[]; workers: boolean }
    ignored: boolean
    rolledBack: boolean
    /** Safe boot kept the settings that did not start: Try it again puts them back. */
    retryAvailable: boolean
    /** Chat and agent team runs in progress now, and how long Restart waits for them at most. */
    runs: { inProgress: number; waitSeconds: number }
    /** AuthKit as saved: complete or not, Staging or Production, and whether a test sign-in passed with these values. */
    authKit: { complete: boolean; environment: 'staging' | 'production' | 'unknown'; tested: boolean; testedAt?: string; locked: boolean }
    /** The database now, after a restart, and the previous one kept by Switch database. */
    database: { running: DatabaseSummary; saved: DatabaseSummary; previous: DatabaseSummary | null; locked: boolean }
}

export class SettingsError extends Error {
    key?: string
    reason?: string
    min?: number
    max?: number
    constructor(
        public status: number,
        public code: string,
        message: string,
        public errors: { key: string; message: string }[] = [],
        detail?: { key?: string; reason?: string; min?: number; max?: number }
    ) {
        super(message)
        this.key = detail?.key
        this.reason = detail?.reason
        this.min = detail?.min
        this.max = detail?.max
    }
}

export function installKind(env: Env): InstallKind {
    if ((env.RENDER ?? '').trim()) return 'render'
    if (env.CUTTLELY_INSTALL === 'docker') return 'docker'
    return 'source'
}

/** Queue mode: workers read the settings too, so each one restarts as well. */
export function queueMode(env: Env): boolean {
    return (env.MODE ?? '').trim().toLowerCase() === 'queue'
}

export const WORKERS_STEP = 'Cuttlely runs in queue mode: restart each worker too, so it uses the new settings.'

export function restartSteps(env: Env): string[] {
    const steps = installSteps(env)
    return queueMode(env) ? [...steps, WORKERS_STEP] : steps
}

function installSteps(env: Env): string[] {
    switch (installKind(env)) {
        case 'docker':
            return ['On the host, run: docker compose restart cuttlely']
        case 'render':
            return ['In the Render dashboard, open this service and choose Manual Deploy, then Restart service.']
        default:
            return [
                'Stop Cuttlely (Ctrl+C in its terminal), then start it again the way you started it.',
                'bash scripts/start-cuttlely.sh restarts by itself next time.'
            ]
    }
}

async function readSaved(deps: ServiceDeps) {
    const key = await deps.key()
    return { ...readSettingsFile(deps.state.dir, key), key }
}

function changedKeys(saved: Record<string, string>, atStart: Record<string, string>, unreadable: string[]): string[] {
    const keys = new Set([...Object.keys(saved), ...Object.keys(atStart)])
    return [...keys].filter((key) => (saved[key] ?? '') !== (atStart[key] ?? '') && !unreadable.includes(key)).sort()
}

export async function getView(deps: ServiceDeps): Promise<SettingsView> {
    const { env, state } = deps
    const read = await readSaved(deps)
    const hostKeys = new Set(state.hostKeys)
    const resolved = resolveSettings({ env, hostKeys, file: read.values })
    const atStartResolved = resolveSettings({ env, hostKeys, file: state.ignored ? {} : state.atStart })
    const changed = changedKeys(read.values, state.atStart, read.unreadable).filter(
        (key) => !hostKeys.has(key) && !settingFor(key)?.runtime
    )
    const live = runtimeSnapshot(env)
    const settings: SettingView[] = SETTINGS.map((setting, index) => {
        const row = resolved[index]
        const locked = row.source === 'host'
        const view: SettingView = { ...setting, source: row.source, locked, changed: changed.includes(setting.key) }
        if (setting.type === 'secret') {
            view.secret = {
                set: row.value !== '' || (read.unreadable.includes(setting.key) && !locked),
                unreadable: read.unreadable.includes(setting.key) && !locked
            }
        } else {
            view.value = row.value
            view.running = atStartResolved[index].value
            view.effective = effectiveValue(row)
        }
        if (setting.runtime) {
            const picked = live.get(setting.key)
            if (picked) {
                const shown = picked.source === 'default' ? '' : String(picked.value)
                view.source = picked.source
                view.locked = hostKeys.has(setting.key) && !isBlank(env[setting.key])
                view.changed = false
                const cap = setting.key === 'CUTTLELY_CHECK_COUNT_DEFAULT' ? live.get('CUTTLELY_CHECK_COUNT_MAX') : undefined
                view.range = { min: setting.min ?? 0, max: cap ? cap.value : setting.max ?? 0 }
                view.value = shown
                view.running = shown
                view.effective = String(picked.value)
            }
        }
        return view
    })
    return {
        sections: SECTIONS,
        settings,
        keptOut: KEPT_OUT.map((group) => ({ group: group.group, why: group.why, keys: [...group.keys] })),
        file: {
            exists: read.exists,
            folder: state.dir,
            updatedAt: read.updatedAt,
            updatedBy: read.updatedBy,
            problems: [...new Set([...state.problems, ...read.problems])]
        },
        restart: {
            inPlace: restartInPlaceAvailable(env),
            install: installKind(env),
            changed,
            steps: restartSteps(env),
            workers: queueMode(env)
        },
        ignored: state.ignored,
        rolledBack: Boolean(state.rolledBack),
        retryAvailable: fs.existsSync(path.join(state.dir, ROLLED_BACK_FILE)),
        runs: { inProgress: runsInProgress(), waitSeconds: Math.round(waitLimitMs(env) / 1000) },
        authKit: authKitView(state.dir, resolved, hostKeys, read.key),
        database: {
            running: describeDatabase(effectiveOf(env, hostKeys, state.ignored ? {} : state.atStart)),
            saved: describeDatabase(effectiveOf(env, hostKeys, read.values)),
            previous: previousDatabaseSummary(state.dir, read.key, env, hostKeys),
            locked: DATABASE_KEYS.some((name) => hostKeys.has(name))
        }
    }
}

function authKitView(dir: string, resolved: ResolvedSetting[], hostKeys: Set<string>, key: string): SettingsView['authKit'] {
    const values = Object.fromEntries(resolved.map((row) => [row.key, row.value]))
    const tested = authKitTested(dir, values, key)
    return {
        complete: authKitComplete(values),
        environment: authKitEnvironment(values.WORKOS_API_KEY),
        tested,
        testedAt: tested ? readAuthKitProof(dir)?.passedAt : undefined,
        locked: AUTHKIT_KEYS.every((name) => hostKeys.has(name))
    }
}

/** True when the values leave at least one way to sign in. */
export function hasWayIn(env: Env, hostKeys: Set<string>, values: Record<string, string>): boolean {
    const resolved = resolveSettings({ env, hostKeys, file: values })
    const effective = new Map(resolved.map((row) => [row.key, effectiveValue(row)]))
    const localAdmin = effective.get('CUTTLELY_LOCAL_ADMIN') === 'true'
    const authKit = ['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_REDIRECT_URI', 'WORKOS_COOKIE_PASSWORD'].every((key) =>
        Boolean((effective.get(key) ?? '').trim())
    )
    return localAdmin || authKit
}

function effectiveMap(env: Env, hostKeys: Set<string>, values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(resolveSettings({ env, hostKeys, file: values }).map((row) => [row.key, effectiveValue(row)]))
}

/**
 * True when a change turns password sign-in off, or changes AuthKit while password sign-in is off.
 * Either one needs a passed test sign-in with the new AuthKit values first.
 */
export function needsAuthKitTest(env: Env, hostKeys: Set<string>, before: Record<string, string>, after: Record<string, string>): boolean {
    const was = effectiveMap(env, hostKeys, before)
    const will = effectiveMap(env, hostKeys, after)
    if (will.CUTTLELY_LOCAL_ADMIN === 'true') return false
    const authKitChanged = AUTHKIT_KEYS.some((name) => (was[name] ?? '') !== (will[name] ?? ''))
    return was.CUTTLELY_LOCAL_ADMIN === 'true' || authKitChanged
}

/** Settings that have their own guided flow and cannot be saved here directly. */
export function guidedOnly(setting: SettingDef): string | null {
    if (setting.section === 'database') return 'Change the database with Switch database, which tests the connection first.'
    return null
}

export async function saveChanges(deps: ServiceDeps, input: unknown, by: string): Promise<SettingsView> {
    const changes = input && typeof input === 'object' ? (input as { values?: unknown }).values : undefined
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        throw new SettingsError(400, 'BAD_REQUEST', 'Send the changed settings as values.')
    }
    const hostKeys = new Set(deps.state.hostKeys)
    const errors: { key: string; message: string; code?: string; min?: number; max?: number }[] = []
    const normalized: Record<string, string> = {}
    for (const [key, raw] of Object.entries(changes as Record<string, unknown>)) {
        const setting = settingFor(key)
        if (!setting) {
            errors.push({ key, message: isKeptOut(key) ? `${key} cannot be changed from the browser.` : `${key} is not a setting.` })
            continue
        }
        if (hostKeys.has(key)) {
            errors.push({ key, message: `${setting.label} is set by the host, so it is locked here.` })
            continue
        }
        const guided = guidedOnly(setting)
        if (guided) {
            errors.push({ key, message: guided })
            continue
        }
        const checked = checkValue(setting, raw)
        if (!checked.ok) errors.push({ key, message: checked.error, code: checked.code, min: checked.min, max: checked.max })
        else normalized[key] = checked.value
    }
    if (errors.length) throw refuse(errors)
    const read = await readSaved(deps)
    const merged: Record<string, string> = { ...read.values }
    for (const [name, value] of Object.entries(normalized)) {
        if (value === '') delete merged[name]
        else merged[name] = value
    }
    const conflict = runtimeConflict(deps.env, hostKeys, merged, new Set(Object.keys(normalized)))
    if (conflict) {
        throw new SettingsError(400, conflict.code, conflict.reason, [{ key: conflict.key, message: conflict.reason }], conflict)
    }
    return writeValues(deps, normalized, by, 'save')
}

function refuse(errors: { key: string; message: string; code?: string; min?: number; max?: number }[]): never {
    const runtime = errors.filter((error) => error.code)
    const only = runtime.length > 0 && runtime.length === errors.length
    const first = runtime[0]
    throw new SettingsError(
        400,
        only && first?.code ? first.code : 'INVALID',
        only && first ? first.message : 'Some settings could not be saved.',
        errors.map(({ key, message }) => ({ key, message })),
        only && first ? { key: first.key, reason: first.message, min: first.min, max: first.max } : undefined
    )
}

/** Writes changes to the file (blank removes), keeps secrets nobody touched, records history. */
export async function writeValues(
    deps: ServiceDeps,
    normalized: Record<string, string>,
    by: string,
    kind: HistoryEntry['kind'],
    note?: string
): Promise<SettingsView> {
    const { state } = deps
    const key = await deps.key()
    const read = readSettingsFile(state.dir, key)
    if (read.exists && read.problems.some((problem) => /not valid JSON|version|no values/.test(problem))) {
        throw new SettingsError(409, 'FILE_DAMAGED', 'The settings file could not be read. Run pnpm settings restore on the server first.')
    }
    const next: Record<string, string> = { ...read.values }
    for (const [name, value] of Object.entries(normalized)) {
        if (value === '') delete next[name]
        else next[name] = value
    }
    if (!hasWayIn(deps.env, new Set(state.hostKeys), next)) {
        throw new SettingsError(
            409,
            'NO_WAY_IN',
            'This would leave no way to sign in. Keep the password sign-in on, or finish setting up AuthKit first.'
        )
    }
    if (
        needsAuthKitTest(deps.env, new Set(state.hostKeys), read.values, next) &&
        !authKitTested(state.dir, effectiveMap(deps.env, new Set(state.hostKeys), next), key)
    ) {
        throw new SettingsError(
            409,
            'AUTHKIT_NOT_TESTED',
            'Password sign-in stays on until a test sign-in with these AuthKit settings passes. Use Set up AuthKit, then Test sign-in.',
            [{ key: 'CUTTLELY_LOCAL_ADMIN', message: 'Run a test sign-in with AuthKit first. Password sign-in stays on until one passes.' }]
        )
    }
    const stored = readStoredValues(state.dir)
    const preserve: Record<string, (typeof stored)[string]> = {}
    for (const name of read.unreadable) if (!(name in normalized)) preserve[name] = stored[name]
    const before = { ...read.values }
    for (const name of read.unreadable) if (name in normalized) before[name] = '(unreadable)'
    const changes = describeChanges(before, next)
    if (changes.length) {
        writeSettingsFile(state.dir, next, { key, by, preserve })
        appendHistory(state.dir, { kind, by, changes, note, outcome: 'ok' })
    }
    return getView(deps)
}

/** Puts the file back the way it was when the server started. */
export async function discardChanges(deps: ServiceDeps, by: string): Promise<SettingsView> {
    const { state } = deps
    const key = await deps.key()
    const before = readSettingsFile(state.dir, key).values
    const file = path.join(state.dir, SETTINGS_FILE)
    if (state.rawAtStart === null || state.rawAtStart === undefined) fs.rmSync(file, { force: true })
    else writeFileAtomic(state.dir, SETTINGS_FILE, state.rawAtStart)
    const changes = describeChanges(before, state.atStart)
    if (changes.length) appendHistory(state.dir, { kind: 'discard', by, changes, outcome: 'ok' })
    return getView(deps)
}

/** Try it again: puts back the settings safe boot set aside, to apply at the next restart. */
export async function retryRolledBack(deps: ServiceDeps, by: string): Promise<SettingsView> {
    const { state } = deps
    const kept = path.join(state.dir, ROLLED_BACK_FILE)
    if (!fs.existsSync(kept)) throw new SettingsError(404, 'NOTHING_TO_RETRY', 'There are no set-aside settings to try again.')
    const key = await deps.key()
    const raw = fs.readFileSync(kept, 'utf8')
    const file = path.join(state.dir, SETTINGS_FILE)
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    const before = readSettingsFile(state.dir, key).values
    writeFileAtomic(state.dir, SETTINGS_FILE, raw)
    const after = readSettingsFile(state.dir, key)
    if (after.problems.some((problem) => /not valid JSON|version|no values/.test(problem))) {
        // Not a usable file: put the working one back, byte for byte, and leave the set-aside copy where it is.
        if (current === null) fs.rmSync(file, { force: true })
        else writeFileAtomic(state.dir, SETTINGS_FILE, current)
        throw new SettingsError(409, 'FILE_DAMAGED', 'The set-aside settings could not be read, so nothing changed.')
    }
    fs.rmSync(kept, { force: true })
    appendHistory(state.dir, {
        kind: 'restore',
        by,
        changes: describeChanges(before, after.values),
        note: 'Put back the settings that did not start, to try them again at the next restart.',
        outcome: 'ok'
    })
    return getView(deps)
}

export function listHistory(deps: ServiceDeps, limit: number): HistoryEntry[] {
    return readHistory(deps.state.dir, Math.max(1, Math.min(500, Number.isFinite(limit) ? limit : 100)))
}

export interface RestartAnswer {
    restarting: boolean
    steps: string[]
    /** Runs Cuttlely lets finish first (only when asked to wait). */
    waitingFor?: number
    waitSeconds?: number
}

/**
 * Restarts in place when the start script can, else answers with the steps. wait: let runs in progress finish first,
 * up to the turn time limit; new runs are turned away meanwhile.
 */
export async function restartNow(deps: ServiceDeps, by: string, options: { wait?: boolean } = {}): Promise<RestartAnswer> {
    const view = await getView(deps)
    if (!view.restart.inPlace) return { restarting: false, steps: view.restart.steps }
    const waitingFor = options.wait ? runsInProgress() : 0
    const limit = waitLimitMs(deps.env)
    const changed = view.restart.changed.length
    appendHistory(deps.state.dir, {
        kind: 'restart',
        by,
        note:
            (changed ? `Restarted to apply ${changed} change(s).` : 'Restarted.') +
            (waitingFor ? ` Let ${waitingFor} run(s) in progress finish first (up to ${Math.round(limit / 1000)} s).` : ''),
        outcome: 'ok'
    })
    const restarting = requestRestart({ env: deps.env, before: waitingFor ? () => drainRuns(limit) : undefined })
    return waitingFor ? { restarting, steps: [], waitingFor, waitSeconds: Math.round(limit / 1000) } : { restarting, steps: [] }
}
