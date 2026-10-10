import { z } from 'zod/v3'
import { Document } from '@langchain/core/documents'
import { BaseRetriever } from '@langchain/core/retrievers'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeOutputsValue, INodeParams } from '../../../src/Interface'
import { getBaseClasses } from '../../../src/utils'
import { SOURCE_DOCUMENTS_PREFIX } from '../../../src/agents'
import { loadEtlModule } from '../../etl/engine'

type Search = (query: string) => Promise<Document[]>

class EtlPipelineRetriever extends BaseRetriever {
    lc_namespace = ['cuttlely', 'etl', 'retriever']

    constructor(private readonly search: Search) {
        super({})
    }

    async _getRelevantDocuments(query: string): Promise<Document[]> {
        return this.search(query)
    }
}

function toolName(pipeline: string): string {
    const slug = pipeline
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
    return `search_${slug || 'pipeline'}`.slice(0, 64)
}

function formatDocs(docs: Document[]): string {
    if (!docs.length) return 'No matching passages were found.'
    return docs
        .map((doc, i) => {
            const source = doc.metadata?.source ? ` (${doc.metadata.source})` : ''
            return `[${i + 1}]${source}\n${doc.pageContent}`
        })
        .join('\n\n')
}

class EtlRetriever_Tools implements INode {
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
        this.label = 'ETL Retriever'
        this.name = 'etlRetriever'
        this.version = 1.1
        this.type = 'EtlRetriever'
        this.icon = 'etlretriever.svg'
        this.category = 'Tools'
        this.badge = 'NEW'
        this.description =
            'Search an ETL pipeline by name, then a namespace that pipeline has written. Uses the embeddings model and store of that run. Works as an agent tool, a retriever, and on a Harness Specialist.'
        this.baseClasses = [this.type, 'Tool', ...getBaseClasses(DynamicStructuredTool)]
        this.inputs = [
            {
                label: 'Pipeline',
                name: 'pipeline',
                type: 'asyncOptions',
                loadMethod: 'listPipelines',
                description: 'ETL pipeline name, as saved on the ETL canvas.'
            },
            {
                label: 'Namespace',
                name: 'etlNamespace',
                type: 'asyncOptions',
                loadMethod: 'listNamespaces',
                refreshOn: ['pipeline'],
                refresh: true,
                optional: true,
                // Hidden until a pipeline is chosen. `^$` matches only an empty pipeline name.
                hide: { pipeline: '^$' },
                description:
                    'Named namespace that pipeline has written. Shown after you pick a pipeline, and only when it has one. Leave empty to search the namespace of the last successful run.'
            },
            {
                label: 'Top K',
                name: 'topK',
                type: 'number',
                default: 4,
                optional: true
            },
            {
                label: 'Tool Name',
                name: 'toolName',
                type: 'string',
                placeholder: 'search_product_docs',
                description: 'Defaults to search_<pipeline name>.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Tool Description',
                name: 'toolDescription',
                type: 'string',
                rows: 3,
                description: 'Tell the agent when to search this data. Defaults to a sentence naming the pipeline.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Return Source Documents',
                name: 'returnSourceDocuments',
                type: 'boolean',
                optional: true,
                additionalParams: true
            }
        ]
        this.outputs = [
            {
                label: 'Tool',
                name: 'tool',
                baseClasses: this.baseClasses
            },
            {
                label: 'Retriever',
                name: 'retriever',
                baseClasses: ['EtlRetriever', 'BaseRetriever']
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listPipelines(_: INodeData, options: ICommonObject = {}): Promise<INodeOptionsValue[]> {
            const api = await loadEtlModule('api.mjs')
            return api.pipelineOptions(options.workspaceId)
        },
        async listNamespaces(nodeData: INodeData, options: ICommonObject = {}): Promise<INodeOptionsValue[]> {
            const pipeline = String(nodeData.inputs?.pipeline || '').trim()
            if (!pipeline) return []
            const api = await loadEtlModule('api.mjs')
            return api.namespaceOptions(pipeline, options.workspaceId)
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject = {}): Promise<any> {
        const pipeline = String(nodeData.inputs?.pipeline || '').trim()
        if (!pipeline) throw new Error('Pick an ETL pipeline on the ETL Retriever node.')
        const namespace = String(nodeData.inputs?.etlNamespace || '').trim()
        const k = Number(nodeData.inputs?.topK) || 4
        const api = await loadEtlModule('api.mjs')
        const ctx = {
            componentNodes: options.componentNodes,
            workspaceId: options.workspaceId,
            storeClients: options.storeClients,
            embeddingsDouble: options.embeddingsDouble,
            flowOptions: options.appDataSource ? options : undefined
        }
        const search: Search = async (query) => {
            const found = await api.searchPipeline(pipeline, query, { k, namespace: namespace || undefined, ctx })
            return found.results.map(
                (hit: any) =>
                    new Document({
                        pageContent: hit.pageContent,
                        metadata: {
                            ...hit.metadata,
                            score: hit.score,
                            pipeline: found.pipeline,
                            ...(found.namespace ? { namespace: found.namespace } : {})
                        }
                    })
            )
        }
        if (nodeData.outputs?.output === 'retriever') return new EtlPipelineRetriever(search)

        const returnSourceDocuments = Boolean(nodeData.inputs?.returnSourceDocuments)
        return new DynamicStructuredTool({
            name: (nodeData.inputs?.toolName as string) || toolName(pipeline),
            description:
                (nodeData.inputs?.toolDescription as string) ||
                (namespace
                    ? `Searches the "${namespace}" namespace of the "${pipeline}" knowledge base built by the ETL pipeline of that name. Use it for questions about that data.`
                    : `Searches the "${pipeline}" knowledge base built by the ETL pipeline of that name. Use it for questions about that data.`),
            schema: z.object({ query: z.string().describe('What to look up') }) as any,
            func: async ({ query }: { query: string }) => {
                const docs = await search(query)
                const content = formatDocs(docs)
                return returnSourceDocuments ? content + SOURCE_DOCUMENTS_PREFIX + JSON.stringify(docs) : content
            }
        })
    }
}

module.exports = { nodeClass: EtlRetriever_Tools }
