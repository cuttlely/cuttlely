import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, afterEach, test } from 'node:test'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-store-'))
after(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
})

function writeCredentialDb(dir, rows) {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'database.sqlite')
    const db = new DatabaseSync(file)
    db.exec(
        'CREATE TABLE credential (id TEXT, name TEXT, credentialName TEXT, encryptedData TEXT, createdDate TEXT, updatedDate TEXT, workspaceId TEXT)'
    )
    const insert = db.prepare(
        'INSERT INTO credential (id, name, credentialName, encryptedData, createdDate, updatedDate, workspaceId) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    for (const row of rows) {
        insert.run(
            row.id,
            row.name || row.id,
            row.credentialName || 'openAIApi',
            row.encryptedData || 'encrypted',
            row.createdDate || '2026-01-01 00:00:00',
            row.updatedDate,
            row.workspaceId || 'ws'
        )
    }
    db.close()
    return file
}

const {
    setFlowiseCredentialPaths,
    setCredentialSource,
    readCredentialRow,
    readCredentialRowAsync,
    credentialStamp,
    credentialStampAsync,
    flowiseNodeOptions
} = await import('./credential-store.mjs')

afterEach(() => {
    setCredentialSource(null)
    setFlowiseCredentialPaths(null)
})

test('a fake source routes readCredentialRowAsync and credentialStampAsync', async () => {
    const seen = { read: [], rows: [] }
    setCredentialSource({
        dialect: 'postgres',
        readRow: async (id) => {
            seen.read.push(id)
            return { id, credentialName: 'openAIApi', encryptedData: 'from-source' }
        },
        rows: async (ids) => {
            seen.rows.push([...ids])
            return ids.map((id) => ({ id, updatedDate: new Date('2026-11-17T20:00:00.000Z') }))
        }
    })
    const row = await readCredentialRowAsync('cred-1')
    assert.equal(row.encryptedData, 'from-source')
    assert.deepEqual(seen.read, ['cred-1'])
    const stamp = await credentialStampAsync(['cred-1'])
    assert.equal(stamp, 'cred-1@2026-11-17T20:00:00.000Z')
    assert.deepEqual(seen.rows, [['cred-1']])
})

test('stamp format sorts and de-duplicates ids, drops blanks, and keeps Date ISO vs SQLite text', async () => {
    setCredentialSource({
        dialect: 'postgres',
        readRow: async () => null,
        rows: async (ids) => [
            { id: 'b', updatedDate: '2026-01-02 03:04:05' },
            { id: 'a', updatedDate: new Date('2026-03-04T05:06:07.000Z') }
        ]
    })
    const stamp = await credentialStampAsync(['b', '', 'a', 'b', null, '  '])
    assert.equal(stamp, 'a@2026-03-04T05:06:07.000Z,b@2026-01-02 03:04:05')
})

test('a missing id is stamped @missing and a throwing source is stamped @error', async () => {
    setCredentialSource({
        dialect: 'postgres',
        readRow: async () => null,
        rows: async (ids) => [{ id: 'kept', updatedDate: 't1' }]
    })
    assert.equal(await credentialStampAsync(['kept', 'gone']), 'gone@missing,kept@t1')
    setCredentialSource({
        dialect: 'postgres',
        readRow: async () => {
            throw new Error('db down')
        },
        rows: async () => {
            throw new Error('db down')
        }
    })
    assert.equal(await credentialStampAsync(['a', 'b']), 'a@error,b@error')
    assert.equal(await credentialStampAsync([]), '')
})

test('setCredentialSource(null) returns to the file path', async () => {
    const file = writeCredentialDb(path.join(tempRoot, 'file-fallback'), [
        { id: 'cred-file', updatedDate: '2026-02-02 02:02:02', encryptedData: 'file-bytes' }
    ])
    setFlowiseCredentialPaths({ database: file })
    setCredentialSource({
        dialect: 'postgres',
        readRow: async () => ({ id: 'cred-file', credentialName: 'openAIApi', encryptedData: 'source-bytes' }),
        rows: async () => [{ id: 'cred-file', updatedDate: new Date('2026-11-01T00:00:00.000Z') }]
    })
    assert.equal((await readCredentialRowAsync('cred-file')).encryptedData, 'source-bytes')
    assert.equal(await credentialStampAsync(['cred-file']), 'cred-file@2026-11-01T00:00:00.000Z')
    setCredentialSource(null)
    assert.equal((await readCredentialRowAsync('cred-file')).encryptedData, 'file-bytes')
    assert.equal(await credentialStampAsync(['cred-file']), 'cred-file@2026-02-02 02:02:02')
    assert.equal(credentialStamp(['cred-file']), 'cred-file@2026-02-02 02:02:02')
    assert.equal(readCredentialRow('cred-file').encryptedData, 'file-bytes')
})

test('flowiseNodeOptions reads through the registered source and does not open the file', async () => {
    setFlowiseCredentialPaths({ database: path.join(tempRoot, 'does-not-exist', 'database.sqlite') })
    setCredentialSource({
        dialect: 'postgres',
        readRow: async (id) => ({ id, credentialName: 'openAIApi', encryptedData: 'source-only' }),
        rows: async () => []
    })
    const row = await flowiseNodeOptions().appDataSource.getRepository().findOneBy({ id: 'cred-q11' })
    assert.equal(row.encryptedData, 'source-only')
})

test('flowiseNodeOptions without a source still returns the encrypted file row', async () => {
    const file = writeCredentialDb(path.join(tempRoot, 'offline-file'), [
        { id: 'cred-offline', updatedDate: 't0', encryptedData: 'offline-encrypted' }
    ])
    setFlowiseCredentialPaths({ database: file })
    const row = await flowiseNodeOptions().appDataSource.getRepository().findOneBy({ id: 'cred-offline' })
    assert.equal(row.encryptedData, 'offline-encrypted')
})

test('split DATABASE_PATH and SECRETKEY_PATH: the registered source stamps the app database, not the secret-path file', async () => {
    const secretDir = path.join(tempRoot, 'secret-path')
    const dataDir = path.join(tempRoot, 'database-path')
    writeCredentialDb(secretDir, [{ id: 'cred-split', updatedDate: 'from-secret-path', encryptedData: 'secret-bytes' }])
    const databaseFile = writeCredentialDb(dataDir, [
        { id: 'cred-split', updatedDate: 'from-database-path', encryptedData: 'database-bytes' }
    ])
    const previousSecret = process.env.SECRETKEY_PATH
    process.env.SECRETKEY_PATH = secretDir
    setFlowiseCredentialPaths(null)
    try {
        assert.equal(credentialStamp(['cred-split']), 'cred-split@from-secret-path')
        const databaseRows = { 'cred-split': { id: 'cred-split', updatedDate: 'from-database-path', encryptedData: 'database-bytes' } }
        setCredentialSource({
            dialect: 'sqlite',
            readRow: async (id) => databaseRows[id] || null,
            rows: async (ids) => ids.map((id) => databaseRows[id]).filter(Boolean)
        })
        assert.equal(await credentialStampAsync(['cred-split']), 'cred-split@from-database-path')
        const row = await readCredentialRowAsync('cred-split')
        assert.equal(row.encryptedData, 'database-bytes')
        assert.equal(databaseFile.endsWith('database.sqlite'), true)
    } finally {
        if (previousSecret == null) delete process.env.SECRETKEY_PATH
        else process.env.SECRETKEY_PATH = previousSecret
    }
})
