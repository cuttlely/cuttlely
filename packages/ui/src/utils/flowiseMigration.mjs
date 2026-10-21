// Flowise migration scan. Pure data in, report out. No network and no secret values in the report.
// Deprecated nodes stay on the canvas. Unknown nodes and removed LlamaIndex nodes do not.
// The removed configuration-only cards are dropped with a note and do not block the import.
// Credential ids and password inputs are stripped the same way a Flowise export strips them.

import { isLangflowExport } from './langflowImport.mjs'
import { REMOVED_NODE_NAMES } from './removedNodes.mjs'

const CHATFLOW_NEEDS_ENDING_NODE = 'This chatflow cannot chat yet. Add a Chain, Agent, or Engine, connect the model to it, and save.'

const ENDING_CATEGORIES = new Set(['Chains', 'Agents', 'Engine', 'Multi Agents', 'Sequential Agents', 'Harness'])

// The 22 LlamaIndex nodes removed in D16. Names that do not say LlamaIndex are still that set.
const REMOVED_LLAMA = new Set([
    'anthropicAgentLlamaIndex',
    'openAIToolAgentLlamaIndex',
    'azureChatOpenAI_LlamaIndex',
    'chatAnthropic_LlamaIndex',
    'chatMistral_LlamaIndex',
    'chatOllama_LlamaIndex',
    'chatOpenAI_LlamaIndex',
    'chatTogetherAI_LlamaIndex',
    'chatGroq_LlamaIndex',
    'azureOpenAIEmbeddingsLlamaIndex',
    'openAIEmbedding_LlamaIndex',
    'contextChatEngine',
    'simpleChatEngine',
    'queryEngine',
    'subQuestionQueryEngine',
    'compactrefineLlamaIndex',
    'refineLlamaIndex',
    'simpleResponseBuilderLlamaIndex',
    'treeSummarizeLlamaIndex',
    'pineconeLlamaIndex',
    'simpleStoreLlamaIndex',
    'queryEngineToolLlamaIndex'
])

const WORKSPACE_KEYS = ['ChatFlow', 'AgentFlow', 'AgentFlowV2', 'AssistantFlow', 'DocumentStore']

const NOT_SECRET = /^(maxTokens|max_tokens|budgetTokens|tokenCount|inputTokens|outputTokens)$/i

const refused = (code, reason) => ({
    ok: false,
    level: 'refused',
    code,
    title: reason,
    reason,
    name: '',
    route: '/canvas',
    counts: { nodes: 0, edges: 0, clean: 0 },
    credentials: [],
    deprecated: [],
    unsupported: [],
    attention: [],
    fixes: [],
    canvas: null
})

const catalogEntries = (catalog) => {
    const list = Array.isArray(catalog) ? catalog : catalog && Array.isArray(catalog.nodes) ? catalog.nodes : []
    const map = new Map()
    for (const entry of list) {
        if (entry && typeof entry.name === 'string' && entry.name) map.set(entry.name, entry)
    }
    return map
}

const deprecateText = (entry) => {
    const raw = (entry && (entry.deprecateMessage || entry.reason)) || 'This node is deprecated.'
    return String(raw).replace(/^Marked deprecated in place\. Not deleted\.\s*/, '')
}

const isDeprecated = (entry) => {
    if (!entry) return false
    if (entry.disposition === 'replaced') return true
    if (entry.badge === 'DEPRECATING') return true
    return false
}

const isSecretKey = (name) => {
    if (!name || NOT_SECRET.test(name)) return false
    if (name === 'FLOWISE_CREDENTIAL_ID') return true
    if (/(api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)$/i.test(name)) return true
    if (/ApiKey|APIKey|apiKey|AccessToken|SecretKey/.test(name)) return true
    return false
}

const stripCredentialIds = (value) => {
    if (Array.isArray(value)) return value.map((item) => stripCredentialIds(item))
    if (!value || typeof value !== 'object') return value
    const next = {}
    for (const [key, child] of Object.entries(value)) {
        if (key === 'FLOWISE_CREDENTIAL_ID') continue
        next[key] = stripCredentialIds(child)
    }
    return next
}

const hasCredentialId = (value) => {
    if (Array.isArray(value)) return value.some((item) => hasCredentialId(item))
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) => key === 'FLOWISE_CREDENTIAL_ID' || hasCredentialId(child))
}

// Model and tool settings on agent canvases live in *ModelConfig / *ToolConfig, not on a credential input.
const CONFIG_KEY = /(?:Model|Tool)Config$/

const TOOL_FILE_MESSAGE = 'This is a Flowise tool, not a flow. Open Tools > Load to import it.'

const aliasFixLine = (label, from, to) => `Updated ${label} from ${from} to ${to}.`
const conversationPromptFixLine = (label) => `Copied the system message on ${label} into its prompt field.`

const CUSTOM_TOOL_RECREATE = 'Recreate it in Tools, then pick it in this node.'
const customToolLine = (name, id) =>
    name && name !== id ? `Custom tool '${name}' (${id}). ${CUSTOM_TOOL_RECREATE}` : `Custom tool ${id}. ${CUSTOM_TOOL_RECREATE}`

// Output handle ids are `${nodeId}-output-${cardName}-${classes}`. These two old card names use the
// same anchor names and types as the current cards, so only that card-name segment has to change.
const NAME_ALIASES = {
    ollamaEmbeddings: {
        to: 'ollamaEmbedding',
        inputs: [],
        outputType: 'OllamaEmbeddings | Embeddings'
    },
    openAIToolAgent: {
        to: 'toolAgent',
        inputs: [
            ['tools', 'Tool'],
            ['memory', 'BaseChatMemory'],
            ['model', 'BaseChatModel'],
            ['chatPromptTemplate', 'ChatPromptTemplate'],
            ['inputModeration', 'Moderation']
        ],
        outputType: 'AgentExecutor | BaseChain | Runnable'
    }
}

const isToolFile = (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    if (Array.isArray(parsed.nodes)) return false
    return (
        typeof parsed.name === 'string' &&
        parsed.name.trim() !== '' &&
        Object.prototype.hasOwnProperty.call(parsed, 'schema') &&
        Object.prototype.hasOwnProperty.call(parsed, 'func')
    )
}

const specRequiresCredential = (catalog, selected) => {
    if (!selected || typeof selected !== 'string' || !catalog.has(selected)) return false
    const cred = catalog.get(selected).credential
    if (!cred) return false
    if (cred === true) return true
    if (typeof cred === 'object') return cred.optional !== true
    return false
}

const holdsCredential = (value) => {
    if (Array.isArray(value)) return value.some((item) => holdsCredential(item))
    if (!value || typeof value !== 'object') return false
    if (present(value.FLOWISE_CREDENTIAL_ID) || present(value.credential)) return true
    return Object.values(value).some((child) => child && typeof child === 'object' && holdsCredential(child))
}

const selectedForConfig = (parent, key, config) => {
    const base = key.endsWith('Config') ? key.slice(0, -'Config'.length) : ''
    if (base && parent && typeof parent[base] === 'string' && parent[base]) return parent[base]
    if (base && config && typeof config[base] === 'string' && config[base]) return config[base]
    return ''
}

const configSlot = (key) => (/ModelConfig$/.test(key) ? 'Model credential' : 'Tool credential')

const noteConfigCredentials = (inputs, catalog, push) => {
    const walk = (parent) => {
        if (!parent || typeof parent !== 'object') return
        if (Array.isArray(parent)) {
            parent.forEach((item) => walk(item))
            return
        }
        for (const [key, value] of Object.entries(parent)) {
            if ((CONFIG_KEY.test(key) || key === 'toolConfig') && value && typeof value === 'object') {
                const entries = Array.isArray(value) ? value : [value]
                for (const config of entries) {
                    if (!config || typeof config !== 'object' || Array.isArray(config)) continue
                    const selected = selectedForConfig(parent, key, config)
                    if (holdsCredential(config) || specRequiresCredential(catalog, selected)) push(configSlot(key))
                }
            }
            if (value && typeof value === 'object') walk(value)
        }
    }
    walk(inputs)
}

const clearConfigCredentialIds = (inputs) => {
    let cleared = false
    const clearValue = (value) => {
        if (Array.isArray(value)) {
            value.forEach((item) => clearValue(item))
            return
        }
        if (!value || typeof value !== 'object') return
        if (typeof value.credential === 'string' && value.credential) {
            cleared = true
            value.credential = ''
        }
        if (Object.prototype.hasOwnProperty.call(value, 'FLOWISE_CREDENTIAL_ID')) {
            if (value.FLOWISE_CREDENTIAL_ID) cleared = true
            delete value.FLOWISE_CREDENTIAL_ID
        }
        for (const child of Object.values(value)) {
            if (child && typeof child === 'object') clearValue(child)
        }
    }
    const walk = (parent) => {
        if (!parent || typeof parent !== 'object') return
        if (Array.isArray(parent)) {
            parent.forEach((item) => walk(item))
            return
        }
        for (const [key, value] of Object.entries(parent)) {
            if ((CONFIG_KEY.test(key) || key === 'toolConfig') && value && typeof value === 'object') clearValue(value)
            else if (value && typeof value === 'object') walk(value)
        }
    }
    walk(inputs)
    return cleared
}

const anchorsMatchAlias = (data, oldName, spec) => {
    const allowed = new Map(spec.inputs)
    for (const anchor of data.inputAnchors || []) {
        if (!anchor || allowed.get(anchor.name) !== anchor.type) return false
    }
    const outputs = data.outputAnchors || []
    if (outputs.length !== 1) return false
    const output = outputs[0]
    if (!output || output.type !== spec.outputType) return false
    const embeds = typeof output.id === 'string' && output.id.includes(`-output-${oldName}-`)
    return output.name === oldName || embeds
}

const rewriteOutputToken = (value, from, to) => {
    if (typeof value !== 'string' || !value.includes(`-output-${from}-`)) return value
    return value.split(`-output-${from}-`).join(`-output-${to}-`)
}

const applyAlias = (data, from, to) => {
    data.name = to
    if (data.type === from) data.type = to
    const rewriteAnchor = (anchor) => {
        if (!anchor || typeof anchor !== 'object') return
        if (anchor.name === from) anchor.name = to
        if (typeof anchor.id === 'string') anchor.id = rewriteOutputToken(anchor.id, from, to)
        if (Array.isArray(anchor.options)) anchor.options.forEach(rewriteAnchor)
    }
    for (const anchor of data.outputAnchors || []) rewriteAnchor(anchor)
    for (const anchor of data.inputAnchors || []) rewriteAnchor(anchor)
}

const noteCustomTools = (nodeName, inputs, label, attention) => {
    const push = (toolName, toolId) => {
        const id = String(toolId || '').trim()
        if (!id) return
        const line = customToolLine(String(toolName || '').trim(), id)
        if (!attention.includes(line)) attention.push(line)
    }
    const fromCustom = (record) => {
        // The runtime always loads the tool by id, so an inline function does not make it portable.
        if (!record || typeof record !== 'object' || Array.isArray(record)) return
        const id = typeof record.selectedTool === 'string' ? record.selectedTool.trim() : ''
        const named = typeof record.customToolName === 'string' ? record.customToolName.trim() : ''
        if (id) push(named, id)
    }
    if (nodeName === 'customTool') fromCustom(inputs)
    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return
        if (Array.isArray(obj)) {
            obj.forEach((item) => walk(item))
            return
        }
        const chosen = obj.agentSelectedTool || obj.toolAgentflowSelectedTool || (obj.selectedTool === 'customTool' ? 'customTool' : '')
        const config = obj.agentSelectedToolConfig || obj.toolAgentflowSelectedToolConfig || obj.selectedToolConfig || obj.toolConfig
        if (chosen === 'customTool') fromCustom(config && typeof config === 'object' && !Array.isArray(config) ? config : obj)
        for (const value of Object.values(obj)) {
            if (value && typeof value === 'object') walk(value)
        }
    }
    if (inputs && typeof inputs === 'object') walk(inputs)
}

const carryConversationPrompt = (inputs) => {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return false
    const current = inputs.systemMessagePrompt
    const older = inputs.systemMessage
    if ((current === undefined || current === null || current === '') && typeof older === 'string' && older) {
        inputs.systemMessagePrompt = older
        return true
    }
    return false
}

const nodeLabel = (data, fallback) => {
    if (data && typeof data.label === 'string' && data.label.trim()) return data.label.trim()
    if (data && typeof data.name === 'string' && data.name.trim()) return data.name.trim()
    return fallback
}

const unwrapGraph = (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (Array.isArray(parsed.nodes)) {
        return {
            name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
            type: typeof parsed.type === 'string' ? parsed.type : '',
            graph: parsed
        }
    }
    const inner = parsed.flowData
    if (typeof inner === 'string') {
        try {
            const graph = JSON.parse(inner)
            if (graph && typeof graph === 'object' && Array.isArray(graph.nodes)) {
                return {
                    name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
                    type: typeof parsed.type === 'string' ? parsed.type : '',
                    graph
                }
            }
        } catch {
            return null
        }
    }
    if (inner && typeof inner === 'object' && Array.isArray(inner.nodes)) {
        return {
            name: typeof parsed.name === 'string' ? parsed.name.trim() : '',
            type: typeof parsed.type === 'string' ? parsed.type : '',
            graph: inner
        }
    }
    return null
}

const isWorkspaceExport = (parsed) =>
    !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && WORKSPACE_KEYS.some((key) => Array.isArray(parsed[key]))

export const migrationRoute = (nodes, type) => {
    const names = new Set()
    const categories = new Set()
    for (const node of nodes || []) {
        const data = node && node.data
        if (data && typeof data.name === 'string') names.add(data.name)
        if (data && typeof data.category === 'string') categories.add(data.category)
    }
    const upper = String(type || '').toUpperCase()
    if (upper === 'CHATFLOW') return '/canvas'
    if (upper === 'HARNESS' || names.has('harnessChief') || names.has('harnessSpecialist')) return '/harnesscanvas'
    if (upper === 'ETL') return '/etlcanvas'
    if (upper === 'AGENTFLOW' || categories.has('Agent Flows')) return '/v2/agentcanvas'
    if (upper === 'MULTIAGENT' || categories.has('Sequential Agents') || categories.has('Multi Agents')) return '/agentcanvas'
    if (names.has('harnessChief') || names.has('harnessSpecialist')) return '/harnesscanvas'
    if (categories.has('Agent Flows')) return '/v2/agentcanvas'
    return '/canvas'
}

const chatflowWouldChat = (nodes, edges) => {
    if (!nodes.length) return false
    const outgoing = {}
    const incoming = {}
    for (const node of nodes) {
        outgoing[node.id] = 0
        incoming[node.id] = 0
    }
    for (const edge of edges) {
        if (outgoing[edge.source] !== undefined) outgoing[edge.source] += 1
        if (incoming[edge.target] !== undefined) incoming[edge.target] += 1
    }
    const endingIds = []
    if (nodes.length === 1) endingIds.push(nodes[0].id)
    else {
        for (const node of nodes) {
            if (!outgoing[node.id] && incoming[node.id] > 0) endingIds.push(node.id)
        }
    }
    if (!endingIds.length) return false
    return endingIds.some((id) => {
        const data = nodes.find((node) => node.id === id)?.data
        if (!data) return false
        if (data.outputs?.output === 'EndingNode') return true
        return ENDING_CATEGORIES.has(data.category)
    })
}

const drawable = (node) => {
    const data = node && node.data
    if (!data || typeof data !== 'object') return false
    return Array.isArray(data.inputParams) && Array.isArray(data.inputAnchors) && Array.isArray(data.outputAnchors)
}

const present = (value) => value !== undefined && value !== null && value !== ''

/**
 * Scan one Flowise export.
 * @param {unknown} parsed
 * @param {{ catalog?: Array<{name: string, disposition?: string, reason?: string, badge?: string, deprecateMessage?: string}> | { nodes: unknown[] } }} [options]
 */
export const scanFlowiseMigration = (parsed, options = {}) => {
    if (isLangflowExport(parsed)) {
        return refused('langflow', 'That file is Langflow JSON. Use Import Langflow JSON.')
    }
    const unwrapped = unwrapGraph(parsed)
    if (!unwrapped) {
        if (isWorkspaceExport(parsed)) {
            return refused('workspace', 'Workspace export is not supported. Import one chatflow JSON.')
        }
        if (isToolFile(parsed)) return refused('tool', TOOL_FILE_MESSAGE)
        return refused('not-flowise', 'That file is not a Flowise chatflow JSON.')
    }

    const catalog = catalogEntries(options.catalog)
    const { graph, type } = unwrapped
    const sourceNodes = graph.nodes
    const sourceEdges = Array.isArray(graph.edges) ? graph.edges : []
    if (!sourceNodes.length) return refused('empty', 'This file has no nodes.')

    const credentials = []
    const deprecated = []
    const unsupported = []
    const fixes = []
    const attention = []
    const aliasPairs = []
    const prepared = []
    let clean = 0

    for (const node of sourceNodes) {
        if (!node || typeof node !== 'object') {
            unsupported.push({ nodeId: '', label: 'Node', name: '', message: 'A node in this file is not an object.' })
            continue
        }
        const data = node.data && typeof node.data === 'object' ? node.data : null
        let name = data && typeof data.name === 'string' ? data.name : ''
        const id = typeof node.id === 'string' && node.id ? node.id : data && typeof data.id === 'string' ? data.id : ''
        const label = nodeLabel(data, 'Node')
        if (!name || !id) {
            unsupported.push({
                nodeId: id,
                label,
                name,
                message: 'This node has no name, so the canvas cannot place it.'
            })
            continue
        }
        if (!catalog.has(name) && REMOVED_NODE_NAMES.has(name)) {
            fixes.push(
                `Dropped ${label}. Cuttlely no longer has this card. Set it up in Analytics (Chatflow Configuration) or Speech to Text instead.`
            )
            continue
        }
        if (!drawable(node)) {
            unsupported.push({
                nodeId: id,
                label,
                name,
                message: 'This node is missing its input or output list, so the canvas cannot draw it.'
            })
            continue
        }

        const alias = NAME_ALIASES[name]
        if (alias && catalog.has(alias.to) && anchorsMatchAlias(data, name, alias)) {
            applyAlias(data, name, alias.to)
            aliasPairs.push({ from: name, to: alias.to })
            fixes.push(aliasFixLine(label, name, alias.to))
            name = alias.to
        }

        const entry = catalog.get(name)
        if (!entry && REMOVED_LLAMA.has(name)) {
            unsupported.push({
                nodeId: id,
                label,
                name,
                message: 'LlamaIndex was removed from Cuttlely. This node is not placed on the canvas.'
            })
            continue
        }
        if (!entry) {
            unsupported.push({
                nodeId: id,
                label,
                name,
                message: 'Cuttlely has no node with this name. The canvas would not run it.'
            })
            continue
        }

        const params = data.inputParams
        const inputs = data.inputs && typeof data.inputs === 'object' && !Array.isArray(data.inputs) ? data.inputs : {}
        const passwordNames = new Set(
            params
                .filter((param) => param && (param.type === 'password' || param.type === 'file' || param.type === 'folder'))
                .map((param) => param.name)
        )
        const credentialParams = params.filter((param) => param && param.type === 'credential')
        let clearedCredential = !!data.credential || hasCredentialId(inputs)
        let strippedSecret = false
        let strippedFile = false

        const nextInputs = stripCredentialIds(inputs)
        for (const key of Object.keys(nextInputs)) {
            if (!present(nextInputs[key])) continue
            const param = params.find((item) => item && item.name === key)
            if (passwordNames.has(key) || isSecretKey(key)) {
                if (param && (param.type === 'file' || param.type === 'folder')) strippedFile = true
                else strippedSecret = true
                delete nextInputs[key]
            }
        }

        for (const param of credentialParams) {
            const required = !param.optional
            const hadValue = present(inputs[param.name]) || !!data.credential || hasCredentialId(inputs)
            if (required || hadValue) {
                credentials.push({
                    nodeId: id,
                    label,
                    name,
                    slot: typeof param.label === 'string' && param.label.trim() ? param.label.trim() : 'Credential'
                })
            }
            if (present(nextInputs[param.name])) {
                clearedCredential = true
                delete nextInputs[param.name]
            }
        }
        const topLevelCredentialId = Object.prototype.hasOwnProperty.call(inputs, 'FLOWISE_CREDENTIAL_ID')
        if (!credentialParams.length && (data.credential || topLevelCredentialId)) {
            credentials.push({ nodeId: id, label, name, slot: 'Credential' })
        }
        noteConfigCredentials(inputs, catalog, (slot) => {
            credentials.push({ nodeId: id, label, name, slot })
        })
        if (clearConfigCredentialIds(nextInputs)) clearedCredential = true
        if (name === 'conversationChain' && carryConversationPrompt(nextInputs)) {
            fixes.push(conversationPromptFixLine(label))
        }
        noteCustomTools(name, inputs, label, attention)
        for (const param of params) {
            if (!param || param.type !== 'password' || !present(inputs[param.name])) continue
            const slot = typeof param.label === 'string' && param.label.trim() ? param.label.trim() : 'API key'
            if (!credentials.some((item) => item.nodeId === id && item.slot === slot)) {
                credentials.push({ nodeId: id, label, name, slot })
            }
        }

        if (clearedCredential) fixes.push(`Cleared the credential on ${label}. The saved value was not copied.`)
        if (strippedSecret) fixes.push(`Removed a saved API key on ${label}. It was not copied.`)
        if (strippedFile) fixes.push(`Removed a file input on ${label}. Upload it again on the node.`)

        const nextData = stripCredentialIds({ ...data, inputs: nextInputs, selected: false })
        delete nextData.credential
        prepared.push({
            ...node,
            id,
            selected: false,
            data: { ...nextData, id: data.id || id }
        })

        if (isDeprecated(entry)) {
            deprecated.push({ nodeId: id, label, name, message: deprecateText(entry) })
        } else if (!credentials.some((item) => item.nodeId === id)) {
            clean += 1
        }
    }

    const keptIds = new Set(prepared.map((node) => node.id))
    const edges = []
    let droppedEdges = 0
    for (const edge of sourceEdges) {
        if (!edge || typeof edge !== 'object' || !keptIds.has(edge.source) || !keptIds.has(edge.target)) {
            droppedEdges += 1
            continue
        }
        let sourceHandle = edge.sourceHandle
        let targetHandle = edge.targetHandle
        for (const pair of aliasPairs) {
            sourceHandle = rewriteOutputToken(sourceHandle, pair.from, pair.to)
            targetHandle = rewriteOutputToken(targetHandle, pair.from, pair.to)
        }
        if (sourceHandle === edge.sourceHandle && targetHandle === edge.targetHandle) edges.push(edge)
        else edges.push({ ...edge, sourceHandle, targetHandle })
    }
    if (droppedEdges && !unsupported.length) {
        fixes.push(
            droppedEdges === 1
                ? 'Dropped 1 edge that pointed at a missing node.'
                : `Dropped ${droppedEdges} edges that pointed at a missing node.`
        )
    }

    const name = unwrapped.name || 'Imported Flowise chatflow'
    const route = migrationRoute(prepared.length ? prepared : sourceNodes, type)
    if (!unsupported.length && route === '/canvas' && !chatflowWouldChat(prepared, edges)) {
        attention.push(CHATFLOW_NEEDS_ENDING_NODE)
    }

    if (unsupported.length) {
        return {
            ok: false,
            level: 'refused',
            code: 'unsupported',
            title: 'This file has nodes Cuttlely cannot place.',
            reason: 'This file has nodes Cuttlely cannot place. Nothing was opened.',
            name,
            route,
            counts: { nodes: sourceNodes.length, edges: sourceEdges.length, clean },
            credentials,
            deprecated,
            unsupported,
            attention,
            fixes: [],
            canvas: null
        }
    }

    const canvas = {
        nodes: prepared,
        edges
    }
    if (graph.viewport && typeof graph.viewport === 'object') canvas.viewport = graph.viewport

    const needsAttention = credentials.length > 0 || deprecated.length > 0 || attention.length > 0 || fixes.length > 0
    return {
        ok: true,
        level: needsAttention ? 'attention' : 'compatible',
        code: needsAttention ? 'attention' : 'compatible',
        title: needsAttention ? 'Ready to open, with items to finish' : 'Ready to open',
        reason: null,
        name,
        route,
        counts: { nodes: prepared.length, edges: edges.length, clean },
        credentials,
        deprecated,
        unsupported,
        attention,
        fixes,
        canvas
    }
}
