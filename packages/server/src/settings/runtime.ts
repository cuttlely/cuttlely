// Runtime product limits. Read on each use: a valid host value, then the settings file, then the default.
// Out of range on save is refused. A bad host value is logged by key and ignored. The read path does not throw.
// On a pair, an in-range host value is kept. The other setting falls back, then is bounded by that host value.
import { SETTINGS, SettingDef, savedValueWins, settingFor } from './registry'
import { hostSetKeys } from './resolve'
import { encryptionKeySync, onSettingsFileWritten, readSettingsFile, settingsDir } from './store'

type Env = Record<string, string | undefined>

export const RUNTIME_CACHE_MS = 5000

export type CandidateSource = 'host' | 'panel' | 'default'
export type RuntimeSource = CandidateSource | 'bounded'

export interface ResolvedRuntime {
    value: number
    source: RuntimeSource
    /** The host key that forced this number. Set only when source is bounded. */
    boundedBy?: string
}

export interface RuntimeProblem {
    code: 'CROSS_FIELD'
    key: string
    reason: string
    min: number
    max: number
}

const COUNT_MAX = 'CUTTLELY_CHECK_COUNT_MAX'
const COUNT_DEFAULT = 'CUTTLELY_CHECK_COUNT_DEFAULT'
const IMPORT_CAP = 'CUTTLELY_RATING_IMPORT_CAP'
const SCAN_CAP = 'CUTTLELY_RATING_SCAN_CAP'
const SESSION_IDLE = 'CUTTLELY_SESSION_IDLE_MINUTES'
const SESSION_ABSOLUTE = 'CUTTLELY_SESSION_ABSOLUTE_HOURS'

interface Candidate {
    value: number
    source: CandidateSource
}

let cache: { at: number; stamp: string; values: Map<string, ResolvedRuntime> } | null = null
let flagCache: { at: number; stamp: string; values: Map<string, ResolvedFlag> } | null = null
const warned = new Set<string>()
let readWarned = false
let hooked = false

export const PUBLISH_CHECK_KEY = 'CUTTLELY_PUBLISH_CHECK'
export const PUBLISH_CHECK_OFF_MESSAGE = 'The publish check is turned off on this server.'

export interface ResolvedFlag {
    value: boolean
    source: CandidateSource
}

function runtimeSettings(): SettingDef[] {
    // panelFirst numbers are invite and mail settings. A saved value overrides the host, so they are resolved apart from these limits.
    return SETTINGS.filter((setting) => setting.runtime && setting.type === 'number' && !setting.panelFirst)
}

function runtimeSwitches(): SettingDef[] {
    // panelFirst switches are invite and mail settings. A saved value overrides the host, so they stay on that reader.
    return SETTINGS.filter((setting) => setting.runtime && setting.type === 'switch' && !setting.panelFirst)
}

function warnKey(key: string): void {
    if (warned.has(key)) return
    warned.add(key)
    // Key only. The value can be a mistake and is not written here.
    console.warn(`[server]: ${key} is not a usable runtime limit, so another value is used`)
}

function warnUnread(): void {
    if (readWarned) return
    readWarned = true
    console.warn('[server]: runtime limits could not be read, so defaults are used')
}

function ensureHook(): void {
    if (hooked) return
    hooked = true
    onSettingsFileWritten(() => {
        cache = null
        flagCache = null
    })
}

/** Drops a cached read. A successful save of server.json does this on its own. */
export function invalidateRuntimeCache(): void {
    cache = null
    flagCache = null
}

/** Tests start from an empty cache and an empty warning set. */
export function resetRuntimeLimitsForTests(): void {
    cache = null
    flagCache = null
    warned.clear()
    readWarned = false
}

/** Exactly the switch's on or off string. Blank, other words, and different casing are not. */
export function parseRuntimeFlag(raw: string, on = 'true', off = 'false'): boolean | null {
    if (typeof raw !== 'string') return null
    if (raw === on) return true
    if (raw === off) return false
    return null
}

/** A whole number in the safe integer range. Blank, floats, exponents, NaN and Infinity are not. */
export function parseRuntimeInteger(raw: string): number | null {
    if (typeof raw !== 'string') return null
    // No trim: spaces, a float, an exponent, NaN and Infinity are not whole numbers.
    const value = raw
    if (!/^-?(?:0|[1-9]\d*)$/.test(value)) return null
    const digits = value.startsWith('-') ? value.slice(1) : value
    if (digits.length > 16) return null
    const n = BigInt(value)
    if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) return null
    return Number(n)
}

function inStaticRange(setting: SettingDef, n: number): boolean {
    if (setting.min !== undefined && n < setting.min) return false
    if (setting.max !== undefined && n > setting.max) return false
    return true
}

function defaultOf(setting: SettingDef): number {
    const n = parseRuntimeInteger(setting.defaultValue ?? '')
    if (n === null || !inStaticRange(setting, n)) throw new Error(`runtime setting ${setting.key} has no default`)
    return n
}

function present(raw: string | undefined): string | null {
    if (raw === undefined || raw === null) return null
    if (String(raw).trim() === '') return null
    return String(raw)
}

function ignored(env: Env): boolean {
    return ['1', 'true', 'yes', 'on'].includes(
        String(env.CUTTLELY_IGNORE_ADMIN_SETTINGS ?? '')
            .trim()
            .toLowerCase()
    )
}

function panelFile(env: Env): Record<string, string> {
    if (ignored(env)) return {}
    try {
        const read = readSettingsFile(settingsDir(env), encryptionKeySync(env))
        if (read.problems.some((problem) => /not valid JSON|no values|this Cuttlely reads version/.test(problem))) warnUnread()
        return read.values
    } catch {
        warnUnread()
        return {}
    }
}

function hostCandidate(setting: SettingDef, env: Env, hostKeys: Set<string>): Candidate | null {
    if (!hostKeys.has(setting.key)) return null
    const raw = present(env[setting.key])
    if (raw === null) return null
    const n = parseRuntimeInteger(raw)
    if (n !== null && inStaticRange(setting, n)) return { value: n, source: 'host' }
    warnKey(setting.key)
    return null
}

function panelCandidate(setting: SettingDef, file: Record<string, string>): Candidate | null {
    const saved = present(file[setting.key])
    if (saved === null) return null
    const n = parseRuntimeInteger(saved)
    if (n !== null && inStaticRange(setting, n)) return { value: n, source: 'panel' }
    warnKey(setting.key)
    return null
}

function candidates(setting: SettingDef, env: Env, hostKeys: Set<string>, file: Record<string, string>): Candidate[] {
    const host = hostCandidate(setting, env, hostKeys)
    const panel = panelCandidate(setting, file)
    // History keep is edited on the page. A saved value wins over the environment variable.
    const ordered = savedValueWins(setting.key) ? [panel, host] : [host, panel]
    const out = ordered.filter((row): row is Candidate => row !== null)
    out.push({ value: defaultOf(setting), source: 'default' })
    return out
}

function boundTo(value: number, setting: SettingDef): number {
    let n = value
    if (setting.min !== undefined && n < setting.min) n = setting.min
    if (setting.max !== undefined && n > setting.max) n = setting.max
    return n
}

// The number comes from the other key's host value. It is not a host value of this key.
function boundedByHost(value: number, setting: SettingDef, boundedBy: string): ResolvedRuntime {
    return { value: boundTo(value, setting), source: 'bounded', boundedBy }
}

/**
 * An in-range host value wins and is not replaced by a looser candidate.
 * The other setting walks its own candidates. If none fit, it is bounded by the host value.
 * When both sides are host values and they conflict, the cap is kept and the other side is bounded.
 */
function pickHostPair(
    limitKey: string,
    otherKey: string,
    limitCands: Candidate[],
    otherCands: Candidate[]
): { limit: ResolvedRuntime; other: ResolvedRuntime } {
    const hostLimit = limitCands.find((candidate) => candidate.source === 'host')
    const hostOther = otherCands.find((candidate) => candidate.source === 'host')
    const limitSetting = setting(limitKey)
    const otherSetting = setting(otherKey)
    if (hostLimit) {
        const other = otherCands.find((candidate) => candidate.value <= hostLimit.value)
        if (other) {
            if (other !== otherCands[0]) warnKey(otherKey)
            return { limit: hostLimit, other }
        }
        warnKey(otherKey)
        return { limit: hostLimit, other: boundedByHost(hostLimit.value, otherSetting, limitKey) }
    }
    const other = hostOther as Candidate
    const limit = limitCands.find((candidate) => other.value <= candidate.value)
    if (limit) {
        if (limit !== limitCands[0]) warnKey(limitKey)
        return { limit, other }
    }
    warnKey(limitKey)
    return { limit: boundedByHost(other.value, limitSetting, otherKey), other }
}

function pickPair(
    depKey: string,
    indKey: string,
    depCands: Candidate[],
    indCands: Candidate[],
    ok: (dep: number, ind: number) => boolean,
    limitSide: 'dep' | 'ind'
): { dep: ResolvedRuntime; ind: ResolvedRuntime } {
    const hostDep = depCands.some((candidate) => candidate.source === 'host')
    const hostInd = indCands.some((candidate) => candidate.source === 'host')
    if (hostDep || hostInd) {
        const limitKey = limitSide === 'dep' ? depKey : indKey
        const otherKey = limitSide === 'dep' ? indKey : depKey
        const picked = pickHostPair(
            limitKey,
            otherKey,
            limitSide === 'dep' ? depCands : indCands,
            limitSide === 'dep' ? indCands : depCands
        )
        return limitSide === 'dep' ? { dep: picked.limit, ind: picked.other } : { dep: picked.other, ind: picked.limit }
    }
    for (const ind of indCands) {
        for (const dep of depCands) {
            if (!ok(dep.value, ind.value)) continue
            if (dep !== depCands[0]) warnKey(depKey)
            if (ind !== indCands[0]) warnKey(indKey)
            return { dep, ind }
        }
    }
    warnKey(depKey)
    warnKey(indKey)
    return { dep: depCands[depCands.length - 1], ind: indCands[indCands.length - 1] }
}

function envStamp(env: Env): string {
    const keys = runtimeSettings().map((setting) => setting.key)
    return [
        env.CUTTLELY_DATA_DIR ?? '',
        env.CUTTLELY_IGNORE_ADMIN_SETTINGS ?? '',
        env.CUTTLELY_SETTINGS_HOST_KEYS ?? '',
        env.CUTTLELY_SETTINGS_SCRIPT_DEFAULTS ?? '',
        ...keys.map((key) => env[key] ?? '')
    ].join('\0')
}

function compute(env: Env): Map<string, ResolvedRuntime> {
    const hostKeys = hostSetKeys(env)
    const file = panelFile(env)
    const byKey = new Map(runtimeSettings().map((setting) => [setting.key, setting]))
    const cands = (key: string) => candidates(byKey.get(key) as SettingDef, env, hostKeys, file)
    const out = new Map<string, ResolvedRuntime>()
    const paired = new Set([COUNT_MAX, COUNT_DEFAULT, IMPORT_CAP, SCAN_CAP, SESSION_IDLE, SESSION_ABSOLUTE])
    for (const setting of runtimeSettings()) {
        if (paired.has(setting.key)) continue
        const chosen = cands(setting.key)[0]
        out.set(setting.key, { value: chosen.value, source: chosen.source })
    }
    const counts = pickPair(COUNT_DEFAULT, COUNT_MAX, cands(COUNT_DEFAULT), cands(COUNT_MAX), (dep, ind) => dep <= ind, 'ind')
    out.set(COUNT_DEFAULT, counts.dep)
    out.set(COUNT_MAX, counts.ind)
    const ratings = pickPair(SCAN_CAP, IMPORT_CAP, cands(SCAN_CAP), cands(IMPORT_CAP), (dep, ind) => dep >= ind, 'dep')
    out.set(SCAN_CAP, ratings.dep)
    out.set(IMPORT_CAP, ratings.ind)
    const sessions = pickSession(cands(SESSION_IDLE), cands(SESSION_ABSOLUTE))
    out.set(SESSION_IDLE, sessions.idle)
    out.set(SESSION_ABSOLUTE, sessions.absolute)
    return out
}

function idleFits(idleMinutes: number, absoluteHours: number): boolean {
    return idleMinutes <= absoluteHours * 60
}

/** Idle minutes must fit inside the absolute lifetime. A host value on one side bounds the other. */
function pickSession(idleCands: Candidate[], absoluteCands: Candidate[]): { idle: ResolvedRuntime; absolute: ResolvedRuntime } {
    const hostIdle = idleCands.find((candidate) => candidate.source === 'host')
    const hostAbsolute = absoluteCands.find((candidate) => candidate.source === 'host')
    if (hostIdle && hostAbsolute) {
        if (idleFits(hostIdle.value, hostAbsolute.value)) return { idle: hostIdle, absolute: hostAbsolute }
        warnKey(SESSION_IDLE)
        return { idle: boundedByHost(hostAbsolute.value * 60, setting(SESSION_IDLE), SESSION_ABSOLUTE), absolute: hostAbsolute }
    }
    if (hostAbsolute) {
        const idle = idleCands.find((candidate) => idleFits(candidate.value, hostAbsolute.value))
        if (idle) {
            if (idle !== idleCands[0]) warnKey(SESSION_IDLE)
            return { idle, absolute: hostAbsolute }
        }
        warnKey(SESSION_IDLE)
        return { idle: boundedByHost(hostAbsolute.value * 60, setting(SESSION_IDLE), SESSION_ABSOLUTE), absolute: hostAbsolute }
    }
    if (hostIdle) {
        const absolute = absoluteCands.find((candidate) => idleFits(hostIdle.value, candidate.value))
        if (absolute) {
            if (absolute !== absoluteCands[0]) warnKey(SESSION_ABSOLUTE)
            return { idle: hostIdle, absolute }
        }
        warnKey(SESSION_ABSOLUTE)
        return { idle: hostIdle, absolute: boundedByHost(Math.ceil(hostIdle.value / 60), setting(SESSION_ABSOLUTE), SESSION_IDLE) }
    }
    for (const idle of idleCands) {
        const absolute = absoluteCands.find((candidate) => idleFits(idle.value, candidate.value))
        if (!absolute) continue
        if (idle !== idleCands[0]) warnKey(SESSION_IDLE)
        if (absolute !== absoluteCands[0]) warnKey(SESSION_ABSOLUTE)
        return { idle, absolute }
    }
    return { idle: idleCands[idleCands.length - 1], absolute: absoluteCands[absoluteCands.length - 1] }
}

export function runtimeSnapshot(env: Env = process.env): Map<string, ResolvedRuntime> {
    ensureHook()
    const stamp = envStamp(env)
    const now = Date.now()
    if (cache && cache.stamp === stamp && now - cache.at < RUNTIME_CACHE_MS) return cache.values
    let values: Map<string, ResolvedRuntime>
    try {
        values = compute(env)
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('runtime setting ')) throw error
        warnUnread()
        values = new Map(runtimeSettings().map((setting) => [setting.key, { value: defaultOf(setting), source: 'default' as const }]))
    }
    cache = { at: now, stamp, values }
    return values
}

function defaultFlag(setting: SettingDef): boolean {
    const on = setting.on ?? 'true'
    return (setting.defaultValue ?? setting.off ?? 'false') === on
}

function flagStamp(env: Env): string {
    const keys = runtimeSwitches().map((setting) => setting.key)
    return [
        env.CUTTLELY_DATA_DIR ?? '',
        env.CUTTLELY_IGNORE_ADMIN_SETTINGS ?? '',
        env.CUTTLELY_SETTINGS_HOST_KEYS ?? '',
        ...keys.map((key) => env[key] ?? '')
    ].join('\0')
}

function computeFlags(env: Env): Map<string, ResolvedFlag> {
    const hostKeys = hostSetKeys(env)
    const file = panelFile(env)
    const out = new Map<string, ResolvedFlag>()
    for (const setting of runtimeSwitches()) {
        const on = setting.on ?? 'true'
        const off = setting.off ?? 'false'
        if (hostKeys.has(setting.key)) {
            const raw = present(env[setting.key])
            if (raw !== null) {
                const flag = parseRuntimeFlag(raw, on, off)
                if (flag !== null) {
                    out.set(setting.key, { value: flag, source: 'host' })
                    continue
                }
                warnKey(setting.key)
            }
        }
        const saved = present(file[setting.key])
        if (saved !== null) {
            const flag = parseRuntimeFlag(saved, on, off)
            if (flag !== null) {
                out.set(setting.key, { value: flag, source: 'panel' })
                continue
            }
            warnKey(setting.key)
        }
        out.set(setting.key, { value: defaultFlag(setting), source: 'default' })
    }
    return out
}

export function flagSnapshot(env: Env = process.env): Map<string, ResolvedFlag> {
    ensureHook()
    const stamp = flagStamp(env)
    const now = Date.now()
    if (flagCache && flagCache.stamp === stamp && now - flagCache.at < RUNTIME_CACHE_MS) return flagCache.values
    let values: Map<string, ResolvedFlag>
    try {
        values = computeFlags(env)
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('runtime setting ')) throw error
        warnUnread()
        values = new Map(runtimeSwitches().map((setting) => [setting.key, { value: defaultFlag(setting), source: 'default' as const }]))
    }
    flagCache = { at: now, stamp, values }
    return values
}

/** The boolean in effect for one runtime switch. */
export function runtimeFlag(key: string, env: Env = process.env): ResolvedFlag {
    const row = flagSnapshot(env).get(key)
    if (!row) throw new Error(`${key} is not a runtime switch`)
    return row
}

/** True unless a valid host or saved value turned the publish check off. */
export function publishCheckEnabled(env: Env = process.env): boolean {
    return runtimeFlag(PUBLISH_CHECK_KEY, env).value
}

/** The limit in effect for one runtime setting. */
export function runtimeNumber(key: string, env: Env = process.env): number {
    const row = runtimeSnapshot(env).get(key)
    if (!row) throw new Error(`${key} is not a runtime setting`)
    return row.value
}

function strictValue(setting: SettingDef, env: Env, hostKeys: Set<string>, file: Record<string, string>): number {
    return candidates(setting, env, hostKeys, file)[0].value
}

function setting(key: string): SettingDef {
    const found = settingFor(key)
    if (!found) throw new Error(`${key} is not a runtime setting`)
    return found
}

/**
 * A save that would leave a pair inconsistent. Checked on the values in effect after this save,
 * including a change to only one side. Null when the pairs hold, or when this save does not touch them.
 */
export function runtimeConflict(
    env: Env,
    hostKeys: Set<string>,
    file: Record<string, string>,
    touched: Set<string>
): RuntimeProblem | null {
    if (touched.has(COUNT_DEFAULT) || touched.has(COUNT_MAX)) {
        const cap = strictValue(setting(COUNT_MAX), env, hostKeys, file)
        const count = strictValue(setting(COUNT_DEFAULT), env, hostKeys, file)
        if (count > cap) {
            const key = touched.has(COUNT_DEFAULT) ? COUNT_DEFAULT : COUNT_MAX
            if (key === COUNT_DEFAULT) {
                return {
                    code: 'CROSS_FIELD',
                    key,
                    reason: 'The question count default cannot be above the question cap.',
                    min: setting(COUNT_DEFAULT).min ?? 1,
                    max: cap
                }
            }
            return {
                code: 'CROSS_FIELD',
                key,
                reason: 'The question cap must be at least the question count default.',
                min: count,
                max: setting(COUNT_MAX).max ?? count
            }
        }
    }
    if (touched.has(IMPORT_CAP) || touched.has(SCAN_CAP)) {
        const imported = strictValue(setting(IMPORT_CAP), env, hostKeys, file)
        const scan = strictValue(setting(SCAN_CAP), env, hostKeys, file)
        if (scan < imported) {
            const key = touched.has(SCAN_CAP) ? SCAN_CAP : IMPORT_CAP
            if (key === SCAN_CAP) {
                return {
                    code: 'CROSS_FIELD',
                    key,
                    reason: 'The rating scan cap must be at least the import cap.',
                    min: imported,
                    max: setting(SCAN_CAP).max ?? imported
                }
            }
            return {
                code: 'CROSS_FIELD',
                key,
                reason: 'The import cap cannot be above the rating scan cap.',
                min: setting(IMPORT_CAP).min ?? 1,
                max: scan
            }
        }
    }
    if (touched.has(SESSION_IDLE) || touched.has(SESSION_ABSOLUTE)) {
        const idle = strictValue(setting(SESSION_IDLE), env, hostKeys, file)
        const absolute = strictValue(setting(SESSION_ABSOLUTE), env, hostKeys, file)
        if (!idleFits(idle, absolute)) {
            const key = touched.has(SESSION_IDLE) ? SESSION_IDLE : SESSION_ABSOLUTE
            if (key === SESSION_IDLE) {
                return {
                    code: 'CROSS_FIELD',
                    key,
                    reason: 'Idle time cannot be longer than the absolute session lifetime.',
                    min: setting(SESSION_IDLE).min ?? 15,
                    max: Math.min(setting(SESSION_IDLE).max ?? absolute * 60, absolute * 60)
                }
            }
            return {
                code: 'CROSS_FIELD',
                key,
                reason: 'The absolute session lifetime must cover the idle time.',
                min: Math.max(setting(SESSION_ABSOLUTE).min ?? 1, Math.ceil(idle / 60)),
                max: setting(SESSION_ABSOLUTE).max ?? 720
            }
        }
    }
    return null
}
