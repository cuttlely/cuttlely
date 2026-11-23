// Time limits and caps: a usable saved value, then the host at start, then the default.
// The host record stays separate because live limits replace process.env after a save.
import { SETTINGS, SettingDef } from './registry'
import { isBlank, scriptDefaultKeys } from './resolve'
import { encryptionKeySync, onSettingsFileWritten, readSettingsFile, settingsDir } from './store'
import { checkValue } from './validate'

type Env = Record<string, string | undefined>

export const HOST_LIMITS_VAR = 'CUTTLELY_SETTINGS_HOST_LIMITS'

export interface ResolvedLimit {
    value: string
    source: 'panel' | 'host' | 'default'
}

const warned = new Set<string>()
let hooked = false
const liveEnvs = new Map<string, Env>()

function limitSettings(): SettingDef[] {
    return SETTINGS.filter((setting) => setting.limit && !setting.fixed)
}

function warnKey(key: string): void {
    if (warned.has(key)) return
    warned.add(key)
    // Key only. The value can be a mistake and is not written here.
    console.warn(`[server]: ${key} is not a usable runtime limit, so another value is used`)
}

/** Capture only numeric limit values, before the file is copied into the environment. */
export function recordHostLimits(env: Env): void {
    if (env[HOST_LIMITS_VAR] !== undefined) return
    const values: Record<string, number> = {}
    const defaults = scriptDefaultKeys(env)
    for (const setting of limitSettings()) {
        const raw = env[setting.key]
        if (defaults.has(setting.key) || isBlank(raw)) continue
        if (setting.boundedHost && !checkValue(setting, raw).ok) {
            warnKey(setting.key)
            continue
        }
        if (Number.isFinite(Number(raw))) values[setting.key] = Number(raw)
    }
    env[HOST_LIMITS_VAR] = JSON.stringify(values)
}

function hostLimits(env: Env): Record<string, number> {
    // CLI reads before startup still use the original environment.
    const copy = { ...env }
    recordHostLimits(copy)
    try {
        const parsed = JSON.parse(copy[HOST_LIMITS_VAR] ?? '{}')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        return Object.fromEntries(
            Object.entries(parsed).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
        ) as Record<string, number>
    } catch {
        return {}
    }
}

/** Pure resolution, also used for the startup snapshot and history. Defaults are not exported. */
export function resolveLimits(env: Env, file: Record<string, string>): Map<string, ResolvedLimit> {
    const host = hostLimits(env)
    const ignored = ['1', 'true', 'yes', 'on'].includes(
        String(env.CUTTLELY_IGNORE_ADMIN_SETTINGS ?? '')
            .trim()
            .toLowerCase()
    )
    return new Map(
        limitSettings().map((setting): [string, ResolvedLimit] => {
            const raw = ignored ? undefined : file[setting.key]
            if (!isBlank(raw)) {
                const checked = checkValue(setting, raw)
                if (checked.ok && checked.value !== '') return [setting.key, { value: checked.value, source: 'panel' as const }]
                warnKey(setting.key)
            }
            if (host[setting.key] !== undefined) return [setting.key, { value: String(host[setting.key]), source: 'host' as const }]
            return [setting.key, { value: setting.defaultValue ?? '', source: 'default' as const }]
        })
    )
}

export function limitSnapshot(env: Env = process.env): Map<string, ResolvedLimit> {
    ensureHook(env)
    const read = readSettingsFile(settingsDir(env), encryptionKeySync(env))
    return resolveLimits(env, read.values)
}

/** Separate from fileValuesToApply: saved limits override even host-set variables. */
export function limitValuesToApply(env: Env, file: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
        [...resolveLimits(env, file)]
            .filter(([, row]) => row.source !== 'default')
            .map(([key, row]) => {
                // Preserve the host's spelling at start, including leading zeros. Later reads use its numeric record.
                const raw =
                    row.source === 'host' && !isBlank(env[key]) && Number(env[key]) === Number(row.value) ? String(env[key]) : row.value
                return [key, raw]
            })
    )
}

/** Only live keys change after start. Clearing restores the host, or leaves the variable unset. */
export function syncLiveLimits(env: Env = process.env): void {
    recordHostLimits(env)
    const snapshot = limitSnapshot(env)
    for (const setting of limitSettings()) {
        if (setting.applies !== 'live') continue
        const row = snapshot.get(setting.key)!
        if (row.source === 'default') delete env[setting.key]
        else env[setting.key] = row.value
    }
}

function ensureHook(env: Env): void {
    recordHostLimits(env)
    liveEnvs.set(settingsDir(env), env)
    if (hooked) return
    hooked = true
    onSettingsFileWritten((dir) => {
        const active = liveEnvs.get(dir)
        if (active) syncLiveLimits(active)
    })
}

/** Called once at start, before any runtime reader imports. */
export function applyLimitSettings(env: Env, file: Record<string, string>): void {
    recordHostLimits(env)
    const values = limitValuesToApply(env, file)
    for (const setting of limitSettings()) {
        if (setting.boundedHost && !(setting.key in values)) delete env[setting.key]
    }
    Object.assign(env, values)
    ensureHook(env)
}
