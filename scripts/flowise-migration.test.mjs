import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrationRoute, scanFlowiseMigration } from '../packages/ui/src/utils/flowiseMigration.mjs'
import { REMOVED_NODE_NAMES } from '../packages/ui/src/utils/removedNodes.mjs'

const SECRET = 'super-secret-flowise-key'
const CREDENTIAL_ID = 'cred-should-not-leak-9f3a'

const catalog = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../packages/components/nodes/module-catalog.json'), 'utf8')
)

const catalogHas = (name) => (Array.isArray(catalog) ? catalog : catalog.nodes).some((entry) => entry && entry.name === name)

const node = (id, name, extra = {}) => ({
    id,
    type: 'customNode',
    position: { x: 0, y: 0 },
    data: {
        id,
        label: extra.label || name,
        name,
        category: extra.category || 'Chains',
        inputParams: extra.inputParams || [],
        inputAnchors: extra.inputAnchors || [],
        outputAnchors: extra.outputAnchors || [],
        inputs: extra.inputs || {},
        ...(extra.credential ? { credential: extra.credential } : {})
    }
})

const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const scan = (parsed) => scanFlowiseMigration(parsed, { catalog })

describe('removed node names', () => {
    it('match between the UI list and the server list', () => {
        const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../packages/server/src/utils/nodePacks.ts'), 'utf8')
        const match = source.match(/export const REMOVED_NODE_NAMES = new Set\(\[([^\]]*)\]\)/)
        assert.ok(match, 'REMOVED_NODE_NAMES is not declared as a Set literal in nodePacks.ts')
        const server = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]).sort()
        assert.ok(server.length > 0)
        assert.deepEqual([...REMOVED_NODE_NAMES].sort(), server)
    })
})

describe('scanFlowiseMigration', () => {
    it('marks a clean chatflow ready to open and keeps the nodes', () => {
        const report = scan({
            name: 'Plain chain',
            type: 'CHATFLOW',
            nodes: [
                node('bufferMemory_0', 'bufferMemory', { label: 'Buffer Memory', category: 'Memory' }),
                node('llmChain_0', 'llmChain', { label: 'LLM Chain', category: 'Chains' })
            ],
            edges: [edge('bufferMemory_0', 'llmChain_0')]
        })
        assert.equal(report.ok, true)
        assert.equal(report.level, 'compatible')
        assert.equal(report.title, 'Ready to open')
        assert.equal(report.canvas.nodes.length, 2)
        assert.equal(report.canvas.nodes[1].data.name, 'llmChain')
        assert.equal(report.route, '/canvas')
        assert.equal(report.credentials.length, 0)
    })

    it('lists credential slots, strips secrets, and still opens', () => {
        const report = scan({
            name: 'Keyed',
            nodes: [
                node('chatOpenAI_0', 'chatOpenAI', {
                    label: 'OpenAI',
                    category: 'Chat Models',
                    credential: CREDENTIAL_ID,
                    inputParams: [
                        { label: 'Connect Credential', name: 'credential', type: 'credential', credentialNames: ['openAIApi'] },
                        { label: 'Model Name', name: 'modelName', type: 'string' },
                        { label: 'OpenAI API Key', name: 'openAIApiKey', type: 'password' }
                    ],
                    inputs: {
                        modelName: 'gpt-4o-mini',
                        openAIApiKey: SECRET,
                        FLOWISE_CREDENTIAL_ID: CREDENTIAL_ID
                    }
                }),
                node('llmChain_0', 'llmChain', { label: 'LLM Chain', category: 'Chains' })
            ],
            edges: [edge('chatOpenAI_0', 'llmChain_0')]
        })
        assert.equal(report.ok, true)
        assert.equal(report.level, 'attention')
        assert.equal(report.title, 'Ready to open, with items to finish')
        assert.ok(report.credentials.some((item) => item.label === 'OpenAI' && item.slot === 'Connect Credential'))
        assert.ok(report.credentials.some((item) => item.slot === 'OpenAI API Key'))
        const dumped = JSON.stringify(report)
        assert.equal(dumped.includes(SECRET), false)
        assert.equal(dumped.includes(CREDENTIAL_ID), false)
        assert.equal(report.canvas.nodes[0].data.credential, undefined)
        assert.equal(report.canvas.nodes[0].data.inputs.openAIApiKey, undefined)
        assert.equal(report.canvas.nodes[0].data.inputs.FLOWISE_CREDENTIAL_ID, undefined)
        assert.equal(report.canvas.nodes[0].data.inputs.modelName, 'gpt-4o-mini')
    })

    it('keeps a deprecated model and does not rename it', () => {
        const report = scan({
            nodes: [
                node('openAI_0', 'openAI', { label: 'OpenAI', category: 'LLMs' }),
                node('llmChain_0', 'llmChain', { label: 'LLM Chain', category: 'Chains' })
            ],
            edges: [edge('openAI_0', 'llmChain_0')]
        })
        assert.equal(report.ok, true)
        assert.equal(report.level, 'attention')
        assert.equal(report.canvas.nodes[0].data.name, 'openAI')
        assert.match(report.deprecated[0].message, /OpenAI Chat Models/)
    })

    it('refuses a removed LlamaIndex node and does not return a canvas', () => {
        const report = scan({
            nodes: [
                node('chatOpenAI_LlamaIndex_0', 'chatOpenAI_LlamaIndex', {
                    label: 'OpenAI',
                    category: 'Chat Models',
                    credential: CREDENTIAL_ID,
                    inputs: { openAIApiKey: SECRET }
                })
            ]
        })
        assert.equal(report.ok, false)
        assert.equal(report.level, 'refused')
        assert.equal(report.canvas, null)
        assert.match(report.unsupported[0].message, /LlamaIndex/)
        assert.match(report.reason, /cannot place/)
        const dumped = JSON.stringify(report)
        assert.equal(dumped.includes(SECRET), false)
        assert.equal(dumped.includes(CREDENTIAL_ID), false)
    })

    it('drops the removed configuration cards with a note and still opens the canvas', () => {
        const removed = ['arize', 'langFuse', 'langSmith', 'LangWatch', 'lunary', 'opik', 'phoenix', 'assemblyAI']
        for (const name of removed) assert.equal(catalogHas(name), false, `${name} is still in the catalog`)
        const report = scan({
            name: 'Traced harness',
            type: 'CHATFLOW',
            nodes: [
                node('harness_0', 'harness', { label: 'Harness', category: 'Harness' }),
                node('langFuse_0', 'langFuse', {
                    label: 'LangFuse',
                    category: 'Analytic',
                    credential: CREDENTIAL_ID,
                    inputs: { langFuseSecretKey: SECRET }
                }),
                node('assemblyAI_0', 'assemblyAI', { label: 'AssemblyAI', category: 'SpeechToText' })
            ],
            edges: [edge('langFuse_0', 'harness_0')]
        })
        assert.equal(report.ok, true)
        assert.equal(report.level, 'attention')
        assert.deepEqual(report.unsupported, [])
        assert.deepEqual(report.attention, [])
        assert.deepEqual(
            report.canvas.nodes.map((item) => item.id),
            ['harness_0']
        )
        assert.deepEqual(report.canvas.edges, [])
        assert.equal(report.fixes.filter((fix) => /^Dropped (LangFuse|AssemblyAI)\. Cuttlely no longer has this card/.test(fix)).length, 2)
        assert.ok(report.fixes.includes('Dropped 1 edge that pointed at a missing node.'))
        const dumped = JSON.stringify(report)
        assert.equal(dumped.includes(SECRET), false)
        assert.equal(dumped.includes(CREDENTIAL_ID), false)
    })

    it('refuses an unknown node', () => {
        const report = scan({
            nodes: [node('missing_0', 'notARealCuttlelyNode', { label: 'Missing' })]
        })
        assert.equal(report.ok, false)
        assert.equal(report.canvas, null)
        assert.match(report.unsupported[0].message, /no node with this name/)
    })

    it('refuses a node the canvas cannot draw', () => {
        const report = scan({
            nodes: [{ id: 'llmChain_0', type: 'customNode', data: { id: 'llmChain_0', name: 'llmChain', label: 'LLM Chain' } }]
        })
        assert.equal(report.ok, false)
        assert.match(report.unsupported[0].message, /cannot draw/)
    })

    it('refuses a Langflow file without converting it', () => {
        const report = scan({
            data: {
                nodes: [{ id: 'ChatOpenAI-1', type: 'genericNode', data: { type: 'ChatOpenAI', node: { template: {} } } }],
                edges: []
            }
        })
        assert.equal(report.code, 'langflow')
        assert.equal(report.canvas, null)
        assert.match(report.reason, /Import Langflow JSON/)
    })

    it('refuses a workspace bundle', () => {
        const report = scan({ ChatFlow: [{ id: '1', flowData: '{}' }], DocumentStore: [] })
        assert.equal(report.code, 'workspace')
        assert.match(report.reason, /Workspace export is not supported/)
    })

    it('reads flowData on a saved chatflow and drops a dangling edge', () => {
        const flowData = JSON.stringify({
            nodes: [node('llmChain_0', 'llmChain', { label: 'LLM Chain', category: 'Chains' })],
            edges: [edge('missing', 'llmChain_0')]
        })
        const report = scan({ name: 'Saved', type: 'CHATFLOW', flowData })
        assert.equal(report.ok, true)
        assert.equal(report.name, 'Saved')
        assert.equal(report.canvas.edges.length, 0)
        assert.ok(report.fixes.some((line) => line.includes('Dropped 1 edge')))
        assert.equal(JSON.stringify(report.canvas).includes('missing'), false)
    })

    it('sends a chief to the harness canvas', () => {
        const nodes = [node('harnessChief_0', 'harnessChief', { label: 'Harness Prime', category: 'Harness' })]
        assert.equal(migrationRoute(nodes, ''), '/harnesscanvas')
        const report = scan({ type: 'HARNESS', nodes })
        assert.equal(report.route, '/harnesscanvas')
    })
})
