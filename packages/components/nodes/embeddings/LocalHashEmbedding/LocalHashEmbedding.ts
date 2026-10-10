import { Embeddings } from '@langchain/core/embeddings'
import { INode, INodeData, INodeParams } from '../../../src/Interface'
import { getBaseClasses } from '../../../src/utils'
import { loadEtlModule } from '../../etl/engine'

class LocalHashEmbeddingModel extends Embeddings {
    constructor(private readonly dimensions: number, private readonly hashEmbed: (text: string, dims: number) => Float32Array) {
        super({})
    }

    async embedDocuments(texts: string[]): Promise<number[][]> {
        return texts.map((text) => Array.from(this.hashEmbed(text, this.dimensions)))
    }

    async embedQuery(text: string): Promise<number[]> {
        return Array.from(this.hashEmbed(text, this.dimensions))
    }
}

class LocalHashEmbedding_Embeddings implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    badge: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Local Hash Embeddings'
        this.name = 'localHashEmbeddings'
        this.version = 1.0
        this.type = 'LocalHashEmbeddings'
        this.icon = 'hashembed.svg'
        this.category = 'Embeddings'
        this.badge = 'NEW'
        this.description =
            'Deterministic word-hashing embeddings computed in the server, with no key or network. Good for tests, demos and keyword-style retrieval; use a provider model for semantic search.'
        this.baseClasses = [this.type, ...getBaseClasses(LocalHashEmbeddingModel)]
        this.inputs = [
            {
                label: 'Dimensions',
                name: 'dimensions',
                type: 'number',
                default: 384,
                optional: true
            }
        ]
    }

    async init(nodeData: INodeData): Promise<any> {
        const dimensions = Math.max(8, Math.min(4096, Number(nodeData.inputs?.dimensions) || 384))
        const engine = await loadEtlModule('hash-embeddings.mjs')
        return new LocalHashEmbeddingModel(dimensions, engine.hashEmbed)
    }
}

module.exports = { nodeClass: LocalHashEmbedding_Embeddings }
