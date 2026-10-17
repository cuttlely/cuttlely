// Deleting a pipeline removes the vectors it wrote, not only ETL's own bookkeeping. Before this, the store kept every
// vector and nothing left in ETL knew their ids, so they could never be cleaned up from Cuttlely.
import { stmt } from './db.mjs'
import { createEmbeddings } from './embed.mjs'
import { errorMessage } from './errors.mjs'
import { storeFingerprint } from './graph.mjs'
import { clearRetrievalCache } from './retrieve.mjs'
import { shapeFor } from './store-adapter.mjs'
import { blockRuns, cancelRun, pipelineContext, unblockRuns, waitForRun } from './runner.mjs'
import { forgetPipelineStores, openStore } from './stores.mjs'
import { deletePipeline as deletePipelineRows, getPipeline, getVersion } from './versions.mjs'

const BATCH = 500
const ACTIVE = ['queued', 'running', 'pausing', 'paused', 'cancelling']

// Every chunk id this pipeline wrote: the records ETL serves from, plus the provider id map (a chunk whose record was
// already swept but whose vector delete has not finished is still in the map).
function chunkIdsOf(pipelineId) {
    const ids = new Set()
    for (const row of stmt('SELECT chunk_id FROM records WHERE pipeline_id = ?').all(pipelineId)) ids.add(row.chunk_id)
    for (const row of stmt("SELECT chunk_id FROM vector_ids WHERE pipeline_id = ? AND chunk_id NOT LIKE 'stale:%'").all(pipelineId))
        ids.add(row.chunk_id)
    return [...ids]
}

function parkedCount(pipelineId) {
    return Number(stmt("SELECT COUNT(*) AS n FROM vector_ids WHERE pipeline_id = ? AND chunk_id LIKE 'stale:%'").get(pipelineId).n)
}

// The stores the vectors can be in: the served version's store and the store of every version a run started on. A run
// that moves the pipeline to a new store leaves the old store's vectors in place, so an earlier store can still hold
// them. Chunk ids are content hashes, so the current ids also match what an earlier store kept for unchanged content.
// `current` marks the store the newest run wrote to: the provider id map (vector_ids) holds that store's ids.
// run_names holds every pipeline name each run ran under, since a blank Local Vector Store collection follows the name.
function targetSpecs(pipeline) {
    // Only runs that began executing can have written; a queued run the delete cancelled never did.
    // A run from before run_names has no name; it ran under the current name as far as ETL can tell. When one run used
    // several names, the current name sorts first among them.
    const started = stmt(
        `SELECT r.version AS version, n.name AS name, MAX(r.started_at) AS last FROM runs r
         LEFT JOIN run_names n ON n.run_id = r.id
         WHERE r.pipeline_id = ? AND r.started_at IS NOT NULL
         GROUP BY r.version, n.name ORDER BY last DESC, (COALESCE(n.name, ?) = ?) DESC`
    ).all(pipeline.id, pipeline.name, pipeline.name)
    const ran = started.map((row) => ({ version: row.version, name: row.name || pipeline.name }))
    const served = pipeline.servedVersion
    const servedName = ran.find((use) => use.version === served)?.name ?? pipeline.name
    const uses = served ? [{ version: served, name: servedName }, ...ran] : ran
    const newest = ran[0] ?? uses[0]
    const currentSpec = newest ? getVersion(pipeline.id, newest.version)?.spec : null
    const currentKey = currentSpec?.store ? storeFingerprint(currentSpec.store, newest.name) : null
    const seen = new Set()
    const targets = []
    for (const { version, name } of uses) {
        const spec = getVersion(pipeline.id, version)?.spec
        if (!spec?.store) continue
        const key = storeFingerprint(spec.store, name)
        if (seen.has(key)) continue
        seen.add(key)
        targets.push({ spec, pipelineName: name, current: key === currentKey })
    }
    return targets
}

// How each target is purged. A store whose provider ids are the chunk ids (Local, Pinecone and most others) is purged by
// chunk id, without the provider id map: the map may hold another store's ids after a move, or after a run that wrote
// but stopped before it saved the map. Only the current store also retries ids parked by an earlier failed delete,
// since those are its own. A store that makes up its own ids (SingleStore, Zep) is purged through the map when it is
// current; an earlier one cannot be purged, because its ids were overwritten. In-Memory vectors live only in this
// process and are dropped with the pipeline.
function storeAccess({ spec, current }) {
    if (spec.store.nodeName === 'memoryVectorStore') return 'map'
    const shape = shapeFor(spec.store.nodeName)
    if (!shape || shape.stableIds) return 'raw'
    return current ? 'map' : 'unreachable'
}

// A run still writing would put vectors back after the purge. Cancel it and wait for the batches in flight.
async function stopRuns(pipelineId) {
    const placeholders = ACTIVE.map(() => '?').join(', ')
    for (const row of stmt(`SELECT id FROM runs WHERE pipeline_id = ? AND status IN (${placeholders})`).all(pipelineId, ...ACTIVE)) {
        try {
            cancelRun(row.id)
        } catch {
            // Already finished between the query and the cancel.
        }
        await waitForRun(row.id)
    }
}

async function purge(pipeline, ctx) {
    const result = { deleted: 0, stores: [], errors: [] }
    const pipelineId = pipeline.id
    await stopRuns(pipelineId)
    const ids = chunkIdsOf(pipelineId)
    if (!ids.length && !parkedCount(pipelineId)) return result
    // Open every target first: each one loads the provider id map, which the first delete then clears.
    const opened = []
    for (const target of targetSpecs(pipeline)) {
        const { spec } = target
        const access = storeAccess(target)
        if (access === 'unreachable') {
            result.errors.push({
                store: spec.store.label,
                error: 'This store was used before the pipeline moved to another one, and it makes up its own vector ids, which ETL no longer has. Its vectors were left there.'
            })
            continue
        }
        // Provider ids parked by an earlier failed delete are retried on the first delete; a failure there comes back
        // through onStale instead of an error, and must still be reported.
        const entry = { store: null, label: spec.store.label, staleErrors: [] }
        try {
            let embeddings
            try {
                embeddings = await createEmbeddings(spec.embeddings, ctx)
            } catch {
                // Deleting by id needs no embeddings; some stores only want the object at init.
            }
            entry.store = await openStore(spec.store, {
                pipelineName: target.pipelineName,
                pipelineId,
                embeddings,
                ctx,
                rawIds: access === 'raw',
                skipParked: !target.current,
                onStale: (stale, error) =>
                    entry.staleErrors.push(`${stale.length} parked vector ids could not be deleted (${errorMessage(error)})`)
            })
            entry.label = entry.store.label || entry.label
            opened.push(entry)
        } catch (error) {
            result.errors.push({ store: spec.store.label, error: errorMessage(error) })
        }
    }
    for (const entry of opened) {
        try {
            // An empty delete still clears provider ids parked by an earlier failed delete.
            if (!ids.length) await entry.store.delete([])
            for (let i = 0; i < ids.length; i += BATCH) await entry.store.delete(ids.slice(i, i + BATCH))
            if (entry.staleErrors.length) result.errors.push({ store: entry.label, error: entry.staleErrors.join('; ') })
            else result.stores.push(entry.label)
        } catch (error) {
            result.errors.push({ store: entry.label, error: errorMessage(error) })
        }
    }
    if (result.stores.length) result.deleted = ids.length
    return result
}

// Removes a pipeline: its vectors first, then its runs, versions, schedules and records. `ctx` defaults to the context the
// runner uses for this pipeline, which carries the store's credential. The purge never throws: a store that cannot be
// reached (a deleted credential, the network) is reported in `errors`, so the caller can still say what was left behind.
// Runs stay blocked until the rows are gone, so a schedule or a click cannot start one and write vectors back.
export async function deletePipeline(pipelineId, { ctx } = {}) {
    const pipeline = getPipeline(pipelineId)
    blockRuns(pipelineId)
    try {
        let purged = { deleted: 0, stores: [], errors: [] }
        if (pipeline) {
            const context = ctx ?? (await pipelineContext(pipeline).catch(() => ({})))
            purged = await purge(pipeline, context || {})
        }
        deletePipelineRows(pipelineId)
        forgetPipelineStores(pipelineId)
        clearRetrievalCache()
        return purged
    } finally {
        unblockRuns(pipelineId)
    }
}
