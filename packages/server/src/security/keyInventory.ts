import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseFlow, queriesOnFlow, unreadableQueryNodes } from '../services/import-verify/stamps'
import { fileValuesToApply, hostSetKeys } from '../settings/resolve'
import { settingFor } from '../settings/registry'
import { readUnrotatedCredential } from '../settings/credentialRewrap'
import { forCredentialGeneration } from '../settings/credentialEnvelope'
import type { RecordContext } from '../settings/credentialEnvelope'
import { encryptionKeyOverwrite } from '../settings/settingAlias'
import { encryptionKeySync, LAST_GOOD_FILE, SETTINGS_FILE } from '../settings/store'
import { PREVIOUS_DATABASE_FILE } from '../settings/database-summary'
import { ROLLED_BACK_FILE } from '../settings/safeboot'
import { AUTHKIT_PROOF_FILE } from '../settings/authkit-proof'
import { Env, Rows, optionalFile, scanApplicationDatabase, settingsDocuments } from './keyInventorySources'

const settingsFiles = [SETTINGS_FILE, LAST_GOOD_FILE, ROLLED_BACK_FILE, PREVIOUS_DATABASE_FILE]
const digest = /^[a-f0-9]{64}$/
const roleName = /^analyst_reader(?:_[a-f0-9]{10})?$/
const counts = () => ({ readable: 0, external: 0, unreadable: 0, requiresReissue: 0, requiresRetest: 0 })
type Counts = ReturnType<typeof counts>
type OpenRecord = (ciphertext: unknown, context: RecordContext) => string

function output() {
    return {
        status: 'inspected' as 'inspected' | 'blocked',
        blockers: [] as string[],
        consumers: {
            credentials: counts(),
            customMcpAuth: counts(),
            webhookSecrets: counts(),
            serverSettingsSecrets: counts(),
            postgresSettingsDocuments: counts(),
            analystRoleRows: counts(),
            analystRoleFiles: counts(),
            inboundAccessKeys: counts(),
            pinnedQueryProofs: counts(),
            authKitProofs: counts()
        }
    }
}

export type KeyInventory = ReturnType<typeof output>

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid inventory record')
    return value as Record<string, unknown>
}

function json(text: string): Record<string, unknown> {
    return record(JSON.parse(text))
}

function inspect(counter: Counts, read: () => void): void {
    try {
        read()
        counter.readable++
    } catch {
        counter.unreadable++
    }
}

function optionalSecret(value: unknown): boolean {
    return value == null || value === ''
}

function inspectSettings(docs: Map<string, string>, open: OpenRecord, result: KeyInventory): Record<string, string> {
    const active: Record<string, string> = {}
    for (const file of settingsFiles) {
        const raw = docs.get(file)
        if (raw === undefined) continue
        try {
            const doc = json(raw)
            if (doc.version !== 1) throw new Error('Unknown settings format')
            if (doc.keyCheck !== undefined && open(doc.keyCheck, ['server-settings', 'key-check']) !== 'server-settings-key-check')
                throw new Error('Wrong settings key')
            for (const [name, value] of Object.entries(record(doc.values))) {
                const setting = settingFor(name)
                if (typeof value === 'string' && setting?.type !== 'secret') {
                    if (file === SETTINGS_FILE && setting && !setting.fixed) active[name] = value
                } else {
                    inspect(result.consumers.serverSettingsSecrets, () => {
                        if (setting?.type !== 'secret' || !doc.keyCheck) throw new Error('Unknown or unverified settings secret')
                        const plain = open(record(value).secret, ['server-setting', name])
                        if (file === SETTINGS_FILE) active[name] = plain
                    })
                }
            }
        } catch {
            result.consumers.serverSettingsSecrets.unreadable++
        }
    }
    const proof = docs.get(AUTHKIT_PROOF_FILE)
    if (proof !== undefined) {
        try {
            if (!digest.test(String(json(proof).fingerprint))) throw new Error('Invalid AuthKit proof')
            result.consumers.authKitProofs.requiresRetest++
        } catch {
            result.consumers.authKitProofs.unreadable++
        }
    }
    return active
}

function checkAnalystRole(value: unknown, role: unknown, open: OpenRecord): void {
    if (typeof role !== 'string' || !roleName.test(role)) throw new Error('Invalid Analyst role identity')
    const info = json(open(value, ['analyst-role', role]))
    if (info.role !== role || typeof info.password !== 'string' || !info.password) {
        throw new Error('Invalid Analyst role secret')
    }
}

function inspectAnalystFiles(env: Env, open: OpenRecord, result: KeyInventory): void {
    const dir = env.SECRETKEY_PATH?.trim() || path.join(os.homedir(), '.cuttlely')
    let files: string[]
    try {
        files = fs.readdirSync(dir)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
    }
    for (const name of files.filter((file) => /^analyst-role.*\.enc$/.test(file))) {
        inspect(result.consumers.analystRoleFiles, () => {
            const match = /^analyst-role(?:-([a-f0-9]{10}))?\.enc$/.exec(name)
            if (!match) throw new Error('Unknown Analyst role file')
            checkAnalystRole(optionalFile(path.join(dir, name)), match[1] ? 'analyst_reader_' + match[1] : 'analyst_reader', open)
        })
    }
}

function inspectCanvas(value: unknown, counter: Counts): void {
    if (optionalSecret(value)) return
    const flow = parseFlow(value)
    if (!flow || unreadableQueryNodes(flow).length) {
        counter.unreadable++
        return
    }
    for (const { pin } of queriesOnFlow(flow)) {
        if (pin.testedStamp === undefined || pin.testedStamp === '') continue
        if (typeof pin.testedStamp === 'string' && digest.test(pin.testedStamp)) counter.requiresRetest++
        else counter.unreadable++
    }
}

async function inspectApplicationRows(rows: Rows, postgres: boolean, open: OpenRecord, result: KeyInventory): Promise<void> {
    const c = result.consumers
    const tables = postgres
        ? await rows('SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = current_schema()')
        : await rows("SELECT name FROM sqlite_master WHERE type = 'table'")
    const names = new Set(tables.map(({ name }) => name))
    for (const table of ['credential', 'custom_mcp_server', 'chat_flow', 'flow_version_state', 'apikey_credential', 'apikey']) {
        if (!names.has(table)) throw new Error('Database schema is outdated')
    }

    for (const { id, encryptedData } of await rows('SELECT id, "encryptedData" FROM credential')) {
        if (typeof encryptedData === 'string' && /^FlowiseCredential_[A-Za-z0-9/_+=.@-]+$/.test(encryptedData)) c.credentials.external++
        else
            inspect(c.credentials, () => {
                json(open(encryptedData, ['credential', String(id)]))
            })
    }
    for (const { id, authConfig } of await rows('SELECT id, "authConfig" FROM custom_mcp_server WHERE "authConfig" IS NOT NULL')) {
        if (!optionalSecret(authConfig))
            inspect(c.customMcpAuth, () => {
                json(open(authConfig, ['custom-mcp', String(id)]))
            })
    }
    for (const { id, flowData, webhookSecret } of await rows('SELECT id, "flowData", "webhookSecret" FROM chat_flow')) {
        if (!optionalSecret(webhookSecret))
            inspect(c.webhookSecrets, () => {
                const value = json(open(webhookSecret, ['chat-webhook', String(id)]))
                if (typeof value.secret !== 'string' || !value.secret) throw new Error('Invalid webhook secret')
            })
        inspectCanvas(flowData, c.pinnedQueryProofs)
    }
    for (const { draftFlowData } of await rows('SELECT "draftFlowData" FROM flow_version_state WHERE "draftFlowData" IS NOT NULL')) {
        inspectCanvas(draftFlowData, c.pinnedQueryProofs)
    }
    const activeDigests = await rows(`
        SELECT c.digest
        FROM apikey_credential AS c
        INNER JOIN apikey AS a ON a.id = c."principalId"
        WHERE c."revokedAt" IS NULL AND a."disabledAt" IS NULL
          AND (c."expiresAt" IS NULL OR c."expiresAt" > CURRENT_TIMESTAMP)
          AND (a."expiresAt" IS NULL OR a."expiresAt" > CURRENT_TIMESTAMP)
    `)
    for (const { digest: value } of activeDigests) {
        if (typeof value === 'string' && digest.test(value)) c.inboundAccessKeys.requiresReissue++
        else c.inboundAccessKeys.unreadable++
    }
    if (postgres) {
        const [lookup] = await rows(
            "SELECT to_regclass('cuttlely_analyst_admin.role_secret') AS managed, to_regclass('public.role_secret') AS legacy"
        )
        if (lookup.managed && lookup.legacy) throw new Error('Ambiguous Analyst role store')
        const table = lookup.managed ? 'cuttlely_analyst_admin.role_secret' : lookup.legacy ? 'public.role_secret' : null
        if (table) {
            for (const { role, ciphertext } of await rows('SELECT role, ciphertext FROM ' + table)) {
                inspect(c.analystRoleRows, () => checkAnalystRole(ciphertext, role, open))
            }
        }
    }
}

export async function inventoryCredentialKey(host: Env): Promise<KeyInventory> {
    const result = output()
    try {
        if (host.SECRETKEY_STORAGE_TYPE?.trim().toLowerCase() === 'aws' && !encryptionKeyOverwrite(host)?.trim()) {
            result.blockers.push('AWS_KEY_PROVIDER')
            return { ...result, status: 'blocked' }
        }
        const key = encryptionKeySync(host)
        if (!key) {
            result.blockers.push('MISSING_INSTALLATION_KEY')
            return { ...result, status: 'blocked' }
        }
        const generation = host.CUTTLELY_CREDENTIAL_GENERATION
        const codec = generation ? forCredentialGeneration(key, generation) : undefined
        const open: OpenRecord = (ciphertext, context) => {
            if (typeof ciphertext !== 'string') throw new Error('Invalid encrypted record')
            return codec
                ? codec.open(ciphertext, context)
                : readUnrotatedCredential(ciphertext, context[0] === 'analyst-role' ? key.trim() : key, context)
        }
        try {
            const docs = await settingsDocuments(host, key)
            const saved = inspectSettings(docs, open, result)
            if (host.CUTTLELY_SERVER_SETTINGS_POSTGRES_URL?.trim()) result.consumers.postgresSettingsDocuments.readable = docs.size
            if (result.consumers.serverSettingsSecrets.unreadable) result.blockers.push('SETTINGS_DOCUMENT_UNREADABLE')
            else {
                const env = /^(1|true|yes|on)$/i.test(host.CUTTLELY_IGNORE_ADMIN_SETTINGS?.trim() ?? '')
                    ? host
                    : { ...host, ...fileValuesToApply(host, saved, hostSetKeys(host)) }
                if (!['sqlite', 'postgres'].includes(env.DATABASE_TYPE || 'sqlite')) result.blockers.push('UNSUPPORTED_DATABASE')
                else {
                    try {
                        await scanApplicationDatabase(env, (rows, postgres) => inspectApplicationRows(rows, postgres, open, result))
                    } catch {
                        result.blockers.push('APPLICATION_DATABASE_UNREADABLE')
                    }
                }
            }
        } catch {
            result.blockers.push('SETTINGS_STORAGE_UNREADABLE')
        }
        try {
            inspectAnalystFiles(host, open, result)
        } catch {
            result.blockers.push('ANALYST_FILES_UNREADABLE')
        }
    } catch {
        result.blockers.push('INSTALLATION_KEY_UNREADABLE')
    }
    if (Object.values(result.consumers).some((counter) => counter.unreadable)) result.blockers.push('UNREADABLE_CONSUMERS')
    if (result.blockers.length) result.status = 'blocked'
    return result
}
