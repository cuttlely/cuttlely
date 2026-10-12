import crypto from 'node:crypto'
import { EtlError } from './errors.mjs'
import { now, stmt } from './db.mjs'
import { nextCron } from './cron.mjs'
import { activeRunFor, getRun } from './runs.mjs'
import { configureRunner, startRun } from './runner.mjs'
import { getPipeline } from './versions.mjs'

// In-process scheduler. enqueue/startRun is still the only execution seam: a later queue
// replaces startRun's pump, and this loop keeps deciding when a pipeline is due.
let clock = () => new Date()
let timer = null
let pollMs = Math.max(1000, Number(process.env.CUTTLELY_ETL_SCHEDULE_MS) || 15000)
let ticking = false

export function configureScheduler({ now: nowFn, pollMs: nextPoll } = {}) {
    if (typeof nowFn === 'function') clock = nowFn
    if (Number(nextPoll) > 0) pollMs = Number(nextPoll)
}

export function schedulerNow() {
    return new Date(clock().getTime())
}

function addInterval(from, every, unit) {
    const ms = every * (unit === 'hours' ? 3600000 : 60000)
    return new Date(from.getTime() + ms)
}

export function nextRunAt(schedule, from) {
    if (schedule.kind === 'cron') return nextCron(schedule.cron, from)
    return addInterval(from, schedule.every, schedule.unit)
}

function rowToSchedule(row) {
    if (!row) return null
    return {
        id: row.id,
        pipelineId: row.pipeline_id,
        kind: row.kind,
        every: row.every_n,
        unit: row.every_unit,
        cron: row.cron,
        mode: row.mode,
        status: row.status,
        nextRunAt: row.next_run_at,
        lastRunId: row.last_run_id,
        lastRunAt: row.last_run_at,
        lastResult: row.last_result,
        lastReason: row.last_reason,
        label: scheduleLabel(row),
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

export function scheduleLabel(row) {
    if (!row) return ''
    if (row.kind === 'cron') return row.cron
    const n = row.every_n ?? row.every
    const unit = row.every_unit || row.unit
    const name = n === 1 ? unit.replace(/s$/, '') : unit
    return `Every ${n} ${name}`
}

function normalize(input = {}) {
    const kind = input.kind === 'cron' ? 'cron' : 'interval'
    const mode = input.mode === 'full' ? 'full' : 'incremental'
    if (kind === 'cron') {
        const cron = String(input.cron || '').trim()
        nextCron(cron, schedulerNow())
        return { kind, cron, every: null, unit: null, mode }
    }
    const every = Math.floor(Number(input.every))
    const unit = input.unit === 'hours' ? 'hours' : 'minutes'
    const max = unit === 'hours' ? 24 * 366 : 60 * 24 * 366
    if (!Number.isInteger(every) || every < 1 || every > max) {
        throw new EtlError('bad_schedule', 'Interval must be a whole number of minutes or hours, at least 1.')
    }
    return { kind, cron: null, every, unit, mode }
}

function requirePipeline(pipelineId) {
    const pipeline = getPipeline(pipelineId)
    if (!pipeline) throw new EtlError('not_found', 'Save the pipeline before scheduling it.', 404)
    return pipeline
}

export function listSchedules(pipelineId) {
    return stmt('SELECT * FROM schedules WHERE pipeline_id = ? ORDER BY created_at').all(pipelineId).map(rowToSchedule)
}

export function getSchedule(id) {
    return rowToSchedule(stmt('SELECT * FROM schedules WHERE id = ?').get(id))
}

export function createSchedule(pipelineId, input = {}) {
    requirePipeline(pipelineId)
    const spec = normalize(input)
    const id = crypto.randomUUID()
    const stamp = now()
    const next = nextRunAt(spec, schedulerNow()).toISOString()
    stmt(
        `INSERT INTO schedules (id, pipeline_id, kind, every_n, every_unit, cron, mode, status, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    ).run(id, pipelineId, spec.kind, spec.every, spec.unit, spec.cron, spec.mode, next, stamp, stamp)
    return getSchedule(id)
}

export function updateSchedule(id, input = {}) {
    const current = getSchedule(id)
    if (!current) throw new EtlError('not_found', 'Schedule was not found.', 404)
    const spec = normalize({ ...current, ...input, every: input.every ?? current.every, unit: input.unit ?? current.unit })
    const next = nextRunAt(spec, schedulerNow()).toISOString()
    stmt(
        `UPDATE schedules SET kind = ?, every_n = ?, every_unit = ?, cron = ?, mode = ?, next_run_at = ?, updated_at = ? WHERE id = ?`
    ).run(spec.kind, spec.every, spec.unit, spec.cron, spec.mode, next, now(), id)
    return getSchedule(id)
}

export function pauseSchedule(id) {
    const current = getSchedule(id)
    if (!current) throw new EtlError('not_found', 'Schedule was not found.', 404)
    stmt(`UPDATE schedules SET status = 'paused', updated_at = ? WHERE id = ?`).run(now(), id)
    return getSchedule(id)
}

export function resumeSchedule(id) {
    const current = getSchedule(id)
    if (!current) throw new EtlError('not_found', 'Schedule was not found.', 404)
    let next = current.nextRunAt
    if (!next || new Date(next).getTime() <= schedulerNow().getTime()) next = nextRunAt(current, schedulerNow()).toISOString()
    stmt(`UPDATE schedules SET status = 'active', next_run_at = ?, updated_at = ? WHERE id = ?`).run(next, now(), id)
    return getSchedule(id)
}

export function deleteSchedule(id) {
    const current = getSchedule(id)
    if (!current) throw new EtlError('not_found', 'Schedule was not found.', 404)
    stmt('DELETE FROM schedules WHERE id = ?').run(id)
    return { id, deleted: true }
}

function mark(id, fields) {
    const sets = []
    const values = []
    for (const [key, value] of Object.entries(fields)) {
        sets.push(`${key} = ?`)
        values.push(value)
    }
    sets.push('updated_at = ?')
    values.push(now(), id)
    stmt(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function noteRunSettled(runId) {
    const run = getRun(runId)
    if (!run) return
    const rows = stmt(`SELECT id, last_result FROM schedules WHERE last_run_id = ?`).all(runId)
    for (const row of rows) {
        if (row.last_result === 'skipped') continue
        mark(row.id, { last_result: run.status, last_reason: run.error || null })
    }
}

function installSettled() {
    configureRunner({ onSettled: noteRunSettled })
}

// Due active schedules fire once. A pipeline that already has a run is skipped and the reason is stored.
export function tickSchedules() {
    if (ticking) return []
    ticking = true
    installSettled()
    const outcomes = []
    try {
        const due = stmt(
            `SELECT * FROM schedules WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`
        ).all(schedulerNow().toISOString())
        for (const row of due) {
            const schedule = rowToSchedule(row)
            const at = schedulerNow()
            let outcome = 'started'
            let runId = null
            let reason = null
            try {
                const running = activeRunFor(schedule.pipelineId)
                if (running) {
                    outcome = 'skipped'
                    reason = `Run ${running.id.slice(0, 8)} is still ${running.status}. This tick was skipped so runs do not stack.`
                    mark(schedule.id, { last_result: 'skipped', last_reason: reason })
                } else {
                    const run = startRun(schedule.pipelineId, { mode: schedule.mode })
                    runId = run.id
                    mark(schedule.id, {
                        last_run_id: run.id,
                        last_run_at: at.toISOString(),
                        last_result: 'running',
                        last_reason: null
                    })
                }
            } catch (error) {
                outcome = 'failed'
                reason = error.message
                mark(schedule.id, { last_result: 'failed', last_reason: reason })
            }
            const next = nextRunAt(schedule, at).toISOString()
            stmt('UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ?').run(next, now(), schedule.id)
            outcomes.push({ scheduleId: schedule.id, outcome, runId, reason })
        }
        return outcomes
    } finally {
        ticking = false
    }
}

export function startScheduler() {
    installSettled()
    if (timer) return
    timer = setInterval(() => {
        try {
            tickSchedules()
        } catch {
            // a bad row must not kill the loop; the next tick tries again
        }
    }, pollMs)
    timer.unref?.()
    tickSchedules()
}

export function stopScheduler() {
    if (timer) clearInterval(timer)
    timer = null
}
