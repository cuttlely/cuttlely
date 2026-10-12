import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { StatusCodes } from 'http-status-codes'

// Optional packs sit beside the nodes that ship with the server. A pack is a directory or a
// package name. Its package.json points at the built node and credential classes.
export const NODE_PACKS_ENV = 'CUTTLELY_NODE_PACKS'

// Always loaded, unless the image was built with INCLUDE_NODE_PACKS=0.
// A later pack adds its package name here.
export const SHIPPED_NODE_PACKS = ['@cuttlely/node-pack-vector-stores']

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

/**
 * The sentence the canvas shows and the prediction API returns when a saved node is not loaded.
 * statusCode is 422 so the run is refused before a missing class is constructed.
 */
export function missingNodeFailure(
    flowData: string | undefined,
    componentNodes: { [key: string]: unknown } | undefined
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
        if (!name || Object.prototype.hasOwnProperty.call(loaded, name)) continue
        const label = typeof record.label === 'string' && record.label.trim() ? record.label : name
        const pack = typeof record.nodePack === 'string' ? record.nodePack.trim() : ''
        const message = pack ? `${label} is not installed. Install the ${pack} pack.` : `${label} is not installed.`
        return { statusCode: StatusCodes.UNPROCESSABLE_ENTITY, message }
    }
    return null
}
