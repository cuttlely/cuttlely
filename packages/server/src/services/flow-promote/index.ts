// Promote: moving a flow from Dev to Prod. Dev copies its published versions to a GitHub repository; Prod reads
// them from there (see GithubSync, read mode) into INCOMING_REF and lists here, per flow, the version that is
// newer than the one it last promoted. Reading changes nothing on Prod. A person promotes a version, which puts it
// Live through the normal update path (controllers/flow-promote): never on its own, and never over a draft.
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import flowDraftsService from '../flow-drafts'
import {
    diffVersion,
    flushVersions,
    getGithub,
    getStore,
    getVersion,
    hasChanges,
    isVersioningEnabled,
    ReadOptions,
    RecordOptions,
    VersionContent,
    VersionedFlow
} from '../flow-versions'
import { INCOMING_REF } from '../flow-versions/github'
import { FlowVersionEntry, listAllVersions, readFlowAt, VersionDiff, VersionEntry } from '../flow-versions/history'
import { runGit } from '../flow-versions/store'
import { trailerGrep } from '../flow-versions/trailers'
import { Unavailable, startUnavailable, typeUnavailable } from '../flow-check/kinds'

// How far back Prod looks on each side. A flow not published on Dev within this many versions is not offered.
const INCOMING_LIMIT = 5000
const LOCAL_LIMIT = 5000
// The versions listed under "What changed on Dev" for one flow.
const CHANGES_LIMIT = 20

const SHA40 = /^[0-9a-f]{40}$/
const FLOW_ID = /^[A-Za-z0-9-]{1,64}$/

// A version on Dev, as the promote view shows it. Dev's user ids are left out: they mean nothing on Prod.
export interface DevVersion {
    sha: string
    shortSha: string
    date: string
    author: string
    title: string
}

export interface IncomingFlow {
    flowId: string
    name: string
    type: string
    // 'update': the flow is on Prod and this version differs from its Live. 'new': the flow is not on Prod yet.
    status: 'update' | 'new'
    // The newest published version on Dev: the one Promote puts Live.
    version: DevVersion
    // Versions published on Dev since the one last promoted here, newest first (at most CHANGES_LIMIT).
    changes: DevVersion[]
    // There are more changes than listed.
    moreChanges: boolean
    // Prod has unpublished changes for this flow. Promote keeps them, and Publish then asks before replacing Live.
    hasDraft: boolean
    // When this flow was last promoted here, and which version from Dev.
    lastPromoted: { sha: string; date: string } | null
}

export interface IncomingList {
    // This server is labeled Prod and history is on.
    enabled: boolean
    connected: boolean
    lastCheckedAt: string | null
    flows: IncomingFlow[]
}

export interface IncomingDetail extends IncomingFlow {
    diff: VersionDiff
    missingCredentials: Array<{ name: string; credentialName: string }>
    ambiguousCredentials: VersionContent['ambiguousCredentials']
    // How many inputs hold a hidden-secret placeholder. Live values carry over where Prod has them.
    hiddenSecrets: number
    // The behavior check compares Live with this version. Null when it can run.
    checkUnavailable: Unavailable | null
}

export interface PromoteDeps {
    // The flow with this id on this server, in any workspace.
    findFlow: (id: string) => Promise<ChatFlow | null>
    draftOf: (id: string) => Promise<string | null>
    environment: () => 'dev' | 'prod' | null
    connected: () => boolean
    lastCheckedAt: () => Promise<string | null>
    readOptions?: (workspaceId: string) => ReadOptions
    recordOptions?: RecordOptions
}

export const defaultDeps: PromoteDeps = {
    findFlow: async (id) => (await getRunningExpressApp().AppDataSource.getRepository(ChatFlow).findOneBy({ id })) || null,
    draftOf: async (id) => (await flowDraftsService.getState(id))?.draftFlowData || null,
    environment: () => getGithub().environment(),
    connected: () => getGithub().isConnected(),
    lastCheckedAt: async () => (await getGithub().status()).lastCheckedAt
}

function devVersion(entry: VersionEntry): DevVersion {
    return { sha: entry.sha, shortSha: entry.shortSha, date: entry.date, author: entry.author, title: entry.title }
}

async function incomingHead(): Promise<string | null> {
    try {
        const out = await runGit(getStore().dir, ['rev-parse', '--verify', '-q', `${INCOMING_REF}^{commit}`])
        return out.stdout.trim() || null
    } catch {
        return null
    }
}

// A stand-in for a flow Prod does not have yet: no nodes, so every node of the version is new.
function blankFlow(id: string, name: string, type: string, workspaceId: string): VersionedFlow {
    return { id, name, type, flowData: JSON.stringify({ nodes: [], edges: [] }), workspaceId }
}

interface Candidate {
    latest: FlowVersionEntry
    history: FlowVersionEntry[]
    row: ChatFlow | null
    lastPromoted: VersionEntry | null
}

// The newest version of each flow on Dev, with what this server has for it. Flows deleted on Dev, flows in
// another workspace here, and flows whose newest version was already promoted are left out.
async function candidates(workspaceId: string, deps: PromoteDeps, onlyFlow?: string): Promise<Candidate[]> {
    // Only while connected: a disconnected server offers nothing, even if a read finished after Disconnect.
    if (!isVersioningEnabled() || deps.environment() !== 'prod' || !deps.connected()) return []
    await flushVersions()
    const head = await incomingHead()
    if (!head) return []
    const store = getStore()
    const incoming = await listAllVersions(store, INCOMING_REF, INCOMING_LIMIT, onlyFlow ? trailerGrep('Flow', onlyFlow) : undefined)
    const promoted = await listAllVersions(store, 'main', LOCAL_LIMIT, trailerGrep('Kind', 'promote'))
    const byFlow = new Map<string, FlowVersionEntry[]>()
    for (const entry of incoming) {
        if (onlyFlow && entry.flowId !== onlyFlow) continue
        if (!FLOW_ID.test(entry.flowId)) continue
        const list = byFlow.get(entry.flowId) || []
        list.push(entry)
        byFlow.set(entry.flowId, list)
    }
    const result: Candidate[] = []
    for (const [flowId, history] of byFlow) {
        const latest = history[0]
        if (latest.kind === 'delete' || latest.kind === 'unknown') continue
        const row = await deps.findFlow(flowId)
        if (row && row.workspaceId !== workspaceId) continue
        const lastPromoted = promoted.find((entry) => entry.flowId === flowId && entry.promotedFrom) || null
        if (lastPromoted?.promotedFrom === latest.sha) continue
        result.push({ latest, history, row, lastPromoted })
    }
    return result
}

async function toIncoming(candidate: Candidate, deps: PromoteDeps, workspaceId: string): Promise<IncomingFlow | null> {
    const { latest, history, row, lastPromoted } = candidate
    if (row) {
        // A version that matches Live already is not offered, whoever put it there.
        const diff = await diffVersion(row, latest.sha, 'current', deps.recordOptions)
        if (!diff) return null
        const version = await getVersion(row, latest.sha, deps.readOptions?.(workspaceId))
        const typeChanged = Boolean(version?.type && version.type !== (row.type || 'CHATFLOW'))
        const categoryChanged = Boolean(version) && (version?.category ?? '') !== String(row.category || '')
        if (!hasChanges(diff) && !typeChanged && !categoryChanged) return null
    }
    // A flow this server does not have yet: its type as Dev stored it, so each flows page lists its own kind.
    let storedType: string = row?.type || 'CHATFLOW'
    if (!row) {
        try {
            const files = await readFlowAt(getStore(), latest.flowId, latest.sha)
            storedType = String(JSON.parse(files?.['flow.json'] || '{}')?.type || 'CHATFLOW')
        } catch {
            storedType = 'CHATFLOW'
        }
    }
    const since = lastPromoted?.promotedFrom
    const stop = since ? history.findIndex((entry) => entry.sha === since) : -1
    const changes = (stop >= 0 ? history.slice(0, stop) : history).filter((entry) => entry.kind !== 'delete')
    return {
        flowId: latest.flowId,
        name: latest.name || row?.name || 'Untitled flow',
        type: storedType,
        status: row ? 'update' : 'new',
        version: devVersion(latest),
        changes: changes.slice(0, CHANGES_LIMIT).map(devVersion),
        moreChanges: changes.length > CHANGES_LIMIT,
        hasDraft: row ? Boolean(await deps.draftOf(row.id)) : false,
        lastPromoted: lastPromoted && lastPromoted.promotedFrom ? { sha: lastPromoted.promotedFrom, date: lastPromoted.date } : null
    }
}

// Every flow with a new version from Dev, newest first.
export async function listIncoming(workspaceId: string, deps: PromoteDeps = defaultDeps): Promise<IncomingList> {
    const enabled = isVersioningEnabled() && deps.environment() === 'prod'
    if (!enabled) return { enabled, connected: false, lastCheckedAt: null, flows: [] }
    const flows: IncomingFlow[] = []
    for (const candidate of await candidates(workspaceId, deps)) {
        const item = await toIncoming(candidate, deps, workspaceId)
        if (item) flows.push(item)
    }
    flows.sort((a, b) => (a.version.date < b.version.date ? 1 : a.version.date > b.version.date ? -1 : 0))
    return { enabled, connected: deps.connected(), lastCheckedAt: await deps.lastCheckedAt(), flows }
}

// One flow's new version from Dev, with what Promote would change and the credentials it needs here.
// A version Dev sent is mapped to this server's own Credentials by name and type.
export async function getIncoming(flowId: string, workspaceId: string, deps: PromoteDeps = defaultDeps): Promise<IncomingDetail> {
    if (!FLOW_ID.test(flowId)) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'There is no new version from Dev for this flow.')
    const [candidate] = await candidates(workspaceId, deps, flowId)
    const item = candidate ? await toIncoming(candidate, deps, workspaceId) : null
    if (!candidate || !item) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'There is no new version from Dev for this flow.')
    const base = candidate.row || blankFlow(flowId, item.name, item.type, workspaceId)
    const version = await getVersion(base, item.version.sha, deps.readOptions?.(workspaceId))
    const diff = await diffVersion(base, item.version.sha, 'current', deps.recordOptions)
    if (!version || !diff) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'There is no new version from Dev for this flow.')
    const { sha: _sha, against: _against, ...changes } = diff
    const type = version.type || item.type
    const checkUnavailable: IncomingDetail['checkUnavailable'] = !candidate.row
        ? { code: 'new-flow', message: 'This flow is new on this server, so there is no Live version to compare with.' }
        : typeUnavailable(type, candidate.row.type) ??
          startUnavailable(type, [candidate.row.flowData, version.flowData]) ??
          (version.missingCredentials.length
              ? { code: 'credentials', message: 'Add the missing credentials first. The check runs the new version with them.' }
              : null)
    return {
        ...item,
        type,
        diff: changes,
        missingCredentials: version.missingCredentials.map((ref) => ({ name: ref.name, credentialName: ref.credentialName })),
        ambiguousCredentials: version.ambiguousCredentials,
        hiddenSecrets: version.hiddenSecrets.reduce((sum, hidden) => sum + hidden.count, 0),
        checkUnavailable
    }
}

// The canvas the behavior check runs for this version, with this server's credentials. Only for a flow Prod has.
// flowData is null when a credential it uses is missing here. Null when there is no new version.
export async function incomingCanvas(
    flow: ChatFlow,
    workspaceId: string,
    deps: PromoteDeps = defaultDeps
): Promise<{ sha: string; flowData: string | null; type: string } | null> {
    const [candidate] = await candidates(workspaceId, deps, flow.id)
    if (!candidate) return null
    const version = await getVersion(flow, candidate.latest.sha, deps.readOptions?.(workspaceId))
    if (!version) return null
    return {
        sha: candidate.latest.sha,
        flowData: version.missingCredentials.length ? null : version.flowData,
        // The kind of flow the version from Dev is, so the check can refuse a kind it cannot replay.
        type: version.type || flow.type || 'CHATFLOW'
    }
}

// Checks that `sha` is still the newest version from Dev for this flow, and returns it.
export async function promotable(flowId: string, sha: unknown, workspaceId: string, deps: PromoteDeps = defaultDeps): Promise<Candidate> {
    if (typeof sha !== 'string' || !SHA40.test(sha)) {
        throw new InternalFlowiseError(
            StatusCodes.BAD_REQUEST,
            'sha is the full id of the version to promote: 40 lowercase hex characters.'
        )
    }
    if (!isVersioningEnabled()) throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Version history is off on this server.')
    if (deps.environment() !== 'prod') {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Only a server labeled Prod promotes versions from Dev.')
    }
    if (!FLOW_ID.test(flowId)) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'There is no new version from Dev for this flow.')
    const [candidate] = await candidates(workspaceId, deps, flowId)
    if (!candidate) {
        throw new InternalFlowiseError(
            StatusCodes.CONFLICT,
            'This version from Dev is already Live here, or it is no longer offered. Reload to see the latest.'
        )
    }
    if (candidate.latest.sha !== sha) {
        throw new InternalFlowiseError(
            StatusCodes.CONFLICT,
            'A newer version of this flow arrived from Dev while you were looking. Review it, then promote.'
        )
    }
    return candidate
}

export default { listIncoming, getIncoming, incomingCanvas, promotable }
