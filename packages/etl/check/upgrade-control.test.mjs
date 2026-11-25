import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createTestSource, skipReason } from './pg-source.mjs'
import { startStorageUpgrade } from '../storage-upgrade.mjs'
import { appendTurn, readMessages, closeSessions } from '../../harness/session.mjs'
import { closeQueueDb } from '../../harness/lock.mjs'
import { configureHarnessPostgres } from '../../harness/side-store-postgres.mjs'
import { db, closeDb } from '../db.mjs'
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
        const options = { source, config: source.connection, enabled: true, log: { info() {}, warn() {}, error() {} } }
        let controller
        try {
            db()
                .prepare("INSERT INTO pipelines(id,name,name_key,workspace_id,created_at,updated_at) VALUES('01','n','n','w','0','0')")
                .run()
            appendTurn('team', 'test', 'first', 'reply')
            controller = await startStorageUpgrade(options)
            const before = await controller.status()
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
            const migrated = await controller.transition('upgrade')
            assert.equal(migrated.phase, 'postgres')
            assert.ok(migrated.stores.every((s) => s.retired))
            const file = path.join(root, 'hermes', 'profiles', 'team', 'sessions.sqlite')
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
