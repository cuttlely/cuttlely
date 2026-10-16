import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { StatusCodes } from 'http-status-codes'

// Optional packs sit beside the nodes that ship with the server. A pack is a directory or a
// package name. Its package.json points at the built node and credential classes.
export const NODE_PACKS_ENV = 'CUTTLELY_NODE_PACKS'

// Always loaded, unless the image was built with INCLUDE_NODE_PACKS=0.
// A later pack adds its package name here.
export const SHIPPED_NODE_PACKS = [
    '@cuttlely/node-pack-vector-stores',
    '@cuttlely/node-pack-tools-mcp',
    '@cuttlely/node-pack-caches-memory',
    '@cuttlely/node-pack-legacy-chains'
]

// Written by an image build that leaves shipped packs out. Extra packs in CUTTLELY_NODE_PACKS still load.
export const NO_NODE_PACKS_FILE = '/etc/cuttlely/no-node-packs'

function packTokens(raw: string | undefined): string[] {
    const tokens: string[] = []
    const seen = new Set<string>()
    for (const token of (raw ?? '').split(',')) {
        const trimmed = token.trim()
        if (!trimmed || seen.has(trimmed)) continue
        seen.add(trimmed)
        tokens.push(trimmed)
    }
    return tokens
}

/**
 * Shipped packs load first. CUTTLELY_NODE_PACKS adds packs after them.
 * A blank value adds nothing. A repeated name is kept once.
 * The slim-image marker skips the shipped packs and still adds the extra list.
 */
export function nodePackList(env: NodeJS.ProcessEnv = process.env, noPacksFile = NO_NODE_PACKS_FILE): string {
    let skipShipped = false
    try {
        skipShipped = fs.existsSync(noPacksFile)
    } catch {
        // A marker the process cannot read does not skip the shipped packs.
    }
    const shipped = skipShipped ? [] : SHIPPED_NODE_PACKS
    const seen = new Set<string>()
    const names: string[] = []
    for (const name of [...shipped, ...packTokens(env[NODE_PACKS_ENV])]) {
        if (seen.has(name)) continue
        seen.add(name)
        names.push(name)
    }
    return names.join(',')
}

export interface NodePackLocation {
    name: string
    root: string
    nodesDir: string
    credentialsDir: string
    manifestPath: string
}

export interface ResolveNodePacksOptions {
    cwd?: string
    resolvePackage?: (name: string) => string
}

export interface ResolveNodePacksResult {
    packs: NodePackLocation[]
    skipped: string[]
}

const insideRoot = (root: string, target: string) => {
    const relative = path.relative(root, target)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

const isDirectory = (file: string) => {
    try {
        return fs.statSync(file).isDirectory()
    } catch {
        return false
    }
}

// A package the server can already require. Used when the caller does not pass a resolver.
const resolveInstalledPackage = (name: string): string => {
    if (!name || name.includes('\0') || path.isAbsolute(name)) return ''
    try {
        const require = createRequire(path.join(__dirname, '..', '..', 'package.json'))
        return path.dirname(require.resolve(path.join(name, 'package.json')))
    } catch {
        return ''
    }
}

const readPackage = (root: string): Record<string, unknown> | null => {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
        return null
    }
}

const packFromRoot = (root: string): NodePackLocation | null => {
    const manifest = readPackage(root)
    if (!manifest) return null
    const cuttlely = manifest.cuttlely
    const nodePack = cuttlely && typeof cuttlely === 'object' ? (cuttlely as { nodePack?: unknown }).nodePack : undefined
    if (!nodePack || typeof nodePack !== 'object') return null
    const nodes = (nodePack as { nodes?: unknown }).nodes
    const credentials = (nodePack as { credentials?: unknown }).credentials
    if (typeof nodes !== 'string' || !nodes.trim()) return null
    const nodesDir = path.resolve(root, nodes)
    if (!insideRoot(root, nodesDir)) return null
    const credentialsRel = typeof credentials === 'string' ? credentials.trim() : ''
    const credentialsDir = credentialsRel ? path.resolve(root, credentialsRel) : ''
    if (credentialsDir && !insideRoot(root, credentialsDir)) return null
    const beside = path.join(path.dirname(nodesDir), 'nodes-manifest.json')
    const manifestPath = insideRoot(root, beside) ? beside : path.join(root, 'nodes-manifest.json')
    const declared = typeof manifest.name === 'string' ? manifest.name.trim() : ''
    return {
        name: declared || path.basename(root),
        root,
        nodesDir,
        credentialsDir,
        manifestPath
    }
}

/**
 * CUTTLELY_NODE_PACKS is a comma-separated list. A token that is a directory is that pack.
 * Anything else is a package name. A token that does not declare cuttlely.nodePack is skipped.
 */
export function resolveNodePacks(raw: string | undefined, options: ResolveNodePacksOptions = {}): ResolveNodePacksResult {
    const cwd = options.cwd ?? process.cwd()
    const packs: NodePackLocation[] = []
    const skipped: string[] = []
    for (const token of (raw ?? '').split(',')) {
        const trimmed = token.trim()
        if (!trimmed) continue
        const direct = path.resolve(cwd, trimmed)
        const fromCaller = options.resolvePackage ? options.resolvePackage(trimmed) : ''
        const resolved = isDirectory(direct) ? direct : isDirectory(fromCaller) ? fromCaller : resolveInstalledPackage(trimmed)
        const pack = resolved && isDirectory(resolved) ? packFromRoot(resolved) : null
        if (pack) packs.push(pack)
        else skipped.push(trimmed)
    }
    return { packs, skipped }
}

export interface NodePackIndexNode {
    name: string
    label: string
    pack: string
}

// Written by scripts/build-node-pack-index.mjs from packages/node-pack-*/nodes.
// The server build copies it beside the compiled file. The source copy stays in the image
// after a slim build leaves the pack packages out.
const indexCandidates = (here = __dirname): string[] => [
    path.join(here, 'node-pack-index.json'),
    path.resolve(here, '..', '..', 'src', 'utils', 'node-pack-index.json')
]

let cachedIndex: NodePackIndexNode[] | undefined

const rowsFromFile = (file: string): NodePackIndexNode[] | null => {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { nodes?: unknown }
        if (!Array.isArray(parsed?.nodes)) return []
        const rows: NodePackIndexNode[] = []
        for (const row of parsed.nodes) {
            if (!row || typeof row !== 'object') continue
            const record = row as { name?: unknown; label?: unknown; pack?: unknown }
            const name = typeof record.name === 'string' ? record.name.trim() : ''
            const pack = typeof record.pack === 'string' ? record.pack.trim() : ''
            if (!name || !pack) continue
            const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim() : name
            rows.push({ name, label, pack })
        }
        return rows
    } catch {
        return null
    }
}

export function loadNodePackIndex(file?: string): NodePackIndexNode[] {
    if (!file && cachedIndex) return cachedIndex
    const candidates = file ? [file] : indexCandidates()
    for (const candidate of candidates) {
        const rows = rowsFromFile(candidate)
        if (!rows) continue
        if (!file) cachedIndex = rows
        return rows
    }
    if (!file) cachedIndex = []
    return []
}

// The saved nodePack field wins. Otherwise the name, then a label that belongs to one pack.
export function packForNode(name: string, label = '', index?: NodePackIndexNode[]): string {
    const rows = index ?? loadNodePackIndex()
    const byName = rows.find((row) => row.name === name)
    if (byName) return byName.pack
    const trimmed = label.trim()
    if (!trimmed) return ''
    const byLabel = rows.filter((row) => row.label === trimmed)
    return byLabel.length === 1 ? byLabel[0].pack : ''
}

// Configuration-only nodes that were never registered and are no longer shipped. They had no
// anchors, so a saved flow can only hold them as loose cards. A run drops them instead of refusing.
export const REMOVED_NODE_NAMES = new Set(['arize', 'langFuse', 'langSmith', 'LangWatch', 'lunary', 'opik', 'phoenix', 'assemblyAI'])

type FlowNodeLike = { id: string; data?: { name?: string } }
type FlowEdgeLike = { source: string; target: string }

export function withoutRemovedNodes<T extends { nodes: FlowNodeLike[]; edges: FlowEdgeLike[] }>(flow: T): T {
    const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
    const removed = new Set(nodes.filter((node) => REMOVED_NODE_NAMES.has(node?.data?.name ?? '')).map((node) => node.id))
    if (!removed.size) return flow
    return {
        ...flow,
        nodes: nodes.filter((node) => !removed.has(node.id)),
        edges: (Array.isArray(flow.edges) ? flow.edges : []).filter((edge) => !removed.has(edge?.source) && !removed.has(edge?.target))
    }
}

export function missingNodeMessage(label: string, pack: string): string {
    return pack ? `${label} is not installed. Install the ${pack} pack.` : `${label} is not installed.`
}

/**
 * The sentence the canvas shows and the prediction API returns when a saved node is not loaded.
 * statusCode is 422 so the run is refused before a missing class is constructed.
 * A saved nodePack is used as written. When that field is absent, the pack index supplies it.
 */
export function missingNodeFailure(
    flowData: string | undefined,
    componentNodes: { [key: string]: unknown } | undefined,
    index?: NodePackIndexNode[]
): { statusCode: number; message: string } | null {
    if (!flowData) return null
    let flow: { nodes?: unknown }
    try {
        flow = JSON.parse(flowData)
    } catch {
        return null
    }
    const nodes = Array.isArray(flow?.nodes) ? flow.nodes : []
    const loaded = componentNodes ?? {}
    for (const node of nodes) {
        const data = node && typeof node === 'object' ? (node as { data?: unknown }).data : undefined
        if (!data || typeof data !== 'object') continue
        const record = data as { name?: unknown; label?: unknown; nodePack?: unknown }
        const name = typeof record.name === 'string' ? record.name : ''
        if (!name || REMOVED_NODE_NAMES.has(name) || Object.prototype.hasOwnProperty.call(loaded, name)) continue
        const label = typeof record.label === 'string' && record.label.trim() ? record.label : name
        const saved = typeof record.nodePack === 'string' ? record.nodePack.trim() : ''
        const pack = saved || packForNode(name, label, index)
        return { statusCode: StatusCodes.UNPROCESSABLE_ENTITY, message: missingNodeMessage(label, pack) }
    }
    return null
}

// Writes nodePack from the index onto saved nodes that do not already name a pack.
// The original string is returned when nothing changes, so an unchanged canvas stays byte-identical.
export function stampNodePack(flowData: string, index?: NodePackIndexNode[]): string {
    if (!flowData) return flowData
    let flow: { nodes?: unknown }
    try {
        flow = JSON.parse(flowData)
    } catch {
        return flowData
    }
    if (!flow || typeof flow !== 'object' || !Array.isArray(flow.nodes)) return flowData
    let changed = false
    for (const node of flow.nodes) {
        if (!node || typeof node !== 'object') continue
        const data = (node as { data?: unknown }).data
        if (!data || typeof data !== 'object') continue
        const record = data as { name?: unknown; label?: unknown; nodePack?: unknown }
        const saved = typeof record.nodePack === 'string' ? record.nodePack.trim() : ''
        if (saved) continue
        const name = typeof record.name === 'string' ? record.name : ''
        if (!name) continue
        const label = typeof record.label === 'string' ? record.label : ''
        const pack = packForNode(name, label, index)
        if (!pack) continue
        record.nodePack = pack
        changed = true
    }
    return changed ? JSON.stringify(flow) : flowData
}

export function stampFlowRecords<T extends { flowData?: unknown }>(rows: T[] | undefined, index?: NodePackIndexNode[]): T[] {
    if (!Array.isArray(rows)) return []
    for (const row of rows) {
        if (!row || typeof row.flowData !== 'string') continue
        const stamped = stampNodePack(row.flowData, index)
        if (stamped !== row.flowData) (row as { flowData: string }).flowData = stamped
    }
    return rows
}
