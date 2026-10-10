import * as fs from 'fs'
import path from 'path'

export type LayoutNodeSpec = {
    inputs?: Array<Record<string, unknown>>
    outputs?: Array<Record<string, unknown>>
    baseClasses?: string[]
    credential?: Record<string, unknown>
    hideOutput?: boolean
    description?: string
    type?: string
    name?: string
    version?: number
}

// Marketplace cards are a fixed 300px wide and grow with every visible field.
// These sizes sit above that render: a clearance check that passes here still
// has a gap on screen when the card is shorter than the estimate.
export const TEMPLATE_NODE_WIDTH = 360
export const TEMPLATE_COLUMN_PITCH = 450
export const TEMPLATE_CLEARANCE = 80
export const TEMPLATE_DESCRIPTION_MAX = 140

const HEADER = 96
const SECTION = 64
const ANCHOR = 80
const OUTPUT_ROW = 80
const ADDITIONAL = 88
const SLACK = 180
const ORIGIN = 40

const INPUT_CATEGORIES = new Set(['Chat Models', 'Memory', 'Embeddings', 'Document Loaders', 'Text Splitters', 'LLMs'])
const CORE_NAMES = new Set(['harnessChief', 'toolAgent'])
const ROSTER_NAMES = new Set(['harnessSpecialist', 'harness'])
const SMALL_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to'])

export type TemplateBox = {
    id: string
    name: string
    x: number
    y: number
    w: number
    h: number
}

type FlowNode = {
    id?: string
    position?: { x: number; y: number }
    positionAbsolute?: { x: number; y: number }
    data?: Record<string, unknown>
}

type FlowEdge = { source?: string; target?: string }

const asArray = <T>(value: T[] | undefined | null): T[] => (Array.isArray(value) ? value : [])

const paramHeight = (param: { type?: string; rows?: number; additionalParams?: boolean; display?: boolean; hidden?: boolean }) => {
    if (!param || param.display === false || param.hidden || param.additionalParams) return 0
    const type = String(param.type || 'string')
    const rows = Number(param.rows) || 0
    if (type === 'credential') return 220
    if (type === 'code' || type === 'json') return 280
    if (type === 'datagrid' || type === 'array') return 240
    if (rows >= 4) return 240
    if (rows > 0) return 200
    if (type === 'boolean') return 100
    if (type === 'asyncOptions' || type === 'asyncMultiOptions' || type === 'options' || type === 'multiOptions') return 140
    if (type === 'file' || type === 'folder') return 160
    return 120
}

export const estimateTemplateNodeSize = (data: Record<string, unknown> | undefined): { width: number; height: number } => {
    const node = data || {}
    const anchors = asArray(node.inputAnchors as unknown[])
    const params = asArray(node.inputParams as Array<Record<string, unknown>>)
    const outputs = asArray(node.outputAnchors as unknown[])
    const visible = params.filter((param) => paramHeight(param as { type?: string; rows?: number }) > 0)
    const additional = params.some((param) => param && param.additionalParams && param.display !== false && !param.hidden)
    let height = HEADER + SLACK
    if (anchors.length || visible.length || additional) height += SECTION
    height += anchors.length * ANCHOR
    for (const param of visible) height += paramHeight(param as { type?: string; rows?: number })
    if (additional) height += ADDITIONAL
    height += SECTION
    height += Math.max(outputs.length, 1) * OUTPUT_ROW
    return { width: TEMPLATE_NODE_WIDTH, height }
}

export const boxClearance = (a: TemplateBox, b: TemplateBox): number => {
    const gapX = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w))
    const gapY = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h))
    if (gapX < 0 && gapY < 0) return Math.max(gapX, gapY)
    if (gapX < 0) return gapY
    if (gapY < 0) return gapX
    return Math.hypot(gapX, gapY)
}

export const templateClearanceFailures = (boxes: TemplateBox[]): string[] => {
    const failures: string[] = []
    for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
            const gap = boxClearance(boxes[i], boxes[j])
            if (gap < TEMPLATE_CLEARANCE) {
                failures.push(`${boxes[i].id} (${boxes[i].name}) and ${boxes[j].id} (${boxes[j].name}) are ${Math.round(gap)}px apart`)
            }
        }
    }
    return failures
}

export const isTitleCaseName = (name: string): boolean => {
    if (!name || name !== name.trim() || /[-_]/.test(name)) return false
    const words = name.split(/\s+/)
    if (!words.length) return false
    return words.every((word, index) => {
        if (index > 0 && index < words.length - 1 && SMALL_WORDS.has(word)) return true
        return /^[A-Z0-9]/.test(word)
    })
}

export const isShortDescription = (text: string): boolean => {
    return (
        typeof text === 'string' &&
        text.length > 0 &&
        text.length <= TEMPLATE_DESCRIPTION_MAX &&
        !/[\r\n]/.test(text) &&
        text === text.trim()
    )
}

const repoRootFrom = (start: string) => {
    let dir = start
    for (let i = 0; i < 8; i += 1) {
        if (fs.existsSync(path.join(dir, 'samples', 'harnesses')) && fs.existsSync(path.join(dir, 'packages', 'components', 'nodes'))) {
            return dir
        }
        dir = path.dirname(dir)
    }
    return ''
}

const skipString = (source: string, start: number) => {
    const quote = source[start]
    let i = start + 1
    while (i < source.length) {
        if (source[i] === '\\') {
            i += 2
            continue
        }
        if (source[i] === quote) return i + 1
        i += 1
    }
    return source.length
}

const skipComment = (source: string, start: number) => {
    if (source.startsWith('//', start)) {
        const end = source.indexOf('\n', start)
        return end === -1 ? source.length : end + 1
    }
    if (source.startsWith('/*', start)) {
        const end = source.indexOf('*/', start + 2)
        return end === -1 ? source.length : end + 2
    }
    return start
}

const topLevelFields = (source: string) => {
    const fields: Record<string, string> = {}
    let depth = 0
    let i = 0
    while (i < source.length) {
        const comment = skipComment(source, i)
        if (comment !== i) {
            i = comment
            continue
        }
        const ch = source[i]
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipString(source, i)
            continue
        }
        if (ch === '{' || ch === '[') {
            depth += 1
            i += 1
            continue
        }
        if (ch === '}' || ch === ']') {
            depth -= 1
            i += 1
            continue
        }
        if (depth === 1) {
            const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(source.slice(i))
            if (match) {
                const key = match[1]
                i += match[0].length
                let value = ''
                let nested = 0
                while (i < source.length) {
                    const innerComment = skipComment(source, i)
                    if (innerComment !== i && nested === 0) break
                    const next = source[i]
                    if (next === '"' || next === "'" || next === '`') {
                        const end = skipString(source, i)
                        value += source.slice(i, end)
                        i = end
                        continue
                    }
                    if (next === '{' || next === '[') nested += 1
                    if ((next === '}' || next === ']') && nested === 0) break
                    if (next === '}' || next === ']') nested -= 1
                    if (next === ',' && nested === 0) break
                    value += next
                    i += 1
                }
                fields[key] = value.trim()
                continue
            }
        }
        i += 1
    }
    return fields
}

// The first `this.<prop> = ` in the source, or the last one with { last: true } (a node may replace a value it set
// earlier in the same constructor, and the last one is what the node offers).
const extractAssigned = (source: string, prop: string, { last = false }: { last?: boolean } = {}) => {
    const marker = `this.${prop} = `
    const at = last ? source.lastIndexOf(marker) : source.indexOf(marker)
    if (at < 0) return ''
    let i = at + marker.length
    while (/\s/.test(source[i] || '')) i += 1
    const open = source[i]
    if (open !== '[' && open !== '{') return ''
    let depth = 0
    const start = i
    while (i < source.length) {
        const comment = skipComment(source, i)
        if (comment !== i) {
            i = comment
            continue
        }
        const ch = source[i]
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipString(source, i)
            continue
        }
        if (ch === '{' || ch === '[') depth += 1
        if (ch === '}' || ch === ']') {
            depth -= 1
            if (depth === 0) return source.slice(start, i + 1)
        }
        i += 1
    }
    return ''
}

const unquote = (value: string | undefined) => {
    if (!value) return ''
    const trimmed = value.trim()
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
        return trimmed.slice(1, -1)
    }
    return trimmed
}

const inputFromFields = (fields: Record<string, string>) => {
    const name = unquote(fields.name)
    const type = unquote(fields.type)
    if (!name || !type) return null
    const input: Record<string, unknown> = { name, type }
    const rows = Number(unquote(fields.rows))
    if (rows > 0) input.rows = rows
    if (fields.additionalParams?.trim() === 'true') input.additionalParams = true
    if (fields.display?.trim() === 'false') input.display = false
    if (fields.hidden?.trim() === 'true') input.hidden = true
    return input
}

const objectsInArray = (source: string) => {
    const objects: string[] = []
    let depth = 0
    let start = -1
    let i = 0
    while (i < source.length) {
        const comment = skipComment(source, i)
        if (comment !== i) {
            i = comment
            continue
        }
        const ch = source[i]
        if (ch === '"' || ch === "'" || ch === '`') {
            i = skipString(source, i)
            continue
        }
        if (ch === '{') {
            if (depth === 1) start = i
            depth += 1
        } else if (ch === '}') {
            depth -= 1
            if (depth === 1 && start >= 0) {
                objects.push(source.slice(start, i + 1))
                start = -1
            }
        } else if (ch === '[') {
            depth += 1
        } else if (ch === ']') {
            depth -= 1
        }
        i += 1
    }
    return objects
}

const specFromSource = (source: string): LayoutNodeSpec | undefined => {
    const nameMatch = source.match(/this\.name = '([^']+)'/)
    if (!nameMatch) return undefined
    const inputsSource = extractAssigned(source, 'inputs')
    const inputs = objectsInArray(inputsSource)
        .map((object) => inputFromFields(topLevelFields(object)))
        .filter((input): input is NonNullable<typeof input> => Boolean(input))
    const credentialSource = extractAssigned(source, 'credential')
    const credentialFields = credentialSource ? topLevelFields(credentialSource) : {}
    const credentialName = unquote(credentialFields.name)
    const credentialType = unquote(credentialFields.type)
    const spec: LayoutNodeSpec = {
        name: nameMatch[1],
        type: unquote(source.match(/this\.type = '([^']+)'/)?.[1]) || 'Node',
        inputs,
        hideOutput: /this\.hideOutput\s*=\s*true/.test(source)
    }
    const version = Number(source.match(/this\.version = ([0-9.]+)/)?.[1])
    if (Number.isFinite(version)) spec.version = version
    if (credentialName && credentialType)
        spec.credential = { name: credentialName, type: credentialType, label: unquote(credentialFields.label) }
    return spec
}

export const loadTemplateNodeSpecs = (start = __dirname): ((name: string) => LayoutNodeSpec | undefined) => {
    const root = repoRootFrom(start)
    const nodesDir = root ? path.join(root, 'packages', 'components', 'nodes') : ''
    const byName = new Map<string, LayoutNodeSpec>()
    const walk = (dir: string) => {
        if (!dir || !fs.existsSync(dir)) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'dist') continue
                walk(full)
            } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
                const spec = specFromSource(fs.readFileSync(full, 'utf8'))
                if (spec?.name && !byName.has(spec.name)) byName.set(spec.name, spec)
            }
        }
    }
    walk(nodesDir)
    return (name: string) => byName.get(name)
}

// Named outputs a node offers ("document" and "text" on Plain Text), read from its source. The layout specs above leave
// them out on purpose; the template open check needs them for samples that store inputs only.
export const loadNodeOutputNames = (start = __dirname): ((name: string) => string[]) => {
    const root = repoRootFrom(start)
    const nodesDir = root ? path.join(root, 'packages', 'components', 'nodes') : ''
    const byName = new Map<string, string[]>()
    const walk = (dir: string) => {
        if (!dir || !fs.existsSync(dir)) return
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'dist') continue
                walk(full)
            } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
                const source = fs.readFileSync(full, 'utf8')
                const name = source.match(/this\.name = '([^']+)'/)?.[1]
                if (!name || byName.has(name)) continue
                const names = objectsInArray(extractAssigned(source, 'outputs', { last: true }))
                    .map((object) => unquote(topLevelFields(object).name))
                    .filter(Boolean)
                byName.set(name, names)
            }
        }
    }
    walk(nodesDir)
    return (name: string) => byName.get(name) || []
}

export const templateNodeBoxes = (flowData: string): TemplateBox[] => {
    let flow: { nodes?: FlowNode[] }
    try {
        flow = JSON.parse(flowData)
    } catch {
        return []
    }
    return asArray(flow.nodes).map((node) => {
        const data = (node.data || {}) as Record<string, unknown>
        const size = estimateTemplateNodeSize(data)
        return {
            id: String(node.id || data.id || ''),
            name: String(data.name || ''),
            x: Number(node.position?.x) || 0,
            y: Number(node.position?.y) || 0,
            w: size.width,
            h: size.height
        }
    })
}

const kindOf = (node: FlowNode) => {
    const name = String(node.data?.name || '')
    const category = String(node.data?.category || '')
    if (CORE_NAMES.has(name) || category === 'Agents' || category === 'Chains') return 'core'
    if (ROSTER_NAMES.has(name)) return 'roster'
    if (INPUT_CATEGORIES.has(category)) return 'input'
    return 'other'
}

const place = (node: FlowNode, x: number, y: number) => {
    node.position = { x, y }
    node.positionAbsolute = { x, y }
}

const stack = (
    nodes: FlowNode[],
    x: number,
    sizeOf: (node: FlowNode) => { height: number },
    order: Map<string, { x: number; y: number }>
) => {
    const sorted = [...nodes].sort((a, b) => {
        const left = order.get(String(a.id)) || { x: 0, y: 0 }
        const right = order.get(String(b.id)) || { x: 0, y: 0 }
        return left.y - right.y || left.x - right.x || String(a.id).localeCompare(String(b.id))
    })
    let y = ORIGIN
    for (const node of sorted) {
        place(node, x, y)
        y += sizeOf(node).height + TEMPLATE_CLEARANCE
    }
}

const layoutRoster = (nodes: FlowNode[], edges: FlowEdge[], sizeOf: (node: FlowNode) => { width: number; height: number }) => {
    const order = new Map(nodes.map((node) => [String(node.id), { x: node.position?.x ?? 0, y: node.position?.y ?? 0 }]))
    const inputs = nodes.filter((node) => kindOf(node) === 'input')
    const cores = nodes.filter((node) => kindOf(node) === 'core')
    const roster = [...nodes.filter((node) => kindOf(node) === 'roster')].sort((a, b) => {
        const left = order.get(String(a.id)) || { x: 0, y: 0 }
        const right = order.get(String(b.id)) || { x: 0, y: 0 }
        return left.x - right.x || left.y - right.y || String(a.id).localeCompare(String(b.id))
    })
    let column = 0
    if (inputs.length) {
        stack(inputs, ORIGIN + column * TEMPLATE_COLUMN_PITCH, sizeOf, order)
        column += 1
    }
    if (cores.length) {
        stack(cores, ORIGIN + column * TEMPLATE_COLUMN_PITCH, sizeOf, order)
        column += 1
    }
    for (const node of roster) {
        place(node, ORIGIN + column * TEMPLATE_COLUMN_PITCH, ORIGIN)
        column += 1
    }
    const placed = new Set(nodes.filter((node) => kindOf(node) !== 'other').map((node) => String(node.id)))
    const pending = nodes.filter((node) => kindOf(node) === 'other')
    const targetOf = (node: FlowNode) => edges.find((edge) => edge.source === node.id)?.target
    let guard = 0
    while (pending.length && guard < 40) {
        guard += 1
        const index = pending.findIndex((node) => {
            const target = targetOf(node)
            return !target || placed.has(target)
        })
        const node = pending.splice(index === -1 ? 0 : index, 1)[0]
        const target = nodes.find((item) => item.id === targetOf(node))
        const size = sizeOf(node)
        let x = target?.position?.x ?? ORIGIN + column * TEMPLATE_COLUMN_PITCH
        let y = target?.position ? target.position.y + sizeOf(target).height + TEMPLATE_CLEARANCE : ORIGIN
        for (let spin = 0; spin < 40; spin += 1) {
            const hit = nodes.find((other) => {
                if (!placed.has(String(other.id)) || !other.position) return false
                const otherSize = sizeOf(other)
                return (
                    boxClearance(
                        { id: '', name: '', x, y, w: size.width, h: size.height },
                        { id: '', name: '', x: other.position.x, y: other.position.y, w: otherSize.width, h: otherSize.height }
                    ) < TEMPLATE_CLEARANCE
                )
            })
            if (!hit?.position) break
            y = hit.position.y + sizeOf(hit).height + TEMPLATE_CLEARANCE
        }
        place(node, x, y)
        placed.add(String(node.id))
    }
}

const layoutPipeline = (nodes: FlowNode[], edges: FlowEdge[], sizeOf: (node: FlowNode) => { height: number }) => {
    const order = new Map(nodes.map((node) => [String(node.id), { x: node.position?.x ?? 0, y: node.position?.y ?? 0 }]))
    const rank = new Map<string, number>()
    const visiting = new Set<string>()
    const rankOf = (id: string): number => {
        const known = rank.get(id)
        if (known !== undefined) return known
        if (visiting.has(id)) return 0
        visiting.add(id)
        const outgoing = edges.filter((edge) => edge.source === id && edge.target)
        const value = outgoing.length ? 1 + Math.max(...outgoing.map((edge) => rankOf(String(edge.target)))) : 0
        visiting.delete(id)
        rank.set(id, value)
        return value
    }
    for (const node of nodes) rankOf(String(node.id))
    const max = Math.max(0, ...rank.values())
    const columns = new Map<number, FlowNode[]>()
    for (const node of nodes) {
        const column = max - (rank.get(String(node.id)) ?? 0)
        const list = columns.get(column) || []
        list.push(node)
        columns.set(column, list)
    }
    for (const [column, list] of columns) stack(list, ORIGIN + column * TEMPLATE_COLUMN_PITCH, sizeOf, order)
}

export const layoutTemplateFlow = (
    flow: { nodes?: FlowNode[]; edges?: FlowEdge[]; viewport?: { x: number; y: number; zoom: number } },
    sizeById: Map<string, { width: number; height: number }>
) => {
    const nodes = asArray(flow.nodes)
    const edges = asArray(flow.edges)
    const sizeOf = (node: FlowNode) => sizeById.get(String(node.id)) || { width: TEMPLATE_NODE_WIDTH, height: 960 }
    const roster = nodes.some((node) => ROSTER_NAMES.has(String(node.data?.name || '')) || CORE_NAMES.has(String(node.data?.name || '')))
    if (roster) layoutRoster(nodes, edges, sizeOf)
    else layoutPipeline(nodes, edges, sizeOf)
    const boxes = nodes.map((node) => {
        const size = sizeOf(node)
        return {
            id: String(node.id || ''),
            name: String(node.data?.name || ''),
            x: node.position?.x || 0,
            y: node.position?.y || 0,
            w: size.width,
            h: size.height
        }
    })
    const minX = Math.min(...boxes.map((box) => box.x), 0)
    const minY = Math.min(...boxes.map((box) => box.y), 0)
    const maxX = Math.max(...boxes.map((box) => box.x + box.w), 1)
    const maxY = Math.max(...boxes.map((box) => box.y + box.h), 1)
    const zoom = Math.min(1, 1280 / Math.max(maxX - minX + 160, 1), 800 / Math.max(maxY - minY + 160, 1))
    flow.viewport = { x: 48, y: 48, zoom: Math.round(Math.max(0.2, zoom) * 100) / 100 }
    return flow
}
