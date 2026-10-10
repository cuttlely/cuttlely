// Workspace scope for ETL pipelines (API-14, issue #42). A pipeline belongs to exactly one workspace, set by the server.
// Every read goes through a pipeline that passed the workspace check: a NULL workspace never matches, a missing
// workspace id throws instead of listing everything, and a pipeline in another workspace looks the same as a missing one.
import { EtlError } from './errors.mjs'
import { stmt, tx } from './db.mjs'
import { getRun } from './runs.mjs'
import { getSchedule } from './schedule.mjs'
import { pipelineDirName } from './paths.mjs'
import { getPipeline, requireWorkspaceId } from './versions.mjs'

export { requireWorkspaceId }

const NOT_FOUND = 'This ETL pipeline was not found in your workspace.'

// The pipeline when it is in this workspace; otherwise 404 (no hint that it exists elsewhere).
export function pipelineInWorkspace(id, workspaceId) {
    const ws = requireWorkspaceId(workspaceId)
    const pipeline = id ? getPipeline(id) : null
    if (!pipeline || !pipeline.workspaceId || pipeline.workspaceId !== ws) throw new EtlError('not_found', NOT_FOUND, 404)
    return pipeline
}

export function runInWorkspace(runId, workspaceId) {
    const ws = requireWorkspaceId(workspaceId)
    const run = runId ? getRun(runId) : null
    if (!run) throw new EtlError('not_found', `Run ${runId} was not found.`, 404)
    try {
        pipelineInWorkspace(run.pipelineId, ws)
    } catch (error) {
        if (error.code === 'not_found') throw new EtlError('not_found', `Run ${runId} was not found.`, 404)
        throw error
    }
    return run
}

export function scheduleInWorkspace(scheduleId, workspaceId) {
    const ws = requireWorkspaceId(workspaceId)
    const schedule = scheduleId ? getSchedule(scheduleId) : null
    if (!schedule) throw new EtlError('not_found', 'Schedule was not found.', 404)
    try {
        pipelineInWorkspace(schedule.pipelineId, ws)
    } catch (error) {
        if (error.code === 'not_found') throw new EtlError('not_found', 'Schedule was not found.', 404)
        throw error
    }
    return schedule
}

// A workspace id as one safe folder name for ETL uploads (ids are UUIDs; anything else gets a short hash suffix).
export function workspaceDirName(workspaceId) {
    return pipelineDirName(requireWorkspaceId(workspaceId))
}

const CHILD_TABLES = ['runs', 'records', 'sources', 'schedules', 'vector_ids', 'shadow_vectors']

// One-time backfill of pipelines saved before every pipeline had a workspace (API-14). Each NULL pipeline takes the
// workspace of its own chat flow when the server knows it, else the instance's default workspace; with neither it stays
// NULL and so is visible to no workspace. Child rows follow their pipeline. Idempotent; returns the counts to log.
export function backfillWorkspaces({ flowWorkspaces = {}, defaultWorkspaceId = null } = {}) {
    const fallback = typeof defaultWorkspaceId === 'string' && defaultWorkspaceId.trim() ? defaultWorkspaceId.trim() : null
    return tx(() => {
        const rows = stmt('SELECT id FROM pipelines WHERE workspace_id IS NULL ORDER BY id').all()
        const counts = { pipelines: rows.length, fromFlow: 0, fromDefault: 0, unassigned: 0, childRows: 0 }
        for (const { id } of rows) {
            const own = typeof flowWorkspaces[id] === 'string' && flowWorkspaces[id].trim() ? flowWorkspaces[id].trim() : null
            const ws = own || fallback
            if (!ws) {
                counts.unassigned += 1
                continue
            }
            stmt('UPDATE pipelines SET workspace_id = ? WHERE id = ? AND workspace_id IS NULL').run(ws, id)
            if (own) counts.fromFlow += 1
            else counts.fromDefault += 1
            for (const table of CHILD_TABLES) {
                counts.childRows += Number(
                    stmt(`UPDATE ${table} SET workspace_id = ? WHERE pipeline_id = ? AND workspace_id IS NULL`).run(ws, id).changes || 0
                )
            }
            counts.childRows += Number(
                stmt(
                    'UPDATE run_events SET workspace_id = ? WHERE workspace_id IS NULL AND run_id IN (SELECT id FROM runs WHERE pipeline_id = ?)'
                ).run(ws, id).changes || 0
            )
        }
        return counts
    })
}

export function unassignedPipelineCount() {
    return Number(stmt('SELECT COUNT(*) AS n FROM pipelines WHERE workspace_id IS NULL').get()?.n ?? 0)
}

export function unassignedPipelineIds() {
    return stmt('SELECT id FROM pipelines WHERE workspace_id IS NULL ORDER BY id')
        .all()
        .map((row) => row.id)
}
