import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EtlError } from './errors.mjs'
import { etlDir } from './db.mjs'
import { LOCAL_STORE } from './graph.mjs'
import { initNode } from './nodes.mjs'
import { namespaceName } from './namespaces.mjs'
import { adaptStore, legacyDeleteFirst, pendingStaleCount, shapeFor } from './store-adapter.mjs'

export function collectionName(value) {
    const text = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
    if (!text) throw new EtlError('bad_store', 'Local Vector Store needs a collection name.')
    return text
}

export function collectionFile(collection) {
    return path.join(etlDir(), 'vectors', `${collectionName(collection)}.sqlite`)
}

const open = new Map()

function toBlob(vector) {
    return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}

function fromBlob(blob) {
    if (blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
    return new Float32Array(Uint8Array.from(blob).buffer)
}

function norm(vector) {
    let sum = 0
    for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i]
    return Math.sqrt(sum)
}

export class LocalVectorStore {
    static open(collection) {
        const file = collectionFile(collection)
        const cached = open.get(file)
        if (cached) return cached
        const store = new LocalVectorStore(file, collectionName(collection))
        open.set(file, store)
        return store
    }

    static closeAll() {
        for (const store of open.values()) store.close()
        open.clear()
    }

    constructor(file, collection) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        this.file = file
        this.collection = collection
        this.db = new DatabaseSync(file)
        this.db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS vectors (
    id TEXT PRIMARY KEY,
    source TEXT,
    content TEXT NOT NULL,
    metadata TEXT,
    norm REAL NOT NULL,
    embedding BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`)
        this.upsertStmt = this.db.prepare(`INSERT INTO vectors (id, source, content, metadata, norm, embedding) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET source = excluded.source, content = excluded.content, metadata = excluded.metadata, norm = excluded.norm, embedding = excluded.embedding`)
        this.deleteStmt = this.db.prepare('DELETE FROM vectors WHERE id = ?')
        const dims = this.db.prepare("SELECT value FROM meta WHERE key = 'dimensions'").get()
        this.dimensions = dims ? Number(dims.value) : null
    }

    upsert(ids, vectors, docs) {
        if (!ids.length) return
        const dims = vectors[0].length
        if (this.dimensions !== null && this.dimensions !== dims) {
            throw new EtlError(
                'bad_dimensions',
                `Collection "${this.collection}" holds ${this.dimensions}-dimension vectors; the embeddings model returned ${dims}. Run a full rebuild or use another collection.`
            )
        }
        this.db.exec('BEGIN IMMEDIATE')
        try {
            if (this.dimensions === null) {
                this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('dimensions', ?)").run(String(dims))
                this.dimensions = dims
            }
            for (let i = 0; i < ids.length; i += 1) {
                const doc = docs[i]
                this.upsertStmt.run(
                    ids[i],
                    doc.metadata?.source ?? null,
                    doc.pageContent,
                    JSON.stringify(doc.metadata || {}),
                    norm(vectors[i]),
                    toBlob(vectors[i])
                )
            }
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    delete(ids) {
        if (!ids.length) return
        this.db.exec('BEGIN IMMEDIATE')
        try {
            for (const id of ids) this.deleteStmt.run(id)
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    reset() {
        this.db.exec("DELETE FROM vectors; DELETE FROM meta WHERE key = 'dimensions';")
        this.dimensions = null
    }

    count() {
        return Number(this.db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n)
    }

    missing(ids) {
        const out = []
        const has = this.db.prepare('SELECT 1 AS hit FROM vectors WHERE id = ?')
        for (const id of ids) if (!has.get(id)) out.push(id)
        return out
    }

    // Exact cosine scan with a k-sized buffer: memory stays O(k) however large the collection is.
    search(query, k = 4) {
        const q = query instanceof Float32Array ? query : Float32Array.from(query)
        const qn = norm(q) || 1
        const top = []
        const scan = this.db.prepare('SELECT rowid, norm, embedding FROM vectors')
        for (const row of scan.iterate()) {
            const v = fromBlob(row.embedding)
            if (v.length !== q.length) continue
            let dot = 0
            for (let i = 0; i < q.length; i += 1) dot += q[i] * v[i]
            const score = dot / (qn * (row.norm || 1))
            if (top.length < k || score > top[top.length - 1].score) {
                top.push({ rowid: row.rowid, score })
                top.sort((a, b) => b.score - a.score)
                if (top.length > k) top.pop()
            }
        }
        const get = this.db.prepare('SELECT id, content, metadata FROM vectors WHERE rowid = ?')
        return top.map(({ rowid, score }) => {
            const row = get.get(rowid)
            return { id: row.id, pageContent: row.content, metadata: JSON.parse(row.metadata || '{}'), score }
        })
    }

    close() {
        try {
            this.db.close()
        } catch {
            // already closed
        }
        open.delete(this.file)
    }
}

// In-Memory vectors exist only on the store object a run created. Keep that object for the process so a later
// search sees them. A restart drops it; the next run writes it again (D23).
const processStores = new Map()

export function clearProcessStores() {
    processStores.clear()
}

// Drops the In-Memory vectors kept for a deleted pipeline.
export function forgetPipelineStores(pipelineId) {
    for (const key of processStores.keys()) if (key.startsWith(`${pipelineId}\0`)) processStores.delete(key)
}

function residentKey(pipelineId, nodeName) {
    return `${pipelineId}\0${nodeName}`
}

function searchMethods(store) {
    return {
        ...(typeof store.similaritySearchVectorWithScore === 'function'
            ? { similaritySearchVectorWithScore: (vector, k) => store.similaritySearchVectorWithScore(vector, k) }
            : {}),
        ...(typeof store.similaritySearchWithScore === 'function'
            ? { similaritySearchWithScore: (query, k) => store.similaritySearchWithScore(query, k) }
            : {})
    }
}

async function liveClient(shape, spec, embeddings, ctx) {
    const store = await initNode(spec, { inputs: { document: [], embeddings, recordManager: undefined }, output: 'vectorStore', ctx })
    if (!store || store.error) throw new EtlError('bad_store', store?.error || `${spec.label} did not return a vector store.`)
    if (shape.nodeName === 'memoryVectorStore') {
        return {
            rows: new Map(),
            // The same chunk id replaces its vector. MemoryVectorStore.addVectors only appends, and its delete throws.
            addVectors: async (vectors, docs, options) => {
                const drop = new Set([...(options?.ids || []), ...docs.map((doc) => doc?.id).filter(Boolean)].map(String))
                if (drop.size && Array.isArray(store.memoryVectors)) {
                    store.memoryVectors = store.memoryVectors.filter((row) => !drop.has(String(row.id)))
                }
                return store.addVectors(vectors, docs)
            },
            delete: async ({ ids }) => {
                const drop = new Set((ids || []).map(String))
                if (Array.isArray(store.memoryVectors)) {
                    store.memoryVectors = store.memoryVectors.filter((row) => !drop.has(String(row.id)))
                }
            },
            ...searchMethods(store)
        }
    }
    if (shape.kind === 'pinecone' && store.pineconeIndex) {
        const textKey = spec.inputs?.pineconeTextKey || 'text'
        const name = namespaceName(store.namespace || spec.inputs?.pineconeNamespace)
        const namespace = store.pineconeIndex.namespace(name)
        return {
            textKey,
            namespace: name,
            rows: new Map(),
            upsert: (records) => namespace.upsert(records),
            deleteMany: (ids) => namespace.deleteMany(ids),
            query: (args) => namespace.query(args),
            describeIndexStats: () => store.pineconeIndex.describeIndexStats(),
            fetch: (ids) => namespace.fetch(ids)
        }
    }
    if (shape.kind === 'astra' && store.collection) {
        return {
            idKey: store.idKey || '_id',
            contentKey: store.contentKey || 'text',
            rows: new Map(),
            insertMany: (docs, options) => store.collection.insertMany(docs, options),
            replaceOne: (filter, doc) => store.collection.replaceOne(filter, doc),
            deleteMany: (filter) => store.collection.deleteMany(filter),
            find: (filter, options) => store.collection.find(filter, options)
        }
    }
    if (shape.kind === 'vectara' && typeof store.addDocuments === 'function') {
        return {
            rows: new Map(),
            addDocuments: (docs) => store.addDocuments(docs),
            deleteDocuments: (ids) => store.deleteDocuments(ids),
            ...searchMethods(store)
        }
    }
    if (typeof store.addVectors === 'function') {
        return {
            rows: new Map(),
            addVectors: (vectors, docs, options) => store.addVectors(vectors, docs, options),
            delete: (params) => (typeof store.delete === 'function' ? store.delete(params) : undefined),
            ...searchMethods(store)
        }
    }
    throw new EtlError(
        'bad_store',
        `${spec.label} did not return a vector store that can add vectors. Its credential has to be selected on the node.`
    )
}

// Where a store keeps this pipeline's vectors, for the store-count check: two pipelines with the same
// scope share a namespace, so neither can be counted on its own. null means the store cannot be counted.
export function storeScope(spec, pipelineName) {
    if (!spec) return null
    if (spec.nodeName === LOCAL_STORE) return { key: `local:${collectionName(spec.inputs?.collection || pipelineName)}` }
    if (spec.nodeName === 'pinecone') {
        const namespace = namespaceName(spec.inputs?.pineconeNamespace)
        if (!namespace) return { key: null, reason: 'default namespace' }
        return { key: `pinecone:${String(spec.inputs?.pineconeIndex || '').trim()}:${namespace}` }
    }
    return null
}

export async function openStore(
    spec,
    { pipelineName, pipelineId, embeddings, ctx = {}, onStale, rawIds = false, skipParked = false } = {}
) {
    if (!spec) throw new EtlError('bad_pipeline', 'The pipeline has no vector store node.')
    if (spec.nodeName === LOCAL_STORE) {
        const store = LocalVectorStore.open(spec.inputs?.collection || pipelineName)
        return {
            kind: 'local',
            label: `Local Vector Store (${store.collection})`,
            local: store,
            upsert: async (ids, vectors, docs) => store.upsert(ids, vectors, docs),
            delete: async (ids) => store.delete(ids),
            search: async (vector, k, queryText) => store.search(vector, k, queryText),
            canCount: true,
            count: async () => store.count(),
            missing: async (ids) => store.missing(ids),
            forget: () => {},
            staleCount: () => 0,
            reset: async () => store.reset()
        }
    }
    const shape = shapeFor(spec.nodeName)
    if (!shape) throw new EtlError('bad_store', `${spec.label} is not a vector store this ETL build knows.`)
    // A pipeline that no longer targets In-Memory must not keep serving the old process-local vectors.
    if (pipelineId && spec.nodeName !== 'memoryVectorStore') processStores.delete(residentKey(pipelineId, 'memoryVectorStore'))
    const key = pipelineId ? residentKey(pipelineId, spec.nodeName) : ''
    let client = ctx.storeClients?.[spec.nodeName]
    if (!client && spec.nodeName === 'memoryVectorStore' && key) client = processStores.get(key)
    if (!client) {
        client = await liveClient(shape, spec, embeddings, ctx)
        if (!ctx.storeClients?.[spec.nodeName] && spec.nodeName === 'memoryVectorStore' && key) processStores.set(key, client)
    }
    const adapted = adaptStore(shape, client, { pipelineId, legacyDeleteFirst: legacyDeleteFirst(ctx), onStale, rawIds, skipParked })
    return {
        kind: spec.nodeName,
        label: spec.label,
        upsert: (ids, vectors, docs) => adapted.upsert(ids, vectors, docs),
        delete: (ids) => adapted.delete(ids),
        search: (vector, k, queryText) => adapted.search(vector, k, queryText),
        canCount: adapted.canCount,
        count: adapted.canCount ? () => adapted.count() : async () => null,
        missing: adapted.canCount ? (ids) => adapted.missing(ids) : null,
        preflight: adapted.preflight || null,
        forget: (ids) => adapted.forget?.(ids),
        staleCount: () => pendingStaleCount(pipelineId),
        reset: null
    }
}
