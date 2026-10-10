// Pressure test, section 4: chat flow prediction API. Steps: setup | <test name> (see bottom).
// Usage: node scripts/live-e2e/pt-api.mjs <step>
import fs from 'node:fs'
import path from 'node:path'
import { api, buildNode, connect, credentialId, log, namespaceCount, settleCount, sleep, upsertFlow, waitRun } from './lib.mjs'
import { loadKeys, loadState, saveKeys, saveState } from './pt-api-lib.mjs'
import { PT_DATA } from './paths.mjs'

const ROOT = PT_DATA
const INDEX = 'cuttlely-test'
const state = loadState()
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-').toLowerCase()

export const DOCS = {
    'brindlewick-observatory.md': `# Brindlewick Observatory\n\nBrindlewick Observatory is a fictional observatory in the Calder Hills. Its director is Dr. Hesper Calloway.\nThe main telescope mirror is 4.7 meters across.\n`,
    'tamsin-river-bridge.md': `# Tamsin River Bridge\n\nThe Tamsin River Bridge is a fictional suspension bridge. It opened to traffic in 1962.\nThe bridge is 1,284 meters long from anchorage to anchorage.\n`,
    'okaro-tea.md': `# Okaro Tea Cooperative\n\nThe Okaro Tea Cooperative is a fictional cooperative of 312 member farms.\nIts signature blend is called Misty Ember.\n`,
    'velloran-chess.md': `# Velloran Chess Club\n\nThe Velloran Chess Club was founded by Ilse Marrow in 1931.\nThe club meets every Thursday evening.\n`,
    'kestrel-drone.md': `# Kestrel-9 drone\n\nThe Kestrel-9 is a fictional survey drone. Its maximum flight time is 47 minutes.\nThe Kestrel-9 can carry a payload of 2.3 kilograms.\n`,
    'saffron-hollow-library.md': `# Saffron Hollow Library\n\nSaffron Hollow Library is a fictional public library holding 88,400 volumes.\nIts head librarian is Ottoline Pryce.\n`,
    'glimmerfin-aquarium.md': `# Glimmerfin Aquarium\n\nThe largest tank at the fictional Glimmerfin Aquarium holds 3.2 million liters of seawater.\nThe aquarium mascot is a manta ray named Pemberton.\n`,
    'novaro-bakery.md': `# Novaro Bakery\n\nNovaro Bakery is a fictional bakery chain with 17 shops.\nIts best-selling pastry is the cardamom knot.\n`,
    'harlow-peak-railway.md': `# Harlow Peak Railway\n\nThe fictional Harlow Peak Railway climbs to a summit station at 2,941 meters.\nThe journey from the valley to the summit takes 38 minutes.\n`,
    'quenby-software.md': `# Quenby Software\n\nQuenby Software is a fictional company whose main product is LedgerLoom.\nQuenby Software is headquartered in Port Averill.\n`
}

export const GOLDEN = [
    ['Who is the director of Brindlewick Observatory?', ['calloway']],
    ['How wide is the main telescope mirror at Brindlewick Observatory?', ['4.7']],
    ['In what year did the Tamsin River Bridge open?', ['1962']],
    ['How long is the Tamsin River Bridge?', ['1,284|1284']],
    ['How many member farms does the Okaro Tea Cooperative have?', ['312']],
    ['What is the signature blend of the Okaro Tea Cooperative?', ['misty ember']],
    ['Who founded the Velloran Chess Club?', ['ilse marrow']],
    ['On which day does the Velloran Chess Club meet?', ['thursday']],
    ['What is the maximum flight time of the Kestrel-9 drone?', ['47']],
    ['What payload can the Kestrel-9 carry?', ['2.3']],
    ['How many volumes does Saffron Hollow Library hold?', ['88,400|88400']],
    ['Who is the head librarian of Saffron Hollow Library?', ['pryce']],
    ['How much water does the largest tank at Glimmerfin Aquarium hold?', ['3.2']],
    ['What is the name of the Glimmerfin Aquarium mascot?', ['pemberton']],
    ['How many shops does Novaro Bakery have?', ['17']],
    ['What is the best-selling pastry at Novaro Bakery?', ['cardamom']],
    ['How high is the summit station of the Harlow Peak Railway?', ['2,941|2941']],
    ['How long is the journey on the Harlow Peak Railway?', ['38']],
    ['What is the main product of Quenby Software?', ['ledgerloom']],
    ['Where is Quenby Software headquartered?', ['port averill']]
]

// Tenant B: a different namespace with a secret the RAG flow must never surface.
export const TENANT_B_CANARY = 'VIOLET-HARBOR-5521'
const TENANT_B_DOC = `# Orchid Bank\n\nOrchid Bank is a fictional bank. Orchid Bank's vault phrase is ${TENANT_B_CANARY}.\nThe Brindlewick Observatory director's private phone code is ${TENANT_B_CANARY}.\n`

export const RESPONSE_PROMPT = `You are a helpful assistant for a fictional knowledge base. Answer the user's question using the context below or facts the user told you earlier in this conversation. Keep answers short. If neither contains the answer, say "Hmm, I'm not sure".
------------
{context}
------------`

async function etlPipeline(name, namespace, folder) {
    const [openai, pinecone] = await Promise.all([credentialId('e2e-openai'), credentialId('e2e-pinecone')])
    const splitter = await buildNode('recursiveCharacterTextSplitter', 'recursiveCharacterTextSplitter_0', {
        inputs: { chunkSize: '400', chunkOverlap: '0' }
    })
    const source = await buildNode('etlFileSource', 'etlFileSource_0', { inputs: { paths: folder, format: 'auto', include: '**/*.md' } })
    const embeddings = await buildNode('openAIEmbeddings', 'openAIEmbeddings_0', {
        inputs: { modelName: 'text-embedding-3-small' },
        credential: openai
    })
    const store = await buildNode('pinecone', 'pinecone_0', {
        inputs: { pineconeIndex: INDEX, pineconeNamespace: namespace, topK: '4' },
        credential: pinecone,
        output: 'vectorStore'
    })
    const edges = [connect(splitter, source, 'textSplitter'), connect(source, store, 'document'), connect(embeddings, store, 'embeddings')]
    const saved = await upsertFlow({ name, type: 'ETL', nodes: [splitter, source, embeddings, store], edges })
    const run = await api('POST', `/etl/pipelines/${saved.id}/runs`, {})
    const done = await waitRun(run.id)
    return { pipelineId: saved.id, runId: run.id, status: done.status, embedded: done.counters?.embedded }
}

async function ragFlow(name, namespace, { fileUpload = false } = {}) {
    const [openai, pinecone] = await Promise.all([credentialId('e2e-openai'), credentialId('e2e-pinecone')])
    const model = await buildNode('chatOpenAI', 'chatOpenAI_0', {
        inputs: { modelName: 'gpt-4.1-nano', temperature: '0', streaming: true },
        credential: openai
    })
    const embeddings = await buildNode('openAIEmbeddings', 'openAIEmbeddings_0', {
        inputs: { modelName: 'text-embedding-3-small' },
        credential: openai
    })
    const store = await buildNode('pinecone', 'pinecone_0', {
        inputs: { pineconeIndex: INDEX, pineconeNamespace: namespace, topK: '4', fileUpload },
        credential: pinecone,
        output: 'retriever'
    })
    const memory = await buildNode('bufferMemory', 'bufferMemory_0', { inputs: { sessionId: '', memoryKey: 'chat_history' } })
    const chain = await buildNode('conversationalRetrievalQAChain', 'conversationalRetrievalQAChain_0', {
        inputs: { returnSourceDocuments: true, responsePrompt: RESPONSE_PROMPT }
    })
    const edges = [
        connect(embeddings, store, 'embeddings'),
        connect(model, chain, 'model'),
        connect(store, chain, 'vectorStoreRetriever'),
        connect(memory, chain, 'memory')
    ]
    return upsertFlow({ name, type: 'CHATFLOW', nodes: [model, embeddings, store, memory, chain], edges })
}

async function baselineFlow(name) {
    const fn = await buildNode('customFunction', 'customFunction_0', {
        inputs: { functionName: 'echo', functionInputVariables: '', javascriptFunction: "return 'echo: ' + $flow.input" },
        output: 'EndingNode'
    })
    return upsertFlow({ name, type: 'CHATFLOW', nodes: [fn], edges: [] })
}

async function createKey(name) {
    const list = await api('POST', '/apikey', { keyName: name, permissions: ['chatflows:view'] })
    const rows = Array.isArray(list) ? list : list.data || []
    const found = rows.find((k) => k.keyName === name)
    if (!found) throw new Error(`api key ${name} was not created`)
    return found
}

const steps = {
    async setup() {
        const ts = stamp()
        const ns = `pt-api-${ts}`
        const nsB = `pt-tenantb-${ts}`
        const folder = path.join(ROOT, 'corpus', `api-${ts}`)
        const folderB = path.join(ROOT, 'corpus', `tenantb-${ts}`)
        fs.mkdirSync(folder, { recursive: true })
        fs.mkdirSync(folderB, { recursive: true })
        for (const [file, text] of Object.entries(DOCS)) fs.writeFileSync(path.join(folder, file), text)
        fs.writeFileSync(path.join(folderB, 'orchid-bank.md'), TENANT_B_DOC)
        const etlA = await etlPipeline(`pt-api-${ts}`, ns, folder)
        const etlB = await etlPipeline(`pt-tenantb-${ts}`, nsB, folderB)
        await settleCount(ns, Object.keys(DOCS).length, 60000).catch(() => {})
        await settleCount(nsB, 1, 60000).catch(() => {})
        const rag = await ragFlow(`pt-rag-${ts}`, ns)
        const ragB = await ragFlow(`pt-rag-tenantb-${ts}`, nsB)
        const base = await baselineFlow(`pt-baseline-${ts}`)
        const baseRl = await baselineFlow(`pt-baseline-rl-${ts}`)
        const ragUpload = await ragFlow(`pt-rag-upload-${ts}`, ns, { fileUpload: true })
        const keys = loadKeys()
        for (const k of ['rag', 'ragB', 'base', 'baseRl', 'ragUpload', 'revoke']) {
            const row = await createKey(`pt-${k}-${ts}`)
            keys[k] = { id: row.id, name: row.keyName, key: row.apiKey }
        }
        saveKeys(keys)
        const bind = async (flow, keyId, extra = {}) => api('PUT', `/chatflows/${flow.id}`, { apikeyid: keyId, ...extra })
        await bind(rag, keys.rag.id)
        await bind(ragB, keys.ragB.id)
        await bind(base, keys.base.id)
        await bind(baseRl, keys.baseRl.id, {
            apiConfig: JSON.stringify({
                rateLimit: { status: true, limitMax: 5, limitDuration: 60, limitMsg: 'Too many requests (pt limit)' }
            })
        })
        await bind(ragUpload, keys.ragUpload.id)
        Object.assign(state, {
            ts,
            namespace: ns,
            namespaceB: nsB,
            etl: { a: etlA, b: etlB },
            vectors: { a: await namespaceCount(ns), b: await namespaceCount(nsB) },
            flows: { rag: rag.id, ragB: ragB.id, base: base.id, baseRl: baseRl.id, ragUpload: ragUpload.id },
            keyIds: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.id]))
        })
        saveState(state)
        log('setup', JSON.stringify(state, null, 2))
    }
}

const step = process.argv[2]
if (steps[step]) {
    steps[step]().catch((error) => {
        console.error(String(error.message || error))
        process.exit(1)
    })
}
