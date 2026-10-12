// Reads version history back out of the local versions repo:
// the list of versions for one flow, the files of one version, and a
// node-level diff between two versions.
import { FlowFiles, normalizeStoredNode } from './serialize'
import { runGit, VersionKind, VersionStore } from './store'
import { readTrailer, TRAILER_LINE, trailerGrep } from './trailers'

export interface VersionEntry {
    sha: string
    shortSha: string
    date: string
    author: string
    // The user id for a signed-in user's change, else null (API key or system).
    authorId: string | null
    authorKind: 'user' | 'system'
    title: string
    details: string[]
    kind: VersionKind | 'unknown'
    name: string
    // How many secret-looking values were hidden from this version (0 when none).
    hiddenSecrets: number
    // This version was put Live by Publish, Roll back or Promote.
    published: boolean
    // Promote: the version from Dev this one copies. Null for every other version.
    promotedFrom: string | null
}

export interface NodeChange {
    id: string
    label: string
    fields: string[]
}

export interface VersionDiff {
    added: { id: string; label: string }[]
    removed: { id: string; label: string }[]
    changed: NodeChange[]
    moved: string[]
    edgesChanged: boolean
    renamed: { from: string; to: string } | null
}

const SHA = /^[0-9a-f]{7,40}$/
const UUID_SAFE = /^[A-Za-z0-9-]{1,64}$/
const FIELD = '\u001f'
const RECORD = '\u001e'
const KINDS = new Set(['create', 'save', 'delete', 'restore', 'publish', 'rollback', 'promote'])
const PUBLISHED_KINDS = new Set(['publish', 'rollback', 'promote'])

export function isSha(value: unknown): value is string {
    return typeof value === 'string' && SHA.test(value)
}

// A signed-in user's change is authored <user id>@users.versions.local (see versionAuthor).
const USER_EMAIL = /^([A-Za-z0-9._-]+)@users\.[A-Za-z0-9-]+\.local$/

const trailer = readTrailer

// The flow's versions, newest first, reachable from `rev` (default: the whole history on main).
export async function listFlowVersions(store: VersionStore, flowId: string, limit = 200, rev = 'main'): Promise<VersionEntry[]> {
    if (!UUID_SAFE.test(flowId)) return []
    return (await logEntries(store, rev, limit, trailerGrep('Flow', flowId))).filter((entry) => entry.flowId === flowId).map(withoutFlowId)
}

// One version of any flow, with the flow it belongs to.
export interface FlowVersionEntry extends VersionEntry {
    flowId: string
}

// The newest versions of every flow at `rev`, newest first. `grep` keeps only versions whose message has that text.
export async function listAllVersions(store: VersionStore, rev: string, limit = 5000, grep?: string): Promise<FlowVersionEntry[]> {
    return logEntries(store, rev, limit, grep)
}

function withoutFlowId(entry: FlowVersionEntry): VersionEntry {
    const { flowId: _flowId, ...rest } = entry
    return rest
}

async function logEntries(store: VersionStore, rev: string, limit: number, grep?: string): Promise<FlowVersionEntry[]> {
    await store.ensure()
    const format = ['%H', '%h', '%aI', '%an', '%ae', '%s', '%b'].join(FIELD) + RECORD
    const { stdout } = await runGit(store.dir, [
        'log',
        `--max-count=${limit}`,
        ...(grep ? ['--fixed-strings', `--grep=${grep}`] : []),
        `--format=${format}`,
        rev
    ])
    const entries: FlowVersionEntry[] = []
    for (const raw of stdout.split(RECORD)) {
        const record = raw.replace(/^\n/, '')
        if (!record.trim()) continue
        const [sha, shortSha, date, author, authorEmail = '', title, body = ''] = record.split(FIELD)
        const userMatch = authorEmail.match(USER_EMAIL)
        const flowId = trailer(body, 'Flow')
        if (!flowId) continue
        const kind = trailer(body, 'Kind')
        const details = body
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !TRAILER_LINE.test(line))
        const from = trailer(body, 'From')
        entries.push({
            flowId,
            sha,
            shortSha,
            date,
            author,
            authorId: userMatch ? userMatch[1] : null,
            authorKind: userMatch ? 'user' : 'system',
            title,
            details,
            kind: KINDS.has(kind) ? (kind as VersionKind) : 'unknown',
            name: trailer(body, 'Name'),
            hiddenSecrets: Math.max(0, parseInt(trailer(body, 'Hidden'), 10) || 0),
            published: PUBLISHED_KINDS.has(kind),
            promotedFrom: kind === 'promote' && /^[0-9a-f]{40}$/.test(from) ? from : null
        })
    }
    return entries
}

// The version of this flow just before `sha`, read from Git, so it is found however long the history is.
export async function previousFlowVersion(store: VersionStore, flowId: string, sha: string): Promise<VersionEntry | null> {
    if (!isSha(sha)) return null
    try {
        const [entry] = await listFlowVersions(store, flowId, 1, `${sha}^`)
        return entry || null
    } catch {
        return null
    }
}

// The files of one flow at one commit, found by the id in flow.json so renames are followed.
export async function readFlowAt(store: VersionStore, flowId: string, sha: string): Promise<FlowFiles | null> {
    if (!isSha(sha) || !UUID_SAFE.test(flowId)) return null
    await store.ensure()
    let listing: string
    try {
        listing = (await runGit(store.dir, ['ls-tree', '-r', '--name-only', sha, '--', 'flows/'])).stdout
    } catch {
        return null
    }
    const paths = listing.split('\n').filter(Boolean)
    const suffix = flowId.replace(/-/g, '')
    const folders = [
        ...new Set(
            paths
                .filter((file) => /^flows\/[^/]+\/flow\.json$/.test(file))
                .map((file) => file.split('/')[1])
                .filter((folder) => suffix.startsWith(folder.split('--').pop() || '\u0000'))
        )
    ]
    for (const folder of folders) {
        const flow = (await runGit(store.dir, ['show', `${sha}:flows/${folder}/flow.json`])).stdout
        let id: unknown
        try {
            id = JSON.parse(flow)?.id
        } catch {
            continue
        }
        if (id !== flowId) continue
        const files: FlowFiles = {}
        const prefix = `flows/${folder}/`
        for (const file of paths.filter((item) => item.startsWith(prefix))) {
            files[file.slice(prefix.length)] = (await runGit(store.dir, ['show', `${sha}:${file}`])).stdout
        }
        return files
    }
    return null
}

function parse(content: string | undefined): any {
    if (content === undefined) return undefined
    try {
        return JSON.parse(content)
    } catch {
        return undefined
    }
}

interface NodeView {
    label: string
    content: Record<string, string>
    // Only the position: width and height are measured by the browser and change
    // without the user doing anything.
    layout: string
}

function nodesOf(files: FlowFiles): Map<string, NodeView> {
    const flow = parse(files['flow.json'])
    const layout = parse(files['layout.json'])?.nodes || {}
    const out = new Map<string, NodeView>()
    for (const entry of Array.isArray(flow?.nodes) ? flow.nodes : []) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.file !== 'string') continue
        const node = normalizeStoredNode(parse(files[entry.file]) || {})
        const stem = entry.file.slice('nodes/'.length, -'.json'.length)
        const content: Record<string, string> = {}
        const data = node.data || {}
        for (const [key, value] of Object.entries(data)) {
            if (key === 'inputs') continue
            content[key] = JSON.stringify(value)
        }
        for (const [name, value] of Object.entries((data.inputs || {}) as Record<string, any>)) {
            const text = value && typeof value === 'object' && typeof value.$text === 'string' ? files[value.$text] : undefined
            content[`inputs.${name}`] = text !== undefined ? JSON.stringify(text) : JSON.stringify(value)
        }
        const { data: _data, ...rest } = node
        for (const [key, value] of Object.entries(rest)) content[`node.${key}`] = JSON.stringify(value)
        const definition = files[`nodes/${stem}.definition.json`]
        if (definition !== undefined) content.definition = definition
        out.set(entry.id, {
            label: String(data.label || data.name || entry.id),
            content,
            layout: JSON.stringify(layout[entry.id]?.position ?? null)
        })
    }
    return out
}

function edgeKeys(files: FlowFiles): string {
    const edges = parse(files['edges.json'])
    if (!Array.isArray(edges)) return ''
    return JSON.stringify(edges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle]).sort())
}

// What changed going from `base` to `head`. Field names are the input names, or the data key.
export function diffFlowFiles(base: FlowFiles | null, head: FlowFiles | null): VersionDiff {
    const before = base ? nodesOf(base) : new Map<string, NodeView>()
    const after = head ? nodesOf(head) : new Map<string, NodeView>()
    const added = [...after].filter(([id]) => !before.has(id)).map(([id, node]) => ({ id, label: node.label }))
    const removed = [...before].filter(([id]) => !after.has(id)).map(([id, node]) => ({ id, label: node.label }))
    const changed: NodeChange[] = []
    const moved: string[] = []
    for (const [id, node] of after) {
        const old = before.get(id)
        if (!old) continue
        const keys = new Set([...Object.keys(old.content), ...Object.keys(node.content)])
        const fields = [...keys]
            .filter((key) => old.content[key] !== node.content[key])
            .map((key) => (key.startsWith('inputs.') ? key.slice('inputs.'.length) : key))
            .sort()
        if (fields.length) changed.push({ id, label: node.label, fields })
        if (old.layout !== node.layout) moved.push(id)
    }
    const oldName = parse(base?.['flow.json'])?.name
    const newName = parse(head?.['flow.json'])?.name
    return {
        added,
        removed,
        changed,
        moved,
        edgesChanged: Boolean(base && head) && edgeKeys(base!) !== edgeKeys(head!),
        renamed: oldName && newName && oldName !== newName ? { from: oldName, to: newName } : null
    }
}
