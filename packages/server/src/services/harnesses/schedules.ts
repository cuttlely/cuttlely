import { getErrorMessage } from '../../errors/utils'
import { safeRecordAudit } from '../../identity/auditLog'
import { resolveTeamAccess } from '../../identity/rbac'
import logger from '../../utils/logger'
import { isDraining, isShuttingDown, onDrainStart, trackBackgroundRun } from '../../settings/runs'
import { orgIdForWorkspace } from '../etl'
import harnessesService, { loadHarness } from '.'

export const HARNESS_SCHEDULE_POLL_MS = 15000
// The same keys that let a person start a run from the harness page or the API.
const RUN_PERMISSIONS = ['chatflows:create', 'chatflows:update', 'agentflows:create']

interface StoredSchedule {
    harness: string
    workspaceId: string
    ownerId: string
    question: string
}

/** A schedule runs with its owner's permissions in the harness team, checked again at every due time. */
export async function ownerMayRun(ownerId: string, workspaceId: string): Promise<boolean> {
    if (!ownerId || !workspaceId) return false
    const access = await resolveTeamAccess(ownerId, workspaceId)
    if (access.owner) return true
    return Array.isArray(access.permissions) && RUN_PERMISSIONS.some((key) => access.permissions!.includes(key))
}

async function auditSchedule(schedule: StoredSchedule, summary: string, detail: Record<string, unknown>) {
    try {
        const organizationId = await orgIdForWorkspace(schedule.workspaceId)
        if (!organizationId) return
        const { applicationSql } = await import('../../identity/production')
        await safeRecordAudit(applicationSql(), {
            type: 'harness_schedule',
            organizationId,
            workspaceId: schedule.workspaceId,
            userId: schedule.ownerId,
            actorId: null,
            summary,
            detail: { harness: schedule.harness, ...detail }
        })
    } catch (error) {
        logger.warn(`[harness] schedule audit event was not saved: ${getErrorMessage(error)}`)
    }
}

const stopping = () => isDraining() || isShuttingDown()

// The run goes through startBackgroundRun, the same path as an API run, so history, traces, and usage match.
// A server that is restarting or shutting down starts nothing; the due time stays due for the next tick. That is checked
// again before each start, because a drain can begin while one tick works through several due schedules.
export async function tickHarnessSchedules() {
    if (stopping()) return []
    const schedules = await loadHarness('schedule.mjs')
    return schedules.tickSchedules({
        stopping,
        // The owner's access was just checked by ownerMayRun, so the run acts as that signed-in person would.
        start: (schedule: StoredSchedule, onSettled: (outcome: { runId: string; status: string }) => void) =>
            harnessesService.startBackgroundRun(
                schedule.harness,
                { question: schedule.question },
                {
                    workspaceId: schedule.workspaceId,
                    source: 'schedule',
                    caller: { via: 'session' },
                    track: trackBackgroundRun,
                    onSettled
                }
            ),
        ownerMayRun: (schedule: StoredSchedule) => ownerMayRun(schedule.ownerId, schedule.workspaceId),
        audit: auditSchedule,
        log: (level: 'info' | 'warn', message: string) => {
            if (level === 'warn') logger.warn(`[harness] ${message}`)
            else logger.info(`[harness] ${message}`)
        }
    })
}

let timer: NodeJS.Timeout | null = null
let unsubscribeDrain: (() => void) | null = null

// The web server calls this once it listens. Schedules live in the harness database, so they resume after a restart.
// A drain (Restart) stops it, the same as shutdown does.
export function startHarnessScheduler(pollMs = HARNESS_SCHEDULE_POLL_MS) {
    if (timer) return
    unsubscribeDrain = onDrainStart(stopHarnessScheduler)
    const tick = () =>
        void tickHarnessSchedules().catch((error) => logger.warn(`[harness] schedule tick failed: ${getErrorMessage(error)}`))
    timer = setInterval(tick, pollMs)
    timer.unref?.()
    tick()
}

/**
 * The web server's start: the scheduler runs only when the app started cleanly. A tick on a failed start would claim a
 * due time and then fail the owner check on the broken data source, so that time would be recorded failed and skipped
 * instead of staying due until the server is healthy. Returns whether it started.
 */
export function startHarnessSchedulerIfReady(initError: unknown, pollMs = HARNESS_SCHEDULE_POLL_MS): boolean {
    if (initError) {
        logger.warn('[harness] schedules are not running: the server did not start cleanly. Due times stay due until it does.')
        return false
    }
    startHarnessScheduler(pollMs)
    return true
}

export function stopHarnessScheduler() {
    if (timer) clearInterval(timer)
    timer = null
    unsubscribeDrain?.()
    unsubscribeDrain = null
}

/** Tests: whether the poll timer is running. */
export function harnessSchedulerRunning(): boolean {
    return timer !== null
}
