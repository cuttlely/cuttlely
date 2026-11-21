import { EtlError } from './errors.mjs'
import { compilePipeline, graphHash } from './graph.mjs'
import { now, parseJson } from './db.mjs'
import * as etlStore from './store.mjs'

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

// `q` is the store, or inside a transaction the transaction's handle.
export async function getPipeline(id, q = etlStore) {
    return pipelineRow(await q.get('SELECT * FROM pipelines WHERE id = ?', [id]))
}

// With a workspace id, only that workspace's pipeline of this name. Without one, the first row of that name.
// Retrieval does not use the unscoped form (E4). Name checks pass the workspace they are saving into.
export async function getPipelineByName(name, workspaceId, q = etlStore) {
    if (workspaceId !== undefined) {
        return pipelineRow(
            await q.get('SELECT * FROM pipelines WHERE name_key = ? AND workspace_id = ?', [nameKey(name), requireWorkspaceId(workspaceId)])
        )
    }
    return pipelineRow(await q.get('SELECT * FROM pipelines WHERE name_key = ?', [nameKey(name)]))
}

// A missing workspace id throws instead of listing every pipeline.
export function requireWorkspaceId(workspaceId) {
    const id = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    if (!id) throw new EtlError('workspace_required', 'No active workspace. Sign in to a workspace and try again.', 400)
    return id
}

// Strict: `workspace_id = ?` never matches NULL, so a pipeline without a workspace is listed to no one.
export async function listPipelines({ workspaceId } = {}) {
    const ws = requireWorkspaceId(workspaceId)
    return (await etlStore.all('SELECT * FROM pipelines WHERE workspace_id = ? ORDER BY name_key', [ws])).map(pipelineRow)
}

export async function latestVersion(pipelineId, options) {
    return versionRow(
        await etlStore.get('SELECT * FROM pipeline_versions WHERE pipeline_id = ? ORDER BY version DESC LIMIT 1', [pipelineId]),
        options
    )
}

export async function getVersion(pipelineId, version, options) {
    return versionRow(
        await etlStore.get('SELECT * FROM pipeline_versions WHERE pipeline_id = ? AND version = ?', [pipelineId, Number(version)]),
        options
    )
}

export async function listVersions(pipelineId) {
    return (await etlStore.all('SELECT * FROM pipeline_versions WHERE pipeline_id = ? ORDER BY version DESC', [pipelineId])).map((row) =>
        versionRow(row)
    )
}

export async function validatePipelineName(id, name, workspaceId, q = etlStore) {
    const text = assertPipelineName(name)
    // With a workspace, the same name may exist in another workspace (UNIQUE is workspace_id + name_key).
    const other = workspaceId !== undefined ? await getPipelineByName(text, workspaceId, q) : await getPipelineByName(text, undefined, q)
    if (other && other.id !== id) {
        throw new EtlError('name_taken', `An ETL pipeline named "${other.name}" already exists. Choose a different name.`)
    }
    return text
}

// A save that only moves nodes keeps the current version; any input, credential or edge change makes a new one.
export async function recordVersion({ id, name, workspaceId, flowData }) {
    if (!id) throw new EtlError('bad_pipeline', 'An ETL pipeline needs an id.')
    // The server sets the workspace from the chat flow; a pipeline is never saved without one.
    const ws = requireWorkspaceId(workspaceId)
    // The name check reads inside the transaction, so no other save can take the name before this one writes it.
    return etlStore.tx(async (t) => {
        const text = await validatePipelineName(id, name, ws, t)
        const flow = typeof flowData === 'string' ? flowData : JSON.stringify(flowData || { nodes: [], edges: [] })
        const hash = graphHash(flow)
        const { spec, problems, warnings } = compilePipeline(flow)
        const stamp = now()
        const existing = await t.get('SELECT * FROM pipelines WHERE id = ?', [id])
        if (existing) {
            if (existing.workspace_id && existing.workspace_id !== ws) {
                throw new EtlError('not_found', 'This ETL pipeline was not found in your workspace.', 404)
            }
            await t.run('UPDATE pipelines SET name = ?, name_key = ?, workspace_id = ?, updated_at = ? WHERE id = ?', [
                text,
                nameKey(text),
                ws,
                stamp,
                id
            ])
        } else {
            await t.run('INSERT INTO pipelines (id, name, name_key, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
                id,
                text,
                nameKey(text),
                ws,
                stamp,
                stamp
            ])
        }
        const latest = await t.get(
            'SELECT version, graph_hash FROM pipeline_versions WHERE pipeline_id = ? ORDER BY version DESC LIMIT 1',
            [id]
        )
        if (latest && latest.graph_hash === hash) {
            await t.run('UPDATE pipeline_versions SET flow_data = ? WHERE pipeline_id = ? AND version = ?', [flow, id, latest.version])
            return { pipeline: await getPipeline(id, t), version: latest.version, created: false, problems, warnings }
        }
        const version = (latest?.version || 0) + 1
        await t.run(
            'INSERT INTO pipeline_versions (pipeline_id, version, graph_hash, flow_data, spec, problems, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [id, version, hash, flow, JSON.stringify(spec), JSON.stringify({ problems, warnings }), stamp]
        )
        return { pipeline: await getPipeline(id, t), version, created: true, problems, warnings }
    })
}

export async function setServedVersion(pipelineId, version, indexFingerprint) {
    await etlStore.run('UPDATE pipelines SET served_version = ?, index_fingerprint = ?, updated_at = ? WHERE id = ?', [
        version,
        indexFingerprint || null,
        now(),
        pipelineId
    ])
}

export async function deletePipeline(id) {
    await etlStore.tx(async (t) => {
        await t.run('DELETE FROM shadow_vectors WHERE pipeline_id = ?', [id])
        await t.run('DELETE FROM vector_ids WHERE pipeline_id = ?', [id])
        await t.run('DELETE FROM schedules WHERE pipeline_id = ?', [id])
        await t.run('DELETE FROM records WHERE pipeline_id = ?', [id])
        await t.run('DELETE FROM sources WHERE pipeline_id = ?', [id])
        await t.run('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE pipeline_id = ?)', [id])
        await t.run('DELETE FROM run_names WHERE pipeline_id = ?', [id])
        await t.run('DELETE FROM runs WHERE pipeline_id = ?', [id])
        await t.run('DELETE FROM pipeline_versions WHERE pipeline_id = ?', [id])
        await t.run('DELETE FROM pipelines WHERE id = ?', [id])
    })
}

export async function pipelineStats(pipelineId) {
    const records = (await etlStore.get('SELECT COUNT(*) AS n FROM records WHERE pipeline_id = ?', [pipelineId]))?.n ?? 0
    const sources = (await etlStore.get('SELECT COUNT(*) AS n FROM sources WHERE pipeline_id = ?', [pipelineId]))?.n ?? 0
    return { chunks: Number(records), sources: Number(sources) }
}
