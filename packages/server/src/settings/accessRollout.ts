// Service-wide rollout. Never exported into process.env: a real host value must remain distinguishable.
import { readSettingsFile, settingsDir } from './store'

export const ACCESS_ROLLOUT_KEY = 'INBOUND_ACCESS_V2'
export type AccessRollout = 'off' | 'shadow' | 'on'
type Env = Record<string, string | undefined>

export interface RolloutState {
    value: AccessRollout | 'invalid'
    source: 'host' | 'panel' | 'default'
    locked: boolean
    invalidStored?: boolean
}

function valid(value: unknown): value is AccessRollout {
    return value === 'off' || value === 'shadow' || value === 'on'
}

export function rolloutState(env: Env = process.env, saved?: Record<string, string>): RolloutState {
    const host = env[ACCESS_ROLLOUT_KEY]
    // Preserve the old empty-env default; every other nonempty invalid host value still refuses with 503.
    if (host !== undefined && host !== '') return { value: valid(host) ? host : 'invalid', source: 'host', locked: true }
    if (/^(1|true|yes|on)$/i.test((env.CUTTLELY_IGNORE_ADMIN_SETTINGS ?? '').trim()))
        return { value: 'off', source: 'default', locked: false }
    let file = saved
    if (!file) {
        try {
            // This setting is not a secret. Reading it never needs the installation encryption key.
            file = readSettingsFile(settingsDir(env), null).values
        } catch {
            file = {}
        }
    }
    const value = file[ACCESS_ROLLOUT_KEY]
    if (value !== undefined)
        return { value: valid(value) ? value : 'off', source: 'panel', locked: false, ...(!valid(value) ? { invalidStored: true } : {}) }
    return { value: 'off', source: 'default', locked: false }
}

/** General restore actions must not activate an old rollout choice without its explicit review. */
export function preserveRollout(raw: string | null, current: Record<string, unknown>): string | null {
    let restored
    try {
        restored = raw === null ? { version: 1, values: {} } : JSON.parse(raw)
    } catch {
        return raw // The caller retains the existing damaged-file handling.
    }
    if (!restored?.values || typeof restored.values !== 'object') return raw
    if (!(ACCESS_ROLLOUT_KEY in current) && !(ACCESS_ROLLOUT_KEY in restored.values)) return raw
    if (ACCESS_ROLLOUT_KEY in current) restored.values[ACCESS_ROLLOUT_KEY] = current[ACCESS_ROLLOUT_KEY]
    else delete restored.values[ACCESS_ROLLOUT_KEY]
    if (raw === null && !Object.keys(restored.values).length) return null
    return JSON.stringify(restored)
}
