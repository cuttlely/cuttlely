import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import type { DataSource } from 'typeorm'
import { guardedEncryptionKeyOverwrite, requiresEncryptionKeyOverride } from './settingAlias'
import { encryptionKeySync } from './store'

const TABLE = 'cuttlely_installation_key'
const LABEL = Buffer.from('cuttlely-installation-key-v1')
const MARKER = /^[a-f0-9]{56}:[a-f0-9]{32}:[a-f0-9]+$/

export class InstallationKeyGuardError extends Error {}

function sealMarker(key: string): string {
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', scryptSync(key, salt, 32), iv)
    const data = Buffer.concat([cipher.update(LABEL), cipher.final()])
    return [Buffer.concat([salt, iv]), cipher.getAuthTag(), data].map((part) => part.toString('hex')).join(':')
}

function matchesMarker(marker: unknown, key: string): boolean {
    if (typeof marker !== 'string' || marker.length !== 90 + LABEL.length * 2 || !MARKER.test(marker)) return false
    const [header, tag, data] = marker.split(':').map((part) => Buffer.from(part, 'hex'))
    try {
        const decipher = createDecipheriv('aes-256-gcm', scryptSync(key, header.subarray(0, 16), 32), header.subarray(16))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(data), decipher.final()]).equals(LABEL)
    } catch {
        return false
    }
}

export async function verifyInstallationKey(source: DataSource, warn: (message: string) => void, env = process.env): Promise<void> {
    const required = requiresEncryptionKeyOverride(env)
    const runner = source.createQueryRunner()
    let issue: string | undefined
    try {
        if (!(await runner.hasTable(TABLE))) {
            if (!required) return
            await runner.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, marker VARCHAR(160) NOT NULL)`)
        }
        const read = async () => (await runner.query(`SELECT marker FROM ${TABLE} WHERE id = 1`))[0]
        let record = await read()
        if (!record && !required) return
        const key = required ? guardedEncryptionKeyOverwrite(env) : encryptionKeySync(env)
        if (!record && key) {
            await source
                .createQueryBuilder(runner)
                .insert()
                .into(TABLE)
                .values({ id: 1, marker: sealMarker(key) })
                .orIgnore()
                .execute()
            record = await read()
        }
        if (!key || !matchesMarker(record?.marker, key)) {
            issue = 'The installation encryption key could not be verified. Restore the key recorded for this database.'
        }
    } catch {
        issue = 'The installation encryption-key verifier could not be read or initialized.'
    } finally {
        await runner.release()
    }
    if (!issue) return
    if (required) throw new InstallationKeyGuardError(issue)
    warn(issue)
}
