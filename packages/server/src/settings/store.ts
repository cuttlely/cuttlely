// The admin settings file: <CUTTLELY_DATA_DIR>/settings/server.json (owner-only permissions).
// Secret values are encrypted with the same key and cipher as Credentials and are never written in plain text.
// A file that cannot be read never stops start-up: it is ignored, and the reason is kept for the Server settings page.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { AES, enc } from 'crypto-js'
import { isKeptOut, settingFor } from './registry'
import { encryptionKeyOverwrite } from './settingAlias'
import { isBlank } from './resolve'

export const SETTINGS_FILE = 'server.json'
export const LAST_GOOD_FILE = 'server.last-good.json'
export const HISTORY_FILE = 'history.jsonl'
export const FILE_VERSION = 1
const KEY_CHECK_TEXT = 'server-settings-key-check'

type Env = Record<string, string | undefined>

export type StoredValue = string | { secret: string }

export interface SettingsFile {
    version: number
    /** Encrypted marker, to tell a wrong key from a damaged value. */
    keyCheck?: string
    updatedAt?: string
    updatedBy?: string
    values: Record<string, StoredValue>
}

export interface ReadResult {
    exists: boolean
    values: Record<string, string>
    /** Secrets that are in the file but cannot be decrypted (lost or changed key). They count as not set. */
    unreadable: string[]
    /** Plain-language problems, never containing a value. */
    problems: string[]
    updatedAt?: string
    updatedBy?: string
}

/** The settings folder. The start script always sets CUTTLELY_DATA_DIR; the fallback is <checkout>/.cuttlely, the same as the start script's default. */
export function settingsDir(env: Env = process.env): string {
    const data = (env.CUTTLELY_DATA_DIR || '').trim()
    return data ? path.join(data, 'settings') : path.resolve(__dirname, '..', '..', '..', '..', '.cuttlely', 'settings')
}

/** The credential encryption key, read without waiting: the override value, or the key file. AWS-held keys are not readable here. */
export function encryptionKeySync(env: Env = process.env): string | null {
    // Differing overwrite names throw. Guessing either value would decrypt stored credentials with the wrong key.
    // A blank overwrite, including spaces, still falls through to the key file, as it does today.
    const override = encryptionKeyOverwrite(env)
    if (!isBlank(override)) return String(override)
    const candidates = [
        env.SECRETKEY_PATH ? path.join(env.SECRETKEY_PATH, 'encryption.key') : '',
        path.resolve(__dirname, '..', '..', 'encryption.key'),
        path.join(os.homedir(), '.cuttlely', 'encryption.key')
    ].filter(Boolean)
    for (const candidate of candidates) {
        try {
            const key = fs.readFileSync(candidate, 'utf8')
            if (key.trim()) return key
        } catch {
            // try the next place
        }
    }
    return null
}

export function encryptSecret(value: string, key: string): string {
    return AES.encrypt(value, key).toString()
}

export function decryptSecret(cipher: string, key: string): string | null {
    try {
        const plain = AES.decrypt(cipher, key).toString(enc.Utf8)
        return plain === '' ? null : plain
    } catch {
        return null
    }
}

export function readSettingsFile(dir: string, key: string | null, file = SETTINGS_FILE): ReadResult {
    const result: ReadResult = { exists: false, values: {}, unreadable: [], problems: [] }
    const full = path.join(dir, file)
    let raw: string
    try {
        raw = fs.readFileSync(full, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            result.problems.push(`The settings file could not be opened (${(error as NodeJS.ErrnoException).code}).`)
        return result
    }
    result.exists = true
    let parsed: SettingsFile
    try {
        parsed = JSON.parse(raw) as SettingsFile
    } catch {
        result.problems.push('The settings file is not valid JSON, so it was ignored.')
        return result
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.values !== 'object' || parsed.values === null) {
        result.problems.push('The settings file has no values, so it was ignored.')
        return result
    }
    if (parsed.version !== FILE_VERSION) {
        result.problems.push(
            `The settings file is version ${String(parsed.version)}; this Cuttlely reads version ${FILE_VERSION}, so it was ignored.`
        )
        return result
    }
    result.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined
    result.updatedBy = typeof parsed.updatedBy === 'string' ? parsed.updatedBy : undefined
    const keyWorks = key !== null && (!parsed.keyCheck || decryptSecret(parsed.keyCheck, key) === KEY_CHECK_TEXT)
    for (const [name, stored] of Object.entries(parsed.values)) {
        const setting = settingFor(name)
        if (!setting) {
            result.problems.push(
                isKeptOut(name)
                    ? `${name} cannot be set from Server settings, so it was ignored.`
                    : `${name} is not a setting this Cuttlely knows, so it was ignored.`
            )
            continue
        }
        if (setting.type === 'secret') {
            if (!stored || typeof stored !== 'object' || typeof stored.secret !== 'string') {
                result.problems.push(`${name} is a secret but was not stored encrypted, so it was ignored.`)
                continue
            }
            const plain = keyWorks && key ? decryptSecret(stored.secret, key) : null
            if (plain === null) result.unreadable.push(name)
            else result.values[name] = plain
            continue
        }
        if (typeof stored !== 'string') {
            result.problems.push(`${name} has a value of the wrong kind, so it was ignored.`)
            continue
        }
        result.values[name] = stored
    }
    if (result.unreadable.length) {
        result.problems.push(
            `${
                result.unreadable.length === 1 ? 'One secret' : `${result.unreadable.length} secrets`
            } could not be read with this server's encryption key. Enter ${result.unreadable.length === 1 ? 'it' : 'them'} again.`
        )
    }
    return result
}

/** Writes the whole file atomically with owner-only permissions. Blank values are dropped; secrets are encrypted. */
export function writeSettingsFile(
    dir: string,
    values: Record<string, string>,
    options: { key: string; by?: string; now?: Date; file?: string; preserve?: Record<string, StoredValue> }
): SettingsFile {
    const stored: Record<string, StoredValue> = {}
    // Stored entries kept exactly as they are, such as secrets this key cannot read and nobody changed.
    for (const [name, value] of Object.entries(options.preserve ?? {})) {
        if (settingFor(name) && !Object.prototype.hasOwnProperty.call(values, name)) stored[name] = value
    }
    for (const name of Object.keys(values).sort()) {
        const setting = settingFor(name)
        if (!setting) throw new Error(`${name} is not a setting this Cuttlely knows.`)
        const value = values[name]
        if (isBlank(value)) continue
        stored[name] = setting.type === 'secret' ? { secret: encryptSecret(value, options.key) } : value
    }
    const sorted: Record<string, StoredValue> = {}
    for (const name of Object.keys(stored).sort()) sorted[name] = stored[name]
    const content: SettingsFile = {
        version: FILE_VERSION,
        keyCheck: encryptSecret(KEY_CHECK_TEXT, options.key),
        updatedAt: (options.now ?? new Date()).toISOString(),
        updatedBy: options.by,
        values: sorted
    }
    writeFileAtomic(dir, options.file ?? SETTINGS_FILE, JSON.stringify(content, null, 2) + '\n')
    return content
}

/** The stored (still encrypted) entries of the file, for keeping secrets this key cannot read. */
export function readStoredValues(dir: string, file = SETTINGS_FILE): Record<string, StoredValue> {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as SettingsFile
        return parsed && typeof parsed.values === 'object' && parsed.values ? parsed.values : {}
    } catch {
        return {}
    }
}

const settingsWriteListeners = new Set<() => void>()

function notifySettingsWrite(): void {
    for (const listener of settingsWriteListeners) listener()
}

/** Called after server.json is saved. Each listener drops its cached read. */
export function onSettingsFileWritten(listener: () => void): void {
    settingsWriteListeners.add(listener)
}

export function writeFileAtomic(dir: string, file: string, text: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const target = path.join(dir, file)
    const temp = path.join(dir, `.${file}.${process.pid}.${Date.now()}.tmp`)
    fs.writeFileSync(temp, text, { mode: 0o600 })
    fs.renameSync(temp, target)
    try {
        fs.chmodSync(target, 0o600)
    } catch {
        // some volumes do not keep permissions
    }
    if (file === SETTINGS_FILE) notifySettingsWrite()
}

/** Copies the current file to the last-good copy, byte for byte. */
export function saveLastGood(dir: string): boolean {
    try {
        const text = fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')
        writeFileAtomic(dir, LAST_GOOD_FILE, text)
        return true
    } catch {
        return false
    }
}
