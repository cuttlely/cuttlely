import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { callPrepared, prepareModule } from '../packages/harness/bridge.mjs'
import { emptyNativeAnalystCard, prepareEmptyAnalystCard } from '../packages/harness/runtime/native-analyst.mjs'
import { localMemoryStoreBinding, supportsNativeCanvasBinding } from './native-canvas-bindings.mjs'

const require = createRequire(import.meta.url)
const nodes = {
    memoryVectorStore: '../packages/node-pack-vector-stores/dist/nodes/vectorstores/InMemory/InMemoryVectorStore.js',
    localHashEmbeddings: '../packages/components/dist/nodes/embeddings/LocalHashEmbedding/LocalHashEmbedding.js',
    plainText: '../packages/components/dist/nodes/documentloaders/PlainText/PlainText.js'
}
function store(source) {
    const docs = ['rutabaga', 'violet'].map((text, i) => ({
        nodeName: 'plainText',
        nodeId: 'document_' + i,
        outputs: { output: 'document' },
        inputs: { text, metadata: JSON.stringify({ source: source + ' ' + i }) }
    }))
    return {
        nodeName: 'memoryVectorStore',
        nodeId: 'store',
        inputs: { topK: '2' },
        outputs: { output: 'retriever' },
        upstream: { document: docs, embeddings: { nodeName: 'localHashEmbeddings', nodeId: 'hash', inputs: { dimensions: 384 } } }
    }
}

test('the released nodes preserve the rank, two exact scores and saved source labels across isolated turns with identical node IDs', async () => {
    for (const owner of ['North', 'South']) {
        const binding = store(owner)
        assert.ok(supportsNativeCanvasBinding(binding))
        const prepared = await prepareModule(binding, '', {
            flowOptions: { appDataSource: {}, workspaceId: owner },
            nodeCache: new Map(),
            loadNode: (name) => require(nodes[name]).nodeClass
        })
        const scored = await prepared.ready.vectorStore.similaritySearchWithScore('violet', 2)
        assert.deepEqual(
            scored.map(([doc, score]) => [doc.pageContent, doc.metadata.source, score]),
            [
                ['violet', owner + ' 1', 1],
                ['rutabaga', owner + ' 0', 0]
            ]
        )
        const actual = await callPrepared(prepared, 'violet')
        assert.deepEqual(
            actual.map((doc) => [doc.pageContent, doc.metadata.source]),
            [
                ['violet', owner + ' 1'],
                ['rutabaga', owner + ' 0']
            ]
        )
    }
})

test('only bounded plain text and local hash embeddings can initialize the memory index', () => {
    for (const change of [
        (b) => (b.inputs.topK = 65),
        (b) => (b.inputs.topK = true),
        (b) => (b.credential = 'saved'),
        (b) => (b.nodeData = { other: 'changed' }),
        (b) => (b.upstream.embeddings.nodeName = 'openAIEmbeddings'),
        (b) => (b.upstream.embeddings.credential = false),
        (b) => (b.upstream.embeddings.inputs.dimensions = 5000),
        (b) => (b.upstream.embeddings.inputs.basePath = 'remote'),
        (b) => (b.upstream.document[0].nodeName = 'fileLoader'),
        (b) => (b.upstream.document[0].credential = 'other'),
        (b) => (b.upstream.document[0].upstream = { textSplitter: {} }),
        (b) => (b.upstream.document[0].inputs.metadata = { source: '/local/path' }),
        (b) => (b.upstream.document[0].inputs.metadata = { source: 'https://example.invalid' }),
        (b) => (b.upstream.document[0].inputs.metadata = { extra: true }),
        (b) => (b.upstream.document = Array(65).fill(b.upstream.document[0])),
        (b) => (b.upstream.document[0].inputs.text = 'ü'.repeat(524288)),
        (b) => (b.outputs.output = 'vectorStore')
    ]) {
        const binding = store('North')
        change(binding)
        assert.equal(supportsNativeCanvasBinding(binding), false)
    }
    const binding = store('South')
    binding.outputs.output = 'vectorStore'
    assert.ok(localMemoryStoreBinding(binding, 'vectorStore'))
})

test('an unconfigured no-action Analyst card preserves ownership checks and never replaces an explicit destination or selected action', async (t) => {
    const old = process.env.CUTTLELY_POSTGRES_URL
    t.after(() => {
        if (old === undefined) delete process.env.CUTTLELY_POSTGRES_URL
        else process.env.CUTTLELY_POSTGRES_URL = old
    })
    delete process.env.CUTTLELY_POSTGRES_URL
    const card = { nodeName: 'postgreSQLMCP', category: 'Tools (MCP)', inputs: { allowPinDefinitions: false } }
    assert.ok(emptyNativeAnalystCard(card))
    const context = { chatId: 'same', roster: { workspaceId: 'owned' }, moduleOptions: { flowOptions: { workspaceId: 'another' } } }
    await assert.rejects(
        prepareEmptyAnalystCard(context, card, () => {}),
        /workspace does not match/
    )
    await assert.rejects(
        prepareEmptyAnalystCard(context, card, () => {
            throw Error('turn revoked')
        }),
        /turn revoked/
    )
    for (const replacement of [
        { inputs: { ...card.inputs, postgresUrl: 'explicit' } },
        { inputs: { ...card.inputs, mcpActions: ['query'] } },
        { inputs: { ...card.inputs, pinnedQueries: '[]' } },
        { inputs: { allowPinDefinitions: true } },
        { nodeData: {} },
        { credential: 'saved' },
        { credential: false },
        { upstream: { postgresUrl: {} } }
    ])
        assert.equal(emptyNativeAnalystCard({ ...card, ...replacement }), false)
    process.env.CUTTLELY_POSTGRES_URL = 'explicit'
    assert.equal(emptyNativeAnalystCard(card), false)
})
