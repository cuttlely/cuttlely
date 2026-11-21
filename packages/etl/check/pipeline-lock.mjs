// The pipeline lock (F2): starting, resuming and deleting one pipeline never interleave. Two starts in the same turn
// both passed the active-run check before either inserted its run, so the pipeline got two runs.
import fs from 'node:fs'
import path from 'node:path'
import { api, check, flowFor, root, WS } from './lib.mjs'

const etlStore = await import('../store.mjs')
const { listRuns } = await import('../runs.mjs')
const { schedulerNow } = await import('../schedule.mjs')

const SETTINGS = { batchSize: 10, concurrency: 1, maxRetries: 1, maxErrors: 5 }
const outcome = (promise) =>
    promise.then(
        (run) => ({ status: 200, run: run?.status }),
        (error) => ({ status: error.status, code: error.code, message: error.message })
    )
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timed out'), ms))])

async function savePipeline(id) {
    const file = path.join(root, `${id}.csv`)
    fs.writeFileSync(file, ['sku,name,notes', ...Array.from({ length: 30 }, (_, i) => `S${i},Loaf ${i},batch ${i}`)].join('\n'))
    await api.recordVersion({ workspaceId: WS, id, name: `Pipeline lock ${id}`, flowData: flowFor(file, '') })
}

// Every run holds its first embed call until release(), so a started run stays active while the check looks at it.
function holdRuns() {
    let reached
    const gateReached = new Promise((resolve) => (reached = resolve))
    let release
    const gateReleased = new Promise((resolve) => (release = resolve))
    const embedGate = async (call) => {
        if (call !== 1) return
        reached(true)
        await gateReleased
    }
    api.configureRunner({ contextFor: () => ({ workspaceId: WS, embedGate }) })
    return { reached: () => within(gateReached, 10000), release }
}

async function settle(gate) {
    api.configureRunner({ contextFor: () => ({ workspaceId: WS }) })
    gate.release()
    await api.waitForIdle()
}

// Two starts of one pipeline in the same turn.
{
    const id = 'lock-double'
    await savePipeline(id)
    const gate = holdRuns()
    const results = await Promise.all([
        outcome(api.startRun(id, { settings: SETTINGS })),
        outcome(api.startRun(id, { settings: SETTINGS }))
    ])
    const rows = (await listRuns(id)).length
    await settle(gate)
    const accepted = results.filter((result) => result.status === 200)
    const refused = results.filter((result) => result.status === 409 && result.code === 'run_active')
    const detail = JSON.stringify({ results, rows })
    check(
        'pipeline lock 1: of two starts of one pipeline in the same turn, one is accepted and one refused',
        accepted.length === 1 && refused.length === 1,
        detail
    )
    check('pipeline lock 2: two starts of one pipeline in the same turn leave one run', rows === 1, detail)
}

// A scheduler tick and a start of the same pipeline in the same turn both finish, and the pipeline gets one run.
{
    const id = 'lock-tick'
    await savePipeline(id)
    const schedule = await api.createSchedule(id, { kind: 'interval', every: 15, unit: 'minutes' })
    await etlStore.run('UPDATE schedules SET next_run_at = ? WHERE id = ?', [schedulerNow().toISOString(), schedule.id])
    const gate = holdRuns()
    const both = within(Promise.all([api.tickSchedules(), outcome(api.startRun(id, { settings: SETTINGS }))]), 10000)
    const settled = await both
    const rows = (await listRuns(id)).length
    await api.pauseSchedule(schedule.id)
    await settle(gate)
    const tick = settled === 'timed out' ? null : settled[0].find((entry) => entry.scheduleId === schedule.id)
    const start = settled === 'timed out' ? null : settled[1]
    const detail = JSON.stringify({ settled: settled === 'timed out' ? settled : 'both', tick, start, rows })
    check(
        'pipeline lock 3: a tick and a start of the same pipeline in the same turn both finish',
        settled !== 'timed out' && Boolean(tick),
        detail
    )
    check(
        'pipeline lock 4: that tick and start leave one run, started by exactly one of them',
        rows === 1 && [tick?.outcome === 'started', start?.status === 200].filter(Boolean).length === 1,
        detail
    )
}

// A start while the pipeline is being deleted is refused at once, not after the delete lets go of the lock.
{
    const id = 'lock-delete'
    await savePipeline(id)
    const gate = holdRuns()
    await api.startRun(id, { settings: SETTINGS })
    const held = await gate.reached()
    let deleted = false
    const deleting = api.deletePipeline(id).then((result) => {
        deleted = true
        return result
    })
    const start = await within(outcome(api.startRun(id, { settings: SETTINGS })), 2000)
    const deleteWasRunning = !deleted
    await settle(gate)
    const result = await deleting
    const detail = JSON.stringify({ held, start, deleteWasRunning, errors: result.errors })
    check(
        'pipeline lock 5: a start during a delete is refused at once with 409',
        held === true && deleteWasRunning && start !== 'timed out' && start.status === 409 && start.code === 'deleting',
        detail
    )
}
