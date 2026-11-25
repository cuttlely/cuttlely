import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dataEnv, freePort, startServer, waitForPing } from './upgrade-check.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const loadServer = createRequire(path.join(root, 'packages/server/package.json'))
const fixtureKey = 'test-only-startup-key-before'
const wrongKey = 'test-only-startup-key-after'

test('server and worker refuse an absent host key, and a replacement server verifies the enrolled key', { timeout: 60000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cuttlely-key-guard-'))
    const port = await freePort()
    const env = dataEnv(dir, port, { CUTTLELY_REQUIRE_KEY_OVERRIDE: 'true' })
    let server
    try {
        for (const command of ['start', 'worker']) {
            const result = spawnSync(process.execPath, [path.join(root, 'packages/server/bin/run'), command], {
                cwd: path.join(root, 'packages/server'),
                env,
                encoding: 'utf8',
                timeout: 10000
            })
            assert.ifError(result.error)
            assert.notEqual(result.status, 0)
            assert.match(result.stderr, /requires a nonblank installation encryption-key override/)
        }

        const enrolled = { ...env, CUTTLELY_SECRETKEY_OVERWRITE: fixtureKey }
        const base = `http://127.0.0.1:${port}`
        server = await startServer(root, enrolled)
        await waitForPing(base, server)
        await server.stop()

        server = await startServer(root, { ...enrolled, CUTTLELY_SECRETKEY_OVERWRITE: wrongKey })
        const code = server.child.exitCode ?? (await once(server.child, 'close', { signal: AbortSignal.timeout(15000) }))[0]
        assert.equal(code, 1)
        const output = server.logs.join('')
        assert.ok(output.includes('The installation encryption key could not be verified.'))
        assert.ok(!output.includes(fixtureKey) && !output.includes(wrongKey))

        server = await startServer(root, enrolled)
        await waitForPing(base, server)
    } finally {
        await server?.stop()
        rmSync(dir, { recursive: true, force: true })
    }
})

test('activates a staged SQLite copy, then restores by starting the untouched original', { timeout: 60000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cuttlely-key-cutover-'))
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const sourceEnv = dataEnv(path.join(dir, 'original'), port, { CUTTLELY_SECRETKEY_OVERWRITE: fixtureKey })
    let server
    try {
        server = await startServer(root, {
            ...sourceEnv,
            CUTTLELY_INITIAL_OWNER_EMAIL: 'key-rotation-fixture@example.test',
            CUTTLELY_INITIAL_OWNER_PASSWORD: 'Test-only fixture password 196!',
            CUTTLELY_LOCAL_USERS: 'true'
        })
        await waitForPing(base, server)
        await server.stop()

        const { AES } = loadServer('crypto-js')
        const plaintext = JSON.stringify({ token: 'test-only-staged-record' })
        const legacy = AES.encrypt(plaintext, fixtureKey).toString()
        const { forCredentialGeneration } = loadServer('./dist/settings/credentialEnvelope')
        const { stageCredentialRotation } = loadServer('./dist/security/keyRotationStage')
        const stageRoot = path.join(dir, 'cuttlely-rotation-fixture')
        const targetEnv = dataEnv(path.join(stageRoot, 'staged'), port)
        mkdirSync(path.join(targetEnv.CUTTLELY_DATA_DIR, 'settings'), { recursive: true })
        mkdirSync(targetEnv.DATABASE_PATH, { recursive: true })
        const targetPath = path.join(targetEnv.DATABASE_PATH, 'database.sqlite')
        const originalPath = path.join(sourceEnv.DATABASE_PATH, 'database.sqlite')
        const original = new DatabaseSync(originalPath)
        try {
            const workspace = original.prepare('SELECT id FROM workspace LIMIT 1').get()
            assert.ok(workspace?.id)
            original
                .prepare('INSERT INTO credential (id, name, "credentialName", "encryptedData", "workspaceId") VALUES (?, ?, ?, ?, ?)')
                .run('fixture-id', 'fixture', 'openAIApi', legacy, workspace.id)
            original.prepare('VACUUM INTO ?').run(targetPath)
        } finally {
            original.close()
        }
        const result = await stageCredentialRotation({
            ...targetEnv,
            CUTTLELY_SECRETKEY_OVERWRITE: fixtureKey,
            CUTTLELY_ROTATION_NEW_KEY: wrongKey,
            CUTTLELY_ROTATION_STAGING_ROOT: stageRoot
        })
        const generation = result.generation
        assert.equal(result.database.staged, 1)
        const destination = forCredentialGeneration(wrongKey, generation)
        const target = new DatabaseSync(targetPath, { readOnly: true })
        try {
            const row = target.prepare('SELECT "encryptedData" FROM credential WHERE id = ?').get('fixture-id')
            assert.equal(destination.open(row.encryptedData, ['credential', 'fixture-id']), plaintext)
        } finally {
            target.close()
        }

        const activeEnv = { ...targetEnv, CUTTLELY_SECRETKEY_OVERWRITE: wrongKey, CUTTLELY_CREDENTIAL_GENERATION: generation }
        server = await startServer(root, activeEnv)
        await waitForPing(base, server)
        await server.stop()
        server = await startServer(root, { ...activeEnv, CUTTLELY_CREDENTIAL_GENERATION: '' })
        const refused = server.child.exitCode ?? (await once(server.child, 'close', { signal: AbortSignal.timeout(15000) }))[0]
        assert.equal(refused, 1)

        server = await startServer(root, sourceEnv)
        await waitForPing(base, server)
        const restored = new DatabaseSync(originalPath, { readOnly: true })
        try {
            const row = restored.prepare('SELECT "encryptedData" FROM credential WHERE id = ?').get('fixture-id')
            assert.equal(row.encryptedData, legacy)
        } finally {
            restored.close()
        }
    } finally {
        await server?.stop()
        rmSync(dir, { recursive: true, force: true })
    }
})
