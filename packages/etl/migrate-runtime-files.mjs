// The installation key comes from the host and survives replacement independently of PostgreSQL.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { guardedEncryptionKeyOverwrite } from '../../scripts/setting-alias.cjs'
import { fingerprint, readSnapshotSource, restoreSnapshot } from './migrate-profile-prompts.mjs'

const artifactDirs = new Set([
    'audio',
    'browser-use',
    'documents',
    'exec',
    'images',
    'partials',
    'scratch',
    'screenshots',
    'spillover',
    'videos'
])
const runtimeFiles = new Set([
    '.env',
    'config.yaml',
    'harness-roster.json',
    'memories/MEMORY.md',
    'memories/USER.md',
    'skills/.usage.json',
    'cache/oauth_heal_clean.json',
    'cache/mcp_schema_cache.json'
])

export function recoverableRuntimePath(name) {
    if (typeof name !== 'string' || /[\\\x00-\x1f:]/.test(name)) return false
    const parts = name.split('/')
    if (parts.some((part) => !part || part === '.' || part === '..')) return false
    if (parts[0] === 'profiles') {
        if (!/^[a-z0-9_-]+$/i.test(parts[1] || '')) return false
        parts.splice(0, 2)
    }
    if (runtimeFiles.has(parts.join('/'))) return true
    if (parts[0] === 'skills') return parts.length === 4 && parts[1] === 'harness-playbooks' && parts[3] === 'SKILL.md'
    return (
        parts[0] === 'cache' &&
        artifactDirs.has(parts[1]) &&
        !parts.some((part) => /(?:\.sqlite\d*|\.db)(?:$|-)|-(?:wal|shm|journal)$|^Singleton(?:Lock|Socket|Cookie)$|^LOCK$/i.test(part))
    )
}

export function runtimeSnapshotKey(generation) {
    const installationKey = guardedEncryptionKeyOverwrite(process.env)
    if (!installationKey?.trim())
        throw Object.assign(
            new Error('Supply the installation encryption key on the web server and workers before upgrading runtime files.'),
            { status: 409 }
        )
    return hkdfSync('sha256', installationKey, 'Cuttlely runtime file backup v1', generation, 32)
}

export async function inventoryRuntimeFiles(entries) {
    const result = []
    for (const entry of entries) {
        result.push(entry.directory ? entry : { ...entry, sha256: await fingerprint(entry.name, recoverableRuntimePath) })
    }
    return result
}

const key = (generation, name) => ['runtime-file-backup', generation, ...name.split('/')]

async function* decode(files, generation, secret, { name, iv, tag }) {
    const cipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(iv, 'hex'))
    cipher.setAAD(Buffer.from(name))
    cipher.setAuthTag(Buffer.from(tag, 'hex'))
    for await (const part of files.stream(key(generation, name))) yield cipher.update(part)
    yield cipher.final()
}

export async function copyRuntimeFiles(files, entries, generation) {
    if (!entries?.length) return []
    const secret = runtimeSnapshotKey(generation)
    const copied = []
    for (const entry of entries) {
        if (entry.directory) {
            copied.push(entry)
            continue
        }
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', secret, iv)
        cipher.setAAD(Buffer.from(entry.name))
        const encrypted = async function* () {
            for await (const part of readSnapshotSource(entry.name, recoverableRuntimePath)) yield cipher.update(part)
            yield cipher.final()
        }
        await files.put(key(generation, entry.name), encrypted())
        const saved = { ...entry, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') }
        const digest = createHash('sha256')
        for await (const part of decode(files, generation, secret, saved)) digest.update(part)
        if (digest.digest('hex') !== entry.sha256) throw new Error('Runtime file changed during the verified copy: ' + entry.name)
        copied.push(saved)
    }
    return copied
}

export async function restoreRuntimeFiles(files, entries, generation) {
    if (!entries?.length) return
    const secret = runtimeSnapshotKey(generation)
    await restoreSnapshot(entries, generation, 'runtime-files', recoverableRuntimePath, (entry) => decode(files, generation, secret, entry))
}
