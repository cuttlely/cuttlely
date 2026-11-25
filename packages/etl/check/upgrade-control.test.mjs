import { createPredictionAttachment, withPredictionAttachments } from '../../harness/prediction-files.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { hermesHome } from '../../harness/paths.mjs'
import { Readable } from 'node:stream'
import { saveUpload } from '../api.mjs'
import { sourceUnits } from '../sources.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createTestSource, skipReason } from './pg-source.mjs'
import { startStorageUpgrade } from '../storage-upgrade.mjs'
import { appendTurn, readMessages, closeSessions } from '../../harness/session.mjs'
import { closeQueueDb } from '../../harness/lock.mjs'
import { configureHarnessPostgres } from '../../harness/side-store-postgres.mjs'
import { db, closeDb } from '../db.mjs'
import { saveHarness, getHarness, setHarnessCategory } from '../../harness/store.mjs'
import { gate, useBackend } from '../store.mjs'
import { pauseStorage } from '../../harness/side-store-maintenance.mjs'

test(
    'operator upgrade resumes a failed store, blocks concurrent instances and restores the exact SQLite snapshot',
    { skip: skipReason },
    async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'side-upgrade-'))
        process.env.CUTTLELY_DATA_DIR = root
        process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
        const source = await createTestSource()
        const session = source.session
        let interrupt = true
        source.session = async () => {
            const client = await session()
            return {
                ...client,
                execute: async (sql, params) => {
                    if (interrupt && sql.startsWith('INSERT INTO cuttlely_session_')) throw new Error('synthetic interruption')
                    return client.execute(sql, params)
                }
            }
        }
        const blobs = path.join(root, 'blobs'),
            uploads = path.join(root, 'incoming')
        const options = {
            source,
            config: source.connection,
            enabled: true,
            log: { info() {}, warn() {}, error() {} },
            fileRoots: { blobs, uploads },
            selectFiles: (backend) => (files = backend)
        }
        let files

        let controller
        try {
            db()
                .prepare("INSERT INTO pipelines(id,name,name_key,workspace_id,created_at,updated_at) VALUES('01','n','n','w','0','0')")
                .run()
            const scope = { pipelineId: '01', workspaceId: 'w' }
            const upload = await saveUpload(Readable.from(['source document']), 'fixture.txt', scope)
            async function readSource(reference, context = scope) {
                const docs = []
                for await (const unit of sourceUnits({ nodeName: 'etlFileSource', inputs: { paths: reference } }, context)) {
                    for await (const doc of unit.docs({})) docs.push([unit.key, unit.fingerprint, doc.docKey, doc.pageContent])
                }
                return docs
            }
            const lostUpload = await saveUpload(Readable.from(['temporary']), 're-upload.txt', scope)
            const expectedDocs = await readSource(upload.path)
            assert.equal(expectedDocs[0][3], 'source document')
            await source.query('CREATE TABLE public.organization(id text PRIMARY KEY)')
            await source.query("INSERT INTO public.organization VALUES ('org-one')")
            fs.mkdirSync(path.join(blobs, 'org-one', 'flow'), { recursive: true })
            const payload = Buffer.alloc(1024 * 1024 + 31, 0x8f)
            fs.writeFileSync(path.join(blobs, 'org-one', 'flow', 'asset.bin'), payload)
            const record = saveHarness({
                name: 'team',
                workspaceId: 'workspace-a',
                chatflowId: 'canvas-a',
                chief: { model: { nodeName: 'fixture' } },
                specialists: [{ name: 'writer' }]
            })
            appendTurn('team', 'test', 'first', 'reply')
            const cacheDir = path.join(hermesHome(), 'profiles', 'team', 'cache')
            fs.mkdirSync(cacheDir, { recursive: true })
            for (const name of ['schema_columns.json', 'memory-cache.sqlite']) fs.writeFileSync(path.join(cacheDir, name), 'fixture')
            const homeDir = hermesHome()
            const customSkill = path.join(homeDir, 'skills', 'my-skill', 'SKILL.md')
            fs.mkdirSync(path.dirname(customSkill), { recursive: true })
            fs.writeFileSync(customSkill, 'fixture skill')
            const { verifiedHostFiles } = await import('../host-files.mjs')
            const { discover } = await import('../upgrade-inventory.mjs')
            assert.ok(discover({ inspectCaches: true }).unresolved.includes('skills/my-skill/SKILL.md'))
            const manifest = path.join(root, 'manifest.json')
            fs.writeFileSync(
                manifest,
                JSON.stringify([
                    { path: 'runtime/skills/my-skill/SKILL.md', sha256: createHash('sha256').update('fixture skill').digest('hex') }
                ])
            )
            const priorManifest = process.env.CUTTLELY_HOST_FILE_MANIFEST
            process.env.CUTTLELY_HOST_FILE_MANIFEST = manifest
            try {
                assert.ok(
                    !discover({ inspectCaches: true, hostFiles: verifiedHostFiles() }).unresolved.includes('skills/my-skill/SKILL.md')
                )
                fs.writeFileSync(customSkill, 'changed')
                assert.throws(() => verifiedHostFiles(), /Restore the deployment-supplied file/)
            } finally {
                if (priorManifest === undefined) delete process.env.CUTTLELY_HOST_FILE_MANIFEST
                else process.env.CUTTLELY_HOST_FILE_MANIFEST = priorManifest
                fs.unlinkSync(customSkill)
            }
            controller = await startStorageUpgrade(options)
            const before = await controller.status()
            assert.ok(before.temporary.some((entry) => entry.includes('profiles/team/cache/schema_columns.json')))
            assert.ok(before.temporary.every((entry) => !entry.includes('memory-cache.sqlite')))
            assert.deepEqual(before.unresolved, ['profiles/team/cache/memory-cache.sqlite'])
            await assert.rejects(controller.transition('upgrade', { availableBytes: before.requiredBytes }), /local storage dependencies/)
            fs.renameSync(path.join(cacheDir, 'memory-cache.sqlite'), path.join(root, 'retained-fixture.sqlite'))
            assert.equal(before.phase, 'sqlite')
            assert.equal(before.stores.length, 2)
            await assert.rejects(controller.transition('upgrade', { availableBytes: 0 }), /disk space/)
            const other = await session()
            const lock = "hashtextextended('cuttlely-side-store-instances',516)"
            await other.execute('SELECT pg_advisory_lock_shared(' + lock + ')', [])
            try {
                await assert.rejects(
                    controller.transition('upgrade', { availableBytes: before.requiredBytes }),
                    /other application instances/
                )
            } finally {
                await other.execute('SELECT pg_advisory_unlock_shared(' + lock + ')', [])
                await other.release()
            }
            await assert.rejects(controller.transition('upgrade', { availableBytes: before.requiredBytes }), /synthetic interruption/)
            assert.equal(controller.paused(), true)
            assert.equal((await controller.status()).phase, 'copying')
            assert.throws(() => readMessages('team', 'test'), { code: 'store_moving' })
            await controller.close()
            interrupt = false
            controller = await startStorageUpgrade(options)
            fs.unlinkSync(lostUpload.path)
            const migrated = await controller.transition('upgrade')
            assert.equal(migrated.phase, 'postgres')
            assert.ok(migrated.stores.every((s) => s.retired))
            const file = path.join(hermesHome(), 'profiles', 'team', 'sessions.sqlite')
            assert.equal(fs.statSync(file + '.migrated').mode & 0o222, 0)
            const kept = fs
                .readdirSync(path.join(root, 'side-store-backups'), { recursive: true })
                .find((name) => name.endsWith('store.sqlite.migrated'))
            assert.ok(kept)
            assert.deepEqual(fs.readFileSync(path.join(root, 'side-store-backups', kept)), fs.readFileSync(file + '.migrated'))
            appendTurn('team', 'test', 'later', 'after cutover')
            await controller.close()
            controller = await startStorageUpgrade(options)
            assert.equal(readMessages('team', 'test').length, 4)
            const replacement = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-data-'))
            try {
                await controller.close()
                process.env.CUTTLELY_DATA_DIR = replacement
                process.env.CUTTLELY_ETL_DIR = path.join(replacement, 'etl')
                controller = await startStorageUpgrade({
                    ...options,
                    fileRoots: { blobs: path.join(replacement, 'blobs'), uploads: path.join(replacement, 'incoming') }
                })
                await assert.rejects(readSource(lostUpload.path), /Upload "re-upload.txt" again in this pipeline/)
                const attachmentScope = { workspace: 'workspace-a', flow: 'flow', chat: 'chat' }
                const priorKey = process.env.CUTTLELY_SECRETKEY_OVERWRITE
                process.env.CUTTLELY_SECRETKEY_OVERWRITE = randomUUID()
                try {
                    const handle = createPredictionAttachment(attachmentScope, ['org-one', 'flow', 'asset.bin'])
                    let scratch
                    await withPredictionAttachments(handle, [handle], attachmentScope, (file) => {
                        assert.deepEqual(fs.readFileSync(file), payload)
                        scratch = file
                    })
                    assert.equal(fs.existsSync(scratch), false)
                    await withPredictionAttachments(handle, [handle], { ...attachmentScope, chat: 'different' }, (text) => {
                        assert.equal(text, '[upload path refused]')
                    })
                } finally {
                    if (priorKey === undefined) delete process.env.CUTTLELY_SECRETKEY_OVERWRITE
                    else process.env.CUTTLELY_SECRETKEY_OVERWRITE = priorKey
                }
                assert.deepEqual(await readSource(upload.path), expectedDocs)
                const nextUpload = await saveUpload(Readable.from(['on replacement']), 'next.txt', scope)
                assert.equal((await readSource(nextUpload.path))[0][3], 'on replacement')
                await assert.rejects(readSource(nextUpload.path, { ...scope, workspaceId: 'other' }), /outside this pipeline/)
                assert.deepEqual(await files.read(['blobs', 'org-one', 'flow', 'asset.bin']), payload)
                await files.put(['blobs', 'org-one', 'flow', 'after.bin'], Buffer.from('new'))
                assert.deepEqual(getHarness('team'), record)
                assert.equal(readMessages('team', 'test').at(-1).content, 'after cutover')
                setHarnessCategory('team', 'published from replacement')
                await controller.close()
            } finally {
                process.env.CUTTLELY_DATA_DIR = root
                process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
                fs.rmSync(replacement, { recursive: true, force: true })
            }
            controller = await startStorageUpgrade(options)
            assert.equal((await files.read(['blobs', 'org-one', 'flow', 'after.bin'])).toString(), 'new')
            assert.equal(getHarness('team').category, 'published from replacement')
            await assert.rejects(controller.transition('rollback', {}), /Confirm/)
            assert.equal((await controller.transition('rollback', { confirm: 'ROLLBACK' })).phase, 'sqlite')
            assert.equal(readMessages('team', 'test').length, 2)
            assert.ok(fs.existsSync(file))
            assert.equal(db().prepare('SELECT id FROM pipelines').get().id, '01')
            appendTurn('team', 'test', 'another', 'SQLite edit')
            const again = await controller.transition('upgrade', { availableBytes: 1e9 })
            assert.equal(again.phase, 'postgres')
            assert.equal(readMessages('team', 'test').at(-1).content, 'SQLite edit')
            const archives = await source.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'cuttlely_retired_%'")
            assert.ok(archives.length >= 2)
        } finally {
            await controller?.close()
            closeDb()
            closeQueueDb()
            closeSessions()
            configureHarnessPostgres(null)
            useBackend(null)
            pauseStorage(false)
            gate.open()
            await source.cleanup()
            fs.rmSync(root, { recursive: true, force: true })
        }
    }
)

test(
    'a new PostgreSQL application stores its first team and conversation before the original data directory disappears',
    { skip: skipReason },
    async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unmounted-application-'))
        const source = await createTestSource()
        const priorData = process.env.CUTTLELY_DATA_DIR,
            priorEtl = process.env.CUTTLELY_ETL_DIR
        const options = { source, config: source.connection, enabled: true, log: { info() {}, warn() {} } }
        let controller
        try {
            process.env.CUTTLELY_DATA_DIR = path.join(root, 'original')
            process.env.CUTTLELY_ETL_DIR = path.join(root, 'original', 'etl')
            const home = hermesHome()
            fs.mkdirSync(home, { recursive: true })
            const runtime = new DatabaseSync(path.join(home, 'state.db'))
            try {
                runtime.exec("CREATE TABLE sessions(id TEXT); INSERT INTO sessions VALUES ('runtime-only')")
            } finally {
                runtime.close()
            }
            controller = await startStorageUpgrade({ ...options, newPostgresApplication: true })
            assert.deepEqual((await controller.status()).local, [{ name: 'state.db', counts: { sessions: 1 } }])
            assert.equal((await controller.status()).phase, 'postgres')
            const saved = saveHarness({
                name: 'brandNew',
                workspaceId: 'w',
                chatflowId: 'canvas',
                chief: { model: { nodeName: 'fixture' } },
                specialists: [{ name: 'writer' }]
            })
            appendTurn(saved.name, 'chat', 'first question', 'first answer')
            await controller.close()
            controller = undefined
            fs.rmSync(process.env.CUTTLELY_DATA_DIR, { recursive: true, force: true })
            process.env.CUTTLELY_DATA_DIR = path.join(root, 'replacement')
            process.env.CUTTLELY_ETL_DIR = path.join(root, 'replacement', 'etl')
            controller = await startStorageUpgrade(options)
            assert.deepEqual(getHarness(saved.name), saved)
            assert.equal(readMessages(saved.name, 'chat').at(-1).content, 'first answer')
        } finally {
            await controller?.close()
            closeDb()
            closeQueueDb()
            closeSessions()
            configureHarnessPostgres(null)
            useBackend(null)
            pauseStorage(false)
            gate.open()
            await source.cleanup()
            if (priorData === undefined) delete process.env.CUTTLELY_DATA_DIR
            else process.env.CUTTLELY_DATA_DIR = priorData
            if (priorEtl === undefined) delete process.env.CUTTLELY_ETL_DIR
            else process.env.CUTTLELY_ETL_DIR = priorEtl
            fs.rmSync(root, { recursive: true, force: true })
        }
    }
)

test('hybrid cutover checks every legacy object and requires the same bucket on replacement', { skip: skipReason }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-cutover-'))
    const originalEnv = { ...process.env }
    const source = await createTestSource()
    const blobs = path.join(root, 'blobs')
    const key = 'fixture-org/flow/fixture.txt'
    const bucket = new Map()
    const options = {
        source,
        config: source.connection,
        enabled: true,
        blobTarget: 's3/fixture-bucket',
        log: { info() {}, warn() {}, error() {} },
        fileRoots: { blobs, uploads: path.join(root, 'incoming') },
        predictionFiles: {
            async *stream(segments) {
                const object = segments.slice(1).join('/')
                if (!bucket.has(object)) throw new Error('missing')
                yield Buffer.from(bucket.get(object))
            }
        }
    }
    let controller
    try {
        process.env.CUTTLELY_DATA_DIR = path.join(root, 'app')
        process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
        await source.query('CREATE TABLE public.organization (id text PRIMARY KEY)')
        await source.query("INSERT INTO public.organization VALUES ('fixture-org')")
        fs.mkdirSync(path.dirname(path.join(blobs, key)), { recursive: true })
        fs.writeFileSync(path.join(blobs, key), 'original')
        controller = await startStorageUpgrade(options)
        await assert.rejects(
            controller.transition('upgrade', { availableBytes: 1e9 }),
            /selected bucket at key fixture-org\/flow\/fixture.txt/
        )
        bucket.set(key, 'wrong')
        await assert.rejects(controller.transition('upgrade'), /bucket object differs/)
        bucket.set(key, 'original')
        assert.equal((await controller.transition('upgrade')).phase, 'postgres')
        await controller.close()
        controller = null
        process.env.CUTTLELY_DATA_DIR = path.join(root, 'replacement')
        process.env.CUTTLELY_ETL_DIR = path.join(root, 'replacement-etl')
        const replacement = { ...options, fileRoots: { blobs: path.join(root, 'empty'), uploads: path.join(root, 'empty-uploads') } }
        await assert.rejects(
            startStorageUpgrade({ ...replacement, blobTarget: 's3/other-bucket' }),
            /Restore the verified file storage provider/
        )
        controller = await startStorageUpgrade(replacement)
        assert.equal((await controller.status()).phase, 'postgres')
    } finally {
        await controller?.close()
        process.env = originalEnv
        await source.cleanup()
        fs.rmSync(root, { recursive: true, force: true })
    }
})
