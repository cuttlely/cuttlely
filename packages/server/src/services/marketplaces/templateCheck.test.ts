import { BundledCanvas, CanvasKind, bundledCanvases, canvasProblems } from './templateCheck'
import { loadNodeOutputNames, loadTemplateNodeSpecs } from './templateLayout'

const nodeByName = loadTemplateNodeSpecs()
const outputNames = loadNodeOutputNames()
const canvases = bundledCanvases()

const problemsOf = (canvas: BundledCanvas) => canvasProblems(canvas, nodeByName, outputNames)

describe('every bundled canvas opens', () => {
    it('finds the Templates page files and the samples', () => {
        const kinds = new Set(canvases.map((canvas) => canvas.kind))
        expect([...kinds].sort()).toEqual(['agentflow', 'chatflow', 'harness', 'pipeline', 'workflow'])
        expect(canvases.some((canvas) => canvas.file.startsWith('samples/chatflows/'))).toBe(true)
        expect(canvases.length).toBeGreaterThanOrEqual(59)
    })

    it.each(canvases.map((canvas) => [canvas.file, canvas] as const))('%s draws, keeps cards apart and connects', (_file, canvas) => {
        expect(problemsOf(canvas)).toEqual([])
    })
})

// Small made-up canvases, each broken one way, so the check is known to catch it.
const card = (id: string, name: string, x: number, y: number, extra: Record<string, any> = {}) => ({
    id,
    type: 'customNode',
    position: { x, y },
    width: 300,
    height: 400,
    data: {
        id,
        name,
        label: name,
        inputAnchors: [{ id: `${id}-input-model-BaseChatModel`, name: 'model' }],
        inputParams: [],
        outputAnchors: [{ id: `${id}-output-${name}-${name}|Runnable`, name }]
    },
    ...extra
})
const link = (source: string, target: string, sourceName: string) => ({
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle: `${source}-output-${sourceName}-${sourceName}|Runnable`,
    targetHandle: `${target}-input-model-BaseChatModel`
})
type MadeCanvas = BundledCanvas & { flow: { nodes: any[]; edges: any[] } }
const made = (nodes: any[], edges: any[] = [], kind: CanvasKind = 'chatflow'): MadeCanvas => ({
    kind,
    file: 'made-up.json',
    name: 'Made up',
    flow: { nodes, edges }
})
const good = () =>
    made(
        [card('chatOpenAI_0', 'chatOpenAI', 0, 0), card('llmChain_0', 'llmChain', 500, 0)],
        [link('chatOpenAI_0', 'llmChain_0', 'chatOpenAI')]
    )

describe('the template open check catches', () => {
    it('nothing on a sound canvas', () => {
        expect(problemsOf(good())).toEqual([])
    })

    it('a part this build does not have', () => {
        const canvas = good()
        canvas.flow.nodes[0].data.name = 'retiredModel'
        expect(problemsOf(canvas).join('\n')).toMatch(/uses "retiredModel", a part this build does not have/)
    })

    it('a connection whose end is not on the canvas', () => {
        const canvas = good()
        canvas.flow.edges.push(link('chatOpenAI_0', 'gone_0', 'chatOpenAI'))
        expect(problemsOf(canvas).join('\n')).toMatch(/ends at gone_0, which is not on the canvas/)
    })

    it('a connection to a plug point the card does not have', () => {
        const canvas = good()
        canvas.flow.edges[0].targetHandle = 'llmChain_0-input-memory-BaseMemory'
        expect(problemsOf(canvas).join('\n')).toMatch(/lands on a plug point llmChain_0-input-memory-BaseMemory/)
        canvas.flow.edges[0].targetHandle = 'llmChain_0-input-model-BaseChatModel'
        canvas.flow.edges[0].sourceHandle = 'chatOpenAI_0-output-retriever-Runnable'
        expect(problemsOf(canvas).join('\n')).toMatch(/leaves from a plug point chatOpenAI_0-output-retriever/)
    })

    it('cards that cover each other', () => {
        const canvas = good()
        canvas.flow.nodes[1].position = { x: 200, y: 300 }
        expect(problemsOf(canvas)).toEqual(['made-up.json: cards chatOpenAI_0 and llmChain_0 overlap'])
    })

    it('a card type the canvas does not draw, a missing position and a repeated id', () => {
        const canvas = good()
        canvas.flow.nodes[0].type = 'agentFlow'
        canvas.flow.nodes[1].position = { x: 'left' }
        canvas.flow.nodes.push(card('llmChain_0', 'llmChain', 1000, 0))
        const text = problemsOf(canvas).join('\n')
        expect(text).toMatch(/card chatOpenAI_0 has card type "agentFlow", which this canvas does not draw/)
        expect(text).toMatch(/card llmChain_0 has no position/)
        expect(text).toMatch(/card llmChain_0 appears twice/)
    })

    it('a workflow card inside a block that is missing, and overlap inside a block', () => {
        const step = (id: string, x: number, parentNode?: string) => ({
            id,
            type: 'agentFlow',
            position: { x, y: 0 },
            width: 200,
            height: 60,
            parentNode,
            data: { id, name: 'llmAgentflow', label: 'LLM', outputAnchors: [{ id: `${id}-output-llmAgentflow` }] }
        })
        const block = { ...step('iterationAgentflow_0', 0), type: 'iteration', width: 600, height: 300 }
        block.data = { ...block.data, name: 'iterationAgentflow', label: 'Iteration' }
        const inside = made(
            [block, step('llmAgentflow_0', 20, 'iterationAgentflow_0'), step('llmAgentflow_1', 320, 'iterationAgentflow_0')],
            [],
            'workflow'
        )
        // A card inside its block is not an overlap, and a workflow card takes connections on its own id.
        inside.flow.edges.push({
            id: 'e',
            source: 'llmAgentflow_0',
            target: 'llmAgentflow_1',
            sourceHandle: 'llmAgentflow_0-output-llmAgentflow',
            targetHandle: 'llmAgentflow_1'
        })
        expect(problemsOf(inside)).toEqual([])
        inside.flow.nodes[2].position = { x: 100, y: 10 }
        inside.flow.nodes.push(step('llmAgentflow_2', 2000, 'iterationAgentflow_9'))
        const text = problemsOf(inside).join('\n')
        expect(text).toMatch(/cards llmAgentflow_0 and llmAgentflow_1 overlap/)
        expect(text).toMatch(/card llmAgentflow_2 sits inside iterationAgentflow_9, which is not on the canvas/)
    })

    it('a sample that stores inputs only, using the outputs its node declares', () => {
        const sample = made(
            [
                {
                    id: 'plainText_0',
                    type: 'customNode',
                    position: { x: 0, y: 0 },
                    data: { id: 'plainText_0', name: 'plainText', label: 'Plain Text', inputs: {} }
                },
                {
                    id: 'memoryVectorStore_0',
                    type: 'customNode',
                    position: { x: 600, y: 0 },
                    data: { id: 'memoryVectorStore_0', name: 'memoryVectorStore', label: 'In-Memory', inputs: {} }
                }
            ],
            [
                {
                    id: 'p',
                    source: 'plainText_0',
                    target: 'memoryVectorStore_0',
                    sourceHandle: 'plainText_0-output-document-Document|json',
                    targetHandle: 'memoryVectorStore_0-input-document'
                }
            ],
            'harness'
        )
        expect(problemsOf(sample)).toEqual([])
        sample.flow.edges[0].sourceHandle = 'plainText_0-output-pages-Document'
        expect(problemsOf(sample).join('\n')).toMatch(/leaves from a plug point plainText_0-output-pages-Document/)
    })

    it('an output a node replaced later in its source (Meilisearch sets its outputs twice; the last one counts)', () => {
        expect(outputNames('meilisearch')).toEqual(['retriever'])
        const sample = made(
            [
                {
                    id: 'meilisearch_0',
                    type: 'customNode',
                    position: { x: 0, y: 0 },
                    data: { id: 'meilisearch_0', name: 'meilisearch', label: 'Meilisearch', inputs: {} }
                },
                {
                    id: 'conversationalRetrievalQAChain_0',
                    type: 'customNode',
                    position: { x: 600, y: 0 },
                    data: { id: 'conversationalRetrievalQAChain_0', name: 'conversationalRetrievalQAChain', label: 'QA', inputs: {} }
                }
            ],
            [
                {
                    id: 'm',
                    source: 'meilisearch_0',
                    target: 'conversationalRetrievalQAChain_0',
                    sourceHandle: 'meilisearch_0-output-retriever-BaseRetriever',
                    targetHandle: 'conversationalRetrievalQAChain_0-input-vectorStoreRetriever'
                }
            ],
            'harness'
        )
        expect(problemsOf(sample)).toEqual([])
        sample.flow.edges[0].sourceHandle = 'meilisearch_0-output-MeilisearchRetriever-BaseRetriever'
        expect(problemsOf(sample).join('\n')).toMatch(/leaves from a plug point meilisearch_0-output-MeilisearchRetriever/)
    })
})
