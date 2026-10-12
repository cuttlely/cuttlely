import crypto from 'node:crypto'
import { inputNameOf, parseFlow, plainInputs, stableStringify } from '@cuttlely/harness/flow-graph.mjs'
import { namespaceProblem } from './namespaces.mjs'
import { parseSchema } from './schema.mjs'

export { parseFlow, stableStringify }

export const STREAM_SOURCES = new Set(['etlFileSource', 'etlRepoSource'])
export const TRANSFORM_NODE = 'etlTransform'
export const LOCAL_STORE = 'etlLocalVectorStore'
export const LOCAL_EMBEDDINGS = 'localHashEmbeddings'

// Vectara Upload File sends whole files. It has no chunk id and no delete, so the identity adapter cannot target it.
const UNSUPPORTED_STORES = {
    vectaraUpload:
        'Vectara Upload File sends whole files and cannot update or delete a chunk. Use the Vectara node, which indexes each chunk by id.'
}

const VERIFIED_STORES = new Set([LOCAL_STORE])
const VERIFIED_EMBEDDINGS = new Set([LOCAL_EMBEDDINGS])

function nodeSpec(node) {
    const data = node.data || {}
    const inputs = plainInputs(data.inputs)
    const credential = data.credential || inputs.FLOWISE_CREDENTIAL_ID || undefined
    return {
        nodeId: node.id,
        nodeName: data.name,
        label: data.label || data.name,
        category: data.category,
        inputs,
        ...(credential ? { credential } : {})
    }
}

function isSourceNode(node) {
    const data = node?.data || {}
    return STREAM_SOURCES.has(data.name) || data.category === 'Document Loaders'
}

export function compilePipeline(flowData) {
    const flow = parseFlow(flowData)
    const nodes = flow.nodes || []
    const edges = flow.edges || []
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]))
    const problems = []
    const warnings = []
    const incoming = (nodeId, inputName) =>
        edges.filter((edge) => edge.target === nodeId && byId[edge.source] && inputNameOf(edge, byId[edge.source]) === inputName)

    const stores = nodes.filter((node) => node.data?.category === 'Vector Stores')
    if (stores.length === 0) problems.push('Add a vector store node, such as Local Vector Store, as the pipeline target.')
    if (stores.length > 1) problems.push(`A pipeline writes to one vector store; this canvas has ${stores.length}.`)
    const storeNode = stores[0]
    let store = null
    let embeddings = null
    const sources = []

    if (storeNode) {
        store = nodeSpec(storeNode)
        const unsupported = UNSUPPORTED_STORES[store.nodeName]
        if (unsupported) problems.push(unsupported)
        else if (!VERIFIED_STORES.has(store.nodeName)) {
            warnings.push(
                `${store.label} is written by the ETL identity adapter using the credential on this node. Chunk ids are stable, so a second run updates changes and deletes removals.`
            )
        }
        const embeddingEdges = incoming(storeNode.id, 'embeddings')
        if (embeddingEdges.length === 0) problems.push(`Connect an embeddings node to ${store.label}.`)
        else {
            embeddings = nodeSpec(byId[embeddingEdges[0].source])
            if (!VERIFIED_EMBEDDINGS.has(embeddings.nodeName)) {
                warnings.push(
                    `${embeddings.label} is called through its Flowise node. Runs use your credential and are billed by the provider.`
                )
            }
        }
        if (incoming(storeNode.id, 'recordManager').length) {
            warnings.push('ETL tracks records itself; the connected record manager is ignored.')
        }
        if (store.nodeName === 'pinecone') {
            const namespace = namespaceProblem(store.inputs?.pineconeNamespace)
            if (namespace) problems.push(`bad_namespace: ${store.label}: ${namespace}`)
        }

        const visit = (nodeId, transforms, seen) => {
            const node = byId[nodeId]
            if (!node || seen.has(nodeId)) return
            seen.add(nodeId)
            if (node.data?.name === TRANSFORM_NODE) {
                const upstream = incoming(nodeId, 'document')
                if (upstream.length === 0) problems.push(`${node.data.label || 'Clean & Transform'} has no source connected.`)
                for (const edge of upstream) visit(edge.source, [nodeSpec(node), ...transforms], new Set(seen))
                return
            }
            if (!isSourceNode(node)) {
                problems.push(`${node.data?.label || node.data?.name} cannot feed documents into an ETL pipeline.`)
                return
            }
            const splitterEdge = incoming(nodeId, 'textSplitter')[0]
            const source = nodeSpec(node)
            sources.push({
                ...source,
                kind: STREAM_SOURCES.has(source.nodeName) ? 'stream' : 'loader',
                transforms,
                splitter: splitterEdge ? nodeSpec(byId[splitterEdge.source]) : null
            })
        }
        for (const edge of incoming(storeNode.id, 'document')) visit(edge.source, [], new Set())
        if (sources.length === 0) problems.push(`Connect a source or document loader to ${store.label}.`)
    }

    const used = new Set([store?.nodeId, embeddings?.nodeId])
    for (const source of sources) {
        used.add(source.nodeId)
        if (source.splitter) used.add(source.splitter.nodeId)
        for (const transform of source.transforms) used.add(transform.nodeId)
        if (source.kind === 'loader') {
            warnings.push(
                `${source.label} loads its whole output before ETL streams it. Use Streaming Files or Code Repository for large sources.`
            )
        }
        problems.push(...keyProblems(source))
    }
    for (const node of nodes) {
        if (!used.has(node.id) && node.data?.category !== 'Record Manager' && node.type !== 'stickyNote') {
            warnings.push(`${node.data?.label || node.data?.name} is not connected to the pipeline and is ignored.`)
        }
    }
    sources.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
    return { spec: { store, embeddings, sources }, problems, warnings: [...new Set(warnings)] }
}

const KEYED_EXTENSIONS = /\.(csv|tsv|jsonl|ndjson)$/i

// Every record needs a stable key (E8): CSV and JSONL a key column, loaders a key template, files and repos their path.
// The schema must parse (E6). Each problem starts with its code.
function keyProblems(source) {
    const inputs = source.inputs || {}
    const problems = []
    if (source.nodeName === 'etlFileSource') {
        const format = String(inputs.format || 'auto')
        const paths = String(inputs.paths || '')
            .split(/[\n,]/)
            .map((entry) => entry.trim())
        const keyed = ['csv', 'tsv', 'jsonl'].includes(format) || (format === 'auto' && paths.some((entry) => KEYED_EXTENSIONS.test(entry)))
        if (keyed && !String(inputs.idColumn ?? inputs.idField ?? '').trim())
            problems.push(
                `missing_key_config: ${source.label} reads CSV or JSON Lines; set "Key column or field" so an edited row replaces its old chunks.`
            )
        try {
            parseSchema(inputs.schema)
        } catch (error) {
            problems.push(`bad_schema: ${source.label}: ${error.message}`)
        }
    } else if (source.kind === 'loader' && !source.transforms.some((t) => String(t.inputs?.keyTemplate || '').trim())) {
        problems.push(
            `missing_key_config: ${source.label} is a document loader; set "Key template" on a Clean & Transform node after it (for example {{source}}) so an edited document replaces its old chunks.`
        )
    }
    return problems
}

// Positions, sizes and selection change on every drag; only pipeline-relevant fields define a version.
export function graphHash(flowData) {
    const flow = parseFlow(flowData)
    const nodes = (flow.nodes || [])
        .map((node) => ({
            id: node.id,
            name: node.data?.name,
            version: node.data?.version,
            inputs: node.data?.inputs || {},
            credential: node.data?.credential || null
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
    const edges = (flow.edges || [])
        .map((edge) => [edge.source, edge.sourceHandle || '', edge.target, edge.targetHandle || ''].join('|'))
        .sort()
    return crypto.createHash('sha256').update(stableStringify({ nodes, edges })).digest('hex')
}

const NON_VECTOR_INPUTS = /^(batchSize|timeout|maxRetries|maxConcurrency|concurrency|FLOWISE_CREDENTIAL_ID)$/i

export function embeddingFingerprint(embeddings) {
    if (!embeddings) return ''
    const inputs = Object.fromEntries(Object.entries(embeddings.inputs || {}).filter(([key]) => !NON_VECTOR_INPUTS.test(key)))
    return crypto
        .createHash('sha256')
        .update(stableStringify({ node: embeddings.nodeName, inputs }))
        .digest('hex')
        .slice(0, 16)
}

export function storeFingerprint(store, pipelineName) {
    if (!store) return ''
    const inputs = { ...(store.inputs || {}) }
    delete inputs.topK
    if (store.nodeName === LOCAL_STORE && !inputs.collection) inputs.collection = pipelineName
    return crypto
        .createHash('sha256')
        .update(stableStringify({ node: store.nodeName, inputs, credential: store.credential || null }))
        .digest('hex')
        .slice(0, 16)
}
