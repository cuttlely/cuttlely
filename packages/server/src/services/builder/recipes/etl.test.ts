import { sampleTemplates } from '../../marketplaces/sampleTemplates'
import { templateClearanceFailures } from '../../marketplaces/templateLayout'
import { planProblems } from '../core'
import { Plan } from '../plan'
import { RecipeContext } from '../recipe'
import { realParts } from '../testRealParts'
import { etlExamples, etlParts, etlRecipe, etlSampleAsPlan } from './etl'

const samples = sampleTemplates().filter((template) => template.type === 'ETL')
const sampleFlows = samples.map((template) => ({ name: template.templateName, flow: JSON.parse(template.flowData) }))
const names = new Set<string>([
    'etlFileSource',
    'etlRepoSource',
    'etlTransform',
    'etlLocalVectorStore',
    'localHashEmbeddings',
    'pinecone',
    'openAIEmbeddings',
    'vectaraUpload',
    'pdfFile'
])
for (const { flow } of sampleFlows) for (const node of flow.nodes) names.add(node.data.name)
const componentNodes = realParts([...names])
const ctx: RecipeContext = {
    componentNodes,
    chatModel: { name: 'chatOpenAI', credential: 'cred-1' },
    credentials: [{ id: 'cred-1', name: 'OpenAI demo', credentialName: 'openAIApi' }],
    credentialLabels: { pineconeApi: 'Pinecone API', openAIApi: 'OpenAI API' }
}
const searches = ['tents', 'sleeping bags', 'stoves']

// Samples become plans the way examples do: placeholders as server paths, bare include globs written out.
const asPlan = (flow: any): Plan => {
    const plan = etlSampleAsPlan(flow, ['format', 'textColumns', 'idColumn', 'metadataColumns', 'include', 'chunkSize', 'collection'])
    for (const node of plan.nodes) {
        if (node.name === 'etlFileSource')
            node.inputs = { ...node.inputs, paths: node.inputs?.format === 'csv' ? '/data/outdoor-catalog.csv' : '/data/bakery-handbook' }
        if (node.name === 'etlRepoSource') node.inputs = { ...node.inputs, repoPath: '/srv/repo' }
    }
    return { ...plan, starterQuestions: searches }
}

const line = (extra: Partial<Plan> = {}): Plan => ({
    nodes: [
        { id: 'split', name: 'recursiveCharacterTextSplitter', inputs: { chunkSize: 500 } },
        {
            id: 'src',
            name: 'etlFileSource',
            inputs: { paths: '/data/catalog.csv', format: 'csv', idColumn: 'sku', textColumns: 'name, description' }
        },
        { id: 'emb', name: 'localHashEmbeddings' },
        { id: 'store', name: 'etlLocalVectorStore', inputs: { collection: 'catalog' } },
        ...(extra.nodes || [])
    ],
    edges: [
        { from: 'split', to: 'src', input: 'textSplitter' },
        { from: 'src', to: 'store', input: 'document' },
        { from: 'emb', to: 'store', input: 'embeddings' },
        ...(extra.edges || [])
    ],
    starterQuestions: searches
})

describe('pipeline recipe', () => {
    it('finds the 3 bundled pipelines', () => expect(samples).toHaveLength(3))

    it.each(sampleFlows.map((s) => [s.name, s.flow]))('the bundled "%s" passes the check and rebuilds clear', (_name, flow) => {
        const plan = asPlan(flow)
        expect(planProblems(etlRecipe, plan, ctx)).toEqual([])
        const built = etlRecipe.materialize(plan, ctx)
        const boxes = built.nodes.map((n) => ({ id: n.id, name: n.data.name, x: n.position.x, y: n.position.y, w: n.width, h: n.height }))
        expect(templateClearanceFailures(boxes)).toEqual([])
        const store = built.nodes.find((n) => n.data.name === 'etlLocalVectorStore')
        for (const n of built.nodes) if (n !== store) expect(n.position.x).toBeLessThan(store.position.x)
        expect(store.data.inputs.embeddings).toMatch(/^{{localHashEmbeddings_0\.data\.instance}}$/)
    })

    it('offers sources, splitters, embeddings and stores, not chat models or Vectara Upload', () => {
        const offered = etlParts(componentNodes).map((p) => p.name)
        expect(offered).toEqual(
            expect.arrayContaining(['etlFileSource', 'etlRepoSource', 'etlTransform', 'etlLocalVectorStore', 'localHashEmbeddings'])
        )
        expect(offered).not.toContain('vectaraUpload')
    })

    it('tells the model that a bare include glob matches in every folder', () => {
        const rule = etlRecipe.rules.find((text) => text.includes('"include" globs'))
        expect(rule).toContain('/README.md')
    })

    it('learns from the closest bundled pipeline, with its paths shown as server paths', () => {
        const examples = etlExamples('index the product catalog csv', ctx)
        expect(examples).toHaveLength(2)
        expect(examples[0].title).toMatch(/Outdoor/)
        const source = examples[0].plan.nodes.find((n) => n.name === 'etlFileSource')
        expect(source?.inputs?.paths).toBe('/srv/cuttlely/samples/etl/data/outdoor-catalog.csv')
        for (const example of examples) expect(etlRecipe.check({ ...example.plan, starterQuestions: searches }, ctx)).toEqual([])
    })

    it('asks for a slash in each include glob, and shows the sample globs written out', () => {
        const handbook = etlExamples('index the repository handbook', ctx).find((e) => e.plan.nodes.some((n) => n.name === 'etlRepoSource'))
        const include = handbook?.plan.nodes.find((n) => n.name === 'etlRepoSource')?.inputs?.include
        expect(include).toMatch(/^\*\*\/README\.md, \*\*\/AGENTS\.md, docs\/\*\*\/\*\.md/)
        const repo: Plan = {
            ...line(),
            nodes: line().nodes.map((n) =>
                n.name === 'etlFileSource'
                    ? { id: n.id, name: 'etlRepoSource', inputs: { repoPath: '/srv/repo', include: 'README.md, docs/*.md' } }
                    : n
            )
        }
        const problems = etlRecipe.check(repo, ctx).join('\n')
        expect(problems).toMatch(/include "README.md" has no slash/)
        expect(problems).not.toMatch(/docs\/\*\.md/)
        repo.nodes.find((n) => n.name === 'etlRepoSource')!.inputs!.include = '/README.md, docs/*.md'
        expect(etlRecipe.check(repo, ctx).join('\n')).not.toMatch(/has no slash/)
    })

    it('builds a local line with settings from the description', () => {
        const plan = line()
        expect(etlRecipe.check(plan, ctx)).toEqual([])
        const built = etlRecipe.materialize(plan, ctx)
        const source = built.nodes.find((n) => n.data.name === 'etlFileSource')
        expect(source.data.inputs).toMatchObject({ paths: '/data/catalog.csv', format: 'csv', idColumn: 'sku' })
        expect(source.data.inputs.textSplitter).toBe('{{recursiveCharacterTextSplitter_0.data.instance}}')
        expect(built.missingCredentials).toEqual([])
    })

    it('lists pipeline problems in plain words', () => {
        const noId = line()
        delete noId.nodes[1].inputs!.idColumn
        expect(etlRecipe.check(noId, ctx).join('\n')).toMatch(/needs "inputs.idColumn"/)
        const twoStores = line({
            nodes: [{ id: 'store2', name: 'etlLocalVectorStore' }],
            edges: [{ from: 'emb', to: 'store2', input: 'embeddings' }]
        })
        expect(etlRecipe.check(twoStores, ctx).join('\n')).toMatch(/exactly one vector store; this plan has 2/)
        const noPath = line()
        noPath.nodes[1].inputs = { format: 'text' }
        expect(etlRecipe.check(noPath, ctx).join('\n')).toMatch(/needs "inputs.paths"/)
        const relative = line()
        relative.nodes[1].inputs!.paths = 'data/catalog.csv'
        expect(etlRecipe.check(relative, ctx).join('\n')).toMatch(/"data\/catalog.csv" is not absolute/)
        const stray = line({ nodes: [{ id: 'extra', name: 'markdownTextSplitter' }] })
        expect(etlRecipe.check(stray, ctx).join('\n')).toMatch(/does not reach the store/)
        const badCollection = line()
        badCollection.nodes[3].inputs = { collection: 'My Catalog!' }
        expect(etlRecipe.check(badCollection, ctx).join('\n')).toMatch(/collection/)
    })

    it('lists a named store credential that is missing', () => {
        const plan = line()
        plan.nodes[3] = { id: 'store', name: 'pinecone', inputs: { collection: 'catalog' } }
        const built = etlRecipe.materialize(plan, ctx)
        expect(built.missingCredentials).toEqual([{ part: 'Pinecone', credential: 'Pinecone API' }])
    })
})
