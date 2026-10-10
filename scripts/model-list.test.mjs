// The model list: the maintainers' list from this repository, refreshed at most once a day, the bundled copy on
// any failure, and MODEL_LIST_CONFIG_JSON=bundled to turn the fetch off. See docs/reference/model-list.md.
// Every fetch here goes to a server on 127.0.0.1; nothing leaves the machine.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, it } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLED = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/components/models.json'), 'utf8'))
const loader = await import(path.join(ROOT, 'packages/components/dist/src/modelLoader.js'))
const { MODEL_LIST_URL, MODEL_TYPE, getModels, getRawModelFile, isModelList, modelListSettings, modelListSource, resetModelListCache } =
    loader.default ?? loader

const REMOTE = {
    chat: [{ name: 'chatOpenAI', models: [{ label: 'bakery-model-2', name: 'bakery-model-2', input_cost: 1e-7, output_cost: 4e-7 }] }],
    llm: [],
    embedding: []
}

let server
let base
let hits = 0
let reply = () => ({ status: 200, body: JSON.stringify(REMOTE) })

before(async () => {
    server = http.createServer((req, res) => {
        hits++
        const { status, body, hang } = reply(req)
        if (hang) return
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(body)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
    server.closeAllConnections()
    server.close()
    delete process.env.MODEL_LIST_CONFIG_JSON
})

beforeEach(() => {
    resetModelListCache()
    hits = 0
    modelListSettings.timeoutMs = 5000
    modelListSettings.refreshMs = 24 * 60 * 60 * 1000
    reply = () => ({ status: 200, body: JSON.stringify(REMOTE) })
})

describe('model list source', () => {
    it('defaults to the maintainers list in the Cuttlely repository', () => {
        assert.deepEqual(modelListSource(''), { kind: 'url', url: MODEL_LIST_URL })
        assert.match(
            MODEL_LIST_URL,
            /^https:\/\/raw\.githubusercontent\.com\/cuttlely\/cuttlely\/main\/packages\/components\/models\.json$/
        )
    })

    it('reads "bundled", a URL or a file path from MODEL_LIST_CONFIG_JSON', () => {
        assert.deepEqual(modelListSource(' Bundled '), { kind: 'bundled' })
        assert.deepEqual(modelListSource('https://models.example.com/list.json'), {
            kind: 'url',
            url: 'https://models.example.com/list.json'
        })
        assert.deepEqual(modelListSource('/etc/cuttlely/models.json'), { kind: 'file', path: '/etc/cuttlely/models.json' })
    })
})

describe('model list shape', () => {
    it('accepts the bundled models.json', () => assert.equal(isModelList(BUNDLED), true))

    it('rejects anything else', () => {
        for (const bad of [
            null,
            [],
            'text',
            {},
            { chat: [], llm: [], embedding: [] },
            { chat: [{ name: 'x' }] },
            { ...REMOTE, chat: [{ models: [] }] },
            { ...REMOTE, chat: [{ name: 'chatOpenAI', models: [{ name: 'm' }] }] }
        ]) {
            assert.equal(isModelList(bad), false, JSON.stringify(bad))
        }
    })
})

describe('loading the model list', () => {
    it('uses the fetched list and asks at most once per refresh interval', async () => {
        process.env.MODEL_LIST_CONFIG_JSON = `${base}/models.json`
        const [a, b] = await Promise.all([getRawModelFile(), getRawModelFile()])
        assert.deepEqual(a, REMOTE)
        assert.deepEqual(b, REMOTE)
        assert.deepEqual(await getModels(MODEL_TYPE.CHAT, 'chatOpenAI'), REMOTE.chat[0].models)
        assert.equal(hits, 1)
    })

    it('refreshes after the interval', async () => {
        process.env.MODEL_LIST_CONFIG_JSON = `${base}/models.json`
        modelListSettings.refreshMs = 0
        await getRawModelFile()
        await getRawModelFile()
        assert.equal(hits, 2)
    })

    for (const [name, answer] of [
        ['an error status', () => ({ status: 404, body: 'Not Found' })],
        ['a body that is not JSON', () => ({ status: 200, body: '<html>' })],
        ['JSON that is not a model list', () => ({ status: 200, body: JSON.stringify({ chat: 'nope' }) })]
    ]) {
        it(`falls back to the bundled list on ${name}, and waits for the next refresh`, async () => {
            process.env.MODEL_LIST_CONFIG_JSON = `${base}/models.json`
            reply = answer
            assert.deepEqual(await getRawModelFile(), BUNDLED)
            assert.deepEqual(await getRawModelFile(), BUNDLED)
            assert.equal(hits, 1)
        })
    }

    it('gives up after the timeout', async () => {
        process.env.MODEL_LIST_CONFIG_JSON = `${base}/slow.json`
        modelListSettings.timeoutMs = 200
        reply = () => ({ hang: true })
        const started = Date.now()
        assert.deepEqual(await getRawModelFile(), BUNDLED)
        assert.ok(Date.now() - started < 3000)
    })

    it('makes no request when set to bundled', async () => {
        process.env.MODEL_LIST_CONFIG_JSON = 'bundled'
        assert.deepEqual(await getRawModelFile(), BUNDLED)
        assert.equal(hits, 0)
    })

    it('reads a valid file, and falls back from a broken one', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-models-'))
        const good = path.join(dir, 'good.json')
        const bad = path.join(dir, 'bad.json')
        fs.writeFileSync(good, JSON.stringify(REMOTE))
        fs.writeFileSync(bad, '{"chat": ')
        process.env.MODEL_LIST_CONFIG_JSON = good
        assert.deepEqual(await getRawModelFile(), REMOTE)
        process.env.MODEL_LIST_CONFIG_JSON = bad
        assert.deepEqual(await getRawModelFile(), BUNDLED)
        process.env.MODEL_LIST_CONFIG_JSON = path.join(dir, 'missing.json')
        assert.deepEqual(await getRawModelFile(), BUNDLED)
        assert.equal(hits, 0)
        fs.rmSync(dir, { recursive: true, force: true })
    })
})

// Every node whose model dropdown reads this file must have a non-empty list in the bundled copy, because a
// private repository or an offline server only ever sees that copy (the xAI node once had no list).
// Text completion nodes whose provider no longer serves any completion model. Their list is empty on purpose;
// the field still takes a typed model name.
const NO_CURRENT_MODELS = {
    'llm/openAI': 'gpt-3.5-turbo-instruct, davinci-002 and babbage-002 were shut down on Sept 28, 2026',
    'llm/azureOpenAI': 'Azure OpenAI no longer offers a completion (instruct) model',
    'llm/cohere': 'Cohere deprecated command and command-light, the Generate API models, on Sept 15, 2025'
}

describe('model dropdowns on nodes', () => {
    const nodesDir = path.join(ROOT, 'packages/components/nodes')
    const sources = fs
        .readdirSync(nodesDir, { recursive: true })
        .filter((file) => String(file).endsWith('.ts') && !String(file).endsWith('.test.ts'))
        .map((file) => [String(file), fs.readFileSync(path.join(nodesDir, String(file)), 'utf8')])

    it('every getModels() call names a node that has models in the bundled list', () => {
        const calls = []
        for (const [file, text] of sources) {
            for (const match of text.matchAll(/getModels\(\s*MODEL_TYPE\.(CHAT|LLM|EMBEDDING)\s*,\s*'([^']+)'\s*\)/g)) {
                calls.push({ file, category: match[1].toLowerCase(), name: match[2] })
            }
        }
        assert.ok(calls.length >= 20, `found only ${calls.length} getModels() calls`)
        for (const { file, category, name } of calls) {
            const entry = BUNDLED[category].find((candidate) => candidate.name === name)
            assert.ok(entry, `${file}: no ${category} entry for ${name} in models.json`)
            if (NO_CURRENT_MODELS[`${category}/${name}`]) {
                assert.equal(entry.models.length, 0, `${category}/${name} has models again: drop it from NO_CURRENT_MODELS`)
                continue
            }
            assert.ok(entry.models.length > 0, `${file}: no ${category} models for ${name} in models.json`)
        }
    })

    it('every model dropdown keeps a typed or saved model name, and its default is in the list', async () => {
        let checked = 0
        for (const [file, text] of sources) {
            const match = text.match(/getModels\(\s*MODEL_TYPE\.(CHAT|LLM|EMBEDDING)\s*,\s*'([^']+)'\s*\)/)
            if (!match || !/loadMethod: 'listModels'/.test(text)) continue
            const { nodeClass } = await import(path.join(ROOT, 'packages/components/dist/nodes', file.replace(/\.ts$/, '.js')))
            if (!nodeClass) continue
            const node = new nodeClass()
            const field = node.inputs.find((input) => input.loadMethod === 'listModels')
            assert.ok(field, `${file}: no listModels field`)
            assert.equal(field.freeSolo, true, `${file}: ${field.name} must keep typed and saved model names (freeSolo)`)
            const key = `${match[1].toLowerCase()}/${match[2]}`
            const models = BUNDLED[match[1].toLowerCase()].find((entry) => entry.name === match[2]).models
            if (field.default && !NO_CURRENT_MODELS[key]) {
                assert.ok(
                    models.some((model) => model.name === field.default),
                    `${file}: default ${field.default} is not in the ${key} list`
                )
            }
            checked++
        }
        assert.ok(checked >= 35, `checked only ${checked} model dropdowns`)
    })

    it('a flow saved with a model that has left the list still loads it', async () => {
        const { nodeClass } = await import(path.join(ROOT, 'packages/components/dist/nodes/chatmodels/ChatOpenAI/ChatOpenAI.js'))
        const node = new nodeClass()
        assert.ok(!BUNDLED.chat.find((entry) => entry.name === 'chatOpenAI').models.some((model) => model.name === 'gpt-4-turbo'))
        // A made-up key: init only builds the client, nothing is sent
        const model = await node.init(
            { id: 'chatOpenAI_0', inputs: { modelName: 'gpt-4-turbo', temperature: '0.2', openAIApiKey: 'not-a-real-key' } },
            '',
            {}
        )
        assert.equal(model.model, 'gpt-4-turbo')

        const openRouter = await import(path.join(ROOT, 'packages/components/dist/nodes/chatmodels/ChatOpenRouter/ChatOpenRouter.js'))
        const router = await new openRouter.nodeClass().init(
            { id: 'chatOpenRouter_0', inputs: { modelName: 'bakery/sourdough-7b', openRouterApiKey: 'not-a-real-key' } },
            '',
            {}
        )
        assert.equal(router.model, 'bakery/sourdough-7b')
    })

    it('the xAI Grok node offers its models with no network, and when the fetch answers 404', async () => {
        const { nodeClass } = await import(path.join(ROOT, 'packages/components/dist/nodes/chatmodels/ChatXAI/ChatXAI.js'))
        const node = new nodeClass()
        const field = node.inputs.find((input) => input.name === 'modelName')
        assert.equal(field.type, 'asyncOptions')
        assert.equal(field.loadMethod, 'listModels')
        assert.equal(field.freeSolo, true, 'a model name missing from the list can still be typed')
        const expected = BUNDLED.chat.find((entry) => entry.name === 'chatXAI').models
        assert.ok(
            expected.some((model) => model.name === field.default),
            `default ${field.default} is in the list`
        )

        process.env.MODEL_LIST_CONFIG_JSON = 'bundled'
        assert.deepEqual(await node.loadMethods.listModels(), expected)
        assert.equal(hits, 0)

        process.env.MODEL_LIST_CONFIG_JSON = `${base}/models.json`
        reply = () => ({ status: 404, body: 'Not Found' })
        assert.deepEqual(await node.loadMethods.listModels(), expected)
        assert.equal(hits, 1)
    })
})
