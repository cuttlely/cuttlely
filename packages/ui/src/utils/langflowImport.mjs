// Langflow JSON is not a Flowise canvas. This converts one simple chat and refuses everything else.
// A simple chat is one model, an optional prompt, and chat input and output. API keys are never copied.

const SIMPLE = 'A simple chat is one model, an optional prompt, and chat input and output.'

const DROPPED_TYPES = new Set(['ChatInput', 'ChatOutput', 'TextInput', 'TextOutput', 'note', 'Note', 'noteNode'])

const PROMPT_TYPES = new Set(['Prompt', 'PromptComponent'])

const COMPONENT_PROVIDER = new Map([
    ['ChatOpenAI', 'openai'],
    ['OpenAIModel', 'openai'],
    ['OpenAIModelComponent', 'openai'],
    ['OpenAI', 'openai'],
    ['ChatAnthropic', 'anthropic'],
    ['AnthropicModel', 'anthropic'],
    ['AnthropicModelComponent', 'anthropic'],
    ['Anthropic', 'anthropic'],
    ['GroqModel', 'groq'],
    ['ChatGroq', 'groq'],
    ['Groq', 'groq'],
    ['OllamaModel', 'ollama'],
    ['ChatOllama', 'ollama'],
    ['Ollama', 'ollama'],
    ['GoogleGenerativeAIModel', 'google'],
    ['ChatGoogleGenerativeAI', 'google'],
    ['GoogleGenerativeAI', 'google'],
    ['GeminiModel', 'google'],
    ['MistralModel', 'mistral'],
    ['ChatMistralAI', 'mistral'],
    ['MistralModelComponent', 'mistral'],
    ['AzureChatOpenAI', 'azure'],
    ['AzureOpenAIModel', 'azure'],
    ['AzureOpenAI', 'azure'],
    ['ChatXAI', 'xai'],
    ['XAIModel', 'xai']
])

const MODEL_NODE = {
    openai: 'chatOpenAI',
    anthropic: 'chatAnthropic',
    google: 'chatGoogleGenerativeAI',
    groq: 'groqChat',
    ollama: 'chatOllama',
    mistral: 'chatMistralAI',
    azure: 'azureChatOpenAI',
    xai: 'chatXAI'
}

const PROVIDER_ALIASES = {
    openai: 'openai',
    'open ai': 'openai',
    anthropic: 'anthropic',
    claude: 'anthropic',
    google: 'google',
    'google generative ai': 'google',
    gemini: 'google',
    groq: 'groq',
    ollama: 'ollama',
    mistral: 'mistral',
    mistralai: 'mistral',
    'mistral ai': 'mistral',
    azure: 'azure',
    'azure openai': 'azure',
    xai: 'xai',
    'x ai': 'xai',
    grok: 'xai'
}

const PARAM_TYPES = new Set([
    'asyncOptions',
    'asyncMultiOptions',
    'options',
    'multiOptions',
    'array',
    'datagrid',
    'string',
    'number',
    'boolean',
    'password',
    'json',
    'code',
    'date',
    'file',
    'folder',
    'tabs',
    'conditionFunction',
    'timePicker',
    'weekDaysPicker',
    'monthDaysPicker',
    'datePicker'
])

const unsupported = (detail) => ({
    ok: false,
    reason: `Langflow import is not supported yet for this graph${detail ? `: ${detail}` : ''}. ${SIMPLE}`
})

const parseMaybeJson = (value) => {
    if (!value) return null
    if (typeof value === 'object') return value
    if (typeof value !== 'string') return null
    try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
        return null
    }
}

const langflowNodeList = (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    if (parsed.data && typeof parsed.data === 'object' && Array.isArray(parsed.data.nodes)) return parsed.data.nodes
    if (Array.isArray(parsed.nodes)) return parsed.nodes
    return []
}

const looksLikeLangflowNode = (node) => {
    if (!node || typeof node !== 'object') return false
    if (node.type === 'genericNode' || node.type === 'note' || node.type === 'noteNode') return true
    const body = node.data && node.data.node
    return !!(body && typeof body === 'object' && body.template && typeof body.template === 'object')
}

export const isLangflowExport = (parsed) => langflowNodeList(parsed).some(looksLikeLangflowNode)

const edgesOf = (parsed) => {
    if (!parsed || typeof parsed !== 'object') return []
    if (parsed.data && typeof parsed.data === 'object' && Array.isArray(parsed.data.edges)) return parsed.data.edges
    return Array.isArray(parsed.edges) ? parsed.edges : []
}

const componentType = (node) => {
    const value = node && node.data && node.data.type
    return typeof value === 'string' ? value : ''
}

const templateOf = (node) => {
    const body = node && node.data && node.data.node
    const template = body && body.template
    return template && typeof template === 'object' ? template : {}
}

const fieldValue = (template, key) => {
    const field = template && template[key]
    if (!field || typeof field !== 'object' || Array.isArray(field)) return undefined
    return field.value
}

const handleOf = (edge, side) => {
    const data = edge && edge.data
    const fromData = data && data[side === 'target' ? 'targetHandle' : 'sourceHandle']
    return parseMaybeJson(fromData) || parseMaybeJson(edge && edge[side === 'target' ? 'targetHandle' : 'sourceHandle'])
}

const targetFieldName = (edge) => {
    const handle = handleOf(edge, 'target')
    return handle && typeof handle.fieldName === 'string' ? handle.fieldName : ''
}

const normalizeProvider = (raw) => {
    const key = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
    if (!key) return ''
    return PROVIDER_ALIASES[key] || ''
}

const providerText = (template) => {
    const direct = fieldValue(template, 'provider')
    if (typeof direct === 'string' && direct.trim()) return direct.trim()
    const model = fieldValue(template, 'model')
    if (Array.isArray(model) && model[0] && typeof model[0].provider === 'string') return model[0].provider.trim()
    return ''
}

const safeModelName = (value) => {
    let name = ''
    if (typeof value === 'string') name = value.trim()
    else if (Array.isArray(value) && value[0] && typeof value[0].name === 'string') name = value[0].name.trim()
    if (!name || name.length > 200) return ''
    if (/sk-|bearer\s|api[_-]?key|secret/i.test(name)) return ''
    return name
}

const modelNameFrom = (template) => {
    const fromModel = safeModelName(fieldValue(template, 'model'))
    if (fromModel) return fromModel
    return safeModelName(fieldValue(template, 'model_name'))
}

const numberField = (template, key) => {
    const value = fieldValue(template, key)
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
    return null
}

const userVarsFor = (promptId, edges, nodesById) => {
    const names = new Set()
    for (const edge of edges) {
        if (!edge || edge.target !== promptId) continue
        const source = nodesById.get(edge.source)
        const sourceType = componentType(source)
        if (sourceType !== 'ChatInput' && sourceType !== 'TextInput') continue
        const field = targetFieldName(edge)
        if (field) names.add(field)
    }
    return names
}

const systemText = (template, userVars) => {
    let text = typeof template === 'string' ? template : ''
    for (const name of userVars) text = text.split(`{${name}}`).join('')
    const kept = []
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (/^(user|human|answer|assistant|ai)\s*:\s*$/i.test(trimmed)) continue
        kept.push(line.trimEnd())
    }
    return kept
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

const resolveProvider = (type, template) => {
    if (type === 'LanguageModelComponent') {
        const raw = providerText(template)
        if (!raw) return { provider: 'openai', empty: true }
        const provider = normalizeProvider(raw)
        if (!provider) return { error: raw }
        return { provider, empty: false }
    }
    const implied = COMPONENT_PROVIDER.get(type)
    if (!implied) return { error: type }
    return { provider: implied, empty: false }
}

const positionOf = (node, fallback) => {
    const position = node && node.position
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) return { x: position.x, y: position.y }
    return fallback
}

export const langflowToFlowise = (parsed) => {
    if (!isLangflowExport(parsed)) return { ok: false, reason: 'That file is not a Langflow export.' }
    const nodes = langflowNodeList(parsed)
    const edges = edgesOf(parsed)
    const nodesById = new Map()
    const dropped = []
    const prompts = []
    const models = []
    const extras = []

    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue
        const id = typeof node.id === 'string' && node.id ? node.id : node.data && node.data.id
        if (typeof id === 'string') nodesById.set(id, node)
        const type = componentType(node)
        if (!type || DROPPED_TYPES.has(type)) {
            dropped.push(node)
            continue
        }
        if (PROMPT_TYPES.has(type)) {
            prompts.push(node)
            continue
        }
        if (type === 'LanguageModelComponent' || COMPONENT_PROVIDER.has(type)) {
            models.push(node)
            continue
        }
        extras.push(type)
    }

    if (extras.length) {
        const unique = [...new Set(extras)].sort()
        return unsupported(unique.join(', '))
    }
    if (models.length === 0) return unsupported('it has no chat model')
    if (models.length > 1) return unsupported('more than one chat model')
    if (prompts.length > 1) return unsupported('more than one prompt')

    const modelNode = models[0]
    const template = templateOf(modelNode)
    const resolved = resolveProvider(componentType(modelNode), template)
    if (resolved.error) return unsupported(`provider "${resolved.error}"`)

    const modelId = `${MODEL_NODE[resolved.provider]}_0`
    const inputs = {}
    const modelName = modelNameFrom(template)
    if (modelName) inputs.modelName = modelName
    const temperature = numberField(template, 'temperature')
    if (temperature !== null && temperature >= 0 && temperature <= 2) inputs.temperature = temperature
    const maxTokens = numberField(template, 'max_tokens')
    const maxCompletion = numberField(template, 'max_completion_tokens')
    const max = maxTokens && maxTokens > 0 ? maxTokens : maxCompletion && maxCompletion > 0 ? maxCompletion : null
    if (max !== null && max < 1e7) inputs.maxTokens = max

    const promptNode = prompts[0]
    const warnings = []
    if (resolved.empty) {
        warnings.push('The file did not name a model provider. This canvas uses OpenAI. Swap the chat model if you used another provider.')
    }
    let systemMessage = typeof fieldValue(template, 'system_message') === 'string' ? fieldValue(template, 'system_message').trim() : ''
    if (promptNode) {
        const promptTemplate = fieldValue(templateOf(promptNode), 'template')
        const promptId = promptNode.id || (promptNode.data && promptNode.data.id)
        const processed = systemText(promptTemplate, userVarsFor(promptId, edges, nodesById))
        const link = edges.find(
            (edge) => edge && edge.source === promptId && edge.target === (modelNode.id || (modelNode.data && modelNode.data.id))
        )
        const field = link ? targetFieldName(link) : ''
        if (processed && (field === 'system_message' || !systemMessage)) systemMessage = processed
        else if (processed && systemMessage && processed !== systemMessage) systemMessage = `${systemMessage}\n\n${processed}`
        if (promptTemplate !== undefined && typeof promptTemplate !== 'string') {
            warnings.push('The prompt template was not plain text, so it was not copied.')
        }
    }

    const chainInputs = {}
    if (systemMessage) chainInputs.systemMessagePrompt = systemMessage
    const modelPosition = positionOf(modelNode, { x: 40, y: 40 })
    const noteLines = [
        'Imported from Langflow.',
        'API keys were not copied. Select a credential on the chat model. Credentials stay in this app.'
    ]
    for (const warning of warnings) noteLines.push(warning)

    const name =
        parsed && typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 200) : 'Imported Langflow chat'

    return {
        ok: true,
        name,
        warnings,
        flow: {
            viewport: { x: 0, y: 0, zoom: 0.75 },
            nodes: [
                {
                    id: modelId,
                    position: modelPosition,
                    data: { name: MODEL_NODE[resolved.provider], inputs }
                },
                {
                    id: 'bufferMemory_0',
                    position: { x: modelPosition.x, y: modelPosition.y + 520 },
                    data: { name: 'bufferMemory', inputs: { memoryKey: 'chat_history' } }
                },
                {
                    id: 'conversationChain_0',
                    position: { x: modelPosition.x + 450, y: modelPosition.y },
                    data: { name: 'conversationChain', inputs: chainInputs }
                },
                {
                    id: 'stickyNote_0',
                    position: { x: modelPosition.x + 900, y: modelPosition.y },
                    width: 320,
                    height: 180,
                    style: { width: 320, height: 180 },
                    data: { name: 'stickyNote', inputs: { note: noteLines.join('\n\n') } }
                }
            ],
            links: [
                { source: modelId, target: 'conversationChain_0', input: 'model' },
                { source: 'bufferMemory_0', target: 'conversationChain_0', input: 'memory' }
            ]
        }
    }
}

const specByName = (catalog) => {
    const map = new Map()
    if (!Array.isArray(catalog)) return map
    for (const node of catalog) {
        if (node && typeof node.name === 'string') map.set(node.name, node)
    }
    return map
}

const anchorId = (nodeId, input) => `${nodeId}-input-${input.name}-${input.type}`

const buildNodeData = (spec, nodeId, savedInputs) => {
    const inputAnchors = []
    const inputParams = []
    const inputs = {}
    if (spec.credential) {
        inputParams.push({
            ...spec.credential,
            id: `${nodeId}-input-${spec.credential.name || 'credential'}-${spec.credential.type || 'credential'}`
        })
    }
    const specInputs = Array.isArray(spec.inputs) ? spec.inputs : []
    for (const input of specInputs) {
        if (!input || !input.name) continue
        const next = { ...input, id: anchorId(nodeId, input) }
        inputs[input.name] = input.default !== undefined && input.default !== null ? input.default : ''
        if (PARAM_TYPES.has(input.type)) inputParams.push(next)
        else inputAnchors.push(next)
    }
    const saved = savedInputs && typeof savedInputs === 'object' ? savedInputs : {}
    for (const key of Object.keys(saved)) {
        if (key in inputs || specInputs.some((input) => input && input.name === key)) inputs[key] = saved[key]
    }
    const baseClasses = Array.isArray(spec.baseClasses) && spec.baseClasses.length ? spec.baseClasses : [spec.type || spec.name]
    const outputAnchors = spec.hideOutput
        ? []
        : [
              {
                  id: `${nodeId}-output-${spec.name}-${baseClasses.join('|')}`,
                  name: spec.name,
                  label: spec.type || spec.label || spec.name,
                  description: spec.description || '',
                  type: baseClasses.join(' | ')
              }
          ]
    return {
        id: nodeId,
        label: spec.label || spec.name,
        name: spec.name,
        version: spec.version,
        type: spec.type || spec.name,
        category: spec.category || '',
        description: spec.description || '',
        baseClasses,
        inputAnchors,
        inputParams,
        inputs,
        outputAnchors,
        outputs: {},
        selected: false,
        credential: spec.credential ? '' : undefined
    }
}

const stickyData = (nodeId, note, spec) => {
    if (!spec) {
        return {
            id: nodeId,
            label: 'Sticky Note',
            name: 'stickyNote',
            version: 2,
            type: 'StickyNote',
            category: 'Utilities',
            baseClasses: ['StickyNote'],
            inputAnchors: [],
            inputParams: [{ label: '', name: 'note', type: 'string', id: `${nodeId}-input-note-string`, rows: 1, optional: true }],
            inputs: { note },
            outputAnchors: [],
            outputs: {},
            selected: false
        }
    }
    const data = buildNodeData(spec, nodeId, { note })
    data.outputAnchors = []
    data.inputs.note = note
    return data
}

export const hydrateLangflowFlow = (flow, catalog) => {
    if (!flow || !Array.isArray(flow.nodes) || !Array.isArray(flow.links)) {
        return { ok: false, reason: 'Langflow import could not build a canvas.' }
    }
    const specs = specByName(catalog)
    const missing = []
    for (const node of flow.nodes) {
        const name = node && node.data && node.data.name
        if (name && name !== 'stickyNote' && !specs.has(name)) missing.push(name)
    }
    if (missing.length) {
        return {
            ok: false,
            reason: `Langflow import could not place ${missing.join(', ')}. Reload the page and try again.`
        }
    }
    const nodes = flow.nodes.map((node) => {
        const name = node.data.name
        const saved = node.data.inputs || {}
        if (name === 'stickyNote') {
            return {
                ...node,
                type: 'stickyNote',
                data: stickyData(node.id, typeof saved.note === 'string' ? saved.note : '', specs.get('stickyNote'))
            }
        }
        return {
            id: node.id,
            position: node.position,
            type: 'customNode',
            data: buildNodeData(specs.get(name), node.id, saved)
        }
    })
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const edges = []
    for (const link of flow.links) {
        const source = byId.get(link.source)
        const target = byId.get(link.target)
        const sourceHandle = source && source.data.outputAnchors[0] && source.data.outputAnchors[0].id
        const targetAnchor = target && target.data.inputAnchors.find((anchor) => anchor.name === link.input)
        if (!source || !target || !sourceHandle || !targetAnchor) {
            return { ok: false, reason: 'Langflow import could not connect the chat model to the conversation chain.' }
        }
        const instance = `{{${link.source}.data.instance}}`
        target.data.inputs[link.input] = instance
        edges.push({
            source: link.source,
            target: link.target,
            sourceHandle,
            targetHandle: targetAnchor.id,
            type: 'buttonedge',
            id: `${link.source}-${sourceHandle}-${link.target}-${targetAnchor.id}`
        })
    }
    return { ok: true, nodes, edges, viewport: flow.viewport }
}
