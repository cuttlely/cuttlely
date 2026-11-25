import type { CredentialEnvelope, RecordContext } from './credentialEnvelope'
import { rewrapCredentialRecord } from './credentialRewrap'

type Source = { passphrase: string } | { envelope: CredentialEnvelope }
type Row = Record<string, unknown>

/** A dedicated connection to an offline staging copy. Queries and updates share one transaction. */
export interface CredentialStageDatabase {
    dialect: 'sqlite' | 'postgres'
    select(sql: string, parameters?: readonly string[]): Promise<Row[]>
    execute(sql: string, parameters?: readonly string[]): Promise<number>
}

const externalCredential = /^FlowiseCredential_[A-Za-z0-9/_+=.@-]+$/
const analystTables = ['cuttlely_analyst_admin.role_secret', 'public.role_secret'] as const

function jsonRecord(plaintext: string): Record<string, unknown> {
    const value = JSON.parse(plaintext)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an encrypted JSON record.')
    return value
}

interface Consumer {
    table: string
    field: string
    identity: string
    kind: string
    optional?: boolean
    external?: boolean
    validate(plaintext: string, id: string): void
}

const primaryConsumers: readonly Consumer[] = [
    { table: 'credential', field: 'encryptedData', identity: 'id', kind: 'credential', external: true, validate: jsonRecord },
    { table: 'custom_mcp_server', field: 'authConfig', identity: 'id', kind: 'custom-mcp', optional: true, validate: jsonRecord },
    {
        table: 'chat_flow',
        field: 'webhookSecret',
        identity: 'id',
        kind: 'chat-webhook',
        optional: true,
        validate(plaintext) {
            const { secret } = jsonRecord(plaintext)
            if (typeof secret !== 'string' || !secret) throw new Error('Invalid encrypted webhook record.')
        }
    }
]

async function listConsumers(db: CredentialStageDatabase): Promise<readonly Consumer[]> {
    if (db.dialect !== 'postgres') return primaryConsumers
    const [roles] = await db.select(
        "SELECT to_regclass('cuttlely_analyst_admin.role_secret') AS managed, to_regclass('public.role_secret') AS legacy"
    )
    if (roles.managed && roles.legacy) throw new Error('The Analyst role storage is ambiguous.')
    const table = roles.managed ? analystTables[0] : roles.legacy ? analystTables[1] : undefined
    if (!table) return primaryConsumers
    return [
        ...primaryConsumers,
        {
            table,
            field: 'ciphertext',
            identity: 'role',
            kind: 'analyst-role',
            validate(plaintext, role) {
                const record = jsonRecord(plaintext)
                if (
                    !/^analyst_reader(?:_[a-f0-9]{10})?$/.test(role) ||
                    record.role !== role ||
                    typeof record.password !== 'string' ||
                    !record.password
                ) {
                    throw new Error('Invalid encrypted Analyst role record.')
                }
            }
        }
    ]
}

/** Verify every row on the staging copy before committing. A malformed row rolls the entire copy back. */
export async function stageApplicationCredentialRecords(
    db: CredentialStageDatabase,
    source: Source,
    destination: CredentialEnvelope,
    generation?: string
): Promise<{ staged: number; external: number }> {
    const postgres = db.dialect === 'postgres'
    const bind = (index: number) => (postgres ? '$' + index : '?')
    const counts = { staged: 0, external: 0 }
    await db.execute(postgres ? 'BEGIN' : 'BEGIN IMMEDIATE')
    try {
        const consumers = await listConsumers(db)
        if (postgres) await db.execute('LOCK TABLE ' + consumers.map(({ table }) => table).join(', ') + ' IN SHARE ROW EXCLUSIVE MODE')
        for (const { table, identity, field, kind, optional, external, validate } of consumers) {
            const rows = await db.select(`SELECT "${identity}" AS id, "${field}" AS value FROM ${table}`)
            for (const { id, value } of rows) {
                if (typeof id !== 'string' || !id) throw new Error('Invalid encrypted record identity.')
                if (optional && (value === null || value === '')) continue
                if (typeof value !== 'string') throw new Error('Invalid encrypted record format.')
                if (external && externalCredential.test(value)) {
                    counts.external++
                    continue
                }
                const context: RecordContext = [kind, id]
                // The legacy Analyst reader trimmed the key material. Authenticated generations use the host key verbatim.
                const readSource = kind === 'analyst-role' && 'passphrase' in source ? { passphrase: source.passphrase.trim() } : source
                const staged = rewrapCredentialRecord(value, readSource, destination, context, (text) => validate(text, id))
                const changes = await db.execute(
                    `UPDATE ${table} SET "${field}" = ${bind(1)} WHERE "${identity}" = ${bind(2)} AND "${field}" = ${bind(3)}`,
                    [staged, id, value]
                )
                if (changes !== 1) throw new Error('An encrypted record changed during staging.')
                const [observed] = await db.select(`SELECT "${field}" AS value FROM ${table} WHERE "${identity}" = ${bind(1)}`, [id])
                if (observed?.value !== staged) throw new Error('The staged encrypted record was not stored intact.')
                counts.staged++
            }
        }
        if (generation !== undefined) {
            await db.execute('UPDATE apikey_credential SET "revokedAt" = CURRENT_TIMESTAMP WHERE "revokedAt" IS NULL')
            await db.execute('CREATE TABLE IF NOT EXISTS cuttlely_installation_key (id INTEGER PRIMARY KEY, marker VARCHAR(160) NOT NULL)')
            const context: RecordContext = ['installation', 'credential-generation']
            const [previous] = await db.select('SELECT marker FROM cuttlely_installation_key WHERE id = 2')
            if (previous) {
                if (!('envelope' in source) || typeof previous.marker !== 'string') throw new Error('Unexpected existing generation.')
                source.envelope.open(previous.marker, context)
            }
            const marker = destination.seal('staged:' + generation, context)
            // The marker commits with the rewrites, but the runtime requires the post-inventory activation marker.
            await db.execute('DELETE FROM cuttlely_installation_key WHERE id = 2')
            if ((await db.execute(`INSERT INTO cuttlely_installation_key (id, marker) VALUES (2, ${bind(1)})`, [marker])) !== 1) {
                throw new Error('The staged generation could not be recorded.')
            }
        }
        await db.execute('COMMIT')
        return counts
    } catch {
        try {
            await db.execute('ROLLBACK')
        } catch {
            throw new Error('Staging was interrupted. Discard this staging copy and restore a fresh copy before retrying.')
        }
        throw new Error('Application credential staging failed and was rolled back.')
    }
}

export async function acceptStagedCredentialGeneration(db: CredentialStageDatabase, destination: CredentialEnvelope, generation: string) {
    const context: RecordContext = ['installation', 'credential-generation']
    const [pending] = await db.select('SELECT marker FROM cuttlely_installation_key WHERE id = 2')
    if (typeof pending?.marker !== 'string' || destination.open(pending.marker, context) !== 'staged:' + generation) {
        throw new Error('The verified staging marker is missing.')
    }
    const markers = [destination.seal(generation, context), pending.marker]
    const sql =
        db.dialect === 'postgres'
            ? 'UPDATE cuttlely_installation_key SET marker = $1 WHERE id = 2 AND marker = $2'
            : 'UPDATE cuttlely_installation_key SET marker = ? WHERE id = 2 AND marker = ?'
    if ((await db.execute(sql, markers)) !== 1) throw new Error('The staging marker changed before acceptance.')
}
