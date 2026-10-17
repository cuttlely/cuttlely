import { HarnessError } from './errors.mjs'
import { assertTimeZone, nextCronRun } from './cron.mjs'
import { database, immediate } from './lock.mjs'
import { assertHarnessName } from './store.mjs'

// One schedule per harness, in the same database as run history, so it survives a restart.
// The server decides when a schedule is due and starts the run; this module only stores it.
export const SCHEDULE_INPUT_LIMIT = 4000
const STATUSES = new Set(['active', 'paused'])

function ensure(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS harness_schedules (
            harness_name TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            cron TEXT NOT NULL,
            timezone TEXT NOT NULL,
            input TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            status TEXT NOT NULL,
            next_run_at INTEGER,
            last_run_id TEXT,
            last_run_at INTEGER,
            last_result TEXT,
            last_reason TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS harness_schedules_due ON harness_schedules (status, next_run_at);
    `)
}

function iso(ms) {
    return Number.isFinite(ms) && ms > 0 ? new Date(Number(ms)).toISOString() : null
}

function toPublic(row) {
    if (!row) return null
    return {
        harness: row.harness_name,
        workspaceId: row.workspace_id,
        cron: row.cron,
        timezone: row.timezone,
        question: row.input,
        ownerId: row.owner_id,
        status: row.status,
        nextRunAt: row.status === 'active' ? iso(row.next_run_at) : null,
        lastRunId: row.last_run_id || null,
        lastRunAt: iso(row.last_run_at),
        lastResult: row.last_result || null,
        lastReason: row.last_reason || null,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at)
    }
}

export function normalizeSchedule(input = {}, now = new Date()) {
    const cron = String(input.cron ?? '')
        .trim()
        .replace(/\s+/g, ' ')
    const timezone = assertTimeZone(input.timezone)
    nextCronRun(cron, timezone, now)
    const question = String(input.question ?? input.input ?? '').trim()
    if (!question) throw new HarnessError('bad_schedule', 'A schedule needs the question the harness answers on each run.')
    if (question.length > SCHEDULE_INPUT_LIMIT) {
        throw new HarnessError('bad_schedule', `The scheduled question is longer than ${SCHEDULE_INPUT_LIMIT} characters.`)
    }
    return { cron, timezone, question }
}

export function getSchedule(name) {
    const harnessName = assertHarnessName(name)
    const db = database()
    ensure(db)
    return toPublic(db.prepare('SELECT * FROM harness_schedules WHERE harness_name = ?').get(harnessName))
}

export function listSchedules() {
    const db = database()
    ensure(db)
    return db.prepare('SELECT * FROM harness_schedules ORDER BY harness_name').all().map(toPublic)
}

/** Create or replace. The caller becomes the owner, and the next run is counted from now. */
export function saveSchedule(name, input = {}, { workspaceId, ownerId, now = new Date() } = {}) {
    const harnessName = assertHarnessName(name)
    if (!workspaceId) throw new HarnessError('bad_schedule', 'A schedule needs the harness team.')
    if (!ownerId) throw new HarnessError('bad_schedule', 'A schedule runs as a person. Sign in to set one.')
    const spec = normalizeSchedule(input, now)
    const status = input.active === false || input.status === 'paused' ? 'paused' : 'active'
    const next = nextCronRun(spec.cron, spec.timezone, now).getTime()
    const stamp = now.getTime()
    immediate((db) => {
        ensure(db)
        db.prepare(
            `INSERT INTO harness_schedules (
                harness_name, workspace_id, cron, timezone, input, owner_id, status, next_run_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(harness_name) DO UPDATE SET
                workspace_id = excluded.workspace_id, cron = excluded.cron, timezone = excluded.timezone,
                input = excluded.input, owner_id = excluded.owner_id, status = excluded.status,
                next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`
        ).run(harnessName, workspaceId, spec.cron, spec.timezone, spec.question, ownerId, status, next, stamp, stamp)
    })
    return getSchedule(harnessName)
}

export function setScheduleStatus(name, status, { now = new Date() } = {}) {
    if (!STATUSES.has(status)) throw new HarnessError('bad_schedule', `Unknown schedule status "${status}".`)
    const current = getSchedule(name)
    if (!current) throw new HarnessError('not_found', `Harness "${name}" has no schedule.`)
    // Resuming counts from now, so a schedule paused over several due times does not fire for each of them.
    const next = status === 'active' ? nextCronRun(current.cron, current.timezone, now).getTime() : null
    immediate((db) => {
        ensure(db)
        db.prepare(
            'UPDATE harness_schedules SET status = ?, next_run_at = COALESCE(?, next_run_at), updated_at = ? WHERE harness_name = ?'
        ).run(status, next, now.getTime(), current.harness)
    })
    return getSchedule(current.harness)
}

export function deleteSchedule(name) {
    const harnessName = assertHarnessName(name)
    let removed = false
    immediate((db) => {
        ensure(db)
        removed = db.prepare('DELETE FROM harness_schedules WHERE harness_name = ?').run(harnessName).changes > 0
    })
    return removed
}

/** Active schedules whose next run is at or before `now`, oldest first. */
export function dueSchedules(now = new Date()) {
    const db = database()
    ensure(db)
    return db
        .prepare(
            `SELECT * FROM harness_schedules WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`
        )
        .all(now.getTime())
        .map(toPublic)
}

/**
 * The next time after a due time, from the later of now and that due time, so time the server was down is not run as
 * a backlog and a late tick does not run the same wall time again. Null when the cron has no later time.
 */
export function nextAfterDue(schedule, now = new Date()) {
    try {
        return nextCronRun(schedule.cron, schedule.timezone, now, { dueAt: new Date(schedule.nextRunAt) }).getTime()
    } catch {
        return null
    }
}

/**
 * Takes one due time for this process. Only the process whose update moves `next_run_at` off the due time may start
 * the run, so two servers on the same data never both start it. Returns false when another process took it, or when
 * the schedule was paused or changed since it was read.
 */
export function claimSchedule(name, { dueAt, next, now = new Date() } = {}) {
    const harnessName = assertHarnessName(name)
    let changes = 0
    immediate((db) => {
        ensure(db)
        changes = db
            .prepare(
                `UPDATE harness_schedules SET next_run_at = ?, last_result = 'starting', last_reason = NULL, updated_at = ?
                 WHERE harness_name = ? AND status = 'active' AND next_run_at = ?`
            )
            .run(next, now.getTime(), harnessName, Date.parse(dueAt)).changes
    })
    return changes === 1
}

/** Records what a claimed due time did. A schedule saved again since the claim keeps its new state. */
export function recordScheduleTick(name, { claimedNext = null, runId = null, result, reason = null, now = new Date() } = {}) {
    const current = getSchedule(name)
    if (!current) return null
    immediate((db) => {
        ensure(db)
        db.prepare(
            `UPDATE harness_schedules
             SET last_result = ?, last_reason = ?, updated_at = ?,
                 last_run_id = COALESCE(?, last_run_id), last_run_at = CASE WHEN ? IS NULL THEN last_run_at ELSE ? END
             WHERE harness_name = ? AND next_run_at IS ?`
        ).run(
            String(result || '').slice(0, 32),
            reason ? String(reason).slice(0, 300) : null,
            now.getTime(),
            runId,
            runId,
            now.getTime(),
            current.harness,
            claimedNext
        )
    })
    return getSchedule(current.harness)
}

/** The run a schedule started has finished. Only the latest run of that schedule changes its last result. */
export function recordScheduledRunSettled(name, runId, result) {
    let harnessName
    try {
        harnessName = assertHarnessName(name)
    } catch {
        return null
    }
    immediate((db) => {
        ensure(db)
        db.prepare('UPDATE harness_schedules SET last_result = ?, updated_at = ? WHERE harness_name = ? AND last_run_id = ?').run(
            String(result || '').slice(0, 32),
            Date.now(),
            harnessName,
            runId
        )
    })
    return getSchedule(harnessName)
}

const OPEN_RUNS = new Set(['queued', 'running'])
const inFlight = new Set()
let ticking = false

/**
 * Starts every due, active schedule once. Each due time is claimed first, so only one process acts on it. A schedule
 * whose last run is still queued or running is skipped, so runs never overlap. Each due time is recorded, and the
 * next time is counted from the later of now and the due time.
 *
 * `start(schedule, onSettled)` starts the run and resolves to `{ runId }`. `ownerMayRun(schedule)` checks the owner's
 * permissions in the harness team at this due time. `audit(schedule, summary, detail)` writes an audit row, including
 * one with the run id for every run a schedule starts.
 */
export async function tickSchedules({ now = () => new Date(), start, ownerMayRun, audit = async () => {}, log = () => {} } = {}) {
    if (ticking) return []
    ticking = true
    const outcomes = []
    try {
        const { getRun } = await import('./history.mjs')
        const at = now()
        for (const schedule of dueSchedules(at)) {
            const name = schedule.harness
            const claimedNext = nextAfterDue(schedule, at)
            if (!claimSchedule(name, { dueAt: schedule.nextRunAt, next: claimedNext, now: at })) continue
            const tick = (fields) => recordScheduleTick(name, { claimedNext, now: at, ...fields })
            try {
                const lastStatus = schedule.lastRunId ? getRun(name, schedule.lastRunId)?.status : null
                if (inFlight.has(name) || OPEN_RUNS.has(lastStatus)) {
                    const reason = `Run ${schedule.lastRunId || ''} is still running, so this time was skipped. Runs do not overlap.`
                    tick({ result: 'skipped', reason })
                    log('info', `schedule ${name}: skipped, the last run is still running`)
                    outcomes.push({ harness: name, result: 'skipped', reason })
                    continue
                }
                if (!(await ownerMayRun(schedule))) {
                    const reason = 'The schedule owner can no longer run this harness. Save the schedule again as someone who can.'
                    tick({ result: 'refused', reason })
                    await audit(schedule, 'Scheduled harness run refused', { action: 'run_refused', reason: 'owner_permission' })
                    log('warn', `schedule ${name}: refused, the owner can no longer run it`)
                    outcomes.push({ harness: name, result: 'refused', reason })
                    continue
                }
                inFlight.add(name)
                let started
                try {
                    started = await start(schedule, (outcome) => {
                        inFlight.delete(name)
                        const status = getRun(name, outcome?.runId)?.status || outcome?.status || 'failed'
                        recordScheduledRunSettled(name, outcome?.runId, status)
                    })
                } catch (error) {
                    inFlight.delete(name)
                    throw error
                }
                tick({ result: 'running', runId: started.runId })
                await audit(schedule, 'Scheduled harness run started', { action: 'run_started', runId: started.runId })
                log('info', `schedule ${name}: started run ${started.runId}`)
                outcomes.push({ harness: name, result: 'running', runId: started.runId })
            } catch (error) {
                const reason = error?.message || String(error)
                try {
                    tick({ result: 'failed', reason })
                } catch {
                    // The claim already moved the schedule to its next due time.
                }
                log('warn', `schedule ${name}: did not start: ${reason}`)
                outcomes.push({ harness: name, result: 'failed', reason })
            }
        }
        return outcomes
    } finally {
        ticking = false
    }
}
