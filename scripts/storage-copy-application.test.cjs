const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { mkdtempSync, rmSync, writeFileSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { test } = require('node:test')

const server = createRequire(path.resolve(__dirname, '../packages/server/package.json'))

test('verified primary copy preserves accounts, workspace-bound ciphertext and flows, and refuses an occupied target', async (t) => {
    const { createTestSource, skipReason } = await import('../packages/etl/check/pg-source.mjs')
    if (skipReason) return t.skip(skipReason)
    const source = await createTestSource()
    const root = mkdtempSync(path.join(tmpdir(), 'sqlite-application-'))
    const file = path.join(root, 'database.sqlite')
    const { DataSource } = server('typeorm')
    const sqlite = new DataSource({
        type: 'sqlite',
        database: file,
        migrations: server('./dist/database/migrations/sqlite').sqliteMigrations
    })
    try {
        await sqlite.initialize()
        await sqlite.runMigrations()
        const { host, port, user, password, database } = source.connection
        const env = {
            DATABASE_HOST: host,
            DATABASE_PORT: String(port),
            DATABASE_USER: user,
            DATABASE_PASSWORD: password,
            DATABASE_NAME: database
        }
        const { copySqliteApplication } = server('./dist/settings/copySqliteApplication')
        const ids = Array.from({ length: 5 }, () => randomUUID())
        const [owner, organization, workspace, flow, credential] = ids
        const { AES, enc } = server('crypto-js')
        const passphrase = randomUUID()
        const encrypted = AES.encrypt('fixture credential', passphrase).toString()
        const passwordHash = await server('bcryptjs').hash('synthetic login only', 4)
        await sqlite.query('INSERT INTO "user" (id,name,email,credential,status,createdBy,updatedBy) VALUES (?,?,?,?,?,?,?)', [
            owner,
            'Owner',
            'user@example.invalid',
            passwordHash,
            'active',
            owner,
            owner
        ])
        await sqlite.query('INSERT INTO organization (id,name,createdBy,updatedBy) VALUES (?,?,?,?)', [
            organization,
            'Fixture',
            owner,
            owner
        ])
        await sqlite.query('INSERT INTO workspace (id,name,organizationId,createdBy,updatedBy) VALUES (?,?,?,?,?)', [
            workspace,
            'Fixture',
            organization,
            owner,
            owner
        ])
        await sqlite.query('INSERT INTO credential (id,name,credentialName,encryptedData,workspaceId) VALUES (?,?,?,?,?)', [
            credential,
            'Fixture',
            'test',
            encrypted,
            workspace
        ])
        await sqlite.query('INSERT INTO chat_flow (id,name,flowData,workspaceId,deployed) VALUES (?,?,?,?,?)', [
            flow,
            'Fixture',
            '{"nodes":[]}',
            workspace,
            1
        ])
        const localNode = JSON.stringify({
            nodes: [{ id: 'private-memory', data: { name: 'sqliteAgentMemory', inputs: { databaseFilePath: '/data/old-memory.sqlite' } } }]
        })
        await sqlite.query('UPDATE chat_flow SET flowData=? WHERE id=?', [localNode, flow])
        await assert.rejects(copySqliteApplication(file, env), /private-memory.*databaseFilePath.*old-memory.sqlite/)
        const memoryNodes = ['BufferMemory', 'BufferWindowMemory']
        const graph = JSON.stringify({
            nodes: memoryNodes.map((label) => ({ id: label, data: { name: label[0].toLowerCase() + label.slice(1) } }))
        })
        await sqlite.query('UPDATE chat_flow SET flowData=? WHERE id=?', [graph, flow])
        const session = randomUUID()
        for (const [index, content] of ['first', 'second', 'third', 'unrelated'].entries()) {
            await sqlite.query(
                'INSERT INTO chat_message (id, role, chatflowid, content, chatType, chatId, sessionId, createdDate) VALUES (?,?,?,?,?,?,?,?)',
                [
                    randomUUID(),
                    'userMessage',
                    flow,
                    content,
                    'INTERNAL',
                    session,
                    index === 3 ? randomUUID() : session,
                    new Date(1700000000000 + index * 1000).toISOString()
                ]
            )
        }
        await sqlite.query('CREATE TABLE custom_workflow_state (id INTEGER PRIMARY KEY)')
        await assert.rejects(copySqliteApplication(file, env), /Source tables differ/)
        assert.deepEqual(await source.query("SELECT tablename FROM pg_tables WHERE schemaname='public'"), [])
        await sqlite.query('DROP TABLE custom_workflow_state')
        await sqlite.query('CREATE TABLE harness_request_window (id INTEGER PRIMARY KEY)')
        await assert.rejects(copySqliteApplication(file, env), /Source tables differ/)
        await sqlite.query('DROP TABLE harness_request_window')
        const report = await copySqliteApplication(file, env)
        assert.deepEqual(await source.query('SELECT hits FROM harness_request_window'), [])
        assert.equal(report.user, 1)
        assert.equal(report.role, 6)
        const [account] = await source.query('SELECT id, credential FROM public."user"')
        assert.equal(account.id, owner)
        assert.ok(await server('bcryptjs').compare('synthetic login only', account.credential))
        assert.deepEqual(await source.query('SELECT id,deployed,"workspaceId","flowData" FROM chat_flow'), [
            { id: flow, deployed: true, workspaceId: workspace, flowData: graph }
        ])
        const { applicationStorageDependencies } = server('./dist/settings/storageDependencies')
        const inventory = await applicationStorageDependencies(source.query)
        assert.deepEqual(inventory.dependencies, [])
        assert.equal(inventory.rebuildable.length, 2)
        const { entities } = server('./dist/database/entities')
        const pg = new DataSource({ type: 'postgres', ...source.connection, username: user, entities: Object.values(entities) })
        await pg.initialize()
        try {
            for (const name of memoryNodes) {
                const { nodeClass } = require('../packages/components/dist/nodes/memory/' + name + '/' + name)
                const cold = await new nodeClass().init({ inputs: { sessionId: session, k: '1' } }, '', {
                    appDataSource: pg,
                    databaseEntities: entities,
                    chatflowid: flow,
                    orgId: organization
                })
                const messages = await cold.getChatMessages()
                assert.deepEqual(
                    messages.map((m) => m.message),
                    name === 'BufferMemory' ? ['first', 'second', 'third'] : ['second', 'third']
                )
            }
        } finally {
            await pg.destroy()
        }
        const [secret] = await source.query('SELECT "workspaceId","encryptedData" FROM credential WHERE id=$1', [credential])
        assert.equal(secret.workspaceId, workspace)
        assert.equal(AES.decrypt(secret.encryptedData, passphrase).toString(enc.Utf8), 'fixture credential')
        const { openPostgresFiles } = await import('../packages/etl/postgres-files.mjs')
        const { StorageProviderFactory, getFileFromStorage, addSingleFileToStorage, removeFilesFromStorage, getStorageType } =
            server('@cuttlely/components')
        const previous = process.env.BLOB_STORAGE_PATH
        process.env.BLOB_STORAGE_PATH = path.join(root, 'scratch')
        try {
            StorageProviderFactory.setApplicationFiles(await openPostgresFiles(source))
            assert.equal(getStorageType(), 'postgres')
            const bytes = Buffer.from([0, 1, 0, 255])
            await addSingleFileToStorage('application/octet-stream', bytes, 'file.bin', organization, flow)
            assert.deepEqual(await getFileFromStorage('file.bin', organization, flow), bytes)
            await assert.rejects(getFileFromStorage('file.bin', workspace, flow), { code: 'ENOENT' })
            await removeFilesFromStorage(workspace, flow)
            assert.deepEqual(await getFileFromStorage('file.bin', organization, flow), bytes)
        } finally {
            StorageProviderFactory.setApplicationFiles(null)
            if (previous === undefined) delete process.env.BLOB_STORAGE_PATH
            else process.env.BLOB_STORAGE_PATH = previous
        }
        await assert.rejects(copySqliteApplication(file, env), /empty PostgreSQL/)
    } finally {
        if (sqlite.isInitialized) await sqlite.destroy()
        await source.cleanup()
        rmSync(root, { recursive: true, force: true })
    }
})

test('version history imports existing SHAs, survives an empty disk, and records a restore', async (t) => {
    const { createTestSource, skipReason } = await import('../packages/etl/check/pg-source.mjs')
    if (skipReason) return t.skip(skipReason)
    const source = await createTestSource()
    const versions = server('@cuttlely/versioning')
    const root = mkdtempSync(path.join(tmpdir(), 'pg-versions-'))
    const { startStorageUpgrade } = await import('../packages/etl/storage-upgrade.mjs')
    const previous = process.env.CUTTLELY_VERSIONS_DIR
    const previousData = process.env.CUTTLELY_DATA_DIR
    const options = {
        source,
        enabled: true,
        config: source.connection,
        log: { info() {}, warn() {} },
        versionHistory: {
            inspect: versions.inspectVersionHistory,
            copy: versions.prepareVersionHistory,
            select: versions.selectVersionHistory
        }
    }
    let coordinator
    const flow = {
        id: randomUUID(),
        name: 'Original name',
        type: 'CHATFLOW',
        flowData: '{"nodes":[],"edges":[]}',
        workspaceId: randomUUID()
    }
    try {
        process.env.CUTTLELY_DATA_DIR = path.join(root, 'original-data')
        process.env.CUTTLELY_VERSIONS_DIR = path.join(root, 'original')
        versions.resetForTests()
        versions.configureVersioning({ log: { warn() {} }, storage: { namesForIds: async () => new Map(), idsByName: async () => [] } })
        const first = await versions.recordFlowVersion(flow)
        const second = await versions.recordFlowVersion({ ...flow, name: 'Before migration' })
        assert.ok(first && second && first !== second)
        const git = (...args) =>
            require('node:child_process')
                .execFileSync('git', ['-C', process.env.CUTTLELY_VERSIONS_DIR, ...args], { encoding: 'utf8' })
                .trim()
        const sideCommit = git(
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.invalid',
            'commit-tree',
            first + '^{tree}',
            '-m',
            'Independent historical branch'
        )
        git('update-ref', 'refs/heads/older-release', sideCommit)
        git('update-ref', 'refs/versions/github', second)
        const syncSettings = JSON.stringify({
            version: 1,
            repo: 'example/fixture',
            credential: { id: 'fixture', workspaceId: flow.workspaceId }
        })
        writeFileSync(path.join(process.env.CUTTLELY_VERSIONS_DIR, '.git', 'versions-github.json'), syncSettings)

        await assert.rejects(versions.prepareVersionHistory(source, first), /changed/)
        coordinator = await startStorageUpgrade(options)
        const inventory = await coordinator.status()
        assert.equal(inventory.versions.head, second)
        assert.ok(inventory.versions.bytes > 0 && inventory.requiredBytes >= inventory.versions.bytes * 2)
        const migrated = await coordinator.transition('upgrade', { availableBytes: inventory.requiredBytes })
        assert.equal(migrated.report.versionHistory.head, second)
        const interrupted = {
            transaction: (work) =>
                source.transaction((tx) =>
                    work({
                        query(sql, params) {
                            if (sql.startsWith('INSERT INTO cuttlely_versions.chunks')) throw new Error('test interrupted bundle write')
                            return tx.query(sql, params)
                        }
                    })
                )
        }
        await versions.selectVersionHistory(interrupted)
        await assert.rejects(versions.recordFlowVersion({ ...flow, name: 'Discard this failed revision' }), /interrupted bundle write/)
        assert.equal((await versions.inspectVersionHistory()).head, second)
        assert.deepEqual(
            (await versions.listVersions(flow.id)).versions.map((v) => v.sha),
            [second, first]
        )
        await versions.selectVersionHistory(source)
        // Check an empty member while the original GitHub connection is still configured.
        const originalDir = process.env.CUTTLELY_VERSIONS_DIR
        await versions.selectVersionHistory(null)
        versions.resetForTests()
        process.env.CUTTLELY_VERSIONS_DIR = path.join(root, 'connected-replacement')
        await versions.selectVersionHistory(source)
        assert.equal(readFileSync(path.join(process.env.CUTTLELY_VERSIONS_DIR, '.git', 'versions-github.json'), 'utf8'), syncSettings)
        assert.equal(git('rev-parse', 'refs/versions/github'), second)
        assert.equal(git('show', '-s', '--format=%s', sideCommit), 'Independent historical branch')
        await versions.selectVersionHistory(null)
        versions.resetForTests()
        process.env.CUTTLELY_VERSIONS_DIR = originalDir
        await versions.selectVersionHistory(source)
        // Exercise the normal settings writer without starting a remote sync.
        await versions.getGithub().disconnect()
        await versions.getGithub().setEnvironment('dev')
        const third = await versions.recordFlowVersion({ ...flow, name: 'After migration' })
        assert.ok(third)
        assert.equal(await versions.recordFlowVersion({ ...flow, name: 'After migration' }), null)
        await coordinator.close()
        coordinator = undefined
        await versions.selectVersionHistory(null)
        rmSync(process.env.CUTTLELY_VERSIONS_DIR, { recursive: true })
        versions.resetForTests()
        process.env.CUTTLELY_VERSIONS_DIR = path.join(root, 'replacement')
        process.env.CUTTLELY_DATA_DIR = path.join(root, 'replacement-data')
        coordinator = await startStorageUpgrade(options)
        assert.deepEqual(
            (await versions.listVersions(flow.id)).versions.map((v) => v.sha),
            [third, second, first]
        )
        assert.equal(git('rev-parse', 'refs/heads/older-release'), sideCommit)
        assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/versions/github'), '')
        assert.deepEqual(
            JSON.parse(readFileSync(path.join(process.env.CUTTLELY_VERSIONS_DIR, '.git', 'versions-environment.json'), 'utf8')),
            { environment: 'dev' }
        )
        assert.equal((await versions.getVersion(flow, second)).name, 'Before migration')
        const restored = await versions.getVersion(flow, first)
        assert.equal(restored.name, 'Original name')
        const fourth = await versions.recordFlowVersion({ ...flow, ...restored }, { kind: 'restore' })
        assert.ok(fourth)
        assert.equal((await versions.listVersions(flow.id)).versions[0].kind, 'restore')
        assert.ok((await versions.diffVersion(flow, fourth, third)).renamed)

        // An independently hydrated replica and the first server write to the same PostgreSQL history.
        const { PostgresHistory } = require('../packages/versioning/dist/postgresHistory')
        const peer = new PostgresHistory(source, new versions.VersionStore(path.join(root, 'peer')))
        await peer.open()
        const [peerSha, localSha] = await Promise.all([
            peer.write(async (repo) => {
                const name = 'Saved on peer'
                const files = versions.serializeFlow({ id: flow.id, type: flow.type, name }, flow.flowData)
                return repo.commit(repo.writeFlow(flow.id, name, files), { flowId: flow.id, name, kind: 'save', title: name })
            }),
            versions.recordFlowVersion({ ...flow, name: 'Saved on first server' })
        ])
        const shas = (await versions.listVersions(flow.id)).versions.map((v) => v.sha)
        assert.deepEqual(new Set(shas.slice(0, 2)), new Set([peerSha, localSha]))
        assert.deepEqual(shas.slice(2), [fourth, third, second, first])
    } finally {
        await coordinator?.close()
        versions.resetForTests()
        if (previousData === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = previousData
        if (previous === undefined) delete process.env.CUTTLELY_VERSIONS_DIR
        else process.env.CUTTLELY_VERSIONS_DIR = previous
        await source.cleanup()
        rmSync(root, { recursive: true, force: true })
    }
})
