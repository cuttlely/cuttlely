import * as fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

export type SampleTemplate = {
    id: string
    name: string
    templateName: string
    description: string
    flowData: string
    badge: string
    framework: string[]
    usecases: string[]
    categories: string[]
    type: 'Harness' | 'ETL' | 'Chatflow'
}

const samplesRoot = () => {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        if (fs.existsSync(path.join(dir, 'samples', 'harnesses')) && fs.existsSync(path.join(dir, 'samples', 'etl'))) return dir
        dir = path.dirname(dir)
    }
    return ''
}

const readJsonFiles = (dir: string, extension: string) => {
    if (!dir || !fs.existsSync(dir)) return []
    return fs
        .readdirSync(dir)
        .filter((file) => file.endsWith(extension))
        .flatMap((file) => {
            try {
                return [JSON.parse(fs.readFileSync(path.join(dir, file)).toString())]
            } catch {
                return []
            }
        })
}

const flowDataOf = (record: { flowData?: unknown }) => {
    if (!record?.flowData) return ''
    return typeof record.flowData === 'string' ? record.flowData : JSON.stringify(record.flowData)
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

export type TemplateNodeSpec = {
    inputs?: Array<{ name?: string; type?: string; default?: unknown; [key: string]: unknown }>
    outputs?: Array<{ name?: string; label?: string; type?: string; description?: string; [key: string]: unknown }>
    baseClasses?: string[]
    credential?: { name?: string; type?: string; [key: string]: unknown }
    hideOutput?: boolean
    description?: string
    type?: string
    name?: string
}

const asArray = <T>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : [])

const splitInputs = (nodeId: string, spec: TemplateNodeSpec | undefined) => {
    const inputAnchors: Array<Record<string, unknown>> = []
    const inputParams: Array<Record<string, unknown>> = []
    const defaults: Record<string, unknown> = {}
    const inputs = asArray(spec?.inputs)
    if (spec?.credential) {
        inputParams.push({
            ...spec.credential,
            id: `${nodeId}-input-${spec.credential.name || 'credential'}-${spec.credential.type || 'credential'}`
        })
    }
    for (const input of inputs) {
        const name = input?.name || 'input'
        const type = input?.type || 'string'
        const next = { ...input, id: `${nodeId}-input-${name}-${type}` }
        defaults[name] = input?.default ?? ''
        if (PARAM_TYPES.has(type)) inputParams.push(next)
        else inputAnchors.push(next)
    }
    return { inputAnchors, inputParams, defaults }
}

const classList = (value: unknown) => (Array.isArray(value) ? value.map((item) => String(item || '')).filter(Boolean) : [])

// Same ids as the canvas initNode: base classes joined with "|", no spaces.
const outputAnchorId = (nodeId: string, name: string, baseClasses: string[]) => {
    const suffix = baseClasses.length > 1 ? baseClasses.join('|') : baseClasses[0] || ''
    return `${nodeId}-output-${name}-${suffix}`
}

const outputAnchorsFor = (
    nodeId: string,
    data: { name?: string; type?: string; description?: string },
    spec: TemplateNodeSpec | undefined
) => {
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

const collectHandles = (node: { data?: Record<string, unknown> } | undefined, kind: 'source' | 'target') => {
    const data = (node?.data || {}) as Record<string, unknown>
    const handles: Array<{ id: string; name: string }> = []
    if (kind === 'source') {
        for (const anchor of asArray(data.outputAnchors as Array<Record<string, unknown>>)) {
            if (anchor?.id) handles.push({ id: String(anchor.id), name: String(anchor.name || '') })
            for (const option of asArray(anchor?.options as Array<Record<string, unknown>>)) {
                if (option?.id) handles.push({ id: String(option.id), name: String(option.name || '') })
            }
        }
        return handles
    }
    for (const anchor of asArray(data.inputAnchors as Array<Record<string, unknown>>)) {
        if (anchor?.id) handles.push({ id: String(anchor.id), name: String(anchor.name || '') })
    }
    return handles
}

const chooseHandle = (
    current: string | undefined,
    handles: Array<{ id: string; name: string }>,
    edge: { id?: string; targetHandle?: string },
    kind: 'source' | 'target'
) => {
    if (!handles.length) return current
    if (current && handles.some((handle) => handle.id === current)) return current
    const prefixed = current ? handles.filter((handle) => handle.id.startsWith(`${current}-`)) : []
    if (prefixed.length === 1) return prefixed[0].id
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

const repairFlowEdges = (nodes: Array<{ id?: string; data?: Record<string, unknown> }>, edges: Array<Record<string, unknown>>) => {
    const byId = new Map(nodes.filter((node) => node?.id).map((node) => [String(node.id), node]))
    for (const edge of edges) {
        if (!edge || typeof edge !== 'object') continue
        const sourceHandles = collectHandles(byId.get(String(edge.source || '')), 'source')
        const targetHandles = collectHandles(byId.get(String(edge.target || '')), 'target')
        const handleEdge = {
            id: typeof edge.id === 'string' ? edge.id : undefined,
            targetHandle: typeof edge.targetHandle === 'string' ? edge.targetHandle : undefined
        }
        if (sourceHandles.length)
            edge.sourceHandle = chooseHandle(
                typeof edge.sourceHandle === 'string' ? edge.sourceHandle : undefined,
                sourceHandles,
                handleEdge,
                'source'
            )
        if (targetHandles.length)
            edge.targetHandle = chooseHandle(
                typeof edge.targetHandle === 'string' ? edge.targetHandle : undefined,
                targetHandles,
                handleEdge,
                'target'
            )
    }
}

// Saved samples store inputs only. The marketplace canvas reads inputAnchors, inputParams, and outputAnchors.
export const normalizeTemplateFlow = (flowData: string, nodeByName?: (name: string) => TemplateNodeSpec | undefined): string => {
    if (typeof flowData !== 'string' || !flowData) return JSON.stringify({ nodes: [], edges: [] })
    let flow: { nodes?: unknown; edges?: unknown; [key: string]: unknown }
    try {
        flow = JSON.parse(flowData)
    } catch {
        return JSON.stringify({ nodes: [], edges: [] })
    }
    if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return flowData
    if (!('nodes' in flow) && !('edges' in flow)) return flowData
    const nodes = asArray(flow.nodes as Array<{ id?: string; data?: Record<string, unknown> }>)
    const edges = asArray(flow.edges as unknown[])
    for (const node of nodes) {
        const data = (node.data && typeof node.data === 'object' ? node.data : {}) as Record<string, unknown>
        node.data = data
        const needsAnchors = !Array.isArray(data.inputAnchors) || !Array.isArray(data.inputParams) || !Array.isArray(data.outputAnchors)
        if (!needsAnchors) continue
        const spec = typeof data.name === 'string' ? nodeByName?.(data.name) : undefined
        const split = splitInputs(String(node.id || data.id || 'node'), spec)
        const savedInputs =
            data.inputs && typeof data.inputs === 'object' && !Array.isArray(data.inputs) ? (data.inputs as Record<string, unknown>) : {}
        if (!Array.isArray(data.inputAnchors)) data.inputAnchors = split.inputAnchors
        if (!Array.isArray(data.inputParams)) data.inputParams = split.inputParams
        if (!Array.isArray(data.outputAnchors)) {
            data.outputAnchors = outputAnchorsFor(String(node.id || data.id || 'node'), data as { name?: string }, spec)
        }
        data.inputs = { ...split.defaults, ...savedInputs }
        if (!Array.isArray(data.baseClasses) && spec?.baseClasses) data.baseClasses = spec.baseClasses
    }
    repairFlowEdges(nodes, edges as Array<Record<string, unknown>>)
    return JSON.stringify({ ...flow, nodes, edges })
}

const readMarketplaceFolder = (folder: string, type: 'Chatflow' | 'AgentflowV2') => {
    const root = marketplaceRoot()
    const dir = root ? path.join(root, 'marketplaces', folder) : ''
    if (!dir || !fs.existsSync(dir)) return []
    return fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.json'))
        .flatMap((file) => {
            try {
                const flowData = fs.readFileSync(path.join(dir, file)).toString()
                const parsed = JSON.parse(flowData)
                return [
                    {
                        templateName: file.slice(0, -'.json'.length),
                        description: parsed?.description || '',
                        flowData,
                        badge: parsed?.badge,
                        framework: parsed?.framework,
                        usecases: parsed?.usecases,
                        type
                    }
                ]
            } catch {
                return []
            }
        })
}

// Chatflow and Agentflow V2 files the Templates API serves, plus the stock samples.
export const marketplaceFlowTemplates = () => {
    return [
        ...readMarketplaceFolder('chatflows', 'Chatflow'),
        ...readMarketplaceFolder('agentflowsv2', 'AgentflowV2'),
        ...sampleTemplates()
    ]
}

export const marketplaceRoot = () => {
    let dir = __dirname
    for (let i = 0; i < 8; i += 1) {
        if (fs.existsSync(path.join(dir, 'marketplaces', 'chatflows')) && fs.existsSync(path.join(dir, 'package.json'))) return dir
        dir = path.dirname(dir)
    }
    return ''
}

// A saved credential id must not reach the community template list.
const flowHasCredential = (flowData: string) => {
    try {
        const flow = JSON.parse(flowData)
        const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
        return nodes.some((node: { data?: { credential?: unknown; credentialId?: unknown } }) => {
            const credential = node?.data?.credential
            const credentialId = node?.data?.credentialId
            return Boolean(credential) || Boolean(credentialId)
        })
    } catch {
        return true
    }
}

const asTemplate = (
    record: { name?: string; description?: string; flowData?: unknown; usecases?: unknown },
    type: SampleTemplate['type']
) => {
    if (!record?.name) return null
    const flowData = flowDataOf(record)
    if (!flowData || flowHasCredential(flowData)) return null
    const usecases = Array.isArray(record.usecases) ? record.usecases.filter((item) => typeof item === 'string' && item) : []
    return {
        id: uuidv4(),
        name: record.name,
        templateName: record.name,
        description: record.description || '',
        flowData,
        badge: '',
        framework: [],
        usecases,
        categories: [],
        type
    }
}

// Stock samples on the Templates page. Harness and ETL were already listed this way.
// Chatflows use the same scan so a file under samples/chatflows shows up next to them.
export const sampleTemplates = (root = samplesRoot()): SampleTemplate[] => {
    if (!root) return []
    const templates: SampleTemplate[] = []
    for (const record of readJsonFiles(path.join(root, 'samples', 'harnesses'), '.canvas.json')) {
        const template = asTemplate(record, 'Harness')
        if (template) templates.push(template)
    }
    for (const record of readJsonFiles(path.join(root, 'samples', 'etl'), '.pipeline.json')) {
        const template = asTemplate(record, 'ETL')
        if (template) templates.push(template)
    }
    for (const record of readJsonFiles(path.join(root, 'samples', 'chatflows'), '.chatflow.json')) {
        const template = asTemplate(record, 'Chatflow')
        if (template) templates.push(template)
    }
    return templates
}
