import { stmt } from './db.mjs'
import { EtlError } from './errors.mjs'
import { createEmbeddings } from './embed.mjs'
import { namespaceName, namespaceProblem, storeNamespace } from './namespaces.mjs'
import { clearProcessStores, openStore } from './stores.mjs'
import { getPipeline, getPipelineByName, getVersion, listPipelines, requireWorkspaceId } from './versions.mjs'

const CACHE_MS = 10 * 60 * 1000
const cache = new Map()

// Name and id lookup stay inside one workspace. A missing workspace fails closed (E4). It does not search every workspace.
export function resolvePipeline(nameOrId, { workspaceId } = {}) {
    const ws = requireWorkspaceId(workspaceId)
    const byId = getPipeline(nameOrId)
    const pipeline = getPipelineByName(nameOrId, ws) || (byId?.workspaceId === ws ? byId : null)
    if (!pipeline) throw new EtlError('not_found', `No ETL pipeline is named "${nameOrId}".`, 404)
    return pipeline
}

// Newest version first. A namespace counts once a run that wrote it finished succeeded or partial (those runs are served).
function writtenVersions(pipelineId) {
    const seen = new Set()
    const versions = []
    for (const row of stmt(
        `SELECT version FROM runs WHERE pipeline_id = ? AND status IN ('succeeded', 'partial') ORDER BY version DESC`
    ).all(pipelineId)) {
        if (seen.has(row.version)) continue
        seen.add(row.version)
        versions.push(row.version)
    }
    return versions
}

// No namespace: the last successful run. A namespace: the newest successful run that wrote that name.
function versionForSearch(pipeline, namespace) {
    const wanted = namespaceName(namespace)
    if (!wanted) {
        if (!pipeline.servedVersion) {
            throw new EtlError(
                'not_ready',
                `ETL pipeline "${pipeline.name}" has no successful run yet. Run it from the ETL menu first.`,
                409
            )
        }
        return getVersion(pipeline.id, pipeline.servedVersion)
    }
    const problem = namespaceProblem(wanted)
    if (problem) throw new EtlError('bad_namespace', problem)
    for (const version of writtenVersions(pipeline.id)) {
        const row = getVersion(pipeline.id, version)
        if (storeNamespace(row?.spec?.store) === wanted) return row
    }
    throw new EtlError('not_found', `ETL pipeline "${pipeline.name}" has not written a namespace named "${wanted}".`, 404)
}

// Search uses the embeddings model and store of the version that wrote the vectors.
async function servingParts(pipeline, version, ctx) {
    if (!version?.spec) throw new EtlError('not_found', `Version ${version?.version ?? ''} of "${pipeline.name}" is missing.`, 404)
    const key = `${pipeline.id}:${version.version}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit
    const embeddings = await createEmbeddings(version.spec.embeddings, ctx)
    const store = await openStore(version.spec.store, { pipelineName: pipeline.name, pipelineId: pipeline.id, embeddings, ctx })
    const parts = {
        at: Date.now(),
        embeddings,
        store,
        version: version.version,
        namespace: storeNamespace(version.spec.store),
        storeLabel: store.label
    }
    for (const old of cache.keys()) if (old.startsWith(`${pipeline.id}:`)) cache.delete(old)
    cache.set(key, parts)
    return parts
}

export async function searchPipeline(nameOrId, query, { k = 4, namespace, ctx = {} } = {}) {
    const text = String(query || '').trim()
    if (!text) throw new EtlError('bad_query', 'Give a search query.')
    const pipeline = resolvePipeline(nameOrId, { workspaceId: ctx?.flowOptions?.workspaceId || ctx?.workspaceId })
    const version = versionForSearch(pipeline, namespace)
    const parts = await servingParts(pipeline, version, ctx)
    const vector = await parts.embeddings.embedQuery(text)
    const hits = await parts.store.search(Float32Array.from(vector), Math.max(1, Math.min(50, Number(k) || 4)), text)
    return { pipeline: pipeline.name, version: parts.version, namespace: parts.namespace, store: parts.storeLabel, results: hits }
}

// The ETL Retriever's pipeline dropdown: this workspace's pipelines only; no workspace id throws (API-14).
export function pipelineOptions(workspaceId) {
    return listPipelines({ workspaceId }).map((pipeline) => ({
        label: pipeline.name,
        name: pipeline.name,
        description: pipeline.servedVersion ? `Serving version ${pipeline.servedVersion}` : 'No successful run yet'
    }))
}

// The ETL Retriever's namespace dropdown, after a pipeline is selected. Empty when that pipeline has written no named
// namespace (a local collection, or Pinecone's default). No workspace id throws, the same as pipelineOptions (API-14).
export function namespaceOptions(pipelineName, workspaceId) {
    const name = String(pipelineName || '').trim()
    if (!name) return []
    const pipeline = resolvePipeline(name, { workspaceId: requireWorkspaceId(workspaceId) })
    const options = []
    const seen = new Set()
    for (const version of writtenVersions(pipeline.id)) {
        const row = getVersion(pipeline.id, version)
        const namespace = storeNamespace(row?.spec?.store)
        if (!namespace || seen.has(namespace)) continue
        seen.add(namespace)
        options.push({
            label: namespace,
            name: namespace,
            description: pipeline.servedVersion === version ? `Serving version ${version}` : `Written by version ${version}`
        })
    }
    return options
}

export function clearRetrievalCache() {
    cache.clear()
    clearProcessStores()
}
