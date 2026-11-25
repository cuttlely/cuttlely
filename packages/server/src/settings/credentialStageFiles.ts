import { AUTHKIT_PROOF_FILE } from './authkit-proof'
import type { CredentialEnvelope, RecordContext } from './credentialEnvelope'
import { rewrapCredentialRecord } from './credentialRewrap'
import { PREVIOUS_DATABASE_FILE } from './database-summary'
import { POSTGRES_SETTINGS_FILES } from './postgres'
import { settingFor } from './registry'
import { ROLLED_BACK_FILE } from './safeboot'
import { LAST_GOOD_FILE, SETTINGS_FILE } from './store'

type Source = Parameters<typeof rewrapCredentialRecord>[1]
const settingsFiles = new Set([SETTINGS_FILE, LAST_GOOD_FILE, ROLLED_BACK_FILE, PREVIOUS_DATABASE_FILE])
const roleFile = /^analyst-role(?:-([a-f0-9]{10}))?\.enc$/

function jsonRecord(text: string): Record<string, unknown> {
    const result = JSON.parse(text)
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Unexpected staging document format.')
    return result
}

/** Fold managed settings documents into a replacement set. Source copies are retained for rollback. */
export function stageSettingsDocuments(
    documents: ReadonlyMap<string, string>,
    source: Source,
    destination: CredentialEnvelope
): { staged: Map<string, string>; rewrapped: number; requiresRetest: number } {
    const staged = new Map<string, string>()
    let rewrapped = 0
    let requiresRetest = 0
    for (const [file, content] of documents) {
        if (!POSTGRES_SETTINGS_FILES.has(file)) throw new Error('Unrecognized settings document.')
        if (file === AUTHKIT_PROOF_FILE) {
            if (!/^[a-f0-9]{64}$/.test(String(jsonRecord(content).fingerprint))) throw new Error('Invalid AuthKit proof.')
            requiresRetest++
            continue
        }
        if (!settingsFiles.has(file)) {
            staged.set(file, content)
            continue
        }
        const doc = jsonRecord(content)
        if (doc.version !== 1 || !doc.values || typeof doc.values !== 'object' || Array.isArray(doc.values)) {
            throw new Error('Unexpected saved settings format.')
        }
        const values = doc.values as Record<string, unknown>
        const rewrap = (value: unknown, context: RecordContext, validate: (p: string) => void) => {
            const result = rewrapCredentialRecord(value, source, destination, context, validate)
            rewrapped++
            return result
        }
        // The current and recovery copies intentionally use the same context so safe boot can promote a copy verbatim.
        if (doc.keyCheck !== undefined) {
            doc.keyCheck = rewrap(doc.keyCheck, ['server-settings', 'key-check'], (plaintext) => {
                if (plaintext !== 'server-settings-key-check') throw new Error('Invalid saved settings key check.')
            })
        }
        for (const [name, value] of Object.entries(values)) {
            const setting = settingFor(name)
            if (typeof value === 'string' && setting?.type !== 'secret') continue
            if (setting?.type !== 'secret' || !doc.keyCheck || typeof value !== 'object' || !value || !('secret' in value)) {
                throw new Error('Unrecognized encrypted server setting.')
            }
            values[name] = {
                secret: rewrap(value.secret, ['server-setting', name], (plaintext) => {
                    if (!plaintext.trim()) throw new Error('Invalid saved setting secret.')
                })
            }
        }
        staged.set(file, JSON.stringify(doc, null, 2) + '\n')
    }
    return { staged, rewrapped, requiresRetest }
}

export function stageAnalystRoleFiles(
    files: ReadonlyMap<string, string>,
    source: Source,
    destination: CredentialEnvelope
): Map<string, string> {
    const staged = new Map<string, string>()
    const readSource = 'passphrase' in source ? { passphrase: source.passphrase.trim() } : source
    for (const [file, value] of files) {
        const match = roleFile.exec(file)
        if (!match) throw new Error('Unrecognized Analyst role file.')
        const role = match[1] ? 'analyst_reader_' + match[1] : 'analyst_reader'
        staged.set(
            file,
            rewrapCredentialRecord(value, readSource, destination, ['analyst-role', role], (plaintext) => {
                const record = jsonRecord(plaintext)
                if (record.role !== role || typeof record.password !== 'string' || !record.password) {
                    throw new Error('Invalid encrypted Analyst role record.')
                }
            })
        )
    }
    return staged
}
