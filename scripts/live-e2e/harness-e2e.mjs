// Live harness RAG steps: a harness with a retrieval specialist (xAI model + ETL Retriever over the Pinecone
// pipeline) and an editor specialist (OpenAI), an OpenAI chief, and a chat flow that calls the harness by name.
// Usage: node scripts/live-e2e/harness-e2e.mjs build | ask
import fs from 'node:fs'
import { api, buildNode, connect, credentialId, log, upsertFlow } from './lib.mjs'
import { e2e } from './paths.mjs'

const STATE = process.env.E2E_STATE || e2e('state.json')
const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2))

const CHIEF_MODEL = process.env.E2E_CHIEF_MODEL || 'gpt-4.1-mini'
const XAI_MODEL = process.env.E2E_XAI_MODEL || 'grok-4.20-0309-non-reasoning'

const CHIEF_INSTRUCTIONS = [
    'Always route every question to both the librarian and the editor.',
    'Write the final answer only from the passages the librarian returned. Never use outside knowledge.',
    'After each fact, cite the source file name in square brackets, for example [aurora-station.md].',
    'If the passages do not contain the answer, reply exactly: "The knowledge base has no information about that." and cite nothing.'
].join(' ')

const LIBRARIAN = [
    'You look things up in the knowledge base with your search tool. Always call the tool with a short query built from the task.',
    'Return the matching passages verbatim with their source file paths. Do not add facts that are not in the passages.'
].join(' ')

const EDITOR = [
    'You are the answer editor. You know no facts about the knowledge base and must never state or guess any.',
    'For the task, list in at most three short bullets which facts the final answer must contain, and remind that every fact needs its source file in brackets',
    'and that a question the passages cannot answer gets "The knowledge base has no information about that."'
].join(' ')

async function harnessFlow({ name, pipeline, retrieverMode = 'etl' }) {
    const [openai, xai] = await Promise.all([credentialId('e2e-openai'), credentialId('e2e-xai')])
    const chiefModel = await buildNode('chatOpenAI', 'chatOpenAI_0', {
        inputs: { modelName: CHIEF_MODEL, temperature: '0' },
        credential: openai,
        position: { x: 0, y: 0 }
    })
    const editorModel = await buildNode('chatOpenAI', 'chatOpenAI_1', {
        inputs: { modelName: CHIEF_MODEL, temperature: '0' },
        credential: openai,
        position: { x: 0, y: 700 }
    })
    const librarianModel = await buildNode('chatXAI', 'chatXAI_0', {
        inputs: { modelName: XAI_MODEL, temperature: '0' },
        credential: xai,
        position: { x: 0, y: 1400 }
    })
    const retriever = await buildNode('etlRetriever', 'etlRetriever_0', {
        inputs: {
            pipeline,
            topK: '4',
            toolName: 'search_knowledge_base',
            toolDescription:
                'Searches the e2e knowledge base (markdown docs and a JSONL feed indexed in Pinecone). Returns passages with their source file paths.'
        },
        output: 'tool',
        position: { x: 400, y: 1400 }
    })
    const librarian = await buildNode('harnessSpecialist', 'harnessSpecialist_0', {
        inputs: { specialistName: 'librarian', instructions: LIBRARIAN },
        position: { x: 800, y: 1000 }
    })
    const editor = await buildNode('harnessSpecialist', 'harnessSpecialist_1', {
        inputs: { specialistName: 'editor', instructions: EDITOR },
        position: { x: 800, y: 400 }
    })
    const chief = await buildNode('harnessChief', 'harnessChief_0', {
        inputs: { instructions: CHIEF_INSTRUCTIONS },
        position: { x: 1200, y: 400 }
    })
    const nodes = [chiefModel, editorModel, librarianModel, retriever, librarian, editor, chief]
    const edges = [
        connect(chiefModel, chief, 'chatModel'),
        connect(editorModel, editor, 'chatModel'),
        connect(librarianModel, librarian, 'chatModel'),
        connect(retriever, librarian, 'attached'),
        connect(librarian, chief, 'specialists'),
        connect(editor, chief, 'specialists')
    ]
    return { name, type: 'HARNESS', nodes, edges, retrieverMode }
}

const QUESTIONS = [
    {
        id: 'aurora',
        q: 'What is the access code for Aurora Station, and how many researchers live there in winter?',
        must: ['AUR-7731', '43'],
        source: 'aurora-station.md'
    },
    {
        id: 'updated-ferry',
        q: 'How often does the Quill Ferry depart Tessaly, what is its flagship vessel, and what does a one-way adult ticket cost?',
        must: ['70', 'Copper Lantern', '16.80'],
        mustNot: ['95 minutes', 'Saltgrass', '14.25'],
        source: 'quill-ferry.md'
    },
    {
        id: 'added-observatory',
        q: 'Who directs Brightwater Observatory, and how large is the Iris Array mirror?',
        must: ['Lindqvist-Oduya', '7.4'],
        source: 'brightwater-observatory.md'
    },
    {
        id: 'jsonl-feed',
        q: 'Who keeps the Harbor Lantern lighthouse and what is its beam code?',
        must: ['Wendeline Osgood', 'HL-3307'],
        source: 'harbor-feed.jsonl'
    },
    {
        id: 'deleted-bakery',
        q: 'Who owns Marrow Lane Bakery, and how many Cinder Rye loaves does it sell each Saturday?',
        must: ['no information'],
        mustNot: ['Ottoline', 'Brashear', '312', 'Gustavo', 'smoked salt'],
        source: null
    }
]

const steps = {
    async build() {
        const name = `e2e-rag-team-${state.ts}`
        const flow = await harnessFlow({ name, pipeline: state.pipelineName })
        const saved = await upsertFlow(flow)
        const harness = await api('GET', `/harnesses/${name}`)
        const chatNode = await buildNode('harness', 'harness_0', { inputs: { harnessName: name, returnDirect: true } })
        const chat = await upsertFlow({ name: `e2e-ask-${state.ts}`, type: 'CHATFLOW', nodes: [chatNode], edges: [] })
        state.harness = { name, canvasId: saved.id, chatflowId: chat.id }
        save()
        log(
            'harness saved:',
            JSON.stringify(
                {
                    name,
                    canvasId: saved.id,
                    chatflowId: chat.id,
                    chief: harness.chief?.model,
                    specialists: (harness.specialists || []).map((s) => ({
                        name: s.name,
                        model: s.model,
                        modules: (s.modules || []).map((m) => m.nodeName)
                    }))
                },
                null,
                2
            )
        )
    },
    async ask() {
        const only = process.argv[3]
        const results = []
        for (const item of QUESTIONS.filter((x) => !only || x.id === only)) {
            const started = Date.now()
            let reply
            try {
                reply = await api('POST', `/prediction/${state.harness.chatflowId}`, {
                    question: item.q,
                    chatId: `e2e-${state.ts}-${item.id}-${Date.now()}`
                })
            } catch (error) {
                reply = { error: error.message }
            }
            const text = String(reply?.text ?? reply?.error ?? '')
            const lower = text.toLowerCase()
            const missing = item.must.filter((m) => !lower.includes(m.toLowerCase()))
            const forbidden = (item.mustNot || []).filter((m) => lower.includes(m.toLowerCase()))
            const cited = item.source ? lower.includes(item.source.toLowerCase()) : true
            const pass = !reply?.error && missing.length === 0 && forbidden.length === 0 && cited
            results.push({
                id: item.id,
                question: item.q,
                answer: text,
                ms: Date.now() - started,
                missing,
                forbidden,
                cited,
                pass,
                agents: reply?.agentReasoning || reply?.usedTools || undefined
            })
            log(`${pass ? 'PASS' : 'FAIL'} ${item.id} (${Date.now() - started} ms)\nQ: ${item.q}\nA: ${text}\n`)
        }
        state.evidence = state.evidence || {}
        state.evidence[`harnessQA${process.env.E2E_QA_LABEL ? `-${process.env.E2E_QA_LABEL}` : ''}`] = results
        save()
        if (results.some((r) => !r.pass)) process.exitCode = 1
    }
}

await steps[process.argv[2]]()
