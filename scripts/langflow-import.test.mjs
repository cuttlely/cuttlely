import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hydrateLangflowFlow, isLangflowExport, langflowToFlowise } from '../packages/ui/src/utils/langflowImport.mjs'

const SECRET = 'super-secret-langflow-key'

const langflowNode = (id, type, template, position) => ({
    id,
    type: 'genericNode',
    position: position || { x: 10, y: 20 },
    data: {
        id,
        type,
        node: {
            template,
            display_name: type
        }
    }
})

const edge = (source, target, fieldName) => ({
    source,
    target,
    sourceHandle: JSON.stringify({ dataType: source, id: source, name: 'out', output_types: ['Message'] }),
    targetHandle: JSON.stringify({ fieldName, id: target, inputTypes: ['Message'], type: 'str' }),
    data: {
        sourceHandle: { dataType: source, id: source, name: 'out', output_types: ['Message'] },
        targetHandle: { fieldName, id: target, inputTypes: ['Message'], type: 'str' }
    }
})

const basicPrompting = () => ({
    name: 'Basic Prompting',
    data: {
        nodes: [
            langflowNode('ChatInput-1', 'ChatInput', { input_value: { value: 'Hello' } }),
            langflowNode('Prompt-1', 'Prompt', {
                template: { value: 'Answer the user as if you were a GenAI expert.' }
            }),
            langflowNode('note-1', 'note', {}),
            { id: 'readme-1', data: { id: 'readme-1', node: { description: '# Read me' } } },
            langflowNode('ChatOutput-1', 'ChatOutput', { input_value: { value: '' } }),
            langflowNode(
                'LanguageModelComponent-1',
                'LanguageModelComponent',
                {
                    provider: { value: '' },
                    model: { value: '' },
                    model_name: { value: '' },
                    temperature: { value: 0.1 },
                    max_tokens: { value: 0 },
                    system_message: { value: '' },
                    api_key: { value: SECRET, password: true },
                    code: { value: `key = "${SECRET}"` }
                },
                { x: 80, y: 40 }
            )
        ],
        edges: [
            edge('ChatInput-1', 'LanguageModelComponent-1', 'input_value'),
            edge('Prompt-1', 'LanguageModelComponent-1', 'system_message'),
            edge('LanguageModelComponent-1', 'ChatOutput-1', 'input_value')
        ]
    }
})

const catalog = [
    {
        name: 'chatOpenAI',
        label: 'OpenAI',
        version: 8.3,
        type: 'ChatOpenAI',
        category: 'Chat Models',
        description: 'OpenAI chat',
        baseClasses: ['ChatOpenAI', 'BaseChatModel'],
        credential: { label: 'Connect Credential', name: 'credential', type: 'credential', credentialNames: ['openAIApi'] },
        inputs: [
            { label: 'Model Name', name: 'modelName', type: 'asyncOptions', default: 'gpt-4o-mini' },
            { label: 'Temperature', name: 'temperature', type: 'number', default: 0.9 },
            { label: 'Max Tokens', name: 'maxTokens', type: 'number', optional: true }
        ]
    },
    {
        name: 'chatAnthropic',
        label: 'Anthropic Claude',
        version: 8,
        type: 'ChatAnthropic',
        category: 'Chat Models',
        baseClasses: ['ChatAnthropic', 'BaseChatModel'],
        credential: { label: 'Connect Credential', name: 'credential', type: 'credential', credentialNames: ['anthropicApi'] },
        inputs: [{ label: 'Model Name', name: 'modelName', type: 'asyncOptions', default: 'claude-haiku-4-5' }]
    },
    {
        name: 'bufferMemory',
        label: 'Buffer Memory',
        version: 2,
        type: 'BufferMemory',
        category: 'Memory',
        baseClasses: ['BufferMemory', 'BaseMemory'],
        inputs: [{ label: 'Memory Key', name: 'memoryKey', type: 'string', default: 'chat_history' }]
    },
    {
        name: 'conversationChain',
        label: 'Conversation Chain',
        version: 3,
        type: 'ConversationChain',
        category: 'Chains',
        baseClasses: ['ConversationChain'],
        inputs: [
            { label: 'Chat Model', name: 'model', type: 'BaseChatModel' },
            { label: 'Memory', name: 'memory', type: 'BaseMemory' },
            { label: 'System Message', name: 'systemMessagePrompt', type: 'string', default: 'default system' }
        ]
    }
]

describe('langflow import', () => {
    it('converts a Basic Prompting export and drops keys, notes, and chat input', () => {
        const file = basicPrompting()
        assert.equal(isLangflowExport(file), true)
        const result = langflowToFlowise(file)
        assert.equal(result.ok, true)
        assert.equal(result.name, 'Basic Prompting')
        assert.equal(result.warnings.length, 1)
        const names = result.flow.nodes.map((node) => node.data.name)
        assert.deepEqual(names, ['chatOpenAI', 'bufferMemory', 'conversationChain', 'stickyNote'])
        const model = result.flow.nodes[0]
        assert.equal(model.inputs || model.data.inputs.temperature, 0.1)
        assert.equal(model.data.inputs.modelName, undefined)
        const chain = result.flow.nodes[2]
        assert.equal(chain.data.inputs.systemMessagePrompt, 'Answer the user as if you were a GenAI expert.')
        const dumped = JSON.stringify(result)
        assert.equal(dumped.includes(SECRET), false)
        assert.equal(dumped.includes('ChatInput'), false)
        assert.equal(dumped.includes('api_key'), false)
    })

    it('maps a named provider and a model list', () => {
        const file = {
            name: 'Claude chat',
            data: {
                nodes: [
                    langflowNode('ChatInput-1', 'ChatInput', {}),
                    langflowNode('LanguageModelComponent-1', 'LanguageModelComponent', {
                        provider: { value: '' },
                        model: { value: [{ name: 'claude-3-5-haiku-latest', provider: 'Anthropic' }] },
                        temperature: { value: '0' }
                    }),
                    langflowNode('ChatOutput-1', 'ChatOutput', {})
                ],
                edges: [edge('LanguageModelComponent-1', 'ChatOutput-1', 'input_value')]
            }
        }
        const result = langflowToFlowise(file)
        assert.equal(result.ok, true)
        assert.equal(result.warnings.length, 0)
        assert.equal(result.flow.nodes[0].data.name, 'chatAnthropic')
        assert.equal(result.flow.nodes[0].data.inputs.modelName, 'claude-3-5-haiku-latest')
        assert.equal(result.flow.nodes[0].data.inputs.temperature, 0)
    })

    it('maps an older OpenAI model component', () => {
        const file = {
            data: {
                nodes: [
                    langflowNode('OpenAIModel-1', 'OpenAIModelComponent', {
                        model_name: { value: 'gpt-4o-mini' },
                        openai_api_key: { value: SECRET, password: true }
                    }),
                    langflowNode('ChatOutput-1', 'ChatOutput', {})
                ],
                edges: []
            }
        }
        const result = langflowToFlowise(file)
        assert.equal(result.ok, true)
        assert.equal(result.flow.nodes[0].data.name, 'chatOpenAI')
        assert.equal(result.flow.nodes[0].data.inputs.modelName, 'gpt-4o-mini')
        assert.equal(JSON.stringify(result).includes(SECRET), false)
    })

    it('turns a pirate prompt wired from chat input into a system message', () => {
        const file = {
            data: {
                nodes: [
                    langflowNode('ChatInput-1', 'ChatInput', {}),
                    langflowNode('Prompt-1', 'Prompt', {
                        template: { value: 'Answer the user as if you were a pirate.\n\nUser: {user_input}\n\nAnswer:\n' }
                    }),
                    langflowNode('OpenAIModel-1', 'ChatOpenAI', { model_name: { value: 'gpt-4o-mini' } }),
                    langflowNode('ChatOutput-1', 'ChatOutput', {})
                ],
                edges: [
                    edge('ChatInput-1', 'Prompt-1', 'user_input'),
                    edge('Prompt-1', 'OpenAIModel-1', 'input_value'),
                    edge('OpenAIModel-1', 'ChatOutput-1', 'input_value')
                ]
            }
        }
        const result = langflowToFlowise(file)
        assert.equal(result.ok, true)
        assert.equal(result.flow.nodes[2].data.inputs.systemMessagePrompt, 'Answer the user as if you were a pirate.')
    })

    it('refuses agents, two models, and an unknown provider', () => {
        const agent = langflowToFlowise({
            data: {
                nodes: [
                    langflowNode('Agent-1', 'Agent', {}),
                    langflowNode('ChatOpenAI-1', 'ChatOpenAI', {}),
                    langflowNode('ChatOutput-1', 'ChatOutput', {})
                ],
                edges: []
            }
        })
        assert.equal(agent.ok, false)
        assert.match(agent.reason, /not supported yet/)
        assert.match(agent.reason, /Agent/)

        const two = langflowToFlowise({
            data: {
                nodes: [langflowNode('A', 'ChatOpenAI', {}), langflowNode('B', 'ChatAnthropic', {})],
                edges: []
            }
        })
        assert.equal(two.ok, false)
        assert.match(two.reason, /more than one chat model/)

        const cohere = langflowToFlowise({
            data: {
                nodes: [langflowNode('M', 'LanguageModelComponent', { provider: { value: 'Cohere' } })],
                edges: []
            }
        })
        assert.equal(cohere.ok, false)
        assert.match(cohere.reason, /Cohere/)
    })

    it('does not treat a Flowise canvas as Langflow', () => {
        const flowise = { nodes: [{ id: 'chatOpenAI_0', data: { name: 'chatOpenAI', inputs: {} } }], edges: [] }
        assert.equal(isLangflowExport(flowise), false)
        assert.equal(langflowToFlowise(flowise).ok, false)
    })

    it('hydrates anchors, edges, and a credential slot without the key', () => {
        const result = langflowToFlowise(basicPrompting())
        const hydrated = hydrateLangflowFlow(result.flow, catalog)
        assert.equal(hydrated.ok, true)
        const model = hydrated.nodes.find((node) => node.data.name === 'chatOpenAI')
        const chain = hydrated.nodes.find((node) => node.data.name === 'conversationChain')
        const note = hydrated.nodes.find((node) => node.type === 'stickyNote')
        assert.equal(model.data.inputs.temperature, 0.1)
        assert.equal(model.data.inputs.modelName, 'gpt-4o-mini')
        assert.ok(model.data.inputParams.some((param) => param.type === 'credential'))
        assert.equal(model.data.credential, '')
        assert.equal(chain.data.category, 'Chains')
        assert.equal(chain.data.inputs.model, '{{chatOpenAI_0.data.instance}}')
        assert.equal(chain.data.inputs.memory, '{{bufferMemory_0.data.instance}}')
        assert.equal(chain.data.inputs.systemMessagePrompt, 'Answer the user as if you were a GenAI expert.')
        const modelEdge = hydrated.edges.find((item) => item.source === 'chatOpenAI_0')
        assert.ok(modelEdge.targetHandle.includes('conversationChain_0-input-model-'))
        assert.ok(modelEdge.sourceHandle.includes('chatOpenAI_0-output-chatOpenAI-'))
        assert.match(note.data.inputs.note, /API keys were not copied/)
        assert.equal(JSON.stringify(hydrated).includes(SECRET), false)
        assert.equal(hydrateLangflowFlow(result.flow, []).ok, false)
    })
})
