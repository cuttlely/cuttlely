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

export async function checkRunControlRaces({ check, writeDuringRead }) {
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
    } finally {
        configureRunner({ faults: null, contextFor: () => ({ workspaceId: 'ws-check' }) })
        await waitForIdle()
    }
}
