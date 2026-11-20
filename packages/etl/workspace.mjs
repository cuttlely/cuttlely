// Workspace scope for ETL pipelines. A pipeline belongs to exactly one workspace, set by the server.
// Every read goes through a pipeline that passed the workspace check: a NULL workspace never matches, a missing
// workspace id throws instead of listing everything, and a pipeline in another workspace looks the same as a missing one.
import { EtlError } from './errors.mjs'
import * as etlStore from './store.mjs'
import { getRun } from './runs.mjs'
import { getSchedule } from './schedule.mjs'
import { pipelineDirName } from './paths.mjs'
import { getPipeline, requireWorkspaceId } from './versions.mjs'

export { requireWorkspaceId }

const NOT_FOUND = 'This ETL pipeline was not found in your workspace.'

// The pipeline when it is in this workspace; otherwise 404 (no hint that it exists elsewhere).
export async function pipelineInWorkspace(id, workspaceId) {
    const ws = requireWorkspaceId(workspaceId)
    const pipeline = id ? await getPipeline(id) : null
    if (!pipeline || !pipeline.workspaceId || pipeline.workspaceId !== ws) throw new EtlError('not_found', NOT_FOUND, 404)
    return pipeline
}

export async function runInWorkspace(runId, workspaceId) {
    const ws = requireWorkspaceId(workspaceId)
    const run = runId ? await getRun(runId) : null
    if (!run) throw new EtlError('not_found', `Run ${runId} was not found.`, 404)
    try {
        await pipelineInWorkspace(run.pipelineId, ws)
    } catch (error) {
        if (error.code === 'not_found') throw new EtlError('not_found', `Run ${runId} was not found.`, 404)
        throw error
    }
    return run
}

export async function scheduleInWorkspace(scheduleId, workspaceId) {
    const ws = requireWorkspaceId(workspaceId)
    const schedule = scheduleId ? await getSchedule(scheduleId) : null
    if (!schedule) throw new EtlError('not_found', 'Schedule was not found.', 404)
    try {
        await pipelineInWorkspace(schedule.pipelineId, ws)
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

// One-time backfill of pipelines saved before every pipeline had a workspace. Each NULL pipeline takes the
// workspace of its own chat flow when the server knows it, else the instance's default workspace; with neither it stays
// NULL and so is visible to no workspace. Child rows follow their pipeline. Idempotent; returns the counts to log.
export async function backfillWorkspaces({ flowWorkspaces = {}, defaultWorkspaceId = null } = {}) {
    const fallback = typeof defaultWorkspaceId === 'string' && defaultWorkspaceId.trim() ? defaultWorkspaceId.trim() : null
    return etlStore.tx(async (t) => {
        const rows = await t.all('SELECT id FROM pipelines WHERE workspace_id IS NULL ORDER BY id')
        const counts = { pipelines: rows.length, fromFlow: 0, fromDefault: 0, unassigned: 0, childRows: 0 }
        for (const { id } of rows) {
            const own = typeof flowWorkspaces[id] === 'string' && flowWorkspaces[id].trim() ? flowWorkspaces[id].trim() : null
            const ws = own || fallback
            if (!ws) {
                counts.unassigned += 1
                continue
            }
            await t.run('UPDATE pipelines SET workspace_id = ? WHERE id = ? AND workspace_id IS NULL', [ws, id])
            if (own) counts.fromFlow += 1
            else counts.fromDefault += 1
            for (const table of CHILD_TABLES) {
                counts.childRows += Number(
                    (await t.run(`UPDATE ${table} SET workspace_id = ? WHERE pipeline_id = ? AND workspace_id IS NULL`, [ws, id]))
                        .changes || 0
                )
            }
            counts.childRows += Number(
                (
                    await t.run(
                        'UPDATE run_events SET workspace_id = ? WHERE workspace_id IS NULL AND run_id IN (SELECT id FROM runs WHERE pipeline_id = ?)',
                        [ws, id]
                    )
                ).changes || 0
            )
        }
        return counts
    })
}

export async function unassignedPipelineCount() {
    return Number((await etlStore.get('SELECT COUNT(*) AS n FROM pipelines WHERE workspace_id IS NULL'))?.n ?? 0)
}

export async function unassignedPipelineIds() {
    return (await etlStore.all('SELECT id FROM pipelines WHERE workspace_id IS NULL ORDER BY id')).map((row) => row.id)
}
