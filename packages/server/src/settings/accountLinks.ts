// Invite and reset settings. Read on each use.
// A usable saved value overrides the environment, then the default.
// Numbers keep the link caps: below the minimum is raised, above the maximum is lowered.
// A blank, zero, negative, or non-integer is skipped. The mail password is never read from this file.
import { SETTINGS, SettingDef } from './registry'
import { isBlank } from './resolve'
import { encryptionKeySync, onSettingsFileWritten, readSettingsFile, settingsDir } from './store'
import { isEmailAddress } from './validate'

type Env = Record<string, string | undefined>

export const ACCOUNT_LINK_CACHE_MS = 5000

export type AccountSource = 'panel' | 'host' | 'default'

export interface ResolvedAccount {
    value: string
    source: AccountSource
}

const warned = new Set<string>()
let readWarned = false
let hooked = false
let cache: { at: number; stamp: string; values: Map<string, ResolvedAccount> } | null = null

function panelFirstSettings(): SettingDef[] {
    return SETTINGS.filter((setting) => setting.panelFirst)
}

function warnKey(key: string): void {
    if (warned.has(key)) return
    warned.add(key)
    console.warn(`[server]: ${key} is not a usable invite setting, so another value is used`)
}

function warnUnread(): void {
    if (readWarned) return
    readWarned = true
    console.warn('[server]: invite settings could not be read, so defaults are used')
}

function ensureHook(): void {
    if (hooked) return
    hooked = true
    onSettingsFileWritten(() => {
        cache = null
    })
}

/** Drops a cached read. A successful save of server.json does this on its own. */
export function invalidateAccountLinkCache(): void {
    cache = null
}

/** Tests start from an empty cache and an empty warning set. */
export function resetAccountLinksForTests(): void {
    cache = null
    warned.clear()
    readWarned = false
}

function ignored(env: Env): boolean {
    return ['1', 'true', 'yes', 'on'].includes(
        String(env.CUTTLELY_IGNORE_ADMIN_SETTINGS ?? '')
            .trim()
            .toLowerCase()
    )
}

function present(raw: string | undefined): string | null {
    if (raw === undefined || raw === null) return null
    const value = String(raw).trim()
    return value === '' ? null : value
}

/** A whole number. Leading zeros are allowed. Blank, floats, exponents, and signs are not. */
function wholeNumber(raw: string): number | null {
    if (!/^[0-9]+$/.test(raw)) return null
    if (raw.length > 16) return null
    const value = Number(raw)
    if (!Number.isSafeInteger(value)) return null
    return value
}

function interpret(setting: SettingDef, raw: string): string | null {
    if (setting.type === 'number') {
        const value = wholeNumber(raw)
        if (value === null || value <= 0) return null
        let next = value
        if (setting.min !== undefined && next < setting.min) next = setting.min
        if (setting.max !== undefined && next > setting.max) next = setting.max
        return String(next)
    }
    if (setting.type === 'switch') {
        if (raw === (setting.on ?? 'true') || raw === (setting.off ?? 'false')) return raw
        return null
    }
    if (setting.type === 'select') {
        if ((setting.options ?? []).some((option) => option.value === raw)) return raw
        return null
    }
    if (raw.length > 4000 || /[\r\n]/.test(raw)) return null
    if (setting.email && !isEmailAddress(raw)) return null
    return raw
}

function panelFile(env: Env): Record<string, string> {
    if (ignored(env)) return {}
    // A caller-supplied env with no data dir is a unit test. Do not read the checkout's settings file.
    if (env !== process.env && !(env.CUTTLELY_DATA_DIR || '').trim()) return {}
    try {
        const read = readSettingsFile(settingsDir(env), encryptionKeySync(env))
        if (read.problems.some((problem) => /not valid JSON|no values|this Cuttlely reads version/.test(problem))) warnUnread()
        return read.values
    } catch {
        warnUnread()
        return {}
    }
}

function pick(setting: SettingDef, env: Env, file: Record<string, string>): ResolvedAccount {
    const saved = present(file[setting.key])
    if (saved !== null) {
        const value = interpret(setting, saved)
        if (value !== null) return { value, source: 'panel' }
        warnKey(setting.key)
    }
    const host = present(env[setting.key])
    if (host !== null) {
        const value = interpret(setting, host)
        if (value !== null) return { value, source: 'host' }
        warnKey(setting.key)
    }
    return { value: setting.defaultValue ?? '', source: 'default' }
}

function envStamp(env: Env): string {
    const keys = panelFirstSettings().map((setting) => setting.key)
    return [env.CUTTLELY_DATA_DIR ?? '', env.CUTTLELY_IGNORE_ADMIN_SETTINGS ?? '', ...keys.map((key) => env[key] ?? '')].join('\0')
}

function compute(env: Env): Map<string, ResolvedAccount> {
    const file = panelFile(env)
    const out = new Map<string, ResolvedAccount>()
    for (const setting of panelFirstSettings()) out.set(setting.key, pick(setting, env, file))
    return out
}

export function accountLinkSnapshot(env: Env = process.env): Map<string, ResolvedAccount> {
    ensureHook()
    const stamp = envStamp(env)
    const now = Date.now()
    if (cache && cache.stamp === stamp && now - cache.at < ACCOUNT_LINK_CACHE_MS) return cache.values
    let values: Map<string, ResolvedAccount>
    try {
        values = compute(env)
    } catch {
        warnUnread()
        values = new Map(
            panelFirstSettings().map((setting) => [setting.key, { value: setting.defaultValue ?? '', source: 'default' as const }])
        )
    }
    cache = { at: now, stamp, values }
    return values
}

/** Environment the link issuer should read. Panel values replace host values. The mail password is copied from env only. */
export function effectiveAccountEnv(env: Env = process.env): Env {
    const snap = accountLinkSnapshot(env)
    const out: Env = { ...env }
    for (const setting of panelFirstSettings()) {
        const row = snap.get(setting.key)
        if (!row || (row.source === 'default' && row.value === '')) delete out[setting.key]
        else out[setting.key] = row?.value
    }
    if (isBlank(env.SMTP_PASSWORD)) delete out.SMTP_PASSWORD
    else out.SMTP_PASSWORD = env.SMTP_PASSWORD
    return out
}

/** True when the environment holds a mail password. A saved settings value does not count. */
export function smtpPasswordSet(env: Env = process.env): boolean {
    return !isBlank(env.SMTP_PASSWORD)
}
