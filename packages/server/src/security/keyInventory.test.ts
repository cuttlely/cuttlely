import fs from 'fs'
import os from 'os'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { inventoryCredentialKey } from './keyInventory'
import { encryptSecret, settingsDir, writeSettingsFile } from '../settings/store'

const key = 'fixture-installation-key'
const stamp = '8'.repeat(64)
const privateExample = 'example-fixture-secret'

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-key-inventory-'))
    const env = {
        CUTTLELY_DATA_DIR: dir,
        DATABASE_PATH: dir,
        DATABASE_TYPE: 'sqlite',
        SECRETKEY_PATH: dir,
        CUTTLELY_SECRETKEY_OVERWRITE: key
    }
    const file = path.join(dir, 'database.sqlite')
    const db = new DatabaseSync(file)
    const canvas = JSON.stringify({
        nodes: [
            { id: 'one', data: { inputs: { pinnedQueries: JSON.stringify([{ id: 'fixture', name: 'fixture', testedStamp: stamp }]) } } }
        ],
        edges: []
    })
    db.exec(`
        CREATE TABLE credential (id TEXT PRIMARY KEY, "encryptedData" TEXT);
        CREATE TABLE custom_mcp_server (id TEXT PRIMARY KEY, "authConfig" TEXT);
        CREATE TABLE chat_flow (id TEXT PRIMARY KEY, "flowData" TEXT, "webhookSecret" TEXT);
        CREATE TABLE flow_version_state ("draftFlowData" TEXT);
        CREATE TABLE apikey (id TEXT, "disabledAt" TEXT, "expiresAt" TEXT);
        CREATE TABLE apikey_credential (digest TEXT, "revokedAt" TEXT, "principalId" TEXT, "expiresAt" TEXT);
        INSERT INTO apikey VALUES ('one', NULL, NULL), ('two', '2000-01-01', NULL);
    `)
    const credential = encryptSecret(JSON.stringify({ apiKey: privateExample }), key)
    db.prepare("INSERT INTO credential VALUES ('model', ?), ('external', ?)").run(credential, 'FlowiseCredential_external-fixture')
    db.prepare("INSERT INTO custom_mcp_server VALUES ('mcp', ?)").run(credential)
    db.prepare("INSERT INTO chat_flow VALUES ('hook', ?, ?)").run(canvas, encryptSecret(JSON.stringify({ secret: privateExample }), key))
    db.prepare('INSERT INTO flow_version_state VALUES (?)').run(canvas)
    db.prepare(
        `INSERT INTO apikey_credential VALUES
        (?, NULL, 'one', NULL),
        (?, '2000-01-01', 'one', NULL),
        (?, NULL, 'one', '2000-01-01'),
        (?, NULL, 'two', NULL)`
    ).run(stamp, stamp, stamp, stamp)
    db.close()
    writeSettingsFile(settingsDir(env), { DATABASE_PASSWORD: privateExample }, { key })
    fs.writeFileSync(path.join(settingsDir(env), 'authkit-test.json'), JSON.stringify({ fingerprint: stamp }))
    fs.writeFileSync(
        path.join(dir, 'analyst-role-abcdef0123.enc'),
        encryptSecret(JSON.stringify({ role: 'analyst_reader_abcdef0123', password: privateExample }), key)
    )
    return { dir, file, env }
}

test('read-only inventory counts reversible records and reports proofs requiring reissue or retest', async () => {
    const { dir, file, env } = fixture()
    try {
        const before = fs.readFileSync(file)
        const result = await inventoryCredentialKey(env)
        expect(result.status).toBe('inspected')
        expect(result.blockers).toEqual([])
        expect(result.consumers.credentials).toMatchObject({ readable: 1, external: 1, unreadable: 0 })
        expect(result.consumers.customMcpAuth.readable).toBe(1)
        expect(result.consumers.webhookSecrets.readable).toBe(1)
        expect(result.consumers.serverSettingsSecrets.readable).toBe(1)
        expect(result.consumers.analystRoleFiles.readable).toBe(1)
        expect(result.consumers.inboundAccessKeys.requiresReissue).toBe(1)
        expect(result.consumers.pinnedQueryProofs.requiresRetest).toBe(2)
        expect(result.consumers.authKitProofs.requiresRetest).toBe(1)
        expect(fs.readFileSync(file)).toEqual(before)
        const publicReport = JSON.stringify(result)
        for (const hidden of [key, privateExample, stamp, 'FlowiseCredential_external-fixture', dir]) {
            expect(publicReport).not.toContain(hidden)
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('blocks on an unreadable settings key or an unknown ciphertext', async () => {
    const { dir, file, env } = fixture()
    try {
        const wrongKey = await inventoryCredentialKey({ ...env, CUTTLELY_SECRETKEY_OVERWRITE: 'wrong-fixture-key' })
        expect(wrongKey.status).toBe('blocked')
        expect(wrongKey.blockers).toContain('SETTINGS_DOCUMENT_UNREADABLE')
        expect(wrongKey.consumers.analystRoleFiles.unreadable).toBe(1)
        const db = new DatabaseSync(file)
        db.prepare("INSERT INTO credential VALUES ('unknown', ?)").run('unknown-fixture-format')
        db.close()
        const before = fs.readFileSync(file)
        const result = await inventoryCredentialKey(env)
        expect(result.status).toBe('blocked')
        expect(result.blockers).toContain('UNREADABLE_CONSUMERS')
        expect(result.consumers.credentials.unreadable).toBe(1)
        expect(fs.readFileSync(file)).toEqual(before)
        expect(JSON.stringify(result)).not.toContain('unknown-fixture-format')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('reports unsupported key sources without resolving a cloud key', async () => {
    const result = await inventoryCredentialKey({ SECRETKEY_STORAGE_TYPE: 'aws' })
    expect(result.status).toBe('blocked')
    expect(result.blockers).toEqual(['AWS_KEY_PROVIDER'])
})
