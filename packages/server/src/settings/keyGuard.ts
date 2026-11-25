import type { DataSource } from 'typeorm'
import { forCredentialGeneration, credentialEnvelopeGeneration, newCredentialGeneration } from './credentialEnvelope'
import { guardedEncryptionKeyOverwrite, requiresEncryptionKeyOverride } from './settingAlias'
import { encryptionKeySync } from './store'

const TABLE = 'cuttlely_installation_key'
const LABEL = 'cuttlely-installation-key-v1'
const CONTEXT = ['installation', 'encryption-key'] as const

export class InstallationKeyGuardError extends Error {}

function sealMarker(key: string): string {
    return forCredentialGeneration(key, newCredentialGeneration()).seal(LABEL, CONTEXT)
}

function matchesMarker(marker: unknown, key: string): boolean {
    if (typeof marker !== 'string') return false
    try {
        return forCredentialGeneration(key, credentialEnvelopeGeneration(marker)).open(marker, CONTEXT) === LABEL
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
