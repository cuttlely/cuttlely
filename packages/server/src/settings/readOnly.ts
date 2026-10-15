// Status for env-only settings. The returned object is key, set, source, and readOnly.
// A value, its length, a hash, a path, a host, or a connection string is never copied onto it.
import fs from 'fs'
import path from 'path'
import { READ_ONLY_SETTINGS, ReadOnlyDef, readOnlyDef } from './registry'

export type ReadOnlySource = 'env' | 'file' | 'default' | 'unset'

export interface ReadOnlyStatus {
    key: string
    set: boolean
    source: ReadOnlySource
    readOnly: true
}

type Env = Record<string, string | undefined>

const PUBLIC_KEYS = ['key', 'set', 'source', 'readOnly'] as const

function trimmed(env: Env, key: string): string {
    const raw = env[key]
    if (typeof raw !== 'string') return ''
    return raw.trim()
}

function isPort(value: string): boolean {
    if (!/^[1-9]\d{0,4}$/.test(value)) return false
    const port = Number(value)
    return port >= 1 && port <= 65535
}

function isDirectory(value: string): boolean {
    if (!value || value.includes('\0')) return false
    try {
        return fs.statSync(value).isDirectory()
    } catch {
        return false
    }
}

function isRedisUrl(value: string): boolean {
    try {
        const url = new URL(value)
        return (url.protocol === 'redis:' || url.protocol === 'rediss:') && Boolean(url.hostname)
    } catch {
        return false
    }
}

function isBase64Payload(value: string): boolean {
    if (value.length < 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
    const decoded = Buffer.from(value, 'base64')
    if (decoded.length === 0) return false
    return decoded.toString('base64') === value
}

function envConfigured(def: ReadOnlyDef, value: string): boolean {
    if (!value || value.includes('\0')) return false
    switch (def.check) {
        case 'nonblank':
        case 'secret-file':
            return true
        case 'port':
            return isPort(value)
        case 'directory':
            return isDirectory(value)
        case 'redis-url':
            return isRedisUrl(value)
        case 'base64':
            return isBase64Payload(value)
        case 'bool':
            return value === 'true' || value === 'false'
        case 'mode':
            return value === 'queue' || value === 'main'
        case 'storage-type':
            return value === 'aws'
        default:
            return false
    }
}

/** A non-empty secret file under a configured SECRETKEY_PATH. Does not create the file or the directory. */
function secretFileConfigured(def: ReadOnlyDef, env: Env): boolean {
    if (!def.secretFile || def.secretFile.includes('\0') || def.secretFile.includes('/') || def.secretFile.includes('\\')) return false
    const dir = trimmed(env, 'SECRETKEY_PATH')
    if (!isDirectory(dir)) return false
    try {
        const file = path.join(dir, def.secretFile)
        const text = fs.readFileSync(file, 'utf8')
        return text.trim() !== ''
    } catch {
        return false
    }
}

function row(key: string, set: boolean, source: ReadOnlySource): ReadOnlyStatus {
    return { key, set, source, readOnly: true }
}

export function readOnlyStatus(env: Env, def: ReadOnlyDef): ReadOnlyStatus {
    const value = trimmed(env, def.key)
    if (def.check === 'secret-file') {
        if (envConfigured(def, value)) return row(def.key, true, 'env')
        if (secretFileConfigured(def, env)) return row(def.key, true, 'file')
        return row(def.key, false, 'unset')
    }
    if (!value) return row(def.key, false, def.whenUnset)
    if (envConfigured(def, value)) return row(def.key, true, 'env')
    return row(def.key, false, 'unset')
}

/** The public row. Only the four status fields are copied. */
export function publicReadOnlyStatus(status: ReadOnlyStatus): ReadOnlyStatus {
    const source: ReadOnlySource =
        status.source === 'env' || status.source === 'file' || status.source === 'default' ? status.source : 'unset'
    const out: ReadOnlyStatus = { key: status.key, set: status.set === true, source, readOnly: true }
    for (const key of Object.keys(out)) {
        if (!PUBLIC_KEYS.includes(key as (typeof PUBLIC_KEYS)[number])) delete (out as unknown as Record<string, unknown>)[key]
    }
    return out
}

export function listReadOnlyStatus(env: Env): ReadOnlyStatus[] {
    return READ_ONLY_SETTINGS.map((def) => publicReadOnlyStatus(readOnlyStatus(env, def)))
}

export function readOnlyStatusFor(env: Env, key: string): ReadOnlyStatus | undefined {
    const def = readOnlyDef(key)
    if (!def) return undefined
    return publicReadOnlyStatus(readOnlyStatus(env, def))
}
