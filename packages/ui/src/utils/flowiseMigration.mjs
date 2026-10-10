// Flowise migration scan. Pure data in, report out. No network and no secret values in the report.
// Deprecated nodes stay on the canvas. Unknown nodes and removed LlamaIndex nodes do not.
// Credential ids and password inputs are stripped the same way a Flowise export strips them.

import { isLangflowExport } from './langflowImport.mjs'

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
    const prepared = []
    let clean = 0

    for (const node of sourceNodes) {
        if (!node || typeof node !== 'object') {
            unsupported.push({ nodeId: '', label: 'Node', name: '', message: 'A node in this file is not an object.' })
            continue
        }
        const data = node.data && typeof node.data === 'object' ? node.data : null
        const name = data && typeof data.name === 'string' ? data.name : ''
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
        if (!drawable(node)) {
            unsupported.push({
                nodeId: id,
                label,
                name,
                message: 'This node is missing its input or output list, so the canvas cannot draw it.'
            })
            continue
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
        if (!credentialParams.length && (data.credential || hasCredentialId(inputs))) {
            credentials.push({ nodeId: id, label, name, slot: 'Credential' })
        }
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
        edges.push(edge)
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
    const attention = []
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
