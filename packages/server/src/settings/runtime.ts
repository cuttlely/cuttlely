// Runtime product limits. Read on each use: a valid host value, then the settings file, then the default.
// Out of range on save is refused. A bad host value is logged by key and ignored. The read path does not throw.
// On a pair, an in-range host value is kept. The other setting falls back, then is bounded by that host value.
import { SETTINGS, SettingDef, settingFor } from './registry'
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

interface Candidate {
    value: number
    source: CandidateSource
}

let cache: { at: number; stamp: string; values: Map<string, ResolvedRuntime> } | null = null
const warned = new Set<string>()
let readWarned = false
let hooked = false

function runtimeSettings(): SettingDef[] {
    return SETTINGS.filter((setting) => setting.runtime && setting.type === 'number')
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
    })
}

/** Drops a cached read. A successful save of server.json does this on its own. */
export function invalidateRuntimeCache(): void {
    cache = null
}

/** Tests start from an empty cache and an empty warning set. */
export function resetRuntimeLimitsForTests(): void {
    cache = null
    warned.clear()
    readWarned = false
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

function candidates(setting: SettingDef, env: Env, hostKeys: Set<string>, file: Record<string, string>): Candidate[] {
    const out: Candidate[] = []
    if (hostKeys.has(setting.key)) {
        const raw = present(env[setting.key])
        if (raw !== null) {
            const n = parseRuntimeInteger(raw)
            if (n !== null && inStaticRange(setting, n)) out.push({ value: n, source: 'host' })
            else warnKey(setting.key)
        }
    }
    const saved = present(file[setting.key])
    if (saved !== null) {
        const n = parseRuntimeInteger(saved)
        if (n !== null && inStaticRange(setting, n)) out.push({ value: n, source: 'panel' })
        else warnKey(setting.key)
    }
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
    const paired = new Set([COUNT_MAX, COUNT_DEFAULT, IMPORT_CAP, SCAN_CAP])
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
    return out
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

/** The limit in effect for one runtime setting. */
export function runtimeNumber(key: string, env: Env = process.env): number {
    const row = runtimeSnapshot(env).get(key)
    if (!row) throw new Error(`${key} is not a runtime setting`)
    return row.value
}

function strictValue(setting: SettingDef, env: Env, hostKeys: Set<string>, file: Record<string, string>): number {
    if (hostKeys.has(setting.key)) {
        const raw = present(env[setting.key])
        if (raw !== null) {
            const n = parseRuntimeInteger(raw)
            if (n !== null && inStaticRange(setting, n)) return n
        }
    }
    const saved = present(file[setting.key])
    if (saved !== null) {
        const n = parseRuntimeInteger(saved)
        if (n !== null && inStaticRange(setting, n)) return n
    }
    return defaultOf(setting)
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
    return null
}
