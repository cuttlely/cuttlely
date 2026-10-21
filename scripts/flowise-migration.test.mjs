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
        ...(extra.type ? { type: extra.type } : {}),
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

    it('records which model cards have a credential slot', () => {
        const byName = new Map((Array.isArray(catalog) ? catalog : catalog.nodes).map((entry) => [entry.name, entry]))
        assert.equal(byName.get('chatOpenAI').credential.optional, false)
        assert.equal(byName.get('chatOllama').credential.optional, true)
        assert.equal(byName.get('ollamaEmbedding').credential, undefined)
        assert.equal(byName.get('toolAgent') !== undefined, true)
    })

    it('refuses a tool file and points at Tools', () => {
        const parsed = JSON.parse(
            readFileSync(
                join(dirname(fileURLToPath(import.meta.url)), '../packages/ui/src/utils/__fixtures__/import/make-webhook.json'),
                'utf8'
            )
        )
        const report = scan(parsed)
        assert.equal(report.ok, false)
        assert.equal(report.code, 'tool')
        assert.equal(report.title, 'This is a Flowise tool, not a flow. Open Tools > Load to import it.')
        assert.equal(report.reason, 'This is a Flowise tool, not a flow. Open Tools > Load to import it.')
        assert.equal(report.canvas, null)
    })

    it('lists model credentials stored on model settings and clears the saved id', () => {
        const savedId = 'made-up-model-cred-77'
        const report = scan({
            name: 'Agent canvas',
            type: 'AGENTFLOW',
            nodes: [
                node('llmAgentflow_0', 'llmAgentflow', {
                    label: 'LLM',
                    category: 'Agent Flows',
                    inputs: {
                        llmModel: 'chatOpenAI',
                        llmModelConfig: {
                            modelName: 'gpt-4o-mini',
                            credential: savedId,
                            FLOWISE_CREDENTIAL_ID: savedId
                        }
                    }
                }),
                node('llmAgentflow_1', 'llmAgentflow', {
                    label: 'Local',
                    category: 'Agent Flows',
                    inputs: {
                        llmModel: 'chatOllama',
                        llmModelConfig: { modelName: 'llama3' }
                    }
                })
            ],
            edges: []
        })
        assert.equal(report.ok, true)
        assert.equal(report.level, 'attention')
        assert.ok(report.credentials.some((item) => item.nodeId === 'llmAgentflow_0' && item.slot === 'Model credential'))
        assert.equal(
            report.credentials.some((item) => item.nodeId === 'llmAgentflow_1'),
            false
        )
        const saved = report.canvas.nodes.find((item) => item.id === 'llmAgentflow_0')
        assert.equal(saved.data.inputs.llmModelConfig.credential, '')
        assert.equal(saved.data.inputs.llmModelConfig.FLOWISE_CREDENTIAL_ID, undefined)
        assert.equal(JSON.stringify(report).includes(savedId), false)
        assert.ok(report.fixes.some((line) => line.includes('Cleared the credential on LLM')))
    })

    it('lists a model credential when the selected model requires one and none was stored', () => {
        const parsed = JSON.parse(
            readFileSync(
                join(dirname(fileURLToPath(import.meta.url)), '../packages/ui/src/utils/__fixtures__/import/agentic-rag-v2.json'),
                'utf8'
            )
        )
        const report = scan(parsed)
        assert.notEqual(report.level, 'compatible')
        assert.ok(report.credentials.some((item) => item.nodeId === 'llmAgentflow_0' && item.slot === 'Model credential'))
    })

    it('lists a tool credential stored on tool settings', () => {
        const savedId = 'made-up-tool-cred-88'
        const report = scan({
            type: 'AGENTFLOW',
            nodes: [
                node('toolAgentflow_0', 'toolAgentflow', {
                    label: 'Search',
                    category: 'Agent Flows',
                    inputs: {
                        toolAgentflowSelectedTool: 'googleCustomSearch',
                        toolAgentflowSelectedToolConfig: { credential: savedId }
                    }
                })
            ],
            edges: []
        })
        assert.equal(report.level, 'attention')
        assert.ok(report.credentials.some((item) => item.slot === 'Tool credential' && item.label === 'Search'))
        assert.equal(report.canvas.nodes[0].data.inputs.toolAgentflowSelectedToolConfig.credential, '')
        assert.equal(JSON.stringify(report).includes(savedId), false)
    })

    it('updates an older tool-agent card when its connectors match', () => {
        const outputType = 'AgentExecutor | BaseChain | Runnable'
        const sourceHandle = 'openAIToolAgent_0-output-openAIToolAgent-AgentExecutor|BaseChain|Runnable'
        const targetHandle = 'llmChain_0-input-model-BaseChatModel'
        const report = scan({
            nodes: [
                node('openAIToolAgent_0', 'openAIToolAgent', {
                    label: 'Tool Agent',
                    category: 'Agents',
                    type: 'AgentExecutor',
                    inputAnchors: [
                        { id: 'openAIToolAgent_0-input-tools-Tool', name: 'tools', type: 'Tool' },
                        { id: 'openAIToolAgent_0-input-memory-BaseChatMemory', name: 'memory', type: 'BaseChatMemory' },
                        { id: 'openAIToolAgent_0-input-model-BaseChatModel', name: 'model', type: 'BaseChatModel' }
                    ],
                    outputAnchors: [
                        {
                            id: sourceHandle,
                            name: 'openAIToolAgent',
                            type: outputType
                        }
                    ]
                }),
                node('llmChain_0', 'llmChain', { label: 'LLM Chain', category: 'Chains' })
            ],
            edges: [
                {
                    id: 'e1',
                    source: 'openAIToolAgent_0',
                    target: 'llmChain_0',
                    sourceHandle,
                    targetHandle
                }
            ]
        })
        assert.equal(report.ok, true)
        const agent = report.canvas.nodes.find((item) => item.id === 'openAIToolAgent_0')
        assert.equal(agent.data.name, 'toolAgent')
        assert.equal(agent.data.type, 'AgentExecutor')
        assert.equal(agent.data.outputAnchors[0].name, 'toolAgent')
        assert.equal(agent.data.outputAnchors[0].id, 'openAIToolAgent_0-output-toolAgent-AgentExecutor|BaseChain|Runnable')
        assert.equal(agent.data.inputAnchors[0].id, 'openAIToolAgent_0-input-tools-Tool')
        assert.equal(report.canvas.edges[0].sourceHandle, 'openAIToolAgent_0-output-toolAgent-AgentExecutor|BaseChain|Runnable')
        assert.equal(report.canvas.edges[0].targetHandle, targetHandle)
        assert.ok(report.fixes.includes('Updated Tool Agent from openAIToolAgent to toolAgent.'))
    })

    it('updates the card type when it still uses the older tool-agent name', () => {
        const report = scan({
            nodes: [
                node('openAIToolAgent_0', 'openAIToolAgent', {
                    label: 'Tool Agent',
                    category: 'Agents',
                    type: 'openAIToolAgent',
                    outputAnchors: [
                        {
                            id: 'openAIToolAgent_0-output-openAIToolAgent-AgentExecutor|BaseChain|Runnable',
                            name: 'openAIToolAgent',
                            type: 'AgentExecutor | BaseChain | Runnable'
                        }
                    ]
                })
            ],
            edges: []
        })
        assert.equal(report.canvas.nodes[0].data.name, 'toolAgent')
        assert.equal(report.canvas.nodes[0].data.type, 'toolAgent')
    })

    it('keeps an older tool-agent card refused when the output type does not match', () => {
        const report = scan({
            nodes: [
                node('openAIToolAgent_0', 'openAIToolAgent', {
                    label: 'Tool Agent',
                    category: 'Agents',
                    outputAnchors: [
                        {
                            id: 'openAIToolAgent_0-output-openAIToolAgent-AgentExecutor',
                            name: 'openAIToolAgent',
                            type: 'AgentExecutor'
                        }
                    ]
                })
            ]
        })
        assert.equal(report.ok, false)
        assert.equal(report.canvas, null)
        assert.equal(report.unsupported[0].name, 'openAIToolAgent')
    })

    it('updates an older embedding card when its connector matches', () => {
        const report = scan({
            nodes: [
                node('ollamaEmbeddings_0', 'ollamaEmbeddings', {
                    label: 'Ollama Embeddings',
                    category: 'Embeddings',
                    inputAnchors: [],
                    outputAnchors: [
                        {
                            id: 'ollamaEmbeddings_0-output-ollamaEmbeddings-OllamaEmbeddings|Embeddings',
                            name: 'ollamaEmbeddings',
                            type: 'OllamaEmbeddings | Embeddings'
                        }
                    ]
                }),
                node('llmChain_0', 'llmChain', { label: 'LLM Chain', category: 'Chains' })
            ],
            edges: [edge('ollamaEmbeddings_0', 'llmChain_0')]
        })
        assert.equal(report.ok, true)
        const embed = report.canvas.nodes.find((item) => item.id === 'ollamaEmbeddings_0')
        assert.equal(embed.data.name, 'ollamaEmbedding')
        assert.equal(embed.data.outputAnchors[0].id, 'ollamaEmbeddings_0-output-ollamaEmbedding-OllamaEmbeddings|Embeddings')
        assert.ok(report.fixes.includes('Updated Ollama Embeddings from ollamaEmbeddings to ollamaEmbedding.'))
    })

    it('lists a custom tool that is only an id', () => {
        const parsed = JSON.parse(
            readFileSync(
                join(dirname(fileURLToPath(import.meta.url)), '../packages/ui/src/utils/__fixtures__/import/text-to-sql.json'),
                'utf8'
            )
        )
        const report = scan(parsed)
        assert.notEqual(report.level, 'compatible')
        assert.ok(
            report.attention.includes(
                'Custom tool 00000000-0000-4000-8000-000000000002. Re-create this in Tools, then pick it in the node.'
            )
        )
    })

    it('lists a custom tool chosen on an agent canvas', () => {
        const report = scan({
            type: 'AGENTFLOW',
            nodes: [
                node('agentAgentflow_0', 'agentAgentflow', {
                    label: 'Worker',
                    category: 'Agent Flows',
                    inputs: {
                        agentTools: [
                            {
                                agentSelectedTool: 'customTool',
                                agentSelectedToolConfig: {
                                    selectedTool: 'tool-made-up-2',
                                    customToolName: 'Lookup rows'
                                }
                            },
                            {
                                agentSelectedTool: 'customTool',
                                agentSelectedToolConfig: {
                                    selectedTool: 'tool-made-up-3',
                                    customToolFunc: 'return "ok"'
                                }
                            }
                        ]
                    }
                })
            ],
            edges: []
        })
        assert.deepEqual(report.attention, [
            "Custom tool 'Lookup rows' (tool-made-up-2). Re-create this in Tools, then pick it in the node."
        ])
    })

    it('copies a conversation chain system message into the current prompt field', () => {
        const report = scan({
            nodes: [
                node('conversationChain_0', 'conversationChain', {
                    label: 'Conversation Chain',
                    category: 'Chains',
                    inputs: { systemMessage: 'Be brief.' }
                })
            ],
            edges: []
        })
        assert.equal(report.ok, true)
        assert.equal(report.canvas.nodes[0].data.inputs.systemMessagePrompt, 'Be brief.')
        assert.equal(report.canvas.nodes[0].data.inputs.systemMessage, 'Be brief.')
        assert.ok(report.fixes.includes('Copied the system message on Conversation Chain into the current prompt field.'))
    })
})
