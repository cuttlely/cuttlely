// Version history for every canvas. Each successful save writes the flow as
// files to the local versions repo and commits it. This never blocks or fails
// a save: commits run in the background, one at a time, and a failure is
// logged and kept for the status route.
import { VersionActor, actorFromUser, versionAuthor } from './author'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { In, IsNull } from 'typeorm'
import { Credential } from '../../database/entities/Credential'
import logger from '../../utils/logger'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { getErrorMessage } from '../../errors/utils'
import { CredentialRef, deserializeFlow, FlowFiles, HiddenSecret, hiddenSecretsIn, parseFlowData, serializeFlow } from './serialize'
import { diffFlowFiles, isSha, listFlowVersions, previousFlowVersion, readFlowAt, VersionDiff, VersionEntry } from './history'
import { scanForSecrets } from './secrets'
import { summarizeChange } from './summary'
import { VersionKind, VersionStore } from './store'
import { GITHUB_CREDENTIAL, GithubCredentialStore, GithubSync } from './github'

export interface VersionedFlow {
    id: string
    name: string
    type?: string
    category?: string | null
    flowData: string
    workspaceId?: string
}

export interface VersioningStatus {
    enabled: boolean
    dir: string
    lastCommit: string | null
    lastError: { flowId: string; message: string; at: string } | null
}

let store: VersionStore | null = null
let queue: Promise<unknown> = Promise.resolve()
let lastCommit: string | null = null
let lastError: VersioningStatus['lastError'] = null
let github: GithubSync | null = null

// The GitHub token is a Github API credential in Credentials, read only when copying.
// Only the id, name and type are queried here; the value is decrypted in memory and never logged.
const githubCredentials: GithubCredentialStore = {
    async get(id, workspaceId) {
        const row = await getRunningExpressApp()
            .AppDataSource.getRepository(Credential)
            .findOne({ where: { id, workspaceId, credentialName: GITHUB_CREDENTIAL } })
        if (!row) return null
        const data = await (await import('../../utils')).decryptCredentialData(row.encryptedData)
        return { id: row.id, name: row.name, token: typeof data?.accessToken === 'string' ? data.accessToken.trim() : '' }
    },
    async create({ name, token, workspaceId }) {
        const credentialsService = (await import('../credentials')).default
        const saved = await credentialsService.createCredential({
            name,
            credentialName: GITHUB_CREDENTIAL,
            plainDataObj: { accessToken: token },
            workspaceId
        })
        return { id: saved.id, name: saved.name }
    }
}

// The optional copy to GitHub. One per server.
export function getGithub(): GithubSync {
    if (!github) {
        github = new GithubSync({
            store: getStore,
            enabled: isVersioningEnabled,
            credentials: githubCredentials,
            log: (message) => logger.warn(message)
        })
    }
    return github
}

// At server start: when GitHub is connected, copy anything saved while it could not be reached.
export function startGithubSync(): void {
    try {
        if (!isVersioningEnabled()) return
        if (hasSavedGithub()) getGithub().start()
    } catch (error) {
        logger.warn(`[versions] GitHub copy did not start: ${getErrorMessage(error)}`)
    }
}

// Tests swap in a GithubSync with their own encryption and timings.
export function setGithubForTests(sync: GithubSync | null): void {
    if (github) github.stop()
    github = sync
}

// A new version was committed. Copy it to GitHub soon, when connected. Never throws.
function copyToGithub(): void {
    try {
        if (github || hasSavedGithub()) getGithub().notify()
    } catch {
        // never break a save
    }
}

function hasSavedGithub(): boolean {
    try {
        return fs.existsSync(path.join(versionsDir(), '.git', 'versions-github.json'))
    } catch {
        return false
    }
}

// History is on by default. CUTTLELY_VERSIONS=off (or false, 0, no) turns it off.
export function isVersioningEnabled(): boolean {
    const value = String(process.env.CUTTLELY_VERSIONS ?? '')
        .trim()
        .toLowerCase()
    return !['off', 'false', '0', 'no'].includes(value)
}

export function versionsDir(): string {
    if (process.env.CUTTLELY_VERSIONS_DIR) return path.resolve(process.env.CUTTLELY_VERSIONS_DIR)
    const dataDir = process.env.CUTTLELY_DATA_DIR || path.join(os.homedir(), '.cuttlely')
    return path.join(dataDir, 'versions')
}

export function getStore(): VersionStore {
    const dir = versionsDir()
    if (!store || store.dir !== dir) store = new VersionStore(dir)
    return store
}

export function resetForTests(): void {
    if (github) github.stop()
    github = null
    store = null
    queue = Promise.resolve()
    lastCommit = null
    lastError = null
}

export function getStatus(): VersioningStatus {
    return { enabled: isVersioningEnabled(), dir: versionsDir(), lastCommit, lastError }
}

const CREDENTIAL_KEYS = new Set(['FLOWISE_CREDENTIAL_ID', 'credential'])

// Credential ids anywhere in a node: data.credential, inputs.FLOWISE_CREDENTIAL_ID, and the
// nested model and tool configs of Agentflow v2 (also inside JSON text).
function collectCredentialIds(value: unknown, ids: Set<string>, depth = 0): void {
    if (depth > 12 || value === null || value === undefined) return
    if (typeof value === 'string') {
        const text = value.trim()
        if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
            try {
                collectCredentialIds(JSON.parse(text), ids, depth + 1)
            } catch {
                // not JSON text
            }
        }
        return
    }
    if (Array.isArray(value)) {
        for (const item of value) collectCredentialIds(item, ids, depth + 1)
        return
    }
    if (typeof value === 'object') {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (CREDENTIAL_KEYS.has(key) && typeof item === 'string' && item.trim()) ids.add(item.trim())
            else collectCredentialIds(item, ids, depth + 1)
        }
    }
}

export function credentialIds(flowData: string): string[] {
    const ids = new Set<string>()
    let flow
    try {
        flow = parseFlowData(flowData)
    } catch {
        return []
    }
    for (const node of flow.nodes) {
        const data = node?.data || {}
        if (typeof data.credential === 'string' && data.credential.trim()) ids.add(data.credential.trim())
        collectCredentialIds(data.inputs, ids)
    }
    return [...ids]
}

// Only the name and type are read. Encrypted data is never selected.
async function credentialNames(flowData: string, workspaceId?: string): Promise<Map<string, CredentialRef>> {
    const ids = credentialIds(flowData)
    const out = new Map<string, CredentialRef>()
    if (!ids.length) return out
    const rows = await getRunningExpressApp()
        .AppDataSource.getRepository(Credential)
        .find({ select: ['id', 'name', 'credentialName'], where: { id: In(ids), workspaceId: workspaceId ?? IsNull() } })
    for (const row of rows || []) out.set(row.id, { name: row.name, credentialName: row.credentialName })
    return out
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
}

function fail(flowId: string, error: unknown): null {
    const message = getErrorMessage(error)
    lastError = { flowId, message, at: new Date().toISOString() }
    logger.warn(`[versions] ${flowId}: ${message}`)
    return null
}

export type { VersionActor }

export interface RecordOptions {
    author?: VersionActor | null
    kind?: VersionKind
    lookupCredentials?: (flowData: string, workspaceId?: string) => Promise<Map<string, CredentialRef>>
    title?: string
    // Put before the generated summary when there is no title, as in "Published: Changed instructions".
    titlePrefix?: string
    // Promote: the version from Dev this save copies, kept with the new version.
    promotedFrom?: string
}

// Writes and commits one flow. Resolves to the commit id, or null when nothing changed or it failed.
// Call it right after the database save: the flow is copied now and queued in save order, so a slower
// step after the save (schedule, harness, or ETL sync) cannot put an older save after a newer one.
export function recordFlowVersion(saved: VersionedFlow, options: RecordOptions = {}): Promise<string | null> {
    if (!isVersioningEnabled() || !saved?.id) return Promise.resolve(null)
    const flow: VersionedFlow = {
        id: saved.id,
        name: saved.name,
        type: saved.type,
        category: saved.category,
        flowData: saved.flowData,
        workspaceId: saved.workspaceId
    }
    return enqueue(async () => {
        try {
            const repo = getStore()
            await repo.ensure()
            const lookup = options.lookupCredentials || credentialNames
            const names = await lookup(flow.flowData, flow.workspaceId)
            const files: FlowFiles = serializeFlow(
                { id: flow.id, name: flow.name, type: flow.type, category: flow.category },
                flow.flowData,
                { credentialRef: (id) => names.get(id) }
            )
            const hits = scanForSecrets(files)
            if (hits.length) {
                const where = hits.map((hit) => `${hit.file} (${hit.pattern})`).join(', ')
                return fail(flow.id, `Not saved to history: secret-shaped text in ${where}. Move it to a credential.`)
            }
            const before = repo.readFlow(flow.id)
            const summary = summarizeChange(before, files, flow.name)
            const hidden = hiddenSecretsIn(files).reduce((sum, item) => sum + item.count, 0)
            const kind: VersionKind = options.kind || (before ? 'save' : 'create')
            const paths = repo.writeFlow(flow.id, flow.name, files)
            const sha = await repo.commit(paths, {
                flowId: flow.id,
                name: flow.name,
                kind,
                title: options.title || withPrefix(options.titlePrefix, summary.title),
                details: hidden ? [...summary.details, hiddenSecretNote(hidden)] : summary.details,
                author: versionAuthor(options.author),
                hidden,
                promotedFrom: options.promotedFrom
            })
            if (sha) {
                lastCommit = sha
                copyToGithub()
            }
            return sha
        } catch (error) {
            return fail(flow.id, error)
        }
    })
}

// The summary with a prefix, at most 72 characters.
export function withPrefix(prefix: string | undefined, title: string): string {
    if (!prefix) return title
    const full = `${prefix}${title}`
    return full.length > 72 ? `${full.slice(0, 71).trimEnd()}…` : full
}

// "1 secret-looking value was hidden from history"
export function hiddenSecretNote(count: number): string {
    return count === 1 ? '1 secret-looking value was hidden from history' : `${count} secret-looking values were hidden from history`
}

export function recordFlowDeletion(flow: Pick<VersionedFlow, 'id' | 'name'>, author?: VersionActor | null): Promise<string | null> {
    if (!isVersioningEnabled() || !flow?.id) return Promise.resolve(null)
    return enqueue(async () => {
        try {
            const repo = getStore()
            await repo.ensure()
            const paths = repo.removeFlow(flow.id)
            const sha = await repo.commit(paths, {
                flowId: flow.id,
                name: flow.name,
                kind: 'delete',
                title: `Deleted ${flow.name}`,
                author: versionAuthor(author)
            })
            if (sha) {
                lastCommit = sha
                copyToGithub()
            }
            return sha
        } catch (error) {
            return fail(flow.id, error)
        }
    })
}

// The credentials in this workspace with this name and type, oldest first. Only id and dates are read.
async function credentialIdsByName(ref: CredentialRef, workspaceId?: string): Promise<string[]> {
    const rows = await getRunningExpressApp()
        .AppDataSource.getRepository(Credential)
        .find({
            select: ['id', 'createdDate'],
            where: { name: ref.name, credentialName: ref.credentialName, workspaceId: workspaceId ?? IsNull() },
            order: { createdDate: 'ASC', id: 'ASC' }
        })
    return (rows || []).map((row) => row.id)
}

// More than one credential has the name and type a version asks for.
export interface AmbiguousCredential extends CredentialRef {
    count: number
    // 'current': the one the flow uses now. 'oldest': none of them is in use, so the oldest is used.
    using: 'current' | 'oldest'
}

// Picks one credential id for a name and type. With several, the one the flow uses now wins, else the
// oldest, so the choice is the same every time; either way the caller is told.
export function pickCredential(
    ref: CredentialRef,
    ids: string[],
    inUse: Set<string>
): { id: string | undefined; ambiguous: AmbiguousCredential | null } {
    if (!ids.length) return { id: undefined, ambiguous: null }
    if (ids.length === 1) return { id: ids[0], ambiguous: null }
    const current = ids.find((id) => inUse.has(id))
    const ambiguous: AmbiguousCredential = {
        name: ref.name,
        credentialName: ref.credentialName,
        count: ids.length,
        using: current ? 'current' : 'oldest'
    }
    return { id: current || ids[0], ambiguous }
}

export interface VersionList {
    enabled: boolean
    versions: VersionEntry[]
    lastError: string | null
}

export async function listVersions(flowId: string): Promise<VersionList> {
    if (!isVersioningEnabled()) return { enabled: false, versions: [], lastError: null }
    await flushVersions()
    const versions = await listFlowVersions(getStore(), flowId)
    return { enabled: true, versions, lastError: lastError && lastError.flowId === flowId ? lastError.message : null }
}

export interface VersionContent {
    sha: string
    name: string
    type?: string
    // The flow's category as stored with this version; '' when it had none.
    category?: string
    flowData: string
    missingCredentials: CredentialRef[]
    ambiguousCredentials: AmbiguousCredential[]
    // Inputs where secret-looking text was hidden when this version was saved. They hold the placeholder.
    hiddenSecrets: HiddenSecret[]
}

export interface ReadOptions {
    // Test hook: map a name and type straight to one id.
    resolveCredential?: (ref: CredentialRef) => Promise<string | undefined>
    // Test hook: the ids with this name and type in the workspace, oldest first.
    matchCredentials?: (ref: CredentialRef) => Promise<string[]>
}

// One version as a canvas. Credentials are mapped by name in this workspace, and
// dropped secret inputs are carried over from the flow as it is now.
export async function getVersion(current: VersionedFlow, sha: string, options: ReadOptions = {}): Promise<VersionContent | null> {
    if (!isVersioningEnabled() || !isSha(sha)) return null
    await flushVersions()
    const files = await readFlowAt(getStore(), current.id, sha)
    if (!files) return null
    const refs = new Map<string, string | undefined>()
    const ambiguousCredentials: AmbiguousCredential[] = []
    const inUse = new Set(credentialIds(current.flowData))
    const match = options.matchCredentials || ((ref: CredentialRef) => credentialIdsByName(ref, current.workspaceId))
    for (const ref of credentialRefsIn(files)) {
        if (options.resolveCredential) {
            refs.set(refKey(ref), await options.resolveCredential(ref))
            continue
        }
        const picked = pickCredential(ref, await match(ref), inUse)
        refs.set(refKey(ref), picked.id)
        if (picked.ambiguous) ambiguousCredentials.push(picked.ambiguous)
    }
    const result = deserializeFlow(files, { current: current.flowData, resolveCredential: (ref) => refs.get(refKey(ref)) })
    return {
        sha,
        name: result.meta.name,
        type: result.meta.type,
        category: String(result.meta.category || ''),
        flowData: JSON.stringify(result.flowData),
        missingCredentials: result.missingCredentials,
        ambiguousCredentials,
        hiddenSecrets: result.hiddenSecrets
    }
}

function refKey(ref: CredentialRef): string {
    return `${ref.credentialName}\u0000${ref.name}`
}

function credentialRefsIn(files: FlowFiles): CredentialRef[] {
    try {
        const flow = JSON.parse(files['flow.json'])
        return Array.isArray(flow?.credentials) ? flow.credentials : []
    } catch {
        return []
    }
}

export type DiffAgainst = 'previous' | 'current' | string

export interface VersionDiffResult extends VersionDiff {
    sha: string
    against: string | null
}

// What the viewed version (`sha`) has compared with `against`: its previous version, the flow as it is now, or another sha.
export async function diffVersion(
    current: VersionedFlow,
    sha: string,
    against: DiffAgainst = 'previous',
    options: RecordOptions = {}
): Promise<VersionDiffResult | null> {
    if (!isVersioningEnabled() || !isSha(sha)) return null
    await flushVersions()
    const store = getStore()
    const head = await readFlowAt(store, current.id, sha)
    if (!head) return null
    let base: FlowFiles | null = null
    let baseRef: string | null = null
    if (against === 'current') {
        const lookup = options.lookupCredentials || credentialNames
        const names = await lookup(current.flowData, current.workspaceId)
        base = serializeFlow({ id: current.id, name: current.name, type: current.type, category: current.category }, current.flowData, {
            credentialRef: (id) => names.get(id)
        })
        baseRef = 'current'
    } else if (against === 'previous') {
        const previous = await previousFlowVersion(store, current.id, sha)
        if (previous) {
            base = await readFlowAt(store, current.id, previous.sha)
            baseRef = previous.sha
        }
    } else if (isSha(against)) {
        base = await readFlowAt(store, current.id, against)
        if (!base) return null
        baseRef = against
    } else {
        return null
    }
    return { sha, against: baseRef, ...diffFlowFiles(base, head) }
}

// "Restored: Changed instructions on Harness Prime (abc1234)", at most 72 characters.
// Roll back uses verb "Rolled back Live to": "Rolled back Live to: Changed instructions (abc1234)".
export function restoreTitle(sha: string, title?: string, verb = 'Restored'): string {
    const short = String(sha).slice(0, 7)
    const base = title ? `${verb}: ${title}` : `${verb} a version`
    const tail = ` (${short})`
    const room = 72 - tail.length
    return `${base.length > room ? `${base.slice(0, room - 1).trimEnd()}…` : base}${tail}`
}

// True when a diff names any change at all.
export function hasChanges(diff: VersionDiff): boolean {
    return Boolean(
        diff.added.length || diff.removed.length || diff.changed.length || diff.moved.length || diff.edgesChanged || diff.renamed
    )
}

// True when restoring would change an input the version holds with hidden secrets. The diff cannot see
// this: the live value is hidden the same way before comparing. Restore then writes the placeholder,
// as its warning says, instead of reporting the flow as unchanged.
export function hiddenInputsDiffer(currentFlowData: string, versionFlowData: string, hidden: HiddenSecret[]): boolean {
    if (!hidden?.length) return false
    const inputsOf = (flowData: string) => {
        const map = new Map<string, Record<string, unknown>>()
        for (const node of parseFlowData(flowData).nodes || []) {
            if (node?.id) map.set(node.id, (node as any).data?.inputs || {})
        }
        return map
    }
    const live = inputsOf(currentFlowData)
    const saved = inputsOf(versionFlowData)
    return hidden.some(
        (item) => JSON.stringify(live.get(item.node)?.[item.input] ?? null) !== JSON.stringify(saved.get(item.node)?.[item.input] ?? null)
    )
}

// The version that is Live now: the newest one, when Live has not changed since it was recorded.
// Null when there is none, or the latest change to Live could not be recorded (for example, secret-shaped text).
// Compared as history stores flows: values history never keeps (hidden secret-looking text, passwords) are not
// compared, because a version holds only their placeholder. A change to only such a value cannot be seen here,
// and checking hiddenInputsDiffer instead would mark every flow with a hidden value as not Live.
export async function liveVersionSha(
    current: VersionedFlow,
    versions: VersionEntry[],
    options: RecordOptions = {}
): Promise<string | null> {
    const newest = versions[0]
    if (!newest || newest.kind === 'delete') return null
    const diff = await diffVersion(current, newest.sha, 'current', options)
    if (!diff || hasChanges(diff)) return null
    // The diff compares nodes, edges and name; a version with another stored type or category is never Live.
    const files = await readFlowAt(getStore(), current.id, newest.sha)
    if (!files) return null
    const stored = storedMeta(files)
    return stored.type === (current.type || 'CHATFLOW') && stored.category === String(current.category || '') ? newest.sha : null
}

function storedMeta(files: FlowFiles): { type: string; category: string } {
    try {
        const flow = JSON.parse(files['flow.json'])
        return { type: String(flow?.type || 'CHATFLOW'), category: String(flow?.category || '') }
    } catch {
        return { type: 'CHATFLOW', category: '' }
    }
}

// The last reason a save of this flow could not be recorded, if that was the most recent failure.
export function lastErrorFor(flowId: string): string | null {
    return lastError && lastError.flowId === flowId ? lastError.message : null
}

// Waits for queued commits. Used by tests and before reads that must see the latest save.
export function flushVersions(): Promise<void> {
    return queue.then(() => undefined)
}

export default {
    isVersioningEnabled,
    versionAuthor,
    actorFromUser,
    versionsDir,
    getStatus,
    recordFlowVersion,
    recordFlowDeletion,
    flushVersions,
    listVersions,
    getVersion,
    getGithub,
    startGithubSync,
    diffVersion,
    hasChanges,
    hiddenInputsDiffer,
    lastErrorFor,
    liveVersionSha,
    restoreTitle,
    withPrefix
}
