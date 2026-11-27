import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import envelope from './credential-envelope.cjs'
import { supportsNativeCanvasBinding } from './native-canvas-bindings.mjs'

function retriever() {
    return {
        nodeName: 'retrieverTool',
        nodeId: 'retriever_0',
        inputs: { name: 'catalog', description: 'Search the saved catalog', returnSourceDocuments: true },
        upstream: {
            retriever: {
                nodeName: 'pinecone',
                nodeId: 'pinecone_0',
                credential: 'pinecone-key',
                inputs: { pineconeIndex: 'catalog', pineconeNamespace: 'qa', topK: 2, fileUpload: true },
                outputs: { output: 'retriever' },
                upstream: {
                    embeddings: {
                        nodeName: 'openAIEmbeddings',
                        nodeId: 'embeddings_0',
                        credential: 'embeddings-key',
                        inputs: { modelName: 'text-embedding-3-small' }
                    }
                }
            }
        }
    }
}

test('native canvas preflight accepts the saved clock and retrieval graph and refuses unsupported dependencies before initialization', () => {
    assert.equal(supportsNativeCanvasBinding({ nodeName: 'currentDateTime', inputs: { timezone: 'Australia/Sydney' } }), true)
    assert.equal(supportsNativeCanvasBinding({ nodeName: 'currentDateTime', upstream: { timezone: {} } }), false)
    assert.equal(supportsNativeCanvasBinding(retriever()), true)
    const page = {
        nodeName: 'webBrowser',
        inputs: { readSource: true },
        upstream: { model: { nodeName: 'chatOpenAI' }, embeddings: { nodeName: 'openAIEmbeddings' } }
    }
    assert.equal(supportsNativeCanvasBinding(page), true)
    for (const value of [false, undefined, 'true'])
        assert.equal(supportsNativeCanvasBinding({ ...page, inputs: { readSource: value } }), false)
    assert.equal(supportsNativeCanvasBinding({ ...page, upstream: { ...page.upstream, other: {} } }), false)
    assert.equal(supportsNativeCanvasBinding({ ...page, upstream: { ...page.upstream, model: { nodeName: 'customFunction' } } }), false)
    const search = { nodeName: 'serpAPI', credential: 'search-key' }
    assert.equal(supportsNativeCanvasBinding(search), true)
    assert.equal(supportsNativeCanvasBinding({ ...search, credential: '' }), false)
    assert.equal(supportsNativeCanvasBinding({ ...search, inputs: { baseUrl: 'https://example.invalid' } }), false)
    assert.equal(supportsNativeCanvasBinding({ ...search, inputs: { serpApiKey: 'inline' } }), false)
    for (const alter of [
        (b) => {
            b.upstream.retriever.nodeName = 'customFunction'
        },
        (b) => {
            b.upstream.retriever.outputs.output = 'vectorStore'
        },
        (b) => {
            b.upstream.retriever.upstream.document = { nodeName: 'fileLoader' }
        },
        (b) => {
            b.upstream.retriever.credential = ''
        },
        (b) => {
            b.upstream.retriever.upstream.embeddings.inputs.basepath = 'https://example.invalid'
        },
        (b) => {
            b.upstream.retriever.upstream.embeddings.inputs.credentialId = 'different-key'
        },
        (b) => {
            b.upstream.retriever.upstream.embeddings.nodeData = { credential: 'other-key' }
        },
        (b) => {
            b.upstream.retriever.upstream.embeddings = [b.upstream.retriever.upstream.embeddings]
        },
        (b) => {
            b.inputs.retrieverToolMetadataFilter = { status: 'open' }
        }
    ]) {
        const b = retriever()
        alter(b)
        assert.equal(supportsNativeCanvasBinding(b), false)
    }
})

test('native delegation uses the saved clock, search, and vector credentials and returns scoped sources', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-retriever-'))
    const key = randomUUID(),
        name = 'research-' + randomUUID().slice(0, 8)
    for (const [keyName, value] of Object.entries({
        CUTTLELY_DATA_DIR: dir,
        DATABASE_PATH: dir,
        CUTTLELY_HERMES_HOME: path.join(dir, 'runtime'),
        CUTTLELY_NATIVE_PRIME_TEAMS: name,
        SERPAPI_API_KEY: randomUUID(),
        OPENAI_API_KEY: randomUUID(),
        PINECONE_API_KEY: randomUUID(),
        CUTTLELY_SECRETKEY_OVERWRITE: key
    })) {
        const before = process.env[keyName]
        process.env[keyName] = value
        t.after(() => {
            if (before === undefined) delete process.env[keyName]
            else process.env[keyName] = before
        })
    }
    const { runHarness } = await import('../packages/harness/run.mjs')
    const { saveHarness } = await import('../packages/harness/store.mjs')
    const { rosterFromFlow } = await import('../packages/harness/sync-from-flow.mjs')
    const { loadFlowiseNode } = await import('../packages/harness/bridge.mjs')
    const { closeSessions } = await import('../packages/harness/session.mjs')
    const { closeQueueDb } = await import('../packages/harness/lock.mjs')
    t.after(() => {
        closeSessions()
        closeQueueDb()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    const workspaceId = 'qa',
        chatId = 'catalog-chat'
    const graph = JSON.parse(JSON.parse(fs.readFileSync(new URL('../samples/harnesses/calculator.canvas.json', import.meta.url))).flowData)
    const math = graph.nodes.find((n) => n.data.name === 'harnessSpecialist')
    graph.nodes = graph.nodes.filter((n) => n.data.name !== 'calculator')
    graph.edges = graph.edges.filter((e) => e.source !== 'calculator_0')
    function attach(binding, target, port, category) {
        graph.nodes.push({
            id: binding.nodeId,
            data: {
                id: binding.nodeId,
                name: binding.nodeName,
                category,
                inputs: binding.inputs,
                credential: binding.credential,
                outputs: binding.outputs
            }
        })
        graph.edges.push({ source: binding.nodeId, target, targetHandle: target + '-input-' + port })
    }
    const tool = retriever(),
        store = tool.upstream.retriever
    attach({ nodeName: 'currentDateTime', nodeId: 'clock_0', inputs: { timezone: 'Asia/Tokyo' } }, math.id, 'attached', 'Tools')
    attach({ nodeName: 'serpAPI', nodeId: 'search_0', credential: 'search-key', inputs: {} }, math.id, 'attached', 'Tools')
    attach(tool, math.id, 'attached', 'Tools')
    attach(store, tool.nodeId, 'retriever', 'Vector Stores')
    attach(store.upstream.embeddings, store.nodeId, 'embeddings', 'Embeddings')
    attach({ nodeName: 'webBrowser', nodeId: 'page', inputs: { readSource: true } }, math.id, 'attached', 'Tools')
    attach({ nodeName: 'chatOpenAI', nodeId: 'unused-model', inputs: {}, credential: 'unused' }, 'page', 'model', 'Chat Models')
    attach({ nodeName: 'openAIEmbeddings', nodeId: 'unused-emb', inputs: {}, credential: 'unused' }, 'page', 'embeddings', 'Embeddings')
    saveHarness(rosterFromFlow({ name, workspaceId, chatflowId: randomUUID(), flowData: JSON.stringify(graph) }))

    const values = {
        'search-key': { serpApiKey: randomUUID() },
        'pinecone-key': { pineconeApiKey: randomUUID() },
        'embeddings-key': { openAIApiKey: randomUUID() }
    }
    const rows = new Map(
        Object.entries(values).map(([id, v]) => [
            id,
            { id, workspaceId, encryptedData: envelope.sealApplicationRecord(JSON.stringify(v), key, ['credential', id]) }
        ])
    )
    const appDataSource = {
        getRepository(entity) {
            assert.equal(entity, 'credential')
            return { findOneBy: async ({ id }) => rows.get(id) }
        }
    }
    const flowOptions = {
        workspaceId,
        chatId: 'caller-forged-chat',
        appDataSource,
        databaseEntities: { Credential: 'credential' },
        harnessCaller: { via: 'session' }
    }
    let lookups = 0,
        searches = 0
    let pages = 0
    const address = 'https://example.invalid/article'
    const components = createRequire(new URL('../packages/components/package.json', import.meta.url))
    t.mock.method(components('@cuttlely/components/httpSecurity'), 'secureFetch', async (url, init, maxRedirects, policy) => {
        assert.equal(url, address)
        assert.equal(maxRedirects, 5)
        assert.equal(policy.publicPageOrigin, 'https://example.invalid')
        assert.ok(init.signal)
        pages++
        return { ok: true, status: 200, url, headers: { get: () => 'text/plain' }, text: async () => 'The source page confirms 19.' }
    })
    t.mock.method(globalThis, 'fetch', async (input, init) => {
        const req = new Request(input, init)
        const url = new URL(req.url)
        const json = (value) => Response.json(value)
        if (url.hostname === 'serpapi.com' && url.pathname === '/search') {
            assert.equal(req.method, 'GET')
            assert.ok(url.searchParams.get('api_key') === values['search-key'].serpApiKey)
            assert.equal(url.searchParams.get('q'), 'What is the catalog code?')
            searches++
            return json({ answer_box: { answer: 'Look up the catalog entry.' } })
        }
        if (url.hostname === 'api.openai.com' && url.pathname === '/v1/embeddings') {
            assert.ok(req.headers.get('authorization') === 'Bearer ' + values['embeddings-key'].openAIApiKey)
            const payload = await req.json()
            assert.equal(payload.model, 'text-embedding-3-small')
            return json({
                object: 'list',
                data: [
                    {
                        object: 'embedding',
                        index: 0,
                        embedding:
                            payload.encoding_format === 'base64'
                                ? Buffer.from(new Float32Array([0.8, 0.2]).buffer).toString('base64')
                                : [0.8, 0.2]
                    }
                ],
                model: payload.model,
                usage: { prompt_tokens: 2, total_tokens: 2 }
            })
        }
        assert.ok(req.headers.get('api-key') === values['pinecone-key'].pineconeApiKey)
        if (url.hostname === 'api.pinecone.io' && req.method === 'GET' && url.pathname === '/indexes/catalog') {
            return json({
                name: 'catalog',
                dimension: 2,
                metric: 'cosine',
                host: 'catalog.example.invalid',
                spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
                status: { ready: true, state: 'Ready' }
            })
        }
        assert.equal(url.hostname, 'catalog.example.invalid')
        assert.equal(req.method, 'POST')
        assert.equal(url.pathname, '/query')
        const payload = await req.json()
        assert.equal(payload.namespace, 'qa')
        assert.ok(payload.filter.$or.some((f) => f.flowise_chatId?.$eq === chatId))
        assert.equal(payload.topK, 2)
        lookups++
        return json({
            matches: [
                {
                    id: 'item',
                    score: 0.96,
                    metadata: {
                        source: 'https://example.invalid/manual',
                        file_path: '/private/workspace/manual.md',
                        title: 'Catalog',
                        text: 'The catalog number is 19.'
                    }
                }
            ]
        })
    })
    class Model {
        async init() {
            return {
                invoke: assert.fail,
                bindTools: (tools, options) => ({
                    invoke: async (messages) => {
                        assert.equal(options?.tool_choice ?? 'auto', 'auto')
                        const last = messages.at(-1)
                        const call = (name, args) => ({ content: '', tool_calls: [{ id: 'call-' + name, name, args }] })
                        if (tools.some((t) => t.function.name === 'run_specialist')) {
                            if (last._getType() === 'tool') return { content: last.content }
                            return call('run_specialist', { name: 'math', task: 'Read the clock and look up the catalog.' })
                        }
                        if (last._getType() !== 'tool') return call('current_date_time', {})
                        if (last.content.includes('Asia/Tokyo')) return call('search', { input: 'What is the catalog code?' })
                        if (last.content.includes('Look up the catalog entry.')) return call('catalog', { input: 'catalog' })
                        if (last.content.includes('The source page confirms 19.')) return { content: 'The catalog number is 19.' }
                        assert.match(last.content, /The catalog number is 19/)
                        assert.ok(last.content.includes('https://example.invalid/manual'))
                        assert.ok(!last.content.includes('/private/workspace'))
                        return call('web-browser', { input: address })
                    }
                })
            }
        }
    }
    const opts = {
        name,
        mode: 'agent',
        chatId,
        input: 'Catalog number? Check ' + address,
        flowOptions,
        fetchImpl: assert.fail,
        loadNode: async (node) => (node === 'chatXAI' ? Model : (await loadFlowiseNode(node)).constructor)
    }
    await assert.rejects(runHarness({ ...opts, flowOptions: { ...flowOptions, workspaceId: 'another-team' } }), { code: 'wrong_workspace' })
    const result = await runHarness(opts)
    assert.equal(result.agents[0].status, 'completed', result.agents[0].error)
    assert.equal(result.trace.engine, 'native')
    assert.equal(result.text, 'The catalog number is 19.')
    assert.equal(searches, 1)
    assert.equal(lookups, 1)
    assert.equal(pages, 1)
    assert.deepEqual(result.agents[0].sources, [{ name: 'https://example.invalid/manual' }, { name: address }])
    assert.equal(result.sources[0].metadata.file_path, 'manual.md')
    for (const [id, service] of [
        ['search-key', 'SerpAPI'],
        ['embeddings-key', 'OpenAI'],
        ['pinecone-key', 'Pinecone']
    ]) {
        const row = rows.get(id)
        const saved = row.encryptedData
        row.encryptedData = envelope.sealApplicationRecord('{}', key, ['credential', id])
        const denied = await runHarness({ ...opts, chatId: 'incomplete-' + id })
        assert.equal(denied.agents[0].status, 'failed')
        assert.equal(denied.agents[0].error, 'The selected ' + service + ' credential is missing its API key.')
        assert.deepEqual(denied.sources, [])
        row.encryptedData = saved
    }
    rows.get('embeddings-key').workspaceId = 'foreign-workspace'
    const denied = await runHarness({ ...opts, chatId: 'other-chat' })
    assert.equal(denied.agents[0].status, 'failed')
    assert.deepEqual(denied.sources, [])
    assert.equal(searches, 1)
    assert.equal(lookups, 1)
})

test('the offline preflight uses the saved graph and outputs only capability labels for blocked tools', async () => {
    const { inspectExport } = await import('./kraken-preflight.mjs')
    const canvas = JSON.parse(fs.readFileSync(new URL('../samples/harnesses/calculator.canvas.json', import.meta.url)))
    assert.equal(inspectExport(canvas)[0].status, 'ready-for-runtime-test')
    const graph = JSON.parse(canvas.flowData)
    const specialist = graph.nodes.find((node) => node.data.name === 'harnessSpecialist')
    specialist.data.inputs.enableShell = true
    const calculator = graph.nodes.find((node) => node.data.name === 'calculator')
    calculator.data.inputs = { privateInput: 'never-print-this' }
    const [team] = inspectExport([{ type: 'CHATFLOW' }, { ...canvas, flowData: JSON.stringify(graph) }])
    assert.equal(team.status, 'requires-bundled-runtime')
    assert.ok(team.gaps[0].capabilities.includes('shell'))
    assert.ok(!JSON.stringify(team).includes('never-print-this'))
    assert.deepEqual(inspectExport({ type: 'HARNESS', flowData: '{' }), [{ team: null, status: 'invalid-canvas' }])
})
