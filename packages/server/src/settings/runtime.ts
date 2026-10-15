// Runtime settings: saved values apply without a restart.
// The process that saved them sees the new value at once. Every other process that reads one of these
// values (the HTTP server and a queue worker) re-reads the settings file at least every RUNTIME_STALE_MS.
// The host environment still wins. A host value outside the allowed range is clamped when it is enforced.
import { settingFor } from './registry'
import { readSettingsFile, encryptionKeySync } from './store'

type Env = Record<string, string | undefined>

export const RUNTIME_STALE_MS = 5000

export interface LimitSpec {
    key: string
    fallback: number
    min: number
    max: number
}

export const LOGIN_FAILURE_LIMIT_KEY = 'CUTTLELY_LOGIN_FAILURE_LIMIT'
export const SESSION_IDLE_MINUTES_KEY = 'CUTTLELY_SESSION_IDLE_MINUTES'
export const SESSION_ABSOLUTE_HOURS_KEY = 'CUTTLELY_SESSION_ABSOLUTE_HOURS'
export const DRAIN_TIMEOUT_MS_KEY = 'CUTTLELY_DRAIN_TIMEOUT_MS'

export const RUNTIME_LIMITS: LimitSpec[] = [
    { key: LOGIN_FAILURE_LIMIT_KEY, fallback: 10, min: 3, max: 50 },
    { key: SESSION_IDLE_MINUTES_KEY, fallback: 720, min: 15, max: 1440 },
    { key: SESSION_ABSOLUTE_HOURS_KEY, fallback: 168, min: 1, max: 720 },
    { key: DRAIN_TIMEOUT_MS_KEY, fallback: 25000, min: 5000, max: 300000 }
]

const SECRET_PARTS = new Set(['SECRET', 'PASSWORD', 'TOKEN', 'CREDENTIAL', 'SECRETKEY'])

interface BoundSource {
    dir: string
    hostKeys: string[]
}

interface Snapshot {
    at: number
    dir: string
    values: Record<string, string>
}

let source: BoundSource | null = null
let snapshot: Snapshot | null = null

export function limitSpec(key: string): LimitSpec | undefined {
    return RUNTIME_LIMITS.find((spec) => spec.key === key)
}

export function isRuntimeKey(key: string): boolean {
    return Boolean(settingFor(key)?.runtime) || Boolean(limitSpec(key))
}

/**
 * Secret settings never keep an old or new value in history.
 * A known setting uses its registry type. An unknown name is secret when a part of the name is a secret word,
 * so a kept-out password is still redacted.
 */
export function isSecretSettingKey(key: string): boolean {
    const setting = settingFor(key)
    if (setting) return setting.type === 'secret'
    const parts = key.toUpperCase().split('_').filter(Boolean)
    if (parts.some((part) => SECRET_PARTS.has(part))) return true
    for (let index = 0; index < parts.length - 1; index += 1) {
        if (parts[index] === 'API' && parts[index + 1] === 'KEY') return true
    }
    return false
}

export function clampLimit(spec: LimitSpec, raw: string | undefined): number {
    if (raw === undefined || raw.trim() === '' || !/^\d+$/.test(raw.trim())) return spec.fallback
    const value = Number(raw)
    if (!Number.isInteger(value)) return spec.fallback
    if (value < spec.min) return spec.min
    if (value > spec.max) return spec.max
    return value
}

/** The directory and host keys from process start. Tests call this with a temporary folder. */
export function bindRuntimeSource(dir: string, hostKeys: readonly string[]): void {
    source = { dir, hostKeys: [...hostKeys] }
}

export function unbindRuntimeSource(): void {
    source = null
    snapshot = null
}

/** The process that just saved: the next read sees these values, with no wait. */
export function publishRuntime(
    env: Env,
    hostKeys: ReadonlySet<string>,
    fileValues: Record<string, string>,
    dir: string,
    now = Date.now()
): void {
    for (const spec of RUNTIME_LIMITS) {
        if (hostKeys.has(spec.key)) continue
        const value = fileValues[spec.key]
        if (value && value.trim()) env[spec.key] = value
        else delete env[spec.key]
    }
    snapshot = { at: now, dir, values: pickRuntime(fileValues) }
}

function pickRuntime(values: Record<string, string>): Record<string, string> {
    const picked: Record<string, string> = {}
    for (const spec of RUNTIME_LIMITS) {
        const value = values[spec.key]
        if (value && value.trim()) picked[spec.key] = value
    }
    return picked
}

function fileValues(dir: string, now: number): Record<string, string> {
    if (snapshot && snapshot.dir === dir && now - snapshot.at < RUNTIME_STALE_MS) return snapshot.values
    let values: Record<string, string> = {}
    try {
        values = pickRuntime(readSettingsFile(dir, encryptionKeySync()).values)
    } catch {
        values = snapshot && snapshot.dir === dir ? snapshot.values : {}
    }
    snapshot = { at: now, dir, values }
    if (source && source.dir === dir) {
        for (const spec of RUNTIME_LIMITS) {
            if (source.hostKeys.includes(spec.key)) continue
            if (values[spec.key]) process.env[spec.key] = values[spec.key]
            else delete process.env[spec.key]
        }
    }
    return values
}

export function runtimeNumber(spec: LimitSpec, env: Env = process.env, now = Date.now()): number {
    const bound = env === process.env ? source : null
    const host = new Set(bound?.hostKeys ?? [])
    const fromEnv = env[spec.key]
    if (host.has(spec.key)) return clampLimit(spec, fromEnv)
    if (bound?.dir) {
        const file = fileValues(bound.dir, now)
        const fromFile = file[spec.key]
        if (fromFile) return clampLimit(spec, fromFile)
    }
    if (fromEnv && fromEnv.trim()) return clampLimit(spec, fromEnv)
    return spec.fallback
}

export function loginFailureLimit(env: Env = process.env, now = Date.now()): number {
    return runtimeNumber(RUNTIME_LIMITS[0], env, now)
}

export function sessionIdleMinutes(env: Env = process.env, now = Date.now()): number {
    return runtimeNumber(RUNTIME_LIMITS[1], env, now)
}

export function sessionAbsoluteHours(env: Env = process.env, now = Date.now()): number {
    return runtimeNumber(RUNTIME_LIMITS[2], env, now)
}

export function drainTimeoutLimit(env: Env = process.env, now = Date.now()): number {
    return runtimeNumber(RUNTIME_LIMITS[3], env, now)
}

/** True when idle minutes fit inside the absolute lifetime. */
export function idleFitsAbsolute(idleMinutes: number, absoluteHours: number): boolean {
    return idleMinutes * 60 <= absoluteHours * 3600
}

function effectiveLimit(
    spec: LimitSpec,
    env: Env,
    hostKeys: ReadonlySet<string>,
    file: Record<string, string>,
    normalized: Record<string, string>
): number {
    const fromEnv = env[spec.key]
    if (hostKeys.has(spec.key) && fromEnv && fromEnv.trim()) return clampLimit(spec, fromEnv)
    if (Object.prototype.hasOwnProperty.call(normalized, spec.key)) {
        const next = normalized[spec.key]
        if (!next) return spec.fallback
        return clampLimit(spec, next)
    }
    const fromFile = file[spec.key]
    if (fromFile) return clampLimit(spec, fromFile)
    return spec.fallback
}

/** The pair after this save. Null when the save does not touch either session lifetime. */
export function sessionLifetimeConflict(
    env: Env,
    hostKeys: ReadonlySet<string>,
    file: Record<string, string>,
    normalized: Record<string, string>
): { key: string; message: string } | null {
    if (!(SESSION_IDLE_MINUTES_KEY in normalized) && !(SESSION_ABSOLUTE_HOURS_KEY in normalized)) return null
    const idle = effectiveLimit(RUNTIME_LIMITS[1], env, hostKeys, file, normalized)
    const absolute = effectiveLimit(RUNTIME_LIMITS[2], env, hostKeys, file, normalized)
    if (idleFitsAbsolute(idle, absolute)) return null
    const key = SESSION_IDLE_MINUTES_KEY in normalized ? SESSION_IDLE_MINUTES_KEY : SESSION_ABSOLUTE_HOURS_KEY
    return { key, message: 'Idle time cannot be longer than the absolute session lifetime.' }
}
