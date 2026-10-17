import { getErrorMessage } from '../../errors/utils'
import { safeRecordAudit } from '../../identity/auditLog'
import { resolveTeamAccess } from '../../identity/rbac'
import logger from '../../utils/logger'
import { isDraining, isShuttingDown, trackBackgroundRun } from '../../settings/runs'
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

// The run goes through startBackgroundRun, the same path as an API run, so history, traces, and usage match.
// A server that is restarting or shutting down starts nothing; the due time stays due for the next tick.
export async function tickHarnessSchedules() {
    if (isDraining() || isShuttingDown()) return []
    const schedules = await loadHarness('schedule.mjs')
    return schedules.tickSchedules({
        start: (schedule: StoredSchedule, onSettled: (outcome: { runId: string; status: string }) => void) =>
            harnessesService.startBackgroundRun(
                schedule.harness,
                { question: schedule.question },
                { workspaceId: schedule.workspaceId, source: 'schedule', apiKeyId: null, track: trackBackgroundRun, onSettled }
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

// The web server calls this once it listens. Schedules live in the harness database, so they resume after a restart.
export function startHarnessScheduler(pollMs = HARNESS_SCHEDULE_POLL_MS) {
    if (timer) return
    const tick = () =>
        void tickHarnessSchedules().catch((error) => logger.warn(`[harness] schedule tick failed: ${getErrorMessage(error)}`))
    timer = setInterval(tick, pollMs)
    timer.unref?.()
    tick()
}

export function stopHarnessScheduler() {
    if (timer) clearInterval(timer)
    timer = null
}
