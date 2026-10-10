// etl:check, deleting a pipeline removes its vectors from its store, not only ETL's own rows.
import fs from 'node:fs'
import path from 'node:path'
import { api, check, flowFor, LocalVectorStore, root, runPipeline, WS } from './lib.mjs'

const { createFake, shapeFor } = await import('../store-adapter.mjs')
const { stmt } = await import('../db.mjs')

const csv = (name, rows) => {
    const file = path.join(root, `${name}.csv`)
    fs.writeFileSync(
        file,
        `sku,name,notes\n${Array.from({ length: rows }, (_, i) => `P${i + 1},Loaf ${i + 1},rye and spelt ${i + 1}`).join('\n')}\n`
    )
    return file
}
const rowsFor = (id) => ({
    records: Number(stmt('SELECT COUNT(*) AS n FROM records WHERE pipeline_id = ?').get(id).n),
    vectorIds: Number(stmt('SELECT COUNT(*) AS n FROM vector_ids WHERE pipeline_id = ?').get(id).n),
    runs: Number(stmt('SELECT COUNT(*) AS n FROM runs WHERE pipeline_id = ?').get(id).n)
})
const embedder = {
    async embedDocuments(texts) {
        return texts.map((text) => [text.length % 7, 1, 0.5])
    },
    async embedQuery() {
        return [1, 1, 0.5]
    }
}
function pineFlow(file, ns) {
    return {
        nodes: [
            {
                id: 'src',
                data: {
                    name: 'etlFileSource',
                    label: 'Streaming Files',
                    category: 'ETL',
                    inputs: { paths: file, textColumns: 'name, notes', idColumn: 'sku' }
                }
            },
            {
                id: 'emb',
                data: { name: 'openAIEmbeddings', label: 'OpenAI Embedding', category: 'Embeddings', inputs: { modelName: 'fake' } }
            },
            {
                id: 'vs',
                data: {
                    name: 'pinecone',
                    label: 'Pinecone',
                    category: 'Vector Stores',
                    inputs: { pineconeIndex: 'cuttlely-test', pineconeNamespace: ns },
                    credential: 'pine-cred'
                }
            }
        ],
        edges: [
            { source: 'src', target: 'vs' },
            { source: 'emb', target: 'vs' }
        ]
    }
}

// Local Vector Store: the collection loses this pipeline's vectors, and a second pipeline sharing the collection keeps its own.
{
    const keep = await runPipeline('purge-keep', 'Purge keep', flowFor(csv('purge-keep', 5), 'purge-shared'))
    const drop = await runPipeline('purge-drop', 'Purge drop', flowFor(csv('purge-drop', 8), 'purge-shared'))
    const store = LocalVectorStore.open('purge-shared')
    const before = store.count()
    const result = await api.deletePipeline('purge-drop')
    const after = store.count()
    const rows = rowsFor('purge-drop')
    check(
        'purge 1: deleting a Local Vector Store pipeline removes its vectors and leaves another pipeline in the same collection alone',
        keep.status === 'succeeded' &&
            drop.status === 'succeeded' &&
            before === 13 &&
            after === 5 &&
            result.deleted === 8 &&
            result.errors.length === 0 &&
            rows.records === 0 &&
            rows.vectorIds === 0 &&
            rows.runs === 0 &&
            !api.getPipeline('purge-drop'),
        JSON.stringify({ before, after, result, rows })
    )
}

// Remote store (fake Pinecone): every vector the pipeline wrote is deleted from the namespace.
{
    const fake = createFake(shapeFor('pinecone'))
    api.configureRunner({ contextFor: () => ({ workspaceId: WS, embeddingsDouble: embedder, storeClients: { pinecone: fake } }) })
    const run = await runPipeline('purge-pine', 'Purge pine', pineFlow(csv('purge-pine', 7), 'purge-pine'))
    const before = fake.rows.size
    const result = await api.deletePipeline('purge-pine')
    check(
        'purge 2: deleting a Pinecone pipeline deletes its vectors from the namespace',
        run.status === 'succeeded' && before === 7 && fake.rows.size === 0 && result.deleted === 7 && result.stores.length === 1,
        JSON.stringify({ status: run.status, before, after: fake.rows.size, result })
    )
}

// A store that cannot be reached: the pipeline is still deleted, nothing throws, and the result names the store.
{
    const fake = createFake(shapeFor('pinecone'))
    api.configureRunner({ contextFor: () => ({ workspaceId: WS, embeddingsDouble: embedder, storeClients: { pinecone: fake } }) })
    const run = await runPipeline('purge-down', 'Purge down', pineFlow(csv('purge-down', 4), 'purge-down'))
    fake.deleteMany = async () => {
        throw Object.assign(new Error('Service unavailable (injected)'), { status: 503 })
    }
    let threw = null
    let result = null
    try {
        result = await api.deletePipeline('purge-down')
    } catch (error) {
        threw = error
    }
    check(
        'purge 3: a store that fails the delete does not stop the pipeline delete, and the failure is reported',
        run.status === 'succeeded' &&
            !threw &&
            result.deleted === 0 &&
            result.errors.length === 1 &&
            /Service unavailable/.test(result.errors[0].error) &&
            !api.getPipeline('purge-down') &&
            rowsFor('purge-down').records === 0,
        JSON.stringify({ threw: threw?.message, result })
    )
}

// A pipeline that never ran has nothing in a store; deleting it opens no store.
{
    api.configureRunner({ contextFor: () => ({ workspaceId: WS }) })
    api.recordVersion({ workspaceId: WS, id: 'purge-new', name: 'Purge new', flowData: flowFor(csv('purge-new', 2), 'purge-new') })
    const result = await api.deletePipeline('purge-new')
    check(
        'purge 4: deleting a pipeline that never ran removes it without touching a store',
        result.deleted === 0 && result.stores.length === 0 && result.errors.length === 0 && !api.getPipeline('purge-new'),
        JSON.stringify(result)
    )
}

// A pipeline that moved to a new store: the old store kept its vectors when the target changed, so delete clears both.
{
    api.configureRunner({ contextFor: () => ({ workspaceId: WS }) })
    const file = csv('purge-moved', 6)
    const first = await runPipeline('purge-moved', 'Purge moved', flowFor(file, 'purge-moved-a'))
    const second = await runPipeline('purge-moved', 'Purge moved', flowFor(file, 'purge-moved-b'))
    const oldStore = LocalVectorStore.open('purge-moved-a')
    const newStore = LocalVectorStore.open('purge-moved-b')
    const before = { old: oldStore.count(), new: newStore.count() }
    const result = await api.deletePipeline('purge-moved')
    const after = { old: oldStore.count(), new: newStore.count() }
    check(
        'purge 5: deleting a pipeline that moved to a new store also clears the store it wrote to before',
        first.status === 'succeeded' &&
            second.status === 'succeeded' &&
            before.old === 6 &&
            before.new === 6 &&
            after.old === 0 &&
            after.new === 0 &&
            result.stores.length === 2 &&
            result.errors.length === 0,
        JSON.stringify({ before, after, result })
    )
}

// While the vectors are being deleted, no run can start (a click or a schedule) or resume, so nothing writes them back.
// The block lifts when the delete finishes.
{
    const fake = createFake(shapeFor('pinecone'))
    api.configureRunner({ contextFor: () => ({ workspaceId: WS, embeddingsDouble: embedder, storeClients: { pinecone: fake } }) })
    const flow = pineFlow(csv('purge-race', 5), 'purge-race')
    const run = await runPipeline('purge-race', 'Purge race', flow)
    // A failed run is not stopped by the delete, and Retry would resume it, so it must be refused too.
    stmt("UPDATE runs SET status = 'failed' WHERE id = ?").run(run.id)
    const original = fake.deleteMany.bind(fake)
    let release
    const gate = new Promise((resolve) => (release = resolve))
    let entered
    const inside = new Promise((resolve) => (entered = resolve))
    fake.deleteMany = async (ids) => {
        entered()
        await gate
        return original(ids)
    }
    const refusals = []
    const attempt = (action) => {
        try {
            action()
            refusals.push('allowed')
        } catch (error) {
            refusals.push(error.code || error.message)
        }
    }
    const deleting = api.deletePipeline('purge-race')
    await inside
    attempt(() => api.startRun('purge-race'))
    attempt(() => api.resumeRun(run.id))
    release()
    const deleted = await deleting
    fake.deleteMany = original
    const left = fake.rows.size
    // A new pipeline saved under the same id runs normally once the delete is over.
    const again = await runPipeline('purge-race', 'Purge race', flow)
    await api.deletePipeline('purge-race')
    check(
        'purge 6: no run starts or resumes while a delete is removing vectors, and the block lifts when it finishes',
        run.status === 'succeeded' &&
            refusals.length === 2 &&
            refusals.every((code) => code === 'deleting') &&
            deleted.deleted === 5 &&
            deleted.errors.length === 0 &&
            left === 0 &&
            again.status === 'succeeded' &&
            !api.getPipeline('purge-race'),
        JSON.stringify({ refusals, deleted, left, again: again.status })
    )
}

// Provider ids parked by an earlier failed delete: if clearing them fails during the purge, the store is reported, not
// counted as cleaned.
{
    const fake = createFake(shapeFor('pinecone'))
    api.configureRunner({ contextFor: () => ({ workspaceId: WS, embeddingsDouble: embedder, storeClients: { pinecone: fake } }) })
    const run = await runPipeline('purge-parked', 'Purge parked', pineFlow(csv('purge-parked', 3), 'purge-parked'))
    // Leave only a parked id, as an earlier failed delete would.
    stmt('DELETE FROM records WHERE pipeline_id = ?').run('purge-parked')
    stmt('DELETE FROM vector_ids WHERE pipeline_id = ?').run('purge-parked')
    stmt('INSERT INTO vector_ids (pipeline_id, chunk_id, provider_id) VALUES (?, ?, ?)').run('purge-parked', 'stale:old-1', 'old-1')
    fake.deleteMany = async () => {
        throw Object.assign(new Error('Service unavailable (injected)'), { status: 503 })
    }
    const result = await api.deletePipeline('purge-parked')
    check(
        'purge 7: a failure clearing parked provider ids is reported, not counted as a clean store',
        run.status === 'succeeded' &&
            result.stores.length === 0 &&
            result.errors.length === 1 &&
            /1 parked vector ids could not be deleted \(Service unavailable/.test(result.errors[0].error) &&
            !api.getPipeline('purge-parked'),
        JSON.stringify(result)
    )
}

// An earlier store that makes up its own vector ids (SingleStore here): after the move the id map holds the new store's
// ids, so the old store cannot be purged by id. Delete clears the current store and names the old one as left behind,
// instead of reporting it clean.
{
    const single = createFake(shapeFor('singlestore'))
    const pine = createFake(shapeFor('pinecone'))
    api.configureRunner({
        contextFor: () => ({ workspaceId: WS, embeddingsDouble: embedder, storeClients: { singlestore: single, pinecone: pine } })
    })
    const file = csv('purge-append', 4)
    const singleFlow = pineFlow(file, 'purge-append')
    singleFlow.nodes[2] = {
        id: 'vs',
        data: { name: 'singlestore', label: 'SingleStore', category: 'Vector Stores', inputs: {}, credential: 'single-cred' }
    }
    const first = await runPipeline('purge-append', 'Purge append', singleFlow)
    const second = await runPipeline('purge-append', 'Purge append', pineFlow(file, 'purge-append'))
    const before = { single: single.rows.size, pine: pine.rows.size }
    const result = await api.deletePipeline('purge-append')
    check(
        'purge 8: an earlier store with its own vector ids is named as left behind, and the current store is cleared',
        first.status === 'succeeded' &&
            second.status === 'succeeded' &&
            before.single === 4 &&
            before.pine === 4 &&
            pine.rows.size === 0 &&
            result.stores.length === 1 &&
            result.errors.length === 1 &&
            result.errors[0].store === 'SingleStore' &&
            /makes up its own vector ids/.test(result.errors[0].error) &&
            !api.getPipeline('purge-append'),
        JSON.stringify({
            first: first.status,
            second: second.status,
            before,
            after: { single: single.rows.size, pine: pine.rows.size },
            result
        })
    )
}

// The other direction: an earlier store whose provider ids are the chunk ids (Pinecone, Local Vector Store), and a
// current store that makes up its own ids. The id map holds the current store's ids, so the earlier stores are purged by
// chunk id without it.
{
    const single = createFake(shapeFor('singlestore'))
    const pine = createFake(shapeFor('pinecone'))
    api.configureRunner({
        contextFor: () => ({ workspaceId: WS, embeddingsDouble: embedder, storeClients: { singlestore: single, pinecone: pine } })
    })
    const file = csv('purge-reverse', 3)
    const singleFlow = pineFlow(file, 'purge-reverse')
    singleFlow.nodes[2] = {
        id: 'vs',
        data: { name: 'singlestore', label: 'SingleStore', category: 'Vector Stores', inputs: {}, credential: 'single-cred' }
    }
    const local = flowFor(file, 'purge-reverse-local')
    local.nodes = local.nodes.map((node) => (node.id === 'emb' ? pineFlow(file, 'x').nodes[1] : node))
    const runs = [
        await runPipeline('purge-reverse', 'Purge reverse', local),
        await runPipeline('purge-reverse', 'Purge reverse', pineFlow(file, 'purge-reverse')),
        await runPipeline('purge-reverse', 'Purge reverse', singleFlow)
    ]
    const localStore = LocalVectorStore.open('purge-reverse-local')
    const before = { local: localStore.count(), pine: pine.rows.size, single: single.rows.size }
    const result = await api.deletePipeline('purge-reverse')
    const after = { local: localStore.count(), pine: pine.rows.size, single: single.rows.size }
    check(
        'purge 9: earlier Local and Pinecone stores are purged by chunk id when the current store makes up its own ids',
        runs.every((run) => run.status === 'succeeded') &&
            before.local === 3 &&
            before.pine === 3 &&
            before.single === 3 &&
            after.local === 0 &&
            after.pine === 0 &&
            after.single === 0 &&
            result.stores.length === 3 &&
            result.errors.length === 0,
        JSON.stringify({ runs: runs.map((run) => run.status), before, after, result })
    )
}

// A run that never began (queued behind another, then cancelled by the delete) wrote nothing, so its store does not
// count as the current one. The SingleStore id map is still the right one and SingleStore is cleared.
{
    const single = createFake(shapeFor('singlestore'))
    const pine = createFake(shapeFor('pinecone'))
    api.configureRunner({
        contextFor: () => ({ workspaceId: WS, embeddingsDouble: embedder, storeClients: { singlestore: single, pinecone: pine } })
    })
    const file = csv('purge-queued', 3)
    const singleFlow = pineFlow(file, 'purge-queued')
    singleFlow.nodes[2] = {
        id: 'vs',
        data: { name: 'singlestore', label: 'SingleStore', category: 'Vector Stores', inputs: {}, credential: 'single-cred' }
    }
    const first = await runPipeline('purge-queued', 'Purge queued', singleFlow)
    const next = api.recordVersion({ workspaceId: WS, id: 'purge-queued', name: 'Purge queued', flowData: pineFlow(file, 'purge-queued') })
    const now = new Date(Date.now() + 1000).toISOString()
    stmt(
        "INSERT INTO runs (id, pipeline_id, version, mode, status, created_at, updated_at) VALUES (?, ?, ?, 'incremental', 'queued', ?, ?)"
    ).run('purge-queued-run', 'purge-queued', next.version, now, now)
    const before = single.rows.size
    const result = await api.deletePipeline('purge-queued')
    check(
        'purge 10: a queued run the delete cancelled does not make its store current, so the SingleStore vectors are cleared',
        first.status === 'succeeded' && before === 3 && single.rows.size === 0 && result.errors.length === 0 && pine.rows.size === 0,
        JSON.stringify({ before, after: single.rows.size, result })
    )
}

// The current store's provider ids are the chunk ids, but the id map still holds another store's ids (a write that
// stopped before the map was saved). The current store is cleared by chunk id.
{
    const pine = createFake(shapeFor('pinecone'))
    api.configureRunner({ contextFor: () => ({ workspaceId: WS, embeddingsDouble: embedder, storeClients: { pinecone: pine } }) })
    const run = await runPipeline('purge-stalemap', 'Purge stale map', pineFlow(csv('purge-stalemap', 4), 'purge-stalemap'))
    stmt("UPDATE vector_ids SET provider_id = 'elsewhere-' || chunk_id WHERE pipeline_id = ?").run('purge-stalemap')
    const before = pine.rows.size
    const result = await api.deletePipeline('purge-stalemap')
    check(
        'purge 11: a current store whose ids are the chunk ids is cleared by chunk id, whatever the id map holds',
        run.status === 'succeeded' && before === 4 && pine.rows.size === 0 && result.stores.length === 1 && result.errors.length === 0,
        JSON.stringify({ before, after: pine.rows.size, result })
    )
}
