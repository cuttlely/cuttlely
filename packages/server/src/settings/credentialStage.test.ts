import { DatabaseSync } from 'node:sqlite'
import { AES } from 'crypto-js'
import { forCredentialGeneration, newCredentialGeneration } from './credentialEnvelope'
import { acceptStagedCredentialGeneration, CredentialStageDatabase, stageApplicationCredentialRecords } from './credentialStage'

const oldKey = 'legacy test key'
const legacy = (value: object) => AES.encrypt(JSON.stringify(value), oldKey).toString()

function fixture(webhook: string) {
    const db = new DatabaseSync(':memory:')
    db.exec(`
        CREATE TABLE credential (id TEXT PRIMARY KEY, encryptedData TEXT NOT NULL);
        CREATE TABLE custom_mcp_server (id TEXT PRIMARY KEY, authConfig TEXT);
        CREATE TABLE chat_flow (id TEXT PRIMARY KEY, webhookSecret TEXT);
        CREATE TABLE apikey_credential (id TEXT PRIMARY KEY, revokedAt TEXT);
        INSERT INTO apikey_credential VALUES ('existing-key', NULL);
    `)
    const credentials = db.prepare('INSERT INTO credential VALUES (?, ?)')
    const original = legacy({ token: 'model fixture' })
    credentials.run('credential-1', original)
    credentials.run('credential-2', 'FlowiseCredential_fixture')
    db.prepare('INSERT INTO custom_mcp_server VALUES (?, ?)').run('mcp-1', legacy({ headers: { example: 'fixture' } }))
    db.prepare('INSERT INTO custom_mcp_server VALUES (?, NULL)').run('mcp-2')
    db.prepare('INSERT INTO chat_flow VALUES (?, ?)').run('flow-1', webhook)
    const source: CredentialStageDatabase = {
        dialect: 'sqlite',
        async select(sql, parameters = []) {
            return db.prepare(sql).all(...parameters)
        },
        async execute(sql, parameters = []) {
            return Number(db.prepare(sql).run(...parameters).changes)
        }
    }
    return { db, source, original }
}

test('rewraps application records in one transaction and leaves external references alone', async () => {
    const { db, source } = fixture(legacy({ secret: 'webhook fixture' }))
    const generation = newCredentialGeneration()
    const next = forCredentialGeneration('next test key', generation)
    try {
        await expect(stageApplicationCredentialRecords(source, { passphrase: oldKey }, next, generation)).resolves.toEqual({
            staged: 3,
            external: 1
        })
        const [credential, external] = await source.select('SELECT "encryptedData" AS value FROM credential ORDER BY id')
        const [mcp, empty] = await source.select('SELECT "authConfig" AS value FROM custom_mcp_server ORDER BY id')
        const [webhook] = await source.select('SELECT "webhookSecret" AS value FROM chat_flow')
        expect(JSON.parse(next.open(String(credential.value), ['credential', 'credential-1']))).toEqual({ token: 'model fixture' })
        expect(external.value).toBe('FlowiseCredential_fixture')
        expect(empty.value).toBeNull()
        expect(JSON.parse(next.open(String(mcp.value), ['custom-mcp', 'mcp-1']))).toEqual({ headers: { example: 'fixture' } })
        expect(JSON.parse(next.open(String(webhook.value), ['chat-webhook', 'flow-1']))).toEqual({ secret: 'webhook fixture' })
        expect(() => next.open(String(credential.value), ['credential', 'credential-2'])).toThrow()
        const [activation] = await source.select('SELECT marker FROM cuttlely_installation_key WHERE id = 2')
        expect(next.open(String(activation.marker), ['installation', 'credential-generation'])).toBe('staged:' + generation)
        await acceptStagedCredentialGeneration(source, next, generation)
        const [accepted] = await source.select('SELECT marker FROM cuttlely_installation_key WHERE id = 2')
        expect(next.open(String(accepted.marker), ['installation', 'credential-generation'])).toBe(generation)
        const [revoked] = await source.select('SELECT "revokedAt" FROM apikey_credential')
        expect(revoked.revokedAt).toEqual(expect.any(String))
    } finally {
        db.close()
    }
})

test('a later malformed record rolls back earlier staged writes', async () => {
    const { db, source, original } = fixture(legacy({ wrongField: 'unreadable webhook' }))
    const next = forCredentialGeneration('next test key', newCredentialGeneration())
    try {
        await expect(stageApplicationCredentialRecords(source, { passphrase: oldKey }, next)).rejects.toThrow('rolled back')
        const [{ value }] = await source.select('SELECT "encryptedData" AS value FROM credential WHERE id = \'credential-1\'')
        expect(value).toBe(original)
    } finally {
        db.close()
    }
})
