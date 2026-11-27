import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { createTestDatabase, skipReason } from '../etl/check/pg-source.mjs'
import { configureHarnessPostgres, harnessRecordDatabase } from './side-store-postgres.mjs'
import { getHarness } from './store.mjs'

const name = 'roster-qa'
const entry = name + '.json'
const schema = 'cuttlely_harness_queue'
const table = schema + '.harness_records'
const original = { name, workspaceId: 'first', canvasId: 'first', createdAt: '2026-01-01' }
const replacement = { name, workspaceId: 'second', canvasId: 'second', createdAt: '2026-01-02' }

if (!isMainThread) {
    configureHarnessPostgres(workerData)
    harnessRecordDatabase()
    parentPort.on('message', () => {
        try {
            parentPort.postMessage({ record: getHarness(name) })
        } catch (error) {
            parentPort.postMessage({ error: error.code || error.message })
        }
    })
    parentPort.postMessage({ ready: true })
} else {
    test('roster reads respect outstanding publications, staged deletions and their own transaction', { skip: skipReason }, async () => {
        const fixture = await createTestDatabase()
        const { Client } = createRequire(new URL('../server/package.json', import.meta.url))('pg')
        const writer = new Client(fixture.connection)
        const observer = new Client(fixture.connection)
        let reader
        const insert = (record) => writer.query(`INSERT INTO ${table}(entry,content) VALUES ($1,$2)`, [entry, JSON.stringify(record)])
        async function waitForLock(event) {
            const sql = "SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'"
            for (let i = 0; i < 150; i++) {
                if ((await observer.query(sql, ['qa-roster-reader'])).rows.some((row) => row.wait_event === event)) return
                await delay(10)
            }
            assert.fail('Independent reader did not wait on the pending publication.')
        }
        function startRead() {
            const result = once(reader, 'message')
            reader.postMessage('read')
            return result.then(([reply]) => {
                assert.equal(reply.error, undefined)
                return reply.record
            })
        }
        try {
            await writer.connect()
            await observer.connect()
            configureHarnessPostgres(fixture.connection)
            const store = harnessRecordDatabase()
            reader = new Worker(new URL(import.meta.url), {
                workerData: {
                    ...fixture.connection,
                    application_name: 'qa-roster-reader',
                    options: '-c search_path=pg_catalog -c default_transaction_isolation=repeatable\\ read'
                }
            })
            assert.deepEqual((await once(reader, 'message'))[0], { ready: true })
            for (const change of ['revoke', 'rollback', 'replacement']) {
                await writer.query(`DELETE FROM ${table}`)
                await insert(original)
                await writer.query('BEGIN')
                await writer.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))', [schema])
                if (change !== 'replacement') await writer.query(`DELETE FROM ${table} WHERE entry=$1`, [entry])
                const pending = startRead()
                await waitForLock('advisory')
                if (change === 'replacement') {
                    // A publisher can acquire the schema lock before touching a row.
                    await writer.query(`DELETE FROM ${table} WHERE entry=$1`, [entry])
                    await insert(replacement)
                }
                await writer.query(change === 'rollback' ? 'ROLLBACK' : 'COMMIT')
                const expected = { revoke: null, rollback: original, replacement }
                assert.deepEqual(await pending, expected[change])
            }

            await writer.query('BEGIN')
            await writer.query(`UPDATE ${table} SET content=$1 WHERE entry=$2`, [JSON.stringify(original), entry])
            const rowRead = startRead()
            await waitForLock('relation')
            await writer.query('COMMIT')
            assert.deepEqual(await rowRead, original)

            await writer.query('BEGIN')
            await writer.query('SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtext($1))', [schema])
            await writer.query(`SELECT content FROM ${table} WHERE entry=$1 FOR SHARE`, [entry])
            assert.deepEqual(await startRead(), original)
            await writer.query('COMMIT')
            // A previously row-locked roster is still visible to readers after an upgrade.
            assert.deepEqual(await startRead(), original)

            store.exec('BEGIN')
            try {
                store.prepare('UPDATE harness_records SET content=? WHERE entry=?').run(JSON.stringify(replacement), entry)
                assert.deepEqual(getHarness(name), replacement)
                const external = await observer.query(`SELECT content FROM ${table} WHERE entry=$1`, [entry])
                assert.deepEqual(JSON.parse(external.rows[0].content), original)
            } finally {
                store.exec('ROLLBACK')
            }
            assert.deepEqual(getHarness(name), original)
        } finally {
            await writer.end()
            await reader?.terminate()
            configureHarnessPostgres(undefined)
            await observer.end()
            await fixture.cleanup()
        }
    })
}
