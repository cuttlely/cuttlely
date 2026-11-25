// Shared SQLite/Postgres cases. SQLite injects through the held transaction; Postgres commits on a second connection
// after the runner's SELECT, while its READ COMMITTED transaction is still open. No execution or provider is mocked.
import crypto from 'node:crypto'
import * as etlStore from '../store.mjs'
import { fault } from '../faults.mjs'
import { addEvent, finishRunStop, getRun, insertRun, listEvents, normalizeSettings, updateRun, updateRunIf } from '../runs.mjs'
import { cancelRun, configureRunner, isActive, pauseRun, resumeInterruptedRuns, resumeRun, waitForIdle } from '../runner.mjs'

const STOP_EVENTS = { paused: 'Paused at the last committed batch.', cancelled: 'Cancelled. Nothing was deleted.' }
const CONTROL_EVENTS = [
    'Pausing after the batches in flight commit.',
    'Cancelling after the batches in flight finish.',
    'Resuming from the last checkpoint.',
    'Retrying from the last checkpoint.'
]

// The error a request was refused with, or null when it succeeded.
function refusal(promise) {
    return promise.then(
        () => null,
        (error) => ({ code: error.code, status: error.status, message: error.message })
    )
}

async function seed(status = 'queued') {
    const pipelineId = `race-${crypto.randomUUID()}`
    const stamp = new Date().toISOString()
    await etlStore.run('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
        pipelineId,
        pipelineId,
        pipelineId,
        'ws-check',
        stamp,
        stamp
    ])
    const run = await insertRun({ pipelineId, version: 1, mode: 'incremental', settings: normalizeSettings() })
    if (status !== 'queued') await updateRun(run.id, { status })
    return run
}

export async function checkRunControlRaces({ check, writeDuringRead, savePipeline }) {
    await waitForIdle()
    try {
        // Exercise the shared field mapping and both affected-row outcomes on the actual selected store.
        const run = await seed()
        const patch = {
            status: 'paused',
            checkpoint: { phase: 'load', offset: 7 },
            counters: { chunks: 3 },
            steps: { load: { status: 'done' } },
            summary: { read: 7 },
            error: 'Fixture error',
            attempt: 2,
            startedAt: '2001-01-01T00:00:00.000Z',
            finishedAt: '2001-01-01T00:01:00.000Z'
        }
        const applied = await updateRunIf(run.id, ['queued', 'running'], patch)
        const stored = await getRun(run.id)
        check(
            'run CAS: conditional updates preserve the updateRun field mapping',
            applied === true &&
                Object.entries(patch).every(([key, value]) =>
                    typeof value === 'object'
                        ? Object.entries(value).every(
                              ([field, expected]) => JSON.stringify(stored[key][field]) === JSON.stringify(expected)
                          )
                        : stored[key] === value
                )
        )
        const missed = await updateRunIf(run.id, ['queued'], { status: 'failed', checkpoint: null, error: 'Stale error' })
        const empty = await updateRunIf(run.id, [], { status: 'failed' })
        const missing = await updateRunIf('missing-fixture-run', ['paused'], { status: 'failed' })
        check(
            'run CAS: mismatched, empty and missing targets return false without changing the row',
            missed === false && empty === false && missing === false && JSON.stringify(await getRun(run.id)) === JSON.stringify(stored)
        )
        await updateRunIf(run.id, ['paused'], { checkpoint: null, summary: null, error: null })
        const cleared = await getRun(run.id)
        check(
            'run CAS: explicit nulls clear fields and omitted fields stay',
            cleared.checkpoint === null && cleared.summary === null && cleared.error === null && cleared.attempt === 2
        )

        for (const status of ['pausing', 'cancelling', 'running']) {
            for (const target of ['cancelled', 'paused']) {
                const seeded = await seed(status)
                let fired = 0
                let launches = 0
                let winner
                configureRunner({
                    contextFor: () => {
                        launches += 1
                        throw new Error('Recovery must not launch the stopped fixture.')
                    },
                    faults: {
                        recoveryAfterRead: async (current, t) => {
                            if (current.id !== seeded.id) return
                            check(`recovery race ${status}/${target}: hook follows the status read`, current.status === status)
                            fired += 1
                            await writeDuringRead(t, async (q) => {
                                await updateRun(
                                    current.id,
                                    {
                                        status: target,
                                        ...(target === 'cancelled' ? { finishedAt: '2001-01-01T00:01:00.000Z' } : {})
                                    },
                                    q
                                )
                                // A known user timestamp also detects an unwanted write when both writers choose paused.
                                await q.run('UPDATE runs SET updated_at = ? WHERE id = ?', ['2001-01-01T00:02:00.000Z', current.id])
                                await addEvent(current.id, 'info', null, STOP_EVENTS[target], q)
                                winner = await getRun(current.id, q)
                            })
                        }
                    }
                })
                const resumed = await resumeInterruptedRuns()
                await waitForIdle()
                const after = await getRun(seeded.id)
                const events = await listEvents(seeded.id)
                check(
                    `recovery race ${status}/${target}: the committed stop wins with no recovery event or relaunch`,
                    fired === 1 &&
                        launches === 0 &&
                        !resumed.includes(seeded.id) &&
                        !isActive(seeded.id) &&
                        JSON.stringify(after) === JSON.stringify(winner) &&
                        events.length === 1 &&
                        events[0].message === STOP_EVENTS[target],
                    JSON.stringify({ fired, launches, resumed, after, events })
                )
            }
        }

        // Throw before executeRun so the real launch catch owns the outcome. A terminal stop is completed through the
        // same helper used by executeRun, then the catch must not add another stop event.
        for (const status of ['queued', 'running']) {
            for (const action of [
                'none',
                'cancel-before-throw',
                'pause-before-throw',
                'cancel-after-read',
                'pause-after-read',
                'cancelled-before-throw',
                'paused-before-throw'
            ]) {
                const seeded = await seed()
                const target = action.startsWith('cancel') ? 'cancelled' : action.startsWith('paus') ? 'paused' : 'failed'
                let launches = 0
                let fired = 0
                const faults = {
                    launchBeforeThrow: async () => {
                        if (action === 'cancel-before-throw') {
                            fired += 1
                            await cancelRun(seeded.id)
                        } else if (action === 'pause-before-throw') {
                            fired += 1
                            await pauseRun(seeded.id)
                        } else if (action === 'cancelled-before-throw' || action === 'paused-before-throw') {
                            fired += 1
                            await etlStore.tx(async (q) => {
                                await updateRun(seeded.id, { status: target === 'cancelled' ? 'cancelling' : 'pausing' }, q)
                                await finishRunStop(seeded.id, q)
                            })
                        }
                    },
                    launchErrorAfterRead: async (current, t) => {
                        if (current?.id !== seeded.id || !action.endsWith('after-read')) return
                        check(`launch race ${status}/${action}: hook follows the status read`, current.status === status)
                        fired += 1
                        await writeDuringRead(t, (q) =>
                            updateRun(seeded.id, { status: target === 'cancelled' ? 'cancelling' : 'pausing' }, q)
                        )
                    }
                }
                configureRunner({
                    faults,
                    contextFor: async () => {
                        launches += 1
                        if (status === 'running') await updateRun(seeded.id, { status })
                        await fault({ faults }, 'launchBeforeThrow')
                        throw new Error('Fixture launch failure.')
                    }
                })
                await resumeInterruptedRuns()
                await waitForIdle()
                const after = await getRun(seeded.id)
                const events = await listEvents(seeded.id)
                const errors = events.filter((event) => event.level === 'error')
                const stopEvents = events.filter((event) => Object.values(STOP_EVENTS).includes(event.message))
                check(
                    `launch race ${status}/${action}: only a failed write logs an error and stop completion logs once`,
                    launches === 1 &&
                        fired === (action === 'none' ? 0 : 1) &&
                        after.status === target &&
                        !isActive(seeded.id) &&
                        !after.startedAt &&
                        (target === 'paused' ? !after.finishedAt : Boolean(after.finishedAt)) &&
                        errors.length === (target === 'failed' ? 1 : 0) &&
                        after.error === (target === 'failed' ? 'Fixture launch failure.' : null) &&
                        stopEvents.length === (target === 'failed' ? 0 : 1),
                    JSON.stringify({ launches, fired, after, events })
                )
            }
        }

        // Pause, cancel and resume write the status only if it is still the one they read. Another writer's commit after
        // the read wins, and the request answers from the status that writer left. C1 and C2 call from contextFor, where
        // the job is active.
        for (const { name, seedStatus, point, request, target, inLaunch, expect } of [
            {
                name: 'pause race running/succeeded',
                seedStatus: 'queued',
                point: 'pauseAfterRead',
                request: pauseRun,
                target: 'succeeded',
                inLaunch: true,
                expect: 'the committed finish wins with 409 and no pausing event'
            },
            {
                name: 'pause race queued/cancelled',
                seedStatus: 'queued',
                point: 'pauseAfterRead',
                request: pauseRun,
                target: 'cancelled',
                expect: 'the committed cancel wins with 409'
            },
            {
                name: 'cancel race running/succeeded',
                seedStatus: 'queued',
                point: 'cancelAfterRead',
                request: cancelRun,
                target: 'succeeded',
                inLaunch: true,
                expect: 'the committed finish wins with 409 and no cancelling event'
            },
            {
                name: 'cancel race paused/queued',
                seedStatus: 'paused',
                point: 'cancelAfterRead',
                request: cancelRun,
                target: 'queued',
                expect: 'cancel re-reads and cancels the queued run once'
            },
            {
                name: 'resume race paused/cancelled',
                seedStatus: 'paused',
                point: 'resumeAfterRead',
                request: resumeRun,
                target: 'cancelled',
                expect: 'the committed cancel wins with 409 and no queued event'
            }
        ]) {
            const seeded = await seed(seedStatus)
            const readStatus = inLaunch ? 'running' : seedStatus
            let fired = 0
            let refused
            const faults = {
                [point]: async (current, t) => {
                    if (current.id !== seeded.id || fired) return
                    fired += 1
                    check(`${name}: hook follows the status read`, current.status === readStatus)
                    await writeDuringRead(t, (q) =>
                        updateRun(
                            seeded.id,
                            { status: target, ...(target === 'cancelled' ? { finishedAt: '2001-01-01T00:01:00.000Z' } : {}) },
                            q
                        )
                    )
                }
            }
            if (inLaunch) {
                configureRunner({
                    faults,
                    contextFor: async () => {
                        await updateRun(seeded.id, { status: 'running' })
                        refused = await refusal(request(seeded.id))
                        throw new Error('Fixture launch stop.')
                    }
                })
                await resumeInterruptedRuns()
            } else {
                configureRunner({ faults })
                refused = await refusal(request(seeded.id))
            }
            await waitForIdle()
            const after = await getRun(seeded.id)
            const events = await listEvents(seeded.id)
            const detail = JSON.stringify({ fired, refused, after, events })
            if (target === 'queued') {
                check(
                    `${name}: ${expect}`,
                    fired === 1 &&
                        refused === null &&
                        after.status === 'cancelled' &&
                        Boolean(after.finishedAt) &&
                        !isActive(seeded.id) &&
                        events.length === 1 &&
                        events[0].message === STOP_EVENTS.cancelled,
                    detail
                )
            } else {
                check(
                    `${name}: ${expect}`,
                    fired === 1 &&
                        refused?.code === 'bad_state' &&
                        refused.status === 409 &&
                        refused.message.includes(target) &&
                        after.status === target &&
                        after.error === null &&
                        !isActive(seeded.id) &&
                        !events.some(
                            (event) => CONTROL_EVENTS.includes(event.message) || Object.values(STOP_EVENTS).includes(event.message)
                        ),
                    detail
                )
            }
        }

        // C4/C4b: Claim races. The claim that starts a queued run writes only while the run is still queued.
        // A pause or cancel committed after its read is finished as a stop, and the run never starts.
        if (savePipeline) {
            const { startRun, isActive } = await import('../runner.mjs')
            for (const [stop, target, message] of [
                ['pausing', 'paused', 'Paused at the last committed batch.'],
                ['cancelling', 'cancelled', 'Cancelled. Nothing was deleted.']
            ]) {
                const name = `claim race queued/${stop}`
                const id = `run-control-claim-${stop}`
                let fired = 0
                try {
                    configureRunner({
                        contextFor: () => ({
                            workspaceId: 'ws-check',
                            faults: {
                                claimAfterRead: async (current, t) => {
                                    if (fired) return
                                    fired += 1
                                    check(`${name}: hook follows the status read`, current?.status === 'queued')
                                    await writeDuringRead(t, (q) => updateRun(current.id, { status: stop }, q))
                                }
                            }
                        })
                    })
                    await savePipeline(id)
                    const started = await startRun(id, { settings: normalizeSettings() })
                    await waitForIdle()
                    const after = await getRun(started.id)
                    const stops = (await listEvents(started.id)).filter((event) => event.message === message)
                    check(
                        `${name}: the claim yields and the stop finishes as ${target} with one event`,
                        fired === 1 &&
                            after.status === target &&
                            !after.startedAt &&
                            (target === 'cancelled' ? Boolean(after.finishedAt) : !after.finishedAt) &&
                            stops.length === 1 &&
                            !isActive(started.id),
                        JSON.stringify({ fired, after, stops })
                    )
                } finally {
                    configureRunner({ contextFor: () => ({ workspaceId: 'ws-check' }) })
                }
            }
        }

        // C5: the stop writer holds an uncommitted UPDATE when the runner's guarded UPDATE starts, so Postgres must block the
        // runner and then re-check the status predicate. Postgres only: SQLite serializes writers before either can start.
        const { backendName } = await import('../store.mjs')
        if (backendName() === 'postgres' && writeDuringRead) {
            const run = await seed('queued')
            let fired = false
            let blocked = false
            let writerCommitted = false
            let writer
            configureRunner({
                contextFor: () => ({ workspaceId: 'ws-check' }),
                faults: {
                    cancelAfterRead: async (current, t) => {
                        if (current.id !== run.id || fired) return
                        fired = true
                        const runnerPid = (await t.get('SELECT pg_backend_pid() AS pid')).pid
                        let locked
                        const held = new Promise((resolve) => (locked = resolve))
                        // Not awaited: the runner must reach its guarded UPDATE while the stop is still uncommitted.
                        writer = writeDuringRead(t, async (q) => {
                            await q.run('UPDATE runs SET status = ? WHERE id = ?', ['cancelled', run.id])
                            locked()
                            for (let poll = 0; poll < 50 && !blocked; poll++) {
                                await new Promise((resolve) => setTimeout(resolve, 20))
                                blocked = Boolean(
                                    await q.get('SELECT 1 AS waiting FROM pg_locks WHERE pid = ? AND NOT granted', [runnerPid])
                                )
                            }
                            writerCommitted = true
                        })
                        await held
                    }
                }
            })
            const refused = await refusal(cancelRun(run.id))
            await writer
            await waitForIdle()
            const after = await getRun(run.id)
            const stops = (await listEvents(run.id)).filter((event) => event.message === STOP_EVENTS.cancelled)
            check(
                'C5: the runner blocks on the uncommitted stop, then its guarded UPDATE re-checks the status and refuses',
                blocked &&
                    writerCommitted &&
                    refused?.code === 'bad_state' &&
                    refused?.status === 409 &&
                    after.status === 'cancelled' &&
                    stops.length === 0,
                JSON.stringify({ blocked, writerCommitted, refused, status: after.status, stops: stops.length })
            )
            configureRunner({ faults: null, contextFor: () => ({ workspaceId: 'ws-check' }) })
        }

        // C7: Queue parity - standalone run executes after tx commits
        {
            const run = await seed()
            const events = []
            await etlStore.tx(async (t) => {
                events.push('tx-start')
                const standalonePending = etlStore.run('UPDATE runs SET error = ? WHERE id = ?', ['standalone', run.id]).then(() => {
                    events.push('standalone')
                })
                await t.run('UPDATE runs SET checkpoint = ? WHERE id = ?', ['{"tx":"1"}', run.id])
                events.push('tx-end')
                await new Promise((resolve) => setTimeout(resolve, 50))
            })
            await new Promise((resolve) => setTimeout(resolve, 100))

            check(
                'C7: queue parity - standalone run waits for tx',
                events[0] === 'tx-start' && events[1] === 'tx-end' && events[2] === 'standalone',
                JSON.stringify({ events })
            )
        }

        // C8: 50 concurrent addEvent calls. listEvents({ after }) is a tail-poll, so poll with a limit that covers every
        // event while the writes are in flight: a missing id can only be an out-of-order commit gap, never truncation.
        {
            const run = await seed()
            let settled = false
            const writes = Promise.all(Array.from({ length: 50 }, (_, i) => addEvent(run.id, 'info', null, `Event ${i}`))).finally(() => {
                settled = true
            })
            const ids = new Set()
            const messages = []
            const pages = []
            let after = 0
            let fetched = 0
            for (let poll = 0; poll < 500; poll++) {
                const done = settled
                const page = await listEvents(run.id, { after, limit: 50 })
                pages.push({ after, ids: page.map((event) => event.id) })
                for (const event of page) {
                    ids.add(event.id)
                    messages.push(event.message)
                }
                fetched += page.length
                if (page.length) after = page[page.length - 1].id
                if (done && page.length === 0) break
                await new Promise((resolve) => setImmediate(resolve))
            }
            await writes
            const ordered = pages.every(({ after: from, ids: page }) => page.every((id, i) => id > (i ? page[i - 1] : from)))
            const expected = Array.from({ length: 50 }, (_, i) => `Event ${i}`)
            const tail = (await listEvents(run.id, { after: 0, limit: 20 })).map((event) => event.id)
            const highest = [...ids].sort((a, b) => a - b).slice(-20)
            check(
                'C8: 50 concurrent events, polls during the writes return each id once in order',
                ids.size === 50 &&
                    fetched === 50 &&
                    ordered &&
                    JSON.stringify([...messages].sort()) === JSON.stringify([...expected].sort()) &&
                    JSON.stringify(tail) === JSON.stringify(highest),
                JSON.stringify({ size: ids.size, fetched, ordered, polls: pages.length, tail })
            )
        }
    } finally {
        configureRunner({ faults: null, contextFor: () => ({ workspaceId: 'ws-check' }) })
        await waitForIdle()
    }
}
