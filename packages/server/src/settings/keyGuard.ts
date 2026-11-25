import type { DataSource } from 'typeorm'
import { forCredentialGeneration, credentialEnvelopeGeneration, newCredentialGeneration } from './credentialEnvelope'
import { requireVerifiedSettingsSelection } from './postgres'
import { guardedEncryptionKeyOverwrite, requiresEncryptionKeyOverride } from './settingAlias'
import { encryptionKeySync } from './store'

const TABLE = 'cuttlely_installation_key'
const LABEL = 'cuttlely-installation-key-v1'
const CONTEXT = ['installation', 'encryption-key'] as const
const ACTIVATION_CONTEXT = ['installation', 'credential-generation'] as const

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
    requireVerifiedSettingsSelection()
    const generation = env.CUTTLELY_CREDENTIAL_GENERATION
    const required = requiresEncryptionKeyOverride(env)
    const runner = source.createQueryRunner()
    let issue: string | undefined
    try {
        if (!(await runner.hasTable(TABLE))) {
            if (generation) throw new InstallationKeyGuardError('The requested credential generation is not staged for this database.')
            if (!required) return
            await runner.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, marker VARCHAR(160) NOT NULL)`)
        }
        const [activation] = await runner.query(`SELECT marker FROM ${TABLE} WHERE id = 2`)
        if (activation || generation) {
            const key = guardedEncryptionKeyOverwrite(env)
            if (!generation || !key?.trim() || !activation?.marker) {
                throw new InstallationKeyGuardError('The host configuration does not match the staged credential generation.')
            }
            try {
                const codec = forCredentialGeneration(key, generation)
                if (codec.open(activation.marker, ACTIVATION_CONTEXT) !== generation) throw new Error()
            } catch {
                throw new InstallationKeyGuardError('The host configuration does not match the staged credential generation.')
            }
            return
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
    } catch (error) {
        if (error instanceof InstallationKeyGuardError) throw error
        issue = 'The installation encryption-key verifier could not be read or initialized.'
    } finally {
        await runner.release()
    }
    if (!issue) return
    if (required || generation) throw new InstallationKeyGuardError(issue)
    warn(issue)
}
