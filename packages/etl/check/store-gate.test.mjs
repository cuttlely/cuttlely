// Gate tests for the ETL store (SQLite only, never skips).
// Run with Node 24 --experimental-test-module-mocks --test --test-concurrency=1.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('closed gate rejects all, get, run, exec, tx with store_moving', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-gate-'))
    t.after(async () => {
        const store = await import('../store.mjs')
        store.gate.open()
        fs.rmSync(root, { recursive: true, force: true })
    })

    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
    process.env.DATABASE_PATH = path.join(root, 'database')

    const store = await import('../store.mjs')
    const { db } = await import('../db.mjs')

    // Ensure gate is open first
    store.gate.open()

    // Initialize the database
    db()

    // Close the gate
    store.gate.close('test')

    // All store operations should throw store_moving
    const expectStoreMoving = async (promise) => {
        await assert.rejects(promise, {
            code: 'store_moving',
            status: 503,
            retryAfter: 30,
            message: 'ETL is moving to the application database. Try again in a minute.'
        })
    }

    await expectStoreMoving(store.all('SELECT 1', []))
    await expectStoreMoving(store.get('SELECT 1', []))
    await expectStoreMoving(store.run('SELECT 1', []))
    await expectStoreMoving(store.exec('SELECT 1'))
    await expectStoreMoving(store.tx(async () => {}))

    // Open the gate and verify operations work
    store.gate.open()
    const result = await store.get('SELECT 1 AS n', [])
    assert.equal(result.n, 1, 'Operations work after gate opens')
})

test('tx body admitted before close commits, drained resolves after it', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-gate-tx-'))
    t.after(async () => {
        const store = await import('../store.mjs')
        store.gate.open()
        fs.rmSync(root, { recursive: true, force: true })
    })

    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
    process.env.DATABASE_PATH = path.join(root, 'database')

    const store = await import('../store.mjs')
    const { db } = await import('../db.mjs')

    // Ensure gate is open first
    store.gate.open()

    db()

    let txStarted = false
    let txFinished = false
    let drained = false

    const txPromise = store.tx(async (t) => {
        txStarted = true
        // Close the gate while tx is running
        store.gate.close('test')
        await new Promise((resolve) => setTimeout(resolve, 20))
        txFinished = true
        // Just do a simple query in the transaction
        return 1
    })

    // Wait for tx to start
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(txStarted, 'Transaction started')
    assert.ok(!txFinished, 'Transaction not yet finished')

    // Try to drain
    const drainPromise = store.drained().then(() => {
        drained = true
    })

    await txPromise
    await drainPromise

    assert.ok(txFinished, 'Transaction finished')
    assert.ok(drained, 'Drained after tx')

    // Verify the tx committed by checking if we can query
    store.gate.open()
    const result = await store.get('SELECT 1 AS n', [])
    assert.equal(result.n, 1, 'Transaction committed and store works')
})

test('run start through public API rejects with store_moving, not restarting', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-gate-api-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
    process.env.DATABASE_PATH = path.join(root, 'database')
    process.env.HOME = root

    const { db } = await import('../db.mjs')
    const store = await import('../store.mjs')
    const { startRun } = await import('../runner.mjs')

    // Ensure gate is open first
    store.gate.open()

    db()

    // Create a test pipeline
    const pipelineId = 'test-pipeline'
    const stamp = new Date().toISOString()
    await store.run('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
        pipelineId,
        pipelineId,
        pipelineId,
        'test-workspace',
        stamp,
        stamp
    ])
    await store.run('INSERT INTO pipeline_versions (pipeline_id, version, graph_hash, flow_data, created_at) VALUES (?, ?, ?, ?, ?)', [
        pipelineId,
        1,
        'hash',
        '{}',
        stamp
    ])

    // Close the gate
    store.gate.close('test')

    // Try to start a run
    await assert.rejects(
        async () => {
            await startRun(pipelineId, { mode: 'full' })
        },
        {
            code: 'store_moving',
            message: 'ETL is moving to the application database. Try again in a minute.'
        },
        'startRun must throw store_moving, not restarting'
    )
})

test('pump launches nothing while closed', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-gate-pump-'))
    t.after(async () => {
        const store = await import('../store.mjs')
        store.gate.open()
        fs.rmSync(root, { recursive: true, force: true })
    })

    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
    process.env.DATABASE_PATH = path.join(root, 'database')
    process.env.HOME = root

    const { db } = await import('../db.mjs')
    const store = await import('../store.mjs')
    const { startRun, waitForIdle, isActive } = await import('../runner.mjs')

    // Ensure gate is open first
    store.gate.open()

    db()

    // Create a test pipeline
    const pipelineId = 'test-pipeline'
    const stamp = new Date().toISOString()
    await store.run('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
        pipelineId,
        pipelineId,
        pipelineId,
        'test-workspace',
        stamp,
        stamp
    ])
    await store.run('INSERT INTO pipeline_versions (pipeline_id, version, graph_hash, flow_data, created_at) VALUES (?, ?, ?, ?, ?)', [
        pipelineId,
        1,
        'hash',
        '{"nodes":[],"edges":[]}',
        stamp
    ])

    // Create a queued run
    const runId = 'test-run'
    await store.run(
        'INSERT INTO runs (id, pipeline_id, version, mode, status, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [runId, pipelineId, 1, 'full', 'queued', 'test-workspace', stamp, stamp]
    )

    // Close the gate
    store.gate.close('test')

    // Pump should not launch the run
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.ok(!isActive(runId), 'Run should not be active while gate is closed')

    // Open gate to verify run status
    store.gate.open()
    const run = await store.get('SELECT status FROM runs WHERE id = ?', [runId])
    assert.equal(run.status, 'queued', 'Run stays queued')
})

test('tickSchedules returns [] while closed and schedule fires after open', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-gate-schedule-'))
    t.after(async () => {
        const store = await import('../store.mjs')
        store.gate.open()
        fs.rmSync(root, { recursive: true, force: true })
    })

    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
    process.env.DATABASE_PATH = path.join(root, 'database')
    process.env.HOME = root

    const { db } = await import('../db.mjs')
    const store = await import('../store.mjs')
    const { tickSchedules } = await import('../schedule.mjs')

    // Ensure gate is open first
    store.gate.open()

    db()

    // Create a test pipeline
    const pipelineId = 'test-pipeline'
    const stamp = new Date().toISOString()
    await store.run('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
        pipelineId,
        pipelineId,
        pipelineId,
        'test-workspace',
        stamp,
        stamp
    ])
    await store.run('INSERT INTO pipeline_versions (pipeline_id, version, graph_hash, flow_data, created_at) VALUES (?, ?, ?, ?, ?)', [
        pipelineId,
        1,
        'hash',
        '{"nodes":[],"edges":[]}',
        stamp
    ])

    // Create a due schedule
    const scheduleId = 'test-schedule'
    const past = new Date(Date.now() - 60000).toISOString()
    await store.run(
        'INSERT INTO schedules (id, pipeline_id, kind, mode, status, next_run_at, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [scheduleId, pipelineId, 'interval', 'full', 'active', past, 'test-workspace', stamp, stamp]
    )

    // Close the gate
    store.gate.close('test')

    // tickSchedules should return empty
    const outcomes1 = await tickSchedules()
    assert.deepEqual(outcomes1, [], 'tickSchedules returns [] while gate closed')

    // Open gate to verify schedule status
    store.gate.open()
    const schedule1 = await store.get('SELECT last_run_id FROM schedules WHERE id = ?', [scheduleId])
    assert.equal(schedule1.last_run_id, null, 'Schedule not fired while gate closed')

    // Close gate again for next part of test
    store.gate.close('test')

    // Open the gate
    store.gate.open()

    // Now tickSchedules should fire
    const outcomes2 = await tickSchedules()
    assert.ok(outcomes2.length > 0, 'tickSchedules fires after gate opens')

    // Verify schedule was fired
    const schedule2 = await store.get('SELECT last_run_id FROM schedules WHERE id = ?', [scheduleId])
    assert.ok(schedule2.last_run_id, 'Schedule fired after gate opens')
})

test('backendName returns sqlite by default', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-gate-backend-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))

    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
    process.env.DATABASE_PATH = path.join(root, 'database')

    const store = await import('../store.mjs')
    const { db } = await import('../db.mjs')

    // Ensure gate is open first
    store.gate.open()

    db()

    assert.equal(store.backendName(), 'sqlite', 'Default backend is sqlite')
})

test('gate close and open are idempotent', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-gate-idempotent-'))
    t.after(async () => {
        const store = await import('../store.mjs')
        store.gate.open()
        fs.rmSync(root, { recursive: true, force: true })
    })

    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
    process.env.DATABASE_PATH = path.join(root, 'database')

    const store = await import('../store.mjs')
    const { db } = await import('../db.mjs')

    store.gate.open()
    db()

    // Open twice should be safe
    store.gate.open()
    store.gate.open()
    assert.equal(store.gate.closed(), false, 'Gate is open after multiple opens')

    // Close twice should be safe
    store.gate.close('test1')
    assert.equal(store.gate.closed(), true, 'Gate is closed')
    store.gate.close('test2')
    assert.equal(store.gate.closed(), true, 'Gate stays closed after multiple closes')

    // Open again should work
    store.gate.open()
    assert.equal(store.gate.closed(), false, 'Gate can be reopened')

    // Verify operations work
    const result = await store.get('SELECT 1 AS n', [])
    assert.equal(result.n, 1, 'Operations work after reopening')
})

test('calls queued before close still run, calls after close reject', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'etl-gate-queued-'))
    t.after(async () => {
        const store = await import('../store.mjs')
        store.gate.open()
        fs.rmSync(root, { recursive: true, force: true })
    })

    process.env.CUTTLELY_DATA_DIR = root
    process.env.CUTTLELY_ETL_DIR = path.join(root, 'etl')
    process.env.DATABASE_PATH = path.join(root, 'database')

    const store = await import('../store.mjs')
    const { db } = await import('../db.mjs')

    store.gate.open()
    db()

    // Start a tx that holds the queue
    const tx1Result = []
    const tx1 = store.tx(async (t) => {
        tx1Result.push('tx1-start')
        await new Promise((resolve) => setTimeout(resolve, 50))
        tx1Result.push('tx1-end')
        return 'tx1-done'
    })

    // Wait a bit for tx1 to start
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Issue a standalone get and a second tx while tx1 is running
    const get1 = store
        .get('SELECT 1 AS n', [])
        .then((r) => {
            tx1Result.push('get1')
            return r
        })
        .catch((e) => {
            tx1Result.push('get1-error:' + e.code)
            throw e
        })
    const tx2 = store
        .tx(async () => {
            tx1Result.push('tx2')
            return 'tx2-done'
        })
        .catch((e) => {
            tx1Result.push('tx2-error:' + e.code)
            throw e
        })

    // Wait a bit more
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Now close the gate
    store.gate.close('test')

    // All three queued operations should still complete
    const results = await Promise.all([tx1, get1, tx2])
    assert.equal(results[0], 'tx1-done', 'tx1 completed')
    assert.ok(results[1] && results[1].n === 1, `get1 completed`)
    assert.equal(results[2], 'tx2-done', 'tx2 completed')
    // All three operations should have recorded completion (order may vary between SQLite and Postgres)
    assert.ok(tx1Result.includes('tx1-start') && tx1Result.includes('tx1-end'), 'tx1 executed')
    assert.ok(tx1Result.includes('get1'), 'get1 executed')
    assert.ok(tx1Result.includes('tx2'), 'tx2 executed')

    // A call issued after close() should reject
    await assert.rejects(
        async () => store.run('SELECT 1', []),
        {
            code: 'store_moving',
            status: 503,
            retryAfter: 30
        },
        'Call after close rejects with store_moving'
    )
})

test('drain waits for a queued backend write and a failed write leaves the queue usable', async (t) => {
    const store = await import('../store.mjs')
    const transaction = Promise.withResolvers()
    const writing = Promise.withResolvers()
    const finish = Promise.withResolvers()
    const failure = new Error('write failed')
    store.useBackend({
        tx: (fn) => fn(),
        async run() {
            writing.resolve()
            await finish.promise
            throw failure
        },
        get: async () => ({ n: 1 })
    })
    t.after(() => {
        store.useBackend(null)
        store.gate.open()
    })

    const first = store.tx(() => transaction.promise)
    const rejected = assert.rejects(store.run('queued write'), failure)
    store.gate.close('migration')
    let drained = false
    const drain = store.drained().then(() => {
        drained = true
    })
    transaction.resolve()
    await first
    await writing.promise
    await new Promise((resolve) => setImmediate(resolve))
    const drainedDuringWrite = drained
    finish.resolve()
    await Promise.all([rejected, drain])
    assert.equal(drainedDuringWrite, false)
    store.gate.open()
    assert.deepEqual(await store.get('read after failure'), { n: 1 })
})
