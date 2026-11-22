import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { api, flowFor, root, WS } from './check/lib.mjs'
import { closeDb } from './db.mjs'

// Use the same disposable CSV, local embeddings and vector store as the runner checks.
after(() => {
    closeDb()
    fs.rmSync(root, { recursive: true, force: true })
})

test('tracks ETL admission and background work, and leaves due schedules alone while draining', async () => {
    const file = path.join(root, 'idle-runner.csv')
    fs.writeFileSync(file, 'sku,name,notes\nA,Loaf,Bakery\n')
    await api.recordVersion({ workspaceId: WS, id: 'idle-runner', name: 'Idle runner', flowData: flowFor(file, '') })
    let count = 0
    let stopping = false
    let entered
    let release
    const ready = new Promise((resolve) => (entered = resolve))
    const gate = new Promise((resolve) => (release = resolve))
    api.configureRunner({
        stopping: () => stopping,
        track: (run) => {
            count += 1
            return run.finally(() => {
                count -= 1
            })
        },
        contextFor: () => ({
            workspaceId: WS,
            embedGate: async () => {
                entered()
                await gate
            }
        })
    })
    try {
        const starting = api.startRun('idle-runner')
        assert.equal(count, 1, 'admission is visible before its first await')
        await starting
        await ready
        assert.equal(count, 1, 'the background job remains visible after admission returns')
        const schedule = await api.createSchedule('idle-runner', { kind: 'interval', every: 1, unit: 'minutes' })
        const store = await import('./store.mjs')
        await store.run('UPDATE schedules SET next_run_at = ? WHERE id = ?', [new Date(0).toISOString(), schedule.id])
        stopping = true
        await assert.rejects(api.startRun('idle-runner'), { status: 503, code: 'restarting' })
        await assert.rejects(api.resumeRun('missing'), { status: 503, code: 'restarting' })
        assert.deepEqual(await api.tickSchedules(), [])
        assert.equal((await api.listSchedules('idle-runner'))[0].nextRunAt, new Date(0).toISOString())
        assert.equal(count, 1, 'draining does not cancel work already running')
    } finally {
        stopping = false
        release()
        await api.waitForIdle()
        api.configureRunner({ stopping: () => false, track: (run) => run, contextFor: () => ({}) })
    }
    assert.equal(count, 0)
})
