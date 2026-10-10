import { EtlError } from './errors.mjs'
import { compilePipeline, graphHash } from './graph.mjs'
import { db, now, parseJson, stmt, tx } from './db.mjs'

export function nameKey(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
}

export function assertPipelineName(name) {
    const text = String(name || '').trim()
    if (!text) throw new EtlError('bad_name', 'Give the pipeline a name before saving it.')
    if (text.length > 100) throw new EtlError('bad_name', 'Pipeline names are limited to 100 characters.')
    return text
}

function pipelineRow(row) {
    if (!row) return null
    return {
        id: row.id,
        name: row.name,
        workspaceId: row.workspace_id || null,
        servedVersion: row.served_version ?? null,
        indexFingerprint: row.index_fingerprint || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

function versionRow(row, { withFlow = false } = {}) {
    if (!row) return null
    return {
        pipelineId: row.pipeline_id,
        version: row.version,
        graphHash: row.graph_hash,
        spec: parseJson(row.spec, null),
        problems: parseJson(row.problems, { problems: [], warnings: [] }),
        createdAt: row.created_at,
        ...(withFlow ? { flowData: row.flow_data } : {})
    }
}

export function getPipeline(id) {
    return pipelineRow(stmt('SELECT * FROM pipelines WHERE id = ?').get(id))
}

// With a workspace id, only that workspace's pipeline of this name. Without one, the first row of that name.
// Retrieval does not use the unscoped form (E4). Name checks pass the workspace they are saving into.
export function getPipelineByName(name, workspaceId) {
    if (workspaceId !== undefined) {
        return pipelineRow(
            stmt('SELECT * FROM pipelines WHERE name_key = ? AND workspace_id = ?').get(nameKey(name), requireWorkspaceId(workspaceId))
        )
    }
    return pipelineRow(stmt('SELECT * FROM pipelines WHERE name_key = ?').get(nameKey(name)))
}

// API-14: a missing workspace id throws instead of listing every pipeline.
export function requireWorkspaceId(workspaceId) {
    const id = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    if (!id) throw new EtlError('workspace_required', 'No active workspace. Sign in to a workspace and try again.', 400)
    return id
}

// Strict: `workspace_id = ?` never matches NULL, so a pipeline without a workspace is listed to no one.
export function listPipelines({ workspaceId } = {}) {
    const ws = requireWorkspaceId(workspaceId)
    return stmt('SELECT * FROM pipelines WHERE workspace_id = ? ORDER BY name_key').all(ws).map(pipelineRow)
}

export function latestVersion(pipelineId, options) {
    return versionRow(stmt('SELECT * FROM pipeline_versions WHERE pipeline_id = ? ORDER BY version DESC LIMIT 1').get(pipelineId), options)
}

export function getVersion(pipelineId, version, options) {
    return versionRow(
        stmt('SELECT * FROM pipeline_versions WHERE pipeline_id = ? AND version = ?').get(pipelineId, Number(version)),
        options
    )
}

export function listVersions(pipelineId) {
    return stmt('SELECT * FROM pipeline_versions WHERE pipeline_id = ? ORDER BY version DESC')
        .all(pipelineId)
        .map((row) => versionRow(row))
}

export function validatePipelineName(id, name, workspaceId) {
    const text = assertPipelineName(name)
    // With a workspace, the same name may exist in another workspace (UNIQUE is workspace_id + name_key).
    const other = workspaceId !== undefined ? getPipelineByName(text, workspaceId) : getPipelineByName(text)
    if (other && other.id !== id) {
        throw new EtlError('name_taken', `An ETL pipeline named "${other.name}" already exists. Choose a different name.`)
    }
    return text
}

// A save that only moves nodes keeps the current version; any input, credential or edge change makes a new one.
export function recordVersion({ id, name, workspaceId, flowData }) {
    if (!id) throw new EtlError('bad_pipeline', 'An ETL pipeline needs an id.')
    // The server sets the workspace from the chat flow; a pipeline is never saved without one (API-14).
    const ws = requireWorkspaceId(workspaceId)
    const text = validatePipelineName(id, name, ws)
    const flow = typeof flowData === 'string' ? flowData : JSON.stringify(flowData || { nodes: [], edges: [] })
    const hash = graphHash(flow)
    const { spec, problems, warnings } = compilePipeline(flow)
    const stamp = now()
    return tx(() => {
        const existing = stmt('SELECT * FROM pipelines WHERE id = ?').get(id)
        if (existing) {
            if (existing.workspace_id && existing.workspace_id !== ws) {
                throw new EtlError('not_found', 'This ETL pipeline was not found in your workspace.', 404)
            }
            stmt('UPDATE pipelines SET name = ?, name_key = ?, workspace_id = ?, updated_at = ? WHERE id = ?').run(
                text,
                nameKey(text),
                ws,
                stamp,
                id
            )
        } else {
            stmt('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
                id,
                text,
                nameKey(text),
                ws,
                stamp,
                stamp
            )
        }
        const latest = stmt('SELECT version, graph_hash FROM pipeline_versions WHERE pipeline_id = ? ORDER BY version DESC LIMIT 1').get(id)
        if (latest && latest.graph_hash === hash) {
            stmt('UPDATE pipeline_versions SET flow_data = ? WHERE pipeline_id = ? AND version = ?').run(flow, id, latest.version)
            return { pipeline: getPipeline(id), version: latest.version, created: false, problems, warnings }
        }
        const version = (latest?.version || 0) + 1
        stmt(
            'INSERT INTO pipeline_versions (pipeline_id, version, graph_hash, flow_data, spec, problems, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, version, hash, flow, JSON.stringify(spec), JSON.stringify({ problems, warnings }), stamp)
        return { pipeline: getPipeline(id), version, created: true, problems, warnings }
    })
}

export function setServedVersion(pipelineId, version, indexFingerprint) {
    stmt('UPDATE pipelines SET served_version = ?, index_fingerprint = ?, updated_at = ? WHERE id = ?').run(
        version,
        indexFingerprint || null,
        now(),
        pipelineId
    )
}

export function deletePipeline(id) {
    tx(() => {
        stmt('DELETE FROM shadow_vectors WHERE pipeline_id = ?').run(id)
        stmt('DELETE FROM vector_ids WHERE pipeline_id = ?').run(id)
        stmt('DELETE FROM schedules WHERE pipeline_id = ?').run(id)
        stmt('DELETE FROM records WHERE pipeline_id = ?').run(id)
        stmt('DELETE FROM sources WHERE pipeline_id = ?').run(id)
        stmt('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE pipeline_id = ?)').run(id)
        stmt('DELETE FROM runs WHERE pipeline_id = ?').run(id)
        stmt('DELETE FROM pipeline_versions WHERE pipeline_id = ?').run(id)
        stmt('DELETE FROM pipelines WHERE id = ?').run(id)
    })
}

export function pipelineStats(pipelineId) {
    const records = stmt('SELECT COUNT(*) AS n FROM records WHERE pipeline_id = ?').get(pipelineId)?.n ?? 0
    const sources = stmt('SELECT COUNT(*) AS n FROM sources WHERE pipeline_id = ?').get(pipelineId)?.n ?? 0
    return { chunks: Number(records), sources: Number(sources) }
}

export { db }
