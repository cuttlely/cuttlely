// Works out each server setting's value and where it came from.
// Order: the host (environment, including packages/server/.env), then the admin settings file, then the built-in default.
// A blank value counts as not set: Docker compose passes unset variables as empty strings.
import { SETTINGS, SettingDef, settingFor } from './registry'
import { partnerIsSet } from './settingAlias'

export type SettingSource = 'host' | 'file' | 'default'

export interface ResolvedSetting {
    key: string
    /** The raw value in effect, or '' when the default applies. */
    value: string
    source: SettingSource
}

type Env = Record<string, string | undefined>

/** Names the start script records before it fills in any default, so a default never looks host-set. */
export const HOST_KEYS_VAR = 'CUTTLELY_SETTINGS_HOST_KEYS'

/** Names the start script filled in with its own default (space or comma separated). They never count as host-set. */
export const SCRIPT_DEFAULTS_VAR = 'CUTTLELY_SETTINGS_SCRIPT_DEFAULTS'

export function scriptDefaultKeys(env: Env): Set<string> {
    return new Set(
        String(env[SCRIPT_DEFAULTS_VAR] ?? '')
            .split(/[\s,]+/)
            .filter((key) => key && settingFor(key))
    )
}

export function isBlank(value: string | undefined | null): boolean {
    return value === undefined || value === null || String(value).trim() === ''
}

/** Settings the host set. Uses the start script's record when it is there. */
export function hostSetKeys(env: Env, settings: SettingDef[] = SETTINGS): Set<string> {
    const recorded = env[HOST_KEYS_VAR]
    if (recorded !== undefined) {
        return new Set(
            recorded
                .split(',')
                .map((key) => key.trim())
                .filter((key) => key && settingFor(key))
        )
    }
    const defaulted = scriptDefaultKeys(env)
    return new Set(settings.filter((setting) => !isBlank(env[setting.key]) && !defaulted.has(setting.key)).map((setting) => setting.key))
}

export function resolveSettings(input: { env: Env; hostKeys?: Set<string>; file?: Record<string, string> }): ResolvedSetting[] {
    const hostKeys = input.hostKeys ?? hostSetKeys(input.env)
    const file = input.file ?? {}
    const defaulted = scriptDefaultKeys(input.env)
    return SETTINGS.map((setting) => {
        const key = setting.key
        if (hostKeys.has(key) && !isBlank(input.env[key])) return { key, value: String(input.env[key]), source: 'host' as const }
        if (Object.prototype.hasOwnProperty.call(file, key) && !isBlank(file[key]))
            return { key, value: String(file[key]), source: 'file' as const }
        if (defaulted.has(key) && !isBlank(input.env[key])) return { key, value: String(input.env[key]), source: 'default' as const }
        return { key, value: '', source: 'default' as const }
    })
}

/** The value the server behaves as if it had: the set value, or the default. */
export function effectiveValue(resolved: ResolvedSetting): string {
    if (resolved.value !== '') return resolved.value
    return settingFor(resolved.key)?.defaultValue ?? ''
}

/** Whether a setting shows, given the other settings' effective values. */
export function isShown(setting: SettingDef, effective: Map<string, string>): boolean {
    if (!setting.showWhen) return true
    return setting.showWhen.equals.includes(effective.get(setting.showWhen.key) ?? '')
}

/** Values from the settings file that the environment should get: only keys the host did not set. */
export function fileValuesToApply(
    env: Env,
    file: Record<string, string>,
    hostKeys: Set<string> = hostSetKeys(env)
): Record<string, string> {
    const out: Record<string, string> = {}
    const defaults = scriptDefaultKeys(env)
    for (const [key, value] of Object.entries(file)) {
        const setting = settingFor(key)
        // Invite and mail settings are read on each use. Copying them onto the process would hide the host value.
        if (!setting || setting.panelFirst || setting.envOnly || hostKeys.has(key) || isBlank(value)) continue
        // A host-set partner of this alias wins, the same way a host-set key wins.
        if (partnerIsSet(env, key, defaults)) continue
        out[key] = String(value)
    }
    return out
}
