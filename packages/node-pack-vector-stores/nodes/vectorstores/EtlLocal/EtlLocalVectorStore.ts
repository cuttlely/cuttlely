import crypto from 'crypto'
import { flatten } from 'lodash'
import { Document } from '@langchain/core/documents'
import { Embeddings } from '@langchain/core/embeddings'
import { VectorStore } from '@langchain/core/vectorstores'
import { INode, INodeData, INodeOutputsValue, INodeParams, IndexingResult } from '@cuttlely/components/interface'
import { getBaseClasses } from '@cuttlely/components/utils'
import { loadEtlModule } from '@cuttlely/components/etl-engine'

type LocalStore = {
    collection: string
    upsert(ids: string[], vectors: Float32Array[], docs: { pageContent: string; metadata: Record<string, any> }[]): void
    delete(ids: string[]): void
    search(vector: Float32Array, k: number): { pageContent: string; metadata: Record<string, any>; score: number }[]
}

// Content-addressed ids make a repeated upsert of the same documents overwrite instead of duplicate.
function contentId(collection: string, doc: Document): string {
    const hex = crypto
        .createHash('sha256')
        .update(`${collection}\0${JSON.stringify(doc.metadata?.source ?? '')}\0${doc.pageContent}`)
        .digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export class CuttlelyLocalVectorStore extends VectorStore {
    declare FilterType: object
    store: LocalStore

    constructor(embeddings: Embeddings, store: LocalStore) {
        super(embeddings, {})
        this.store = store
    }

    _vectorstoreType(): string {
        return 'cuttlely-local'
    }

    async addVectors(vectors: number[][], documents: Document[], options?: { ids?: string[] }): Promise<string[]> {
        const ids = options?.ids?.length ? options.ids : documents.map((doc) => contentId(this.store.collection, doc))
        this.store.upsert(
            ids,
            vectors.map((vector) => Float32Array.from(vector)),
            documents.map((doc) => ({ pageContent: doc.pageContent, metadata: doc.metadata || {} }))
        )
        return ids
    }

    async addDocuments(documents: Document[], options?: { ids?: string[] }): Promise<string[]> {
        const vectors = await this.embeddings.embedDocuments(documents.map((doc) => doc.pageContent))
        return this.addVectors(vectors, documents, options)
    }

    async delete(params?: { ids?: string[] }): Promise<void> {
        if (params?.ids?.length) this.store.delete(params.ids)
    }

    async similaritySearchVectorWithScore(query: number[], k: number): Promise<[Document, number][]> {
        return this.store
            .search(Float32Array.from(query), k)
            .map((hit) => [new Document({ pageContent: hit.pageContent, metadata: hit.metadata }), hit.score] as [Document, number])
    }
}

class EtlLocalVectorStore_VectorStores implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    badge: string
    baseClasses: string[]
    inputs: INodeParams[]
    outputs: INodeOutputsValue[]

    constructor() {
        this.label = 'Local Vector Store'
        this.name = 'etlLocalVectorStore'
        this.version = 1.0
        this.type = 'CuttlelyLocal'
        this.icon = 'localvs.svg'
        this.category = 'Vector Stores'
        this.badge = 'NEW'
        this.description =
            'Persistent vector collection in a SQLite file under .cuttlely/etl/vectors. Upserts and deletes by id, needs no external service, and is the default ETL target.'
        this.baseClasses = [this.type, 'VectorStoreRetriever', 'BaseRetriever']
        this.inputs = [
            {
                label: 'Document',
                name: 'document',
                type: 'Document',
                list: true,
                optional: true
            },
            {
                label: 'Embeddings',
                name: 'embeddings',
                type: 'Embeddings'
            },
            {
                label: 'Collection',
                name: 'collection',
                type: 'string',
                placeholder: 'product-docs',
                optional: true,
                description: 'Defaults to the ETL pipeline name. On a chat flow, name the collection a pipeline wrote.'
            },
            {
                label: 'Top K',
                name: 'topK',
                type: 'number',
                placeholder: '4',
                optional: true,
                additionalParams: true
            }
        ]
        this.outputs = [
            {
                label: 'Local Retriever',
                name: 'retriever',
                baseClasses: this.baseClasses
            },
            {
                label: 'Local Vector Store',
                name: 'vectorStore',
                baseClasses: [this.type, ...getBaseClasses(VectorStore)]
            }
        ]
    }

    //@ts-ignore
    vectorStoreMethods = {
        async upsert(nodeData: INodeData): Promise<Partial<IndexingResult>> {
            const docs = flatten((nodeData.inputs?.document as Document[]) || []).filter((doc) => doc?.pageContent)
            const vectorStore = await openVectorStore(nodeData)
            const finalDocs = docs.map((doc) => new Document({ pageContent: doc.pageContent, metadata: doc.metadata || {} }))
            await vectorStore.addDocuments(finalDocs)
            return { numAdded: finalDocs.length, addedDocs: finalDocs }
        },
        async delete(nodeData: INodeData, ids: string[]): Promise<void> {
            const vectorStore = await openVectorStore(nodeData)
            await vectorStore.delete({ ids })
        }
    }

    async init(nodeData: INodeData): Promise<any> {
        const vectorStore = await openVectorStore(nodeData)
        const k = Number(nodeData.inputs?.topK) || 4
        if (nodeData.outputs?.output === 'retriever') return vectorStore.asRetriever(k)
        ;(vectorStore as any).k = k
        return vectorStore
    }
}

async function openVectorStore(nodeData: INodeData): Promise<CuttlelyLocalVectorStore> {
    const embeddings = nodeData.inputs?.embeddings as Embeddings
    if (!embeddings) throw new Error('Connect an embeddings node to Local Vector Store.')
    const collection = (nodeData.inputs?.collection as string) || ''
    if (!collection.trim()) throw new Error('Name the Local Vector Store collection, for example the ETL pipeline name.')
    const stores = await loadEtlModule('stores.mjs')
    return new CuttlelyLocalVectorStore(embeddings, stores.LocalVectorStore.open(collection))
}

module.exports = { nodeClass: EtlLocalVectorStore_VectorStores }
