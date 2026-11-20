import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

// Split-path SQLite host with the server's own DataSource: DATABASE_PATH and
// SECRETKEY_PATH are separate directories, and a stale database.sqlite sits under
// SECRETKEY_PATH. Credential reads and rotation must come from DATABASE_PATH.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-server-datasource-'))
const databasePath = path.join(tempRoot, 'database-path')
const secretPath = path.join(tempRoot, 'secret-path')
fs.mkdirSync(databasePath, { recursive: true })
fs.mkdirSync(secretPath, { recursive: true })

const credentialId = '7d1f3a52-4c0e-4f6b-9a3e-2b8c5d9e1f00'
const secretFile = path.join(secretPath, 'database.sqlite')
const stale = new DatabaseSync(secretFile)
stale.exec(
    'CREATE TABLE credential (id TEXT, name TEXT, credentialName TEXT, encryptedData TEXT, createdDate TEXT, updatedDate TEXT, workspaceId TEXT)'
)
stale
    .prepare(
        'INSERT INTO credential (id, name, credentialName, encryptedData, createdDate, updatedDate, workspaceId) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(credentialId, 'stale', 'openAIApi', 'secret-bytes', '2026-01-01 00:00:00', 'from-secret-path', 'ws')
stale.close()
const secretFileHash = () => crypto.createHash('sha256').update(fs.readFileSync(secretFile)).digest('hex')
const secretHashBefore = secretFileHash()

const previous = {
    DATABASE_TYPE: process.env.DATABASE_TYPE,
    DATABASE_PATH: process.env.DATABASE_PATH,
    SECRETKEY_PATH: process.env.SECRETKEY_PATH,
    CUTTLELY_FLOWISE_DB: process.env.CUTTLELY_FLOWISE_DB
}
process.env.DATABASE_TYPE = 'sqlite'
process.env.DATABASE_PATH = databasePath
process.env.SECRETKEY_PATH = secretPath
delete process.env.CUTTLELY_FLOWISE_DB

const requireFromHere = createRequire(import.meta.url)
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
    module: 'commonjs',
    moduleResolution: 'node',
    esModuleInterop: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true
})
requireFromHere('ts-node/register/transpile-only')
const { init, getDataSource } = requireFromHere('../DataSource.ts')
const { registerAppCredentialSource } = requireFromHere('./credentialSource.ts')
const { Credential } = requireFromHere('../database/entities/Credential.ts')

let dataSource
const restore = async () => {
    if (dataSource?.isInitialized) await dataSource.destroy()
    for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key]
        else process.env[key] = value
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
}

try {
    await init()
    dataSource = getDataSource()
    const databaseFile = path.join(databasePath, 'database.sqlite')
    assert.equal(dataSource.options.type, 'sqlite')
    assert.equal(dataSource.options.database, databaseFile)
    await dataSource.initialize()
    await dataSource.runMigrations({ transaction: 'each' })

    const storeUrl = pathToFileURL(path.resolve(import.meta.dirname, '../../../../packages/harness/credential-store.mjs')).href
    const { setCredentialSource, setFlowiseCredentialPaths, credentialStamp, credentialStampAsync, readCredentialRowAsync } = await import(
        storeUrl
    )
    setFlowiseCredentialPaths(null)
    setCredentialSource(null)
    await registerAppCredentialSource(dataSource)

    // credential.workspaceId references workspace, which references user and organization.
    const userId = '00000000-0000-4000-8000-000000000001'
    const organizationId = '00000000-0000-4000-8000-000000000002'
    const workspaceId = '00000000-0000-4000-8000-000000000003'
    await dataSource.query('INSERT INTO "user" (id, name, email, createdBy, updatedBy) VALUES (?, ?, ?, ?, ?)', [
        userId,
        'owner',
        'owner@example.com',
        userId,
        userId
    ])
    await dataSource.query('INSERT INTO organization (id, createdBy, updatedBy) VALUES (?, ?, ?)', [organizationId, userId, userId])
    await dataSource.query('INSERT INTO workspace (id, name, organizationId, createdBy, updatedBy) VALUES (?, ?, ?, ?, ?)', [
        workspaceId,
        'default',
        organizationId,
        userId,
        userId
    ])

    const repo = dataSource.getRepository(Credential)
    const firstDate = new Date('2026-11-17T10:00:00.000Z')
    await repo.insert({
        id: credentialId,
        name: 'app',
        credentialName: 'openAIApi',
        encryptedData: 'database-bytes',
        createdDate: firstDate,
        updatedDate: firstDate,
        workspaceId
    })

    // The file reader alone follows SECRETKEY_PATH and would pick the stale row.
    assert.equal(credentialStamp([credentialId]), `${credentialId}@from-secret-path`)

    const firstStamp = await credentialStampAsync([credentialId])
    assert.equal(firstStamp, `${credentialId}@2026-11-17T10:00:00.000Z`)
    assert.deepEqual(await readCredentialRowAsync(credentialId), {
        id: credentialId,
        credentialName: 'openAIApi',
        encryptedData: 'database-bytes'
    })

    const rotatedDate = new Date('2026-11-17T11:30:00.000Z')
    await repo.update({ id: credentialId }, { encryptedData: 'rotated-bytes', updatedDate: rotatedDate })

    const rotatedStamp = await credentialStampAsync([credentialId])
    assert.equal(rotatedStamp, `${credentialId}@2026-11-17T11:30:00.000Z`)
    assert.notEqual(rotatedStamp, firstStamp)
    assert.deepEqual(await readCredentialRowAsync(credentialId), {
        id: credentialId,
        credentialName: 'openAIApi',
        encryptedData: 'rotated-bytes'
    })

    const app = new DatabaseSync(databaseFile, { readOnly: true })
    try {
        assert.equal(app.prepare('SELECT encryptedData FROM credential WHERE id = ?').get(credentialId).encryptedData, 'rotated-bytes')
    } finally {
        app.close()
    }
    assert.equal(secretFileHash(), secretHashBefore)
    assert.equal(credentialStamp([credentialId]), `${credentialId}@from-secret-path`)
    setCredentialSource(null)
    console.log('server DataSource split-path assertions passed')
} catch (error) {
    // Report the failure ourselves: a server module can swallow an uncaught rejection.
    console.error(error)
    process.exitCode = 1
} finally {
    await restore()
}
