// A sample canvas stores inputs only. CanvasNode reads inputParams, inputAnchors, and outputAnchors.
// Missing arrays throw on .length. Fill them on load, and from the node catalog when that catalog is already loaded.

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

const asArray = (value) => (Array.isArray(value) ? value : [])

function classList(value) {
    return asArray(value)
        .map((item) => String(item || ''))
        .filter(Boolean)
}

// Same ids as initNode in genericHelper.js: base classes joined with "|", no spaces.
function outputAnchorId(nodeId, name, baseClasses) {
    const classes = classList(baseClasses)
    const suffix = classes.length > 1 ? classes.join('|') : classes[0] || ''
    return `${nodeId}-output-${name}-${suffix}`
}

function outputAnchorsFor(nodeId, data, spec) {
    if (spec?.hideOutput) return []
    const outputs = asArray(spec?.outputs)
    if (outputs.length) {
        return [
            {
                name: 'output',
                label: 'Output',
                type: 'options',
                description: outputs[0]?.description || '',
                options: outputs.map((output) => {
                    const classes = classList(output.baseClasses)
                    const type = classes.length > 1 ? classes.join(' | ') : classes[0] || output.type || ''
                    return {
                        ...output,
                        id: outputAnchorId(nodeId, output.name || 'output', classes),
                        type
                    }
                }),
                default: outputs[0]?.name
            }
        ]
    }
    const classes = classList(spec?.baseClasses)
    const name = data.name || spec?.name || 'output'
    const type = classes.length ? classes.join(' | ') : spec?.type || data.type || 'string'
    const idType = classes.length ? classes : [spec?.type || data.type || 'string']
    return [
        {
            id: outputAnchorId(nodeId, name, idType),
            name,
            label: data.type || spec?.type || name,
            description: data.description || spec?.description || '',
            type
        }
    ]
}

function splitInputs(nodeId, spec) {
    const inputAnchors = []
    const inputParams = []
    const defaults = {}
    if (spec?.credential) {
        inputParams.push({
            ...spec.credential,
            id: `${nodeId}-input-${spec.credential.name || 'credential'}-${spec.credential.type || 'credential'}`
        })
    }
    for (const input of asArray(spec?.inputs)) {
        const name = input?.name || 'input'
        const type = input?.type || 'string'
        const next = { ...input, id: `${nodeId}-input-${name}-${type}` }
        defaults[name] = input?.default ?? ''
        if (PARAM_TYPES.has(type)) inputParams.push(next)
        else inputAnchors.push(next)
    }
    return { inputAnchors, inputParams, defaults }
}

function carryConversationPrompt(data) {
    if (!data || data.name !== 'conversationChain') return
    const inputs = data.inputs
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return
    const current = inputs.systemMessagePrompt
    const older = inputs.systemMessage
    if ((current === undefined || current === null || current === '') && typeof older === 'string' && older) {
        inputs.systemMessagePrompt = older
    }
}

export function normalizeNodeData(data, spec) {
    if (!data || typeof data !== 'object') return data
    carryConversationPrompt(data)
    const missingParams = !Array.isArray(data.inputParams)
    const missingAnchors = !Array.isArray(data.inputAnchors)
    const missingOutputs = !Array.isArray(data.outputAnchors)
    if (!missingParams && !missingAnchors && !missingOutputs) return data
    const nodeId = String(data.id || 'node')
    if (spec) {
        const split = splitInputs(nodeId, spec)
        const saved = data.inputs && typeof data.inputs === 'object' && !Array.isArray(data.inputs) ? data.inputs : {}
        if (missingAnchors) data.inputAnchors = split.inputAnchors
        if (missingParams) data.inputParams = split.inputParams
        if (missingOutputs) data.outputAnchors = outputAnchorsFor(nodeId, data, spec)
        data.inputs = { ...split.defaults, ...saved }
        if (!Array.isArray(data.baseClasses) && spec.baseClasses) data.baseClasses = spec.baseClasses
        delete data.cuttlelyRawNode
        return data
    }
    if (missingParams) data.inputParams = []
    if (missingAnchors) data.inputAnchors = []
    if (missingOutputs) data.outputAnchors = []
    data.cuttlelyRawNode = true
    return data
}

export function specsByName(list) {
    const specs = new Map()
    if (!Array.isArray(list)) return specs
    for (const node of list) {
        if (node && typeof node.name === 'string') specs.set(node.name, node)
    }
    return specs
}

function collectHandles(node, kind) {
    const data = node?.data || {}
    const handles = []
    if (kind === 'source') {
        for (const anchor of asArray(data.outputAnchors)) {
            if (anchor?.id) handles.push({ id: String(anchor.id), name: anchor.name || '' })
            for (const option of asArray(anchor?.options)) {
                if (option?.id) handles.push({ id: String(option.id), name: option.name || '' })
            }
        }
        return handles
    }
    for (const anchor of asArray(data.inputAnchors)) {
        if (anchor?.id) handles.push({ id: String(anchor.id), name: anchor.name || '' })
    }
    return handles
}

function chooseHandle(current, handles, edge, kind) {
    if (!handles.length) return current
    if (current && handles.some((handle) => handle.id === current)) return current
    const prefixed = current ? handles.filter((handle) => handle.id.startsWith(`${current}-`)) : []
    if (prefixed.length === 1) return prefixed[0].id
    const legacy = !current || prefixed.length > 0 || !handles.some((handle) => handle.id === current)
    if (!legacy) return current
    const inputName =
        String(edge?.targetHandle || '')
            .split('-input-')[1]
            ?.split('-')[0] || ''
    const edgeName =
        String(edge?.id || '')
            .split('-')
            .pop() || ''
    const named = handles.filter((handle) => handle.name && (handle.name === inputName || handle.name === edgeName))
    if (named.length === 1) return named[0].id
    if (!current && handles.length === 1) return handles[0].id
    if (kind === 'source') return handles[0].id
    if (prefixed.length) return prefixed[0].id
    return current
}

// Older samples stored chief, specialist, and attached handles without the type suffix, and omitted sourceHandle.
export function repairFlowEdges(flow) {
    if (!flow || typeof flow !== 'object' || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) return flow
    const byId = new Map(flow.nodes.filter((node) => node?.id).map((node) => [node.id, node]))
    for (const edge of flow.edges) {
        if (!edge || typeof edge !== 'object') continue
        const sourceHandles = collectHandles(byId.get(edge.source), 'source')
        const targetHandles = collectHandles(byId.get(edge.target), 'target')
        if (sourceHandles.length) edge.sourceHandle = chooseHandle(edge.sourceHandle, sourceHandles, edge, 'source')
        if (targetHandles.length) edge.targetHandle = chooseHandle(edge.targetHandle, targetHandles, edge, 'target')
    }
    return flow
}

export function normalizeCanvasFlow(flow, specs) {
    if (!flow || typeof flow !== 'object') return flow
    const byName = specs instanceof Map ? specs : specsByName(specs)
    if (Array.isArray(flow.nodes)) {
        for (const node of flow.nodes) {
            if (!node || !node.data) continue
            normalizeNodeData(node.data, byName.get(node.data.name))
        }
    }
    repairFlowEdges(flow)
    return flow
}

// A node loaded before the catalog arrived still has cuttlelyRawNode. Fill it once the spec exists.
export function hydrateRawCanvasNodes(nodes, specs) {
    if (!Array.isArray(nodes)) return nodes
    const byName = specs instanceof Map ? specs : specsByName(specs)
    let changed = false
    const next = nodes.map((node) => {
        if (!node?.data?.cuttlelyRawNode) return node
        const spec = byName.get(node.data.name)
        if (!spec) return node
        const data = { ...node.data }
        delete data.inputParams
        delete data.inputAnchors
        delete data.outputAnchors
        delete data.cuttlelyRawNode
        normalizeNodeData(data, spec)
        changed = true
        return { ...node, data }
    })
    return changed ? next : nodes
}

export function stripRawCanvasMarker(data) {
    if (data && typeof data === 'object') delete data.cuttlelyRawNode
    return data
}
