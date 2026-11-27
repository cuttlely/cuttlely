import { createPredictionAttachment, selectPredictionFiles, withPredictionAttachments } from '../../harness/prediction-files.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { hermesHome } from '../../harness/paths.mjs'
import { Readable } from 'node:stream'
import { saveUpload } from '../api.mjs'
import { sourceUnits } from '../sources.mjs'
import { selectEtlUploads } from '../stored-uploads.mjs'
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
import { assertStorageReady, jobsStopped, pauseStorage } from '../../harness/side-store-maintenance.mjs'

test('coordinator loss closes storage access without marking idle phases as upgrades', { skip: skipReason }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-loss-'))
    const priorData = process.env.CUTTLELY_DATA_DIR
    const priorEtl = process.env.CUTTLELY_ETL_DIR
    const source = await createTestSource()
    const openSession = source.session
    const errors = []
    const log = { info() {}, warn() {}, error: (message) => errors.push(message) }
    const code = 'coordinator_connection_lost'
    let disconnect
    source.session = async () => {
        const session = await openSession()
        let lost = false
        return {
            onLost(listener) {
                disconnect = () => {
                    lost = true
                    listener()
                }
            },
            execute(sql, params) {
                assert.equal(lost, false, 'a lost session must not be reused')
                return session.execute(sql, params)
            },
            release: (error) => session.release(error || lost)
        }
    }
    async function checkPhase({ enabled, phase, newPostgresApplication = false, stopJobsBeforeLoss = false }) {
        const controller = await startStorageUpgrade({ source, config: source.connection, enabled, log, newPostgresApplication })
        try {
            if (stopJobsBeforeLoss) {
                await controller.transition('stop-jobs', { confirm: 'STOP' })
                assert.equal(controller.jobsPaused(), true)
            }
            const active = ['copying', 'retiring', 'restoring'].includes(phase)
            assert.equal((await controller.status()).phase, phase)
            assert.equal(controller.paused(), active)
            assert.equal(controller.failure(), null)
            if (active) assert.throws(assertStorageReady, { code: 'store_moving' })
            else assert.doesNotThrow(assertStorageReady)

            const previousErrors = errors.length
            disconnect()
            disconnect()
            assert.equal(errors.length, previousErrors + 1)
            assert.match(errors.at(-1), /coordinator_connection_lost/)
            assert.equal(controller.paused(), active)
            assert.equal(controller.failure().code, code)
            assert.deepEqual((await controller.status()).failure, controller.failure())
            assert.throws(assertStorageReady, { code, status: 503 })
            assert.throws(gate.assertOpen, { code, status: 503 })
            await assert.rejects(controller.transition('upgrade'), /lost its PostgreSQL connection/)
        } finally {
            await controller.close()
        }
        assert.equal(jobsStopped(), false)
    }
    try {
        process.env.CUTTLELY_DATA_DIR = root
        process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
        await checkPhase({ enabled: false, phase: 'sqlite' })
        await checkPhase({ enabled: true, phase: 'sqlite', stopJobsBeforeLoss: true })
        assert.equal((await source.query("SELECT to_regclass('cuttlely_storage.upgrade') AS control"))[0].control, null)
        await checkPhase({ enabled: true, phase: 'postgres', newPostgresApplication: true })
        for (const phase of ['copying', 'retiring', 'restoring']) {
            await source.query("UPDATE cuttlely_storage.upgrade SET state=jsonb_set(state,'{phase}',to_jsonb($1::text)) WHERE id=1", [
                phase
            ])
            await checkPhase({ enabled: true, phase })
        }
    } finally {
        closeDb()
        closeQueueDb()
        closeSessions()
        configureHarnessPostgres(null)
        useBackend(null)
        selectEtlUploads(null)
        selectPredictionFiles(null)
        pauseStorage(false)
        gate.open()
        await source.cleanup()
        if (priorData === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = priorData
        if (priorEtl === undefined) delete process.env.CUTTLELY_ETL_DIR
        else process.env.CUTTLELY_ETL_DIR = priorEtl
        fs.rmSync(root, { recursive: true, force: true })
    }
})

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
            const readSource = async (reference, context = scope) => {
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
            const profile = 'zz-test-a--research'
            const promptPath = () => path.join(hermesHome(), 'profiles', profile, 'SOUL.md')
            fs.mkdirSync(path.dirname(promptPath()), { recursive: true })
            const prompt = 'Custom instructions for this profile.\n'
            fs.writeFileSync(promptPath(), prompt)
            fs.renameSync(promptPath(), promptPath() + '.source')
            fs.symlinkSync(promptPath() + '.source', promptPath())
            assert.ok(discover({ inspectCaches: true }).unresolved.includes('profiles/' + profile + '/SOUL.md'))
            fs.unlinkSync(promptPath())
            fs.renameSync(promptPath() + '.source', promptPath())
            controller = await startStorageUpgrade(options)
            const before = await controller.status()
            assert.ok(before.temporary.some((entry) => entry.includes('profiles/team/cache/schema_columns.json')))
            assert.ok(before.temporary.every((entry) => !entry.includes('memory-cache.sqlite')))
            assert.deepEqual(before.prompts, [{ name: 'profiles/' + profile + '/SOUL.md', bytes: Buffer.byteLength(prompt) }])
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
            fs.writeFileSync(promptPath(), 'edited during the interruption')
            await assert.rejects(controller.transition('upgrade'), /original profile prompts/)
            fs.writeFileSync(promptPath(), prompt)
            fs.unlinkSync(lostUpload.path)
            const migrated = await controller.transition('upgrade')
            assert.equal(migrated.phase, 'postgres')
            assert.deepEqual(migrated.report.profilePrompts, { count: 1 })
            assert.equal(fs.readFileSync(promptPath(), 'utf8'), prompt)
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
                fs.mkdirSync(path.dirname(promptPath()), { recursive: true })
                fs.writeFileSync(promptPath(), 'local customization')
                await assert.rejects(startStorageUpgrade(options), /differs from the upgrade backup/)
                assert.equal(fs.readFileSync(promptPath(), 'utf8'), 'local customization')
                fs.unlinkSync(promptPath())
                controller = await startStorageUpgrade({
                    ...options,
                    fileRoots: { blobs: path.join(replacement, 'blobs'), uploads: path.join(replacement, 'incoming') }
                })
                assert.equal(fs.readFileSync(promptPath(), 'utf8'), prompt)
                fs.unlinkSync(promptPath())
                await controller.close()
                controller = await startStorageUpgrade(options)
                assert.equal(fs.existsSync(promptPath()), false)
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
        const priorKey = process.env.CUTTLELY_SECRETKEY_OVERWRITE
        process.env.CUTTLELY_SECRETKEY_OVERWRITE = randomUUID()
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
            const restored = new DatabaseSync(path.join(hermesHome(), 'state.db'), { readOnly: true })
            try {
                assert.equal(restored.prepare('SELECT id FROM sessions').get().id, 'runtime-only')
            } finally {
                restored.close()
            }
            assert.deepEqual(getHarness(saved.name), saved)
            assert.equal(readMessages(saved.name, 'chat').at(-1).content, 'first answer')
        } finally {
            if (priorKey === undefined) delete process.env.CUTTLELY_SECRETKEY_OVERWRITE
            else process.env.CUTTLELY_SECRETKEY_OVERWRITE = priorKey
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

test('storage inventory distinguishes shipped skills from local dependencies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-inventory-'))
    const previous = process.env.CUTTLELY_DATA_DIR
    const previousHome = process.env.CUTTLELY_HERMES_HOME
    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_HERMES_HOME = path.join(root, 'runtime')
    try {
        const { discover } = await import('../upgrade-inventory.mjs')
        const home = hermesHome()
        const write = (name, value) => {
            const target = path.join(home, name)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, value)
        }
        const stock = 'skills/example/SKILL.md'
        const copy = 'profiles/team/' + stock
        const body = 'bundled content'
        const skillCatalog = { [stock]: [body.length, createHash('sha256').update(body).digest('hex')] }
        const inspect = () => discover({ inspectCaches: true, skillCatalog })
        for (const name of [stock, copy, 'skills/.bundled_manifest', 'skills/.curator_state']) write(name, body)
        let report = inspect()
        assert.deepEqual(report.unresolved, [])
        assert.equal(report.temporary.length, 4)
        write(stock, 'edited content!')
        write('skills/example/local.md', body)
        assert.deepEqual(inspect().unresolved, [stock, 'skills/example/local.md'])
        fs.unlinkSync(path.join(home, stock))
        fs.symlinkSync(path.join(home, copy), path.join(home, stock))
        assert.ok(inspect().unresolved.includes(stock))
        write('profiles/team/.no-bundled-skills', '')
        assert.ok(inspect().unresolved.includes(copy))
        fs.unlinkSync(path.join(home, 'profiles/team/.no-bundled-skills'))
        assert.ok(discover({ inspectCaches: true, skillCatalog: {} }).unresolved.includes(copy))
    } finally {
        if (previous === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = previous
        if (previousHome === undefined) delete process.env.CUTTLELY_HERMES_HOME
        else process.env.CUTTLELY_HERMES_HOME = previousHome
        fs.rmSync(root, { recursive: true, force: true })
    }
})

test('operator stops live work before retiring orphaned jobs and locks, and can resume or migrate', { skip: skipReason }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-for-upgrade-'))
    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
    const source = await createTestSource()
    const options = { source, config: source.connection, enabled: true, log: { info() {}, warn() {} } }
    const controller = await startStorageUpgrade(options)
    const { database } = await import('../../harness/lock.mjs')
    const { AGENT_SCHEMA } = await import('../../harness/side-store-schema.mjs')
    const { trackStorageJob } = await import('../../harness/side-store-maintenance.mjs')
    const { claimJob } = await import('../../harness/queue.mjs')
    let finish
    let cancelled = false
    const live = trackStorageJob(
        (signal) =>
            new Promise((resolve) => {
                finish = resolve
                signal.addEventListener('abort', () => {
                    cancelled = true
                })
            })
    )
    const stop = () => controller.transition('stop-jobs', { confirm: 'STOP' })
    try {
        const queue = database()
        const payload = JSON.stringify({ chatId: 'chat', images: ['test image'], managedUploadReceipts: ['test upload'] })
        for (const status of ['queued', 'running', 'succeeded']) {
            queue
                .prepare('INSERT INTO jobs (id,session_key,status,payload,created_at,updated_at) VALUES (?,?,?, ?,1,1)')
                .run(status, status, status, payload)
        }
        const phases = ['queued', 'dispatched', 'dispatched', 'confirmed']
        phases.forEach((phase, index) => {
            const callId = ['waiting', 'unconfirmed', 'done', 'done'][index]
            const event = { type: 'nativeToolReceipt', callId, specialist: 'worker', name: 'ops_status', phase }
            queue.prepare('INSERT INTO job_events (job_id, seq, event) VALUES (?, ?, ?)').run('running', index + 1, JSON.stringify(event))
        })
        queue.exec(AGENT_SCHEMA)
        queue.exec(
            "INSERT INTO turns VALUES ('chat','orphan',0); INSERT INTO try_profile_turns VALUES ('draft','orphan',99999999,''); INSERT INTO agent_turns VALUES ('session','profile','chat','turn','[]')"
        )
        db().exec(
            "INSERT INTO runs(id,pipeline_id,version,mode,status,created_at,updated_at) VALUES ('orphan','pipeline',1,'full','running','0','0')"
        )
        const { SQLITE_DASH_SCHEMA, defaultDashFile } = await import('../../harness/dashflows.mjs')
        const dash = new DatabaseSync(defaultDashFile())
        try {
            dash.exec(SQLITE_DASH_SCHEMA)
            dash.prepare(
                'INSERT INTO dash_flow(id,workspace,owner,revision,definition,snapshot,lease,lease_until) VALUES(?,?,?,1,?,?,?,?)'
            ).run('d', 'team', 'owner', '{}', '{"verified":true}', 'old-lease', Date.now() + 60000)
        } finally {
            dash.close()
        }
        await assert.rejects(controller.transition('stop-jobs'), /Confirm/)
        const other = await source.session()
        try {
            await other.execute("SELECT pg_advisory_lock_shared(hashtextextended('cuttlely-side-store-instances',516))")
            await assert.rejects(stop(), /other application instances/)
            assert.equal(cancelled, false)
        } finally {
            await other.execute("SELECT pg_advisory_unlock_shared(hashtextextended('cuttlely-side-store-instances',516))")
            await other.release()
        }
        const waiting = await stop()
        assert.equal(waiting.stopComplete, false)
        assert.equal(cancelled, true)
        assert.equal(claimJob(), null)
        assert.equal(queue.prepare("SELECT cancel_requested FROM jobs WHERE id='running'").get().cancel_requested, 1)
        assert.equal(queue.prepare("SELECT payload FROM jobs WHERE id='running'").get().payload, payload)
        assert.deepEqual(JSON.parse(queue.prepare("SELECT payload FROM jobs WHERE id='queued'").get().payload), { chatId: 'chat' })
        assert.equal(queue.prepare('SELECT count(*) AS n FROM turns').get().n, 1)
        assert.equal(db().prepare("SELECT status FROM runs WHERE id='orphan'").get().status, 'cancelled')
        const [peer] = await source.query(
            "SELECT pg_try_advisory_lock_shared(hashtextextended('cuttlely-side-store-instances',516)) AS joined"
        )
        assert.equal(peer.joined, false)
        await assert.rejects(controller.transition('upgrade'), /Finish stopping/)
        finish()
        await live
        const ready = await controller.transition('check-stop')
        assert.equal(ready.stopComplete, true)
        assert.ok(ready.stores.every((store) => !store.busy))
        const stopped = queue.prepare("SELECT payload,error_message FROM jobs WHERE id='running'").get()
        assert.deepEqual(JSON.parse(stopped.payload), { chatId: 'chat' })
        assert.match(stopped.error_message, /outcome of 1 dispatched tool call could not be confirmed/)
        const receipts = queue.prepare("SELECT event FROM job_events WHERE job_id='running' ORDER BY seq").all()
        assert.deepEqual(
            receipts.map((row) => JSON.parse(row.event).phase),
            [...phases, 'uncertain']
        )
        assert.equal(JSON.parse(receipts.at(-1).event).callId, 'unconfirmed')
        assert.deepEqual(
            queue
                .prepare('SELECT status FROM jobs ORDER BY id')
                .all()
                .map((row) => row.status),
            ['cancelled', 'cancelled', 'succeeded']
        )
        assert.equal((await controller.transition('resume-jobs')).jobsPaused, false)
        assert.equal((await controller.transition('check-stop')).jobsPaused, false)
        const next = await stop()
        const upgraded = await controller.transition('upgrade', { availableBytes: next.requiredBytes + 10485760 })
        assert.equal(upgraded.phase, 'postgres')
        assert.equal(upgraded.jobsPaused, false)
    } finally {
        finish()
        await live
        await controller.close()
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
})
