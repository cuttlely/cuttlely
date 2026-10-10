import crypto from 'node:crypto'
import { stmt } from './db.mjs'
import { EtlError } from './errors.mjs'

// One identity adapter for every Flowise vector store. The shape table is how each
// client's upsert, delete and query are spelled. The adapter keeps a chunk id → provider
// id map, so a store that only appends still updates and deletes instead of duplicating.
// A later queue does not change this: workers call the same adaptStore().
//
// Write order (E9a): upsert first, then delete only stale provider ids (an old provider id for a
// chunk that the upsert gave a different id). A stable-id store overwrites in place, so it has no
// stale id and no delete. A failed upsert therefore never removes a vector that was there before,
// and a failed stale delete leaves an extra vector, never a missing one. Stale ids whose delete
// failed are parked in vector_ids under STALE_PREFIX and deleted on the next write.

const ID_STORES = [
    'chroma',
    'supabase',
    'qdrant',
    'couchbase',
    'openSearch',
    'elasticsearch',
    'milvus',
    'upstash',
    'weaviate',
    'postgres',
    'mongoDBAtlas',
    'documentStoreVS'
]

export const SHAPES = [
    { nodeName: 'etlLocalVectorStore', kind: 'local', adaptable: true, stableIds: true, label: 'Local Vector Store' },
    { nodeName: 'pinecone', kind: 'pinecone', adaptable: true, stableIds: true, label: 'Pinecone' },
    { nodeName: 'Astra', kind: 'astra', adaptable: true, stableIds: true, label: 'Astra' },
    { nodeName: 'redis', kind: 'keys', adaptable: true, stableIds: true, label: 'Redis' },
    ...ID_STORES.map((nodeName) => ({ nodeName, kind: 'ids', adaptable: true, stableIds: true, label: nodeName })),
    { nodeName: 'memoryVectorStore', kind: 'append', adaptable: true, stableIds: false, label: 'In-Memory Vector Store' },
    { nodeName: 'singlestore', kind: 'append', adaptable: true, stableIds: false, label: 'SingleStore' },
    { nodeName: 'zep', kind: 'append', adaptable: true, stableIds: false, label: 'Zep' },
    { nodeName: 'zepCloud', kind: 'append', adaptable: true, stableIds: false, label: 'Zep Cloud' },
    { nodeName: 'faiss', kind: 'shadow', adaptable: true, stableIds: true, label: 'Faiss' },
    { nodeName: 'vectara', kind: 'vectara', adaptable: true, stableIds: true, label: 'Vectara' },
    { nodeName: 'kendra', kind: 'kendra', adaptable: true, stableIds: true, label: 'AWS Kendra' },
    { nodeName: 'meilisearch', kind: 'meili', adaptable: true, stableIds: true, label: 'Meilisearch' },
    {
        nodeName: 'vectaraUpload',
        kind: null,
        adaptable: false,
        stableIds: false,
        label: 'Vectara Upload File',
        reason: 'Vectara Upload File sends whole files and cannot update or delete a chunk. Use the Vectara node, which indexes each chunk by id.'
    }
]

const byName = new Map(SHAPES.map((shape) => [shape.nodeName, shape]))

export function shapeFor(nodeName) {
    return byName.get(nodeName) || null
}

export const STALE_PREFIX = 'stale:'
const FETCH_BATCH = 100

function loadIndex(pipelineId) {
    const index = new Map()
    const stale = new Set()
    if (!pipelineId) return { index, stale }
    for (const row of stmt('SELECT chunk_id, provider_id FROM vector_ids WHERE pipeline_id = ?').all(pipelineId)) {
        if (row.chunk_id.startsWith(STALE_PREFIX)) stale.add(row.provider_id)
        else index.set(row.chunk_id, row.provider_id)
    }
    return { index, stale }
}

// Stale provider ids parked by a failed delete, for the store-count check: the store may still hold them.
export function pendingStaleCount(pipelineId) {
    if (!pipelineId) return 0
    return Number(stmt("SELECT COUNT(*) AS n FROM vector_ids WHERE pipeline_id = ? AND chunk_id LIKE 'stale:%'").get(pipelineId).n)
}

function saveIndex(pipelineId, chunkId, providerId) {
    if (!pipelineId) return
    stmt(
        `INSERT INTO vector_ids (pipeline_id, chunk_id, provider_id) VALUES (?, ?, ?)
         ON CONFLICT (pipeline_id, chunk_id) DO UPDATE SET provider_id = excluded.provider_id`
    ).run(pipelineId, chunkId, providerId)
}

function dropIndex(pipelineId, chunkId) {
    if (!pipelineId) return
    stmt('DELETE FROM vector_ids WHERE pipeline_id = ? AND chunk_id = ?').run(pipelineId, chunkId)
}

function asArray(vector) {
    return vector instanceof Float32Array ? Array.from(vector) : vector
}

function cosine(rows, vector, k) {
    const q = asArray(vector)
    const scored = []
    for (const [id, row] of rows) {
        const v = row.vector || []
        let dot = 0
        let na = 0
        let nb = 0
        const n = Math.min(q.length, v.length)
        for (let i = 0; i < n; i += 1) {
            dot += q[i] * v[i]
            na += q[i] * q[i]
            nb += v[i] * v[i]
        }
        const score = dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1))
        scored.push({
            id,
            score,
            pageContent: row.text,
            metadata: row.metadata || {}
        })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
}

function remember(client, id, text, vector, metadata) {
    client.rows.set(id, { text, vector: asArray(vector), metadata: metadata || {} })
}

function asHit(doc, score) {
    return {
        id: doc?.id,
        pageContent: doc?.pageContent || '',
        metadata: doc?.metadata || {},
        score
    }
}

// A store that cannot search by vector (Vectara, and SingleStore unless its strategy is VECTOR_ONLY) is searched
// with the question text instead. Any other error is the store's own failure.
const VECTOR_SEARCH_UNAVAILABLE = /not implemented|only available for VECTOR_ONLY/i

async function queryClient(client, vector, k, queryText) {
    if (typeof client.similaritySearchVectorWithScore === 'function') {
        try {
            const hits = await client.similaritySearchVectorWithScore(asArray(vector), k)
            return (hits || []).map(([doc, score]) => asHit(doc, score))
        } catch (error) {
            const textSearch = queryText && typeof client.similaritySearchWithScore === 'function'
            if (!textSearch || !VECTOR_SEARCH_UNAVAILABLE.test(String(error?.message || error))) throw error
        }
    }
    if (queryText && typeof client.similaritySearchWithScore === 'function') {
        const hits = await client.similaritySearchWithScore(queryText, k)
        return (hits || []).map(([doc, score]) => asHit(doc, score))
    }
    return cosine(client.rows, vector, k)
}

const HANDLERS = {
    ids: {
        async upsert(client, ids, vectors, docs) {
            const returned = await client.addVectors(
                vectors.map(asArray),
                docs.map((doc) => ({ pageContent: doc.pageContent, metadata: doc.metadata || {} })),
                { ids }
            )
            return Array.isArray(returned) && returned.length === ids.length ? returned : ids
        },
        async delete(client, ids) {
            await client.delete({ ids })
        },
        async query(client, vector, k) {
            if (typeof client.similaritySearchVectorWithScore === 'function') {
                const hits = await client.similaritySearchVectorWithScore(asArray(vector), k)
                return hits.map(([doc, score]) => ({
                    id: doc.id,
                    pageContent: doc.pageContent,
                    metadata: doc.metadata || {},
                    score
                }))
            }
            return cosine(client.rows, vector, k)
        },
        dump(client) {
            return [...client.rows.entries()].map(([id, row]) => ({ id, text: row.text }))
        }
    },
    keys: {
        async upsert(client, ids, vectors, docs) {
            await client.addVectors(
                vectors.map(asArray),
                docs.map((doc) => ({ pageContent: doc.pageContent, metadata: doc.metadata || {} })),
                { keys: ids }
            )
            return ids
        },
        async delete(client, ids) {
            await client.delete({ ids })
        },
        query(client, vector, k, queryText) {
            return queryClient(client, vector, k, queryText)
        },
        dump(client) {
            return [...client.rows.entries()].map(([id, row]) => ({ id, text: row.text }))
        }
    },
    pinecone: {
        async upsert(client, ids, vectors, docs) {
            const textKey = client.textKey || 'text'
            const records = ids.map((id, i) => ({
                id,
                values: asArray(vectors[i]),
                metadata: { ...(docs[i].metadata || {}), [textKey]: docs[i].pageContent }
            }))
            for (let i = 0; i < records.length; i += 100) await client.upsert(records.slice(i, i + 100))
            return ids
        },
        async delete(client, ids) {
            for (let i = 0; i < ids.length; i += 1000) await client.deleteMany(ids.slice(i, i + 1000))
        },
        async query(client, vector, k) {
            const textKey = client.textKey || 'text'
            const result = await client.query({ vector: asArray(vector), topK: k, includeMetadata: true })
            return (result.matches || []).map((match) => {
                const metadata = { ...(match.metadata || {}) }
                const pageContent = metadata[textKey] || ''
                delete metadata[textKey]
                return { id: match.id, pageContent, metadata, score: match.score }
            })
        },
        dump(client) {
            const textKey = client.textKey || 'text'
            return [...client.rows.entries()].map(([id, row]) => ({ id, text: row.metadata?.[textKey] || row.text }))
        },
        canCount(client) {
            return typeof client.describeIndexStats === 'function' && typeof client.fetch === 'function'
        },
        // The preflight before a run reads anything: describe_index_stats on the target index. It sends no records, so
        // the caller treats any error but a transient or rate-limit one as configuration (PR #41).
        async preflight(client) {
            if (typeof client.describeIndexStats === 'function') await client.describeIndexStats()
        },
        // Per-namespace record count from describe_index_stats. Eventually consistent; the caller polls.
        async count(client) {
            const stats = await client.describeIndexStats()
            const summary = stats?.namespaces?.[client.namespace || '']
            return Number(summary?.recordCount ?? summary?.vectorCount ?? 0)
        },
        // Ids that fetch-by-id does not return, in batches small enough for a GET query string.
        async missing(client, ids) {
            const out = []
            for (let i = 0; i < ids.length; i += FETCH_BATCH) {
                const slice = ids.slice(i, i + FETCH_BATCH)
                const result = await client.fetch(slice)
                const found = result?.records || result?.vectors || {}
                for (const id of slice) if (!found[id]) out.push(id)
            }
            return out
        }
    },
    astra: {
        async upsert(client, ids, vectors, docs) {
            const idKey = client.idKey || '_id'
            const contentKey = client.contentKey || 'text'
            const records = ids.map((id, i) => ({
                [idKey]: id,
                [contentKey]: docs[i].pageContent,
                $vector: asArray(vectors[i]),
                ...(docs[i].metadata || {})
            }))
            let inserted = []
            try {
                const result = await client.insertMany(records, { ordered: false })
                inserted = result.insertedIds || []
            } catch (error) {
                if (error?.name !== 'InsertManyError') throw error
                inserted = error.partialResult?.insertedIds || []
            }
            const have = new Set(inserted)
            for (const record of records) {
                if (!have.has(record[idKey])) await client.replaceOne({ [idKey]: record[idKey] }, record)
            }
            return ids
        },
        async delete(client, ids) {
            if (!ids.length) return
            const idKey = client.idKey || '_id'
            await client.deleteMany({ [idKey]: { $in: ids } })
        },
        async query(client, vector, k) {
            const contentKey = client.contentKey || 'text'
            const idKey = client.idKey || '_id'
            const cursor = await client.find({}, { sort: { $vector: asArray(vector) }, limit: k, includeSimilarity: true })
            const hits = []
            for await (const row of cursor) {
                hits.push({
                    id: row[idKey],
                    pageContent: row[contentKey] || '',
                    metadata: row,
                    score: row.$similarity ?? 0
                })
            }
            return hits
        },
        dump(client) {
            const contentKey = client.contentKey || 'text'
            return [...client.rows.values()].map((row) => ({ id: row[client.idKey || '_id'], text: row[contentKey] }))
        }
    },
    append: {
        async upsert(client, ids, vectors, docs) {
            const documents = docs.map((doc, i) => ({
                pageContent: doc.pageContent,
                metadata: { ...(doc.metadata || {}), etlChunkId: ids[i] },
                id: ids[i]
            }))
            const returned = await client.addVectors(vectors.map(asArray), documents, { ids })
            if (Array.isArray(returned) && returned.length === ids.length && returned.every(Boolean)) return returned
            ids.forEach((id, i) => remember(client, id, docs[i].pageContent, vectors[i], docs[i].metadata))
            return ids
        },
        async delete(client, ids) {
            if (typeof client.delete === 'function') await client.delete({ ids })
            ids.forEach((id) => client.rows.delete(id))
        },
        query(client, vector, k, queryText) {
            return queryClient(client, vector, k, queryText)
        },
        dump(client) {
            return [...client.rows.entries()].map(([id, row]) => ({ id, text: row.text }))
        }
    },
    shadow: {
        async upsert(client, ids, vectors, docs) {
            ids.forEach((id, i) => remember(client, id, docs[i].pageContent, vectors[i], docs[i].metadata))
            return ids
        },
        async delete(client, ids) {
            ids.forEach((id) => client.rows.delete(id))
        },
        query(client, vector, k) {
            return cosine(client.rows, vector, k)
        },
        dump(client) {
            return [...client.rows.entries()].map(([id, row]) => ({ id, text: row.text }))
        }
    },
    vectara: {
        async upsert(client, ids, vectors, docs) {
            await client.addDocuments(
                docs.map((doc, i) => ({
                    pageContent: doc.pageContent,
                    metadata: { ...(doc.metadata || {}), document_id: ids[i] }
                }))
            )
            ids.forEach((id, i) => remember(client, id, docs[i].pageContent, vectors[i], docs[i].metadata))
            return ids
        },
        async delete(client, ids) {
            await client.deleteDocuments(ids)
            ids.forEach((id) => client.rows.delete(id))
        },
        query(client, vector, k, queryText) {
            return queryClient(client, vector, k, queryText)
        },
        dump(client) {
            return [...client.rows.entries()].map(([id, row]) => ({ id, text: row.text }))
        }
    },
    kendra: {
        async upsert(client, ids, vectors, docs) {
            await client.put(
                ids.map((id, i) => ({
                    Id: id,
                    Text: docs[i].pageContent,
                    vector: asArray(vectors[i])
                }))
            )
            return ids
        },
        async delete(client, ids) {
            await client.remove(ids)
        },
        query(client, vector, k, queryText) {
            return queryClient(client, vector, k, queryText)
        },
        dump(client) {
            return [...client.rows.entries()].map(([id, row]) => ({ id, text: row.text }))
        }
    },
    meili: {
        async upsert(client, ids, vectors, docs) {
            await client.addDocuments(
                ids.map((id, i) => ({
                    id,
                    content: docs[i].pageContent,
                    vector: asArray(vectors[i]),
                    ...(docs[i].metadata || {})
                }))
            )
            return ids
        },
        async delete(client, ids) {
            await client.deleteDocuments(ids)
        },
        query(client, vector, k, queryText) {
            return queryClient(client, vector, k, queryText)
        },
        dump(client) {
            return [...client.rows.entries()].map(([id, row]) => ({ id, text: row.text }))
        }
    }
}

function strictProblem(record) {
    for (const [key, value] of Object.entries(record.metadata || {})) {
        if (value === null || value === undefined) return `metadata value for ${key} must not be null`
        if (typeof value === 'string' && !value.isWellFormed()) return `metadata value for ${key} is not valid UTF-8`
    }
    return null
}

export function createFake(shape) {
    const rows = new Map()
    const calls = []
    const kind = shape.kind
    if (kind === 'pinecone') {
        return {
            rows,
            calls,
            textKey: 'text',
            namespace: '',
            async describeIndexStats() {
                calls.push('describeIndexStats')
                return { namespaces: { [this.namespace]: { recordCount: rows.size } } }
            },
            async fetch(ids) {
                calls.push('fetch')
                const records = {}
                for (const id of ids) if (rows.has(id)) records[id] = { id, values: rows.get(id).vector, metadata: rows.get(id).metadata }
                return { records, namespace: this.namespace }
            },
            // Test switches: `strict` validates like Pinecone (a lone surrogate or a null metadata value is a 400 for the
            // whole request), `rejectIds` gives a 400 for any request holding one of those ids.
            strict: false,
            rejectIds: new Set(),
            async upsert(records) {
                calls.push('upsert')
                for (const record of records) {
                    const problem = this.rejectIds.has(record.id)
                        ? `record ${record.id} is invalid`
                        : this.strict
                        ? strictProblem(record)
                        : null
                    if (problem) throw Object.assign(new Error(`Bad Request: ${problem}`), { status: 400 })
                }
                for (const record of records)
                    rows.set(record.id, { text: record.metadata.text, vector: record.values, metadata: record.metadata })
            },
            async deleteMany(ids) {
                calls.push('deleteMany')
                ids.forEach((id) => rows.delete(id))
            },
            async query({ vector, topK }) {
                calls.push('query')
                const hits = cosine(rows, vector, topK)
                return {
                    matches: hits.map((hit) => ({ id: hit.id, score: hit.score, metadata: { ...hit.metadata, text: hit.pageContent } }))
                }
            }
        }
    }
    if (kind === 'astra') {
        return {
            rows,
            calls,
            idKey: '_id',
            contentKey: 'text',
            async insertMany(docs) {
                calls.push('insertMany')
                const insertedIds = []
                const dupes = []
                for (const doc of docs) {
                    if (rows.has(doc._id)) dupes.push(doc)
                    else {
                        rows.set(doc._id, doc)
                        insertedIds.push(doc._id)
                    }
                }
                if (dupes.length) {
                    const error = new Error('duplicate')
                    error.name = 'InsertManyError'
                    error.partialResult = { insertedIds }
                    throw error
                }
                return { insertedIds }
            },
            async replaceOne(filter, doc) {
                calls.push('replaceOne')
                rows.set(filter._id, doc)
            },
            async deleteMany(filter) {
                calls.push('deleteMany')
                for (const id of filter._id.$in) rows.delete(id)
            },
            async find(_filter, opts) {
                calls.push('find')
                const hits = cosine(
                    new Map([...rows.entries()].map(([id, row]) => [id, { text: row.text, vector: row.$vector, metadata: row }])),
                    opts.sort.$vector,
                    opts.limit
                )
                return hits.map((hit) => ({ ...rows.get(hit.id), $similarity: hit.score }))
            }
        }
    }
    if (kind === 'kendra') {
        return {
            rows,
            calls,
            async put(docs) {
                calls.push('put')
                for (const doc of docs) rows.set(doc.Id, { text: doc.Text, vector: doc.vector, metadata: {} })
            },
            async remove(ids) {
                calls.push('remove')
                ids.forEach((id) => rows.delete(id))
            }
        }
    }
    if (kind === 'meili') {
        return {
            rows,
            calls,
            async addDocuments(docs) {
                calls.push('addDocuments')
                for (const doc of docs) rows.set(doc.id, { text: doc.content, vector: doc.vector, metadata: doc })
            },
            async deleteDocuments(ids) {
                calls.push('deleteDocuments')
                ids.forEach((id) => rows.delete(id))
            }
        }
    }
    if (kind === 'vectara') {
        return {
            rows,
            calls,
            async addDocuments(docs) {
                calls.push('addDocuments')
                for (const doc of docs) {
                    const id = doc.metadata.document_id
                    rows.set(id, { text: doc.pageContent, vector: doc.metadata._vector || [1, 0], metadata: doc.metadata })
                }
            },
            async deleteDocuments(ids) {
                calls.push('deleteDocuments')
                ids.forEach((id) => rows.delete(id))
            }
        }
    }
    if (kind === 'shadow') {
        return { rows, calls }
    }
    if (kind === 'append') {
        return {
            rows,
            calls,
            async addVectors(vectors, docs) {
                calls.push('addVectors')
                return vectors.map((vector, i) => {
                    const id = crypto.randomUUID()
                    rows.set(id, { text: docs[i].pageContent, vector, metadata: docs[i].metadata || {} })
                    return id
                })
            },
            async delete({ ids }) {
                calls.push('delete')
                ids.forEach((id) => rows.delete(id))
            }
        }
    }
    return {
        rows,
        calls,
        async addVectors(vectors, docs, options) {
            calls.push(options?.keys ? 'keys' : 'ids')
            const ids = options?.keys || options?.ids || options
            const list = Array.isArray(ids) ? ids : null
            if (!list) {
                return vectors.map((vector, i) => {
                    const id = crypto.randomUUID()
                    rows.set(id, { text: docs[i].pageContent, vector, metadata: docs[i].metadata || {} })
                    return id
                })
            }
            list.forEach((id, i) => rows.set(id, { text: docs[i].pageContent, vector: vectors[i], metadata: docs[i].metadata || {} }))
            return list
        },
        async delete({ ids }) {
            calls.push('delete')
            ids.forEach((id) => rows.delete(id))
        },
        async similaritySearchVectorWithScore(vector, k) {
            calls.push('query')
            return cosine(rows, vector, k).map((hit) => [{ pageContent: hit.pageContent, metadata: hit.metadata, id: hit.id }, hit.score])
        }
    }
}

// The test-only fault is honored only when ETL_CHECK=1 (set by etl/check.mjs), so a context built by spreading
// settings or request data can never switch it on.
export function legacyDeleteFirst(ctx) {
    return Boolean(ctx?.faults?.legacyDeleteFirst) && process.env.ETL_CHECK === '1'
}

// Supplies identity for every shape: same chunk id overwrites, delete removes that provider row.
// `legacyDeleteFirst` restores the pre-E9a order (delete the old provider ids, then upsert). It exists
// only so etl:check can prove the store-count check catches the loss on its own; nothing sets it in production.
// `rawIds` deletes by chunk id without the provider id map, which may hold another store's ids (a store the pipeline
// used before it moved, or a write that stopped before the map was saved). Only for stores whose provider ids are the
// chunk ids (`stableIds`). `skipParked` leaves ids parked by an earlier failed delete alone, for a store they may not
// belong to.
export function adaptStore(shape, client, { pipelineId, legacyDeleteFirst = false, onStale, rawIds = false, skipParked = false } = {}) {
    if (!shape?.adaptable || !HANDLERS[shape.kind]) {
        const reason = shape?.reason || `${shape?.label || 'This store'} cannot take incremental chunk ids.`
        const fail = async () => {
            throw new EtlError('bad_store', reason)
        }
        return { upsert: fail, delete: fail, search: fail, dump: () => [], canCount: false }
    }
    const handler = HANDLERS[shape.kind]
    const loaded = loadIndex(pipelineId)
    const index = rawIds ? new Map() : loaded.index
    const parked = skipParked ? new Set() : loaded.stale
    if (shape.kind === 'shadow' && pipelineId && client.rows.size === 0) {
        for (const row of stmt('SELECT chunk_id, content, metadata, embedding FROM shadow_vectors WHERE pipeline_id = ?').all(pipelineId)) {
            client.rows.set(row.chunk_id, {
                text: row.content,
                metadata: JSON.parse(row.metadata || '{}'),
                vector: JSON.parse(row.embedding)
            })
        }
    }
    const park = (ids, error) => {
        ids.forEach((id) => {
            parked.add(id)
            saveIndex(pipelineId, `${STALE_PREFIX}${id}`, id)
        })
        if (onStale) onStale(ids, error)
    }
    let parkedTried = false
    const clearParked = async () => {
        if (parkedTried || !parked.size) return
        parkedTried = true
        const ids = [...parked]
        try {
            await handler.delete(client, ids)
        } catch (error) {
            if (onStale) onStale(ids, error)
            return
        }
        ids.forEach((id) => {
            parked.delete(id)
            dropIndex(pipelineId, `${STALE_PREFIX}${id}`)
        })
    }
    const canCount = typeof handler.canCount === 'function' && handler.canCount(client)
    return {
        async upsert(ids, vectors, docs) {
            if (!ids.length) return
            await clearParked()
            const previous = ids.map((id) => index.get(id))
            if (legacyDeleteFirst) {
                const old = previous.filter(Boolean)
                if (old.length) await handler.delete(client, old)
            }
            const written = await handler.upsert(client, ids, vectors, docs)
            const provider = Array.isArray(written) && written.length === ids.length ? written : ids
            ids.forEach((id, i) => {
                index.set(id, String(provider[i]))
                saveIndex(pipelineId, id, String(provider[i]))
                if (shape.kind === 'shadow' && pipelineId) {
                    stmt(
                        `INSERT INTO shadow_vectors (pipeline_id, chunk_id, content, metadata, embedding) VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT (pipeline_id, chunk_id) DO UPDATE SET content = excluded.content, metadata = excluded.metadata, embedding = excluded.embedding`
                    ).run(pipelineId, id, docs[i].pageContent, JSON.stringify(docs[i].metadata || {}), JSON.stringify(asArray(vectors[i])))
                }
            })
            if (legacyDeleteFirst) return
            const kept = new Set(provider.map(String))
            const stale = previous.filter((old) => old && !kept.has(old))
            if (!stale.length) return
            try {
                await handler.delete(client, stale)
            } catch (error) {
                park(stale, error)
            }
        },
        async delete(ids) {
            await clearParked()
            const provider = rawIds ? ids : ids.map((id) => index.get(id)).filter(Boolean)
            if (provider.length) await handler.delete(client, provider)
            ids.forEach((id) => {
                index.delete(id)
                dropIndex(pipelineId, id)
                if (shape.kind === 'shadow' && pipelineId)
                    stmt('DELETE FROM shadow_vectors WHERE pipeline_id = ? AND chunk_id = ?').run(pipelineId, id)
            })
        },
        // Forget chunk ids the store no longer holds, so the next write treats them as new.
        forget(ids) {
            ids.forEach((id) => {
                index.delete(id)
                dropIndex(pipelineId, id)
            })
        },
        search: (vector, k, queryText) => handler.query(client, vector, k, queryText),
        dump: () => handler.dump(client),
        canCount,
        count: canCount ? () => handler.count(client) : null,
        missing: canCount ? (ids) => handler.missing(client, ids) : null,
        preflight: typeof handler.preflight === 'function' ? () => handler.preflight(client) : null,
        index
    }
}
