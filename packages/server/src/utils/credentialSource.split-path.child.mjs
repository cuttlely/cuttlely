import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { DataSource, EntitySchema } from 'typeorm'

const requireFromHere = createRequire(import.meta.url)
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
    module: 'commonjs',
    moduleResolution: 'node',
    esModuleInterop: true
})
requireFromHere('ts-node/register/transpile-only')
const { makeSource } = requireFromHere('./credentialSource.ts')

const CredentialSchema = new EntitySchema({
    name: 'credential',
    tableName: 'credential',
    columns: {
        id: { type: String, primary: true },
        name: { type: String },
        credentialName: { type: String },
        encryptedData: { type: 'text' },
        createdDate: { type: 'datetime' },
        updatedDate: { type: 'datetime' },
        workspaceId: { type: 'text' }
    }
})

function writeSecretPathDb(dir, row) {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'database.sqlite')
    const db = new DatabaseSync(file)
    db.exec(
        'CREATE TABLE credential (id TEXT, name TEXT, credentialName TEXT, encryptedData TEXT, createdDate TEXT, updatedDate TEXT, workspaceId TEXT)'
    )
    db.prepare(
        'INSERT INTO credential (id, name, credentialName, encryptedData, createdDate, updatedDate, workspaceId) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(row.id, row.id, 'openAIApi', row.encryptedData, '2026-01-01 00:00:00', row.updatedDate, 'ws')
    db.close()
    return file
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-split-path-'))
const databasePath = path.join(tempRoot, 'database-path')
const secretPath = path.join(tempRoot, 'secret-path')
fs.mkdirSync(databasePath, { recursive: true })
const secretFile = writeSecretPathDb(secretPath, {
    id: 'cred-split',
    updatedDate: 'from-secret-path',
    encryptedData: 'secret-bytes'
})

const previous = {
    DATABASE_TYPE: process.env.DATABASE_TYPE,
    DATABASE_PATH: process.env.DATABASE_PATH,
    SECRETKEY_PATH: process.env.SECRETKEY_PATH
}
process.env.DATABASE_TYPE = 'sqlite'
process.env.DATABASE_PATH = databasePath
process.env.SECRETKEY_PATH = secretPath

const databaseFile = path.resolve(databasePath, 'database.sqlite')
const dataSource = new DataSource({
    type: 'sqlite',
    database: databaseFile,
    enableWAL: false,
    synchronize: true,
    entities: [CredentialSchema]
})

const restore = async () => {
    if (dataSource.isInitialized) await dataSource.destroy()
    for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key]
        else process.env[key] = value
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
}

try {
    await dataSource.initialize()
    const repo = dataSource.getRepository(CredentialSchema)
    const firstDate = new Date('2026-11-17T10:00:00.000Z')
    await repo.save({
        id: 'cred-split',
        name: 'cred-split',
        credentialName: 'openAIApi',
        encryptedData: 'database-bytes',
        createdDate: firstDate,
        updatedDate: firstDate,
        workspaceId: 'ws'
    })

    const storeUrl = pathToFileURL(path.resolve(import.meta.dirname, '../../../../packages/harness/credential-store.mjs')).href
    const { setCredentialSource, setFlowiseCredentialPaths, credentialStamp, credentialStampAsync, readCredentialRowAsync } = await import(
        storeUrl
    )
    setFlowiseCredentialPaths(null)
    setCredentialSource(makeSource(dataSource, CredentialSchema))

    // Without the registered source, the file reader follows SECRETKEY_PATH.
    assert.equal(credentialStamp(['cred-split']), 'cred-split@from-secret-path')

    const firstStamp = await credentialStampAsync(['cred-split'])
    assert.equal(firstStamp, 'cred-split@2026-11-17T10:00:00.000Z')
    assert.equal(firstStamp.includes('from-secret-path'), false)
    const firstRow = await readCredentialRowAsync('cred-split')
    assert.deepEqual(firstRow, { id: 'cred-split', credentialName: 'openAIApi', encryptedData: 'database-bytes' })
    assert.notEqual(firstRow.encryptedData, 'secret-bytes')

    const rotatedDate = new Date('2026-11-17T11:30:00.000Z')
    await repo.update({ id: 'cred-split' }, { encryptedData: 'rotated-bytes', updatedDate: rotatedDate })

    const rotatedStamp = await credentialStampAsync(['cred-split'])
    assert.equal(rotatedStamp, 'cred-split@2026-11-17T11:30:00.000Z')
    assert.notEqual(rotatedStamp, firstStamp)
    assert.equal(rotatedStamp.includes('from-secret-path'), false)
    const rotatedRow = await readCredentialRowAsync('cred-split')
    assert.deepEqual(rotatedRow, { id: 'cred-split', credentialName: 'openAIApi', encryptedData: 'rotated-bytes' })
    assert.notEqual(rotatedRow.encryptedData, 'secret-bytes')

    const stale = new DatabaseSync(secretFile, { readOnly: true })
    try {
        const staleRow = stale.prepare('SELECT updatedDate, encryptedData FROM credential WHERE id = ?').get('cred-split')
        assert.equal(staleRow.updatedDate, 'from-secret-path')
        assert.equal(staleRow.encryptedData, 'secret-bytes')
    } finally {
        stale.close()
    }
    assert.equal(credentialStamp(['cred-split']), 'cred-split@from-secret-path')
    assert.equal(fs.existsSync(databaseFile), true)
    assert.notEqual(databaseFile, secretFile)
    setCredentialSource(null)
    console.log('split-path SQLite rotation assertions passed')
} finally {
    await restore()
}
