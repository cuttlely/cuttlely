import * as fs from 'fs'
import path from 'path'
import { normalizeTemplateFlow } from './sampleTemplates'
import { LayoutNodeSpec, estimateTemplateNodeSize } from './templateLayout'

// The template open check: every bundled canvas (Templates page and samples) must draw, keep its cards apart, connect
// only to plug points that exist, and use only parts this build knows. It reads the files the way the canvas loads them,
// so it runs in verify without a browser. The screenshot gallery (scripts/live-e2e/template-gallery.mjs) is the visual half.

export type CanvasKind = 'chatflow' | 'agentflow' | 'workflow' | 'harness' | 'pipeline'

export type BundledCanvas = {
    kind: CanvasKind
    file: string
    name: string
    flow: { nodes: FlowNode[]; edges: FlowEdge[] }
}

type FlowNode = {
    id?: unknown
    type?: unknown
    parentNode?: unknown
    width?: unknown
    height?: unknown
    position?: { x?: unknown; y?: unknown }
    data?: Record<string, any>
}

type FlowEdge = { id?: unknown; source?: unknown; target?: unknown; sourceHandle?: unknown; targetHandle?: unknown }

// Card types each canvas draws. Anything else would render as a blank default box.
const CARD_TYPES: Record<CanvasKind, Set<string>> = {
    chatflow: new Set(['customNode', 'stickyNote']),
    agentflow: new Set(['customNode', 'stickyNote']),
    harness: new Set(['customNode', 'stickyNote']),
    pipeline: new Set(['customNode', 'stickyNote']),
    workflow: new Set(['agentFlow', 'stickyNote', 'iteration'])
}

const STICKY_NAMES = new Set(['stickyNote', 'stickyNoteAgentflow'])

const SOURCES: Array<{ kind: CanvasKind; dir: string[]; suffix: string }> = [
    { kind: 'chatflow', dir: ['packages', 'server', 'marketplaces', 'chatflows'], suffix: '.json' },
    { kind: 'agentflow', dir: ['packages', 'server', 'marketplaces', 'agentflows'], suffix: '.json' },
    { kind: 'workflow', dir: ['packages', 'server', 'marketplaces', 'agentflowsv2'], suffix: '.json' },
    { kind: 'chatflow', dir: ['samples', 'chatflows'], suffix: '.chatflow.json' },
    { kind: 'harness', dir: ['samples', 'harnesses'], suffix: '.canvas.json' },
    { kind: 'pipeline', dir: ['samples', 'etl'], suffix: '.pipeline.json' }
]

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

export const repoRoot = (start = __dirname) => {
    let dir = start
    for (let i = 0; i < 8; i += 1) {
        if (fs.existsSync(path.join(dir, 'samples')) && fs.existsSync(path.join(dir, 'packages', 'server', 'marketplaces'))) return dir
        dir = path.dirname(dir)
    }
    return ''
}

// Every bundled canvas, parsed the way the Templates page and Use Template read it.
export const bundledCanvases = (root = repoRoot()): BundledCanvas[] => {
    const canvases: BundledCanvas[] = []
    for (const source of SOURCES) {
        const dir = path.join(root, ...source.dir)
        if (!fs.existsSync(dir)) continue
        for (const file of fs
            .readdirSync(dir)
            .filter((name) => name.endsWith(source.suffix))
            .sort()) {
            const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
            const raw = record.flowData === undefined ? record : record.flowData
            const flow = typeof raw === 'string' ? JSON.parse(raw) : raw
            canvases.push({
                kind: source.kind,
                file: path.join(...source.dir, file),
                name: String(record.name || file.replace(/\.json$/, '')),
                flow: { nodes: asArray<FlowNode>(flow?.nodes), edges: asArray<FlowEdge>(flow?.edges) }
            })
        }
    }
    return canvases
}

type Box = { id: string; parent: string; x: number; y: number; w: number; h: number }

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

// Plug points a card offers. Chatflow-style cards list them in their anchors (an options output lists one per choice).
// A workflow card takes connections on its own id and sends them from its output anchors.
const plugPoints = (node: FlowNode, kind: CanvasKind, outputNames: (name: string) => string[]) => {
    const data = node.data || {}
    const outputs = new Set<string>()
    // The running server builds a named output for each one the node declares.
    for (const name of outputNames(String(data.name || ''))) outputs.add(`${String(node.id)}-output-${name}`)
    for (const anchor of asArray<Record<string, any>>(data.outputAnchors)) {
        if (anchor?.id) outputs.add(String(anchor.id))
        for (const option of asArray<Record<string, any>>(anchor?.options)) if (option?.id) outputs.add(String(option.id))
    }
    const inputs = new Set<string>()
    for (const anchor of asArray<Record<string, any>>(data.inputAnchors)) if (anchor?.id) inputs.add(String(anchor.id))
    // A field that accepts a variable has its own plug point too.
    for (const param of asArray<Record<string, any>>(data.inputParams)) if (param?.id && param?.acceptVariable) inputs.add(String(param.id))
    if (kind === 'workflow') inputs.add(String(node.id))
    return { outputs: new Set([...outputs].map(plugKey)), inputs: new Set([...inputs].map(plugKey)) }
}

// A plug point id reads card-direction-name, then the types it carries ("llmChain_0-input-model-BaseLanguageModel").
// Samples save the short form and the type list follows the node version, so the check compares card, direction and name.
const plugKey = (handle: string) => handle.split('-').slice(0, 3).join('-')

// Problems with one canvas, in plain words. An empty list means it opens and draws as it should.
export const canvasProblems = (
    canvas: BundledCanvas,
    nodeByName: (name: string) => LayoutNodeSpec | undefined,
    outputNames: (name: string) => string[] = () => []
): string[] => {
    const problems: string[] = []
    const where = (id: unknown) => `${canvas.file}: card ${String(id)}`
    // Build missing anchors from the node definitions, as the canvas does for samples that store inputs only.
    const normalized = JSON.parse(normalizeTemplateFlow(JSON.stringify(canvas.flow), nodeByName)) as BundledCanvas['flow']
    const nodes = asArray<FlowNode>(normalized.nodes)
    if (!nodes.length) problems.push(`${canvas.file}: no cards`)

    const byId = new Map<string, FlowNode>()
    for (const node of nodes) {
        const id = typeof node.id === 'string' ? node.id : ''
        if (!id) {
            problems.push(`${canvas.file}: a card has no id`)
            continue
        }
        if (byId.has(id)) problems.push(`${where(id)} appears twice`)
        byId.set(id, node)
        const type = String(node.type || '')
        if (!CARD_TYPES[canvas.kind].has(type)) problems.push(`${where(id)} has card type "${type}", which this canvas does not draw`)
        const x = Number(node.position?.x)
        const y = Number(node.position?.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) problems.push(`${where(id)} has no position`)
        const name = String(node.data?.name || '')
        if (!name) problems.push(`${where(id)} names no part`)
        else if (!STICKY_NAMES.has(name) && !nodeByName(name)) problems.push(`${where(id)} uses "${name}", a part this build does not have`)
        if (!STICKY_NAMES.has(name) && !String(node.data?.label || '')) problems.push(`${where(id)} has no label`)
        if (node.data?.id !== undefined && node.data.id !== id)
            problems.push(`${where(id)} carries a different id (${String(node.data.id)}) inside`)
    }

    for (const node of nodes) {
        const parent = typeof node.parentNode === 'string' ? node.parentNode : ''
        if (parent && !byId.has(parent)) problems.push(`${where(node.id)} sits inside ${parent}, which is not on the canvas`)
    }

    // Check the connections as saved. The Templates page repairs a wrong plug point on the way out, but Use Template on a
    // file and the import path load it as written, so a file must be right on its own.
    for (const edge of canvas.flow.edges) {
        const label = `${canvas.file}: connection ${String(edge.id || `${edge.source} to ${edge.target}`)}`
        const source = byId.get(String(edge.source))
        const target = byId.get(String(edge.target))
        if (!source) problems.push(`${label} starts at ${String(edge.source)}, which is not on the canvas`)
        if (!target) problems.push(`${label} ends at ${String(edge.target)}, which is not on the canvas`)
        if (!source || !target) continue
        if (edge.sourceHandle && !plugPoints(source, canvas.kind, outputNames).outputs.has(plugKey(String(edge.sourceHandle))))
            problems.push(`${label} leaves from a plug point ${String(edge.sourceHandle)} that ${String(edge.source)} does not have`)
        if (edge.targetHandle && !plugPoints(target, canvas.kind, outputNames).inputs.has(plugKey(String(edge.targetHandle))))
            problems.push(`${label} lands on a plug point ${String(edge.targetHandle)} that ${String(edge.target)} does not have`)
    }

    // Cards that share a parent (the canvas, or one iteration block) must not cover each other. A saved size is what the
    // canvas measured; samples store none, so they use the same estimate as the template layout check.
    const boxes: Box[] = nodes
        .filter((node) => typeof node.id === 'string')
        .map((node) => {
            const estimate = estimateTemplateNodeSize(node.data)
            const w = Number(node.width) > 0 ? Number(node.width) : estimate.width
            const h = Number(node.height) > 0 ? Number(node.height) : estimate.height
            return {
                id: String(node.id),
                parent: typeof node.parentNode === 'string' ? node.parentNode : '',
                x: Number(node.position?.x) || 0,
                y: Number(node.position?.y) || 0,
                w,
                h
            }
        })
    for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i]
            const b = boxes[j]
            if (a.parent !== b.parent) continue
            if (a.id === b.parent || b.id === a.parent) continue
            if (overlaps(a, b)) problems.push(`${canvas.file}: cards ${a.id} and ${b.id} overlap`)
        }
    }
    return problems
}
