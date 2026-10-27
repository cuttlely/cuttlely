// Draft and Live for one flow. ChatFlow.flowData is Live: prediction, embeds, shared links, MCP,
// schedules and webhooks read it, unchanged. POST /api/v1/harnesses/:name/runs reads the roster synced from
// that Live canvas. The canvas chat and Try it use the internal prediction route, which runs the draft when
// one exists. The canvas saves to a draft in flow_version_state. Publish copies the draft to Live (and syncs
// the harness roster); Roll back sets Live to an earlier version.
//
// No data migration: a flow with no state row has no draft. An existing harness stays the Live canvas it
// already has, and the first edit after drafts include harnesses creates a draft.
import crypto from 'crypto'
import { StatusCodes } from 'http-status-codes'
import { IsNull, type EntityManager, type FindOptionsWhere } from 'typeorm'
import { versionAuthor } from '@cuttlely/versioning'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { FlowVersionState } from '../../database/entities/FlowVersionState'
import { User } from '../../database/entities/identity/User'
import { AppError } from '../../errors/appError'
import { DraftChangedError } from './draftChanged'
import { containsBase64File, updateFlowDataWithFilePaths } from '../../utils/fileRepository'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { stampNodePack } from '../../utils/nodePacks'
import type { IHarnessCaller } from '../../Interface'
import { assertCallerMayUseHarnesses, assertHarnessReferencesWellFormed, referencedHarnessNames } from '../harnesses/apiAccess'
import {
    GateResult,
    GateStatus,
    conflictingSettingsMessage,
    emptyGateStatus,
    gateResultRecord,
    parseGateInput,
    publishBlockReason,
    publishGateApplies,
    readEvaluatorIdList,
    readGateResult,
    sameGateSettings,
    postProcessChangedReason,
    postProcessHash,
    testSetChangedReason
} from './gate'
import { datasetStartRefusal } from '../flow-check/kinds'
import { casesFromDataset, currentTestSetHash, loadEvaluators } from '../flow-check/score'
import { assertHarnessDraftLimits } from './harnessLimits'

export { redactDraftStatus } from './gate'
export { DraftChangedError } from './draftChanged'
export type { DraftSaver } from './draftChanged'

// Test seam. A race test changes the flow's type after a draft save has started and before it writes.
export const draftWriteHooks: {
    beforeDraftWrite: null | (() => Promise<void>)
    // After the row is read and before this save writes. A test uses it to commit another write in between.
    afterStateRead: null | (() => Promise<void>)
    // After the settings read and before the locked re-read. A test uses it to commit a draft in between.
    beforeSettingsWrite: null | (() => Promise<void>)
} = { beforeDraftWrite: null, afterStateRead: null, beforeSettingsWrite: null }

const OVERLAPPED_SAVE = 'That save overlapped another save. Try again.'

const TYPE_CHANGED =
    "This flow changed to another kind of flow after these edits started, so they can't be saved. Discard them to continue."

function unlockedManager(ds: any): EntityManager {
    return (
        ds.manager ?? {
            getRepository: (entity: unknown) => ds.getRepository(entity),
            createQueryBuilder: (...args: unknown[]) => ds.createQueryBuilder?.(...args)
        }
    )
}

// One chain of state writes per flow. SQLite has a single connection and no row lock, so two
// first inserts would both see no row. A transaction on that connection would also pull other
// requests' statements into it, so the writes wait here instead.
const sqliteStateWrites = new Map<string, Promise<void>>()

function enqueueSqliteStateWrite<T>(chatflowId: string, fn: () => Promise<T>): Promise<T> {
    const previous = sqliteStateWrites.get(chatflowId) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    const settled = run.then(
        () => undefined,
        () => undefined
    )
    sqliteStateWrites.set(chatflowId, settled)
    void settled.then(() => {
        if (sqliteStateWrites.get(chatflowId) === settled) sqliteStateWrites.delete(chatflowId)
    })
    return run
}

// Postgres, MySQL and MariaDB: lock the chatflow row so a draft save and a type change cannot pass
// each other's check. SQLite serializes the same read-then-insert in this process, one flow at a time.
export async function withChatflowLock<T>(chatflowId: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    const ds = getRunningExpressApp().AppDataSource as any
    const driver = ds.options?.type
    const sqlite = driver === 'sqlite' || driver === 'better-sqlite3'
    if (sqlite) return enqueueSqliteStateWrite(chatflowId, () => fn(unlockedManager(ds)))
    if (!driver || !ds.createQueryRunner) {
        if (typeof ds.transaction === 'function') return ds.transaction(fn)
        return fn(unlockedManager(ds))
    }
    const qr = ds.createQueryRunner()
    await qr.connect()
    try {
        await qr.startTransaction()
        await qr.manager
            .getRepository(ChatFlow)
            .createQueryBuilder('chat_flow')
            .setLock('pessimistic_write')
            .where('chat_flow.id = :id', { id: chatflowId })
            .getOne()
        const result = await fn(qr.manager)
        await qr.commitTransaction()
        return result
    } catch (error) {
        try {
            if (qr.isTransactionActive) await qr.rollbackTransaction()
        } catch {
            // The original error is the one to throw.
        }
        throw error
    } finally {
        await qr.release()
    }
}

// Canvas types whose edits go to a draft. Assistants have no canvas. A harness canvas saves here too;
// its runs keep serving the published roster until Publish syncs Live. A pipeline canvas saves here too;
// scheduled runs, a run you start, and a full rebuild keep the published pipeline until Publish syncs Live.
// Preview is the canvas test: it runs the draft and does not write the store.
export const DRAFT_TYPES = ['CHATFLOW', 'MULTIAGENT', 'AGENTFLOW', 'HARNESS', 'ETL']

// The flow fields this module reads.
export interface DraftFlow {
    id: string
    type?: string | null
    flowData: string
    workspaceId: string
    name?: string
}

export interface DraftInfo {
    flowData: string
    updatedDate: string | null
    // User id of the last person who saved the draft. Null for an API key.
    updatedBy: string | null
    // Live changed after the draft started, for example through the API.
    stale: boolean
    // The draft's version: sha256 hex of the stored draft canvas.
    hash: string
}

export interface DraftStatus {
    // Drafts are on for this server: CUTTLELY_DRAFTS is not off.
    enabled: boolean
    // How the canvas saves this flow: to a draft, or straight to Live.
    mode: 'draft' | 'live'
    // Why it saves to Live: drafts are off, this kind of canvas has no drafts yet, or Publish instantly is on.
    reason: 'off' | 'type' | 'publish-instantly' | null
    publishInstantly: boolean
    publishGate: GateStatus
    draft: DraftInfo | null
    // The last Publish or Roll back: the history version it recorded (null when none was recorded) and when.
    lastPublished: { sha: string | null; date: string } | null
}

// Drafts are on by default. CUTTLELY_DRAFTS=off (or false, 0, no) turns them off, and the canvas saves straight to Live.
export function isDraftsEnabled(): boolean {
    const value = String(process.env.CUTTLELY_DRAFTS ?? '')
        .trim()
        .toLowerCase()
    return !['off', 'false', '0', 'no'].includes(value)
}

export function typeHasDrafts(type?: string | null): boolean {
    return DRAFT_TYPES.includes(type || 'CHATFLOW')
}

function repo() {
    return getRunningExpressApp().AppDataSource.getRepository(FlowVersionState)
}

export function canvasHash(flowData: string): string {
    return crypto
        .createHash('sha256')
        .update(String(flowData ?? ''))
        .digest('hex')
}

// Where a draft started: the flow's type and a hash of the Live canvas, as "<TYPE>:<48 hex>" (fits the
// 64-character column). Live changing under the draft makes it stale; a different type means the draft is a
// canvas of another kind of flow and is never published. A bare 64-hex value (written before the type was kept)
// is compared as a canvas hash, and its type is unknown, so it is treated as another kind of flow: discard only.
export function draftBase(flow: Pick<DraftFlow, 'type' | 'flowData'>): string {
    return `${flow.type || 'CHATFLOW'}:${canvasHash(flow.flowData).slice(0, 48)}`
}

export function draftBaseType(base?: string | null): string | null {
    return base && base.includes(':') ? base.split(':')[0] : null
}

function baseMatches(base: string, flow: DraftFlow): boolean {
    return base.includes(':') ? base === draftBase(flow) : base === canvasHash(flow.flowData)
}

// The draft was started on another kind of flow, or on an unknown one (a base written before the type was kept).
function isOtherType(base: string | null | undefined, flow: Pick<DraftFlow, 'type'>): boolean {
    if (!base) return false
    const baseType = draftBaseType(base)
    return !baseType || baseType !== (flow.type || 'CHATFLOW')
}

// The same canvas, ignoring formatting.
export function sameCanvas(a: string, b: string): boolean {
    if (a === b) return true
    try {
        return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b))
    } catch {
        return false
    }
}

export async function getState(chatflowId: string): Promise<FlowVersionState | null> {
    return (await repo().findOneBy({ chatflowId })) || null
}

function modeFor(flow: DraftFlow, state: FlowVersionState | null): Pick<DraftStatus, 'mode' | 'reason'> {
    if (!isDraftsEnabled()) return { mode: 'live', reason: 'off' }
    if (!typeHasDrafts(flow.type)) return { mode: 'live', reason: 'type' }
    if (state?.publishInstantly) return { mode: 'live', reason: 'publish-instantly' }
    return { mode: 'draft', reason: null }
}

function draftInfo(flow: DraftFlow, state: FlowVersionState | null): DraftInfo | null {
    if (!state?.draftFlowData) return null
    return {
        flowData: state.draftFlowData,
        updatedDate: state.draftUpdatedDate ? new Date(state.draftUpdatedDate).toISOString() : null,
        updatedBy: state.draftUpdatedBy || null,
        stale: Boolean(state.draftBaseHash) && !baseMatches(state.draftBaseHash as string, flow),
        hash: canvasHash(state.draftFlowData)
    }
}

function gateSettingsOf(state: FlowVersionState | null) {
    return {
        enabled: Boolean(state?.publishGate),
        datasetId: state?.publishGateDatasetId || null,
        evaluatorIds: readEvaluatorIdList(state?.publishGateEvaluatorIds),
        threshold: typeof state?.publishGateThreshold === 'number' ? state.publishGateThreshold : null
    }
}

export function gateStatusFor(
    flow: Pick<DraftFlow, 'type' | 'flowData'>,
    state: FlowVersionState | null,
    draftFlowData?: string | null
): GateStatus {
    const settings = gateSettingsOf(state)
    const result = readGateResult(state?.publishGateResult)
    // Harness and other canvases share this row. The setting is refused for them, and a harness check
    // does not write a pass, so the gate stays off even when the flag is set.
    const enabled = publishGateApplies(flow.type) && settings.enabled
    // A start that cannot take a dataset keeps the gate on. Dropping it would let a start change publish with no pass.
    const startBlock = enabled ? datasetGateBlock(flow.type, [flow.flowData, draftFlowData]) : null
    const block = enabled
        ? startBlock || publishBlockReason({ ...settings, enabled: true }, result, draftFlowData ? canvasHash(draftFlowData) : null)
        : null
    if (!state) return emptyGateStatus()
    return { ...settings, enabled, result, block }
}

export function statusFrom(flow: DraftFlow, state: FlowVersionState | null): DraftStatus {
    const { mode, reason } = modeFor(flow, state)
    return {
        enabled: isDraftsEnabled(),
        mode,
        reason,
        publishInstantly: Boolean(state?.publishInstantly),
        publishGate: gateStatusWithNote(flow, gateStatusFor(flow, state, state?.draftFlowData)),
        // A draft left over from before Publish instantly or a type change is still shown, so it is not lost.
        draft: draftInfo(flow, state),
        lastPublished: state?.publishedDate ? { sha: state.liveSha || null, date: new Date(state.publishedDate).toISOString() } : null
    }
}

// The same 400 a dataset check returns, plus how to leave the block. The gate stays on.
function datasetGateBlock(type: string | null | undefined, canvases: Array<string | null | undefined>): string | null {
    const refusal = datasetStartRefusal(type, canvases)
    if (!refusal) return null
    return `${refusal} Turn off the passing test set before you publish.`
}

// An older pass stays usable only when this process has not started a later check. A check that failed
// to store its result, and failed to clear the previous one, notes its id here. Publish then refuses
// a stored result that is not from that check.
function gateStatusWithNote(flow: DraftFlow, gate: GateStatus): GateStatus {
    const noted = notedGateCheck(flow.id)
    if (!gate.enabled || !noted || gate.block || gate.result?.checkId === noted) return gate
    const threshold = gate.threshold ?? 100
    return {
        ...gate,
        block: `Publish needs a passing test set at ${threshold}%. The test set result could not be saved.`
    }
}

// A passing result is stale when the rows the check asked, or an evaluator's type or config, no longer match.
// A missing dataset or evaluator is the same stale result. Settings and draft checks stay in front of this.
async function withTestSet(flow: DraftFlow, status: DraftStatus): Promise<DraftStatus> {
    const gate = status.publishGate
    if (!gate.enabled || gate.block || !gate.result || gate.result.verdict !== 'passed' || !gate.datasetId) return status
    const current = await currentTestSetHash(gate.datasetId, gate.evaluatorIds, flow.workspaceId)
    const threshold = gate.threshold ?? gate.result.threshold
    if (!current || !gate.result.contentHash || current !== gate.result.contentHash) {
        return { ...status, publishGate: { ...gate, block: testSetChangedReason(threshold, gate.result) } }
    }
    const chat = await getRunningExpressApp().AppDataSource.getRepository(ChatFlow).findOneBy({ id: flow.id })
    const post = postProcessHash(chat?.chatbotConfig)
    if (!gate.result.postProcessHash || post !== gate.result.postProcessHash) {
        return { ...status, publishGate: { ...gate, block: postProcessChangedReason(threshold, gate.result) } }
    }
    return status
}

export async function getDraftStatus(flow: DraftFlow): Promise<DraftStatus> {
    return withTestSet(flow, statusFrom(flow, await getState(flow.id)))
}

function refuse(flow: DraftFlow, state: FlowVersionState | null) {
    const { reason } = modeFor(flow, state)
    if (reason === 'off') throw new AppError(StatusCodes.CONFLICT, 'Drafts are off on this server.')
    if (reason === 'type') throw new AppError(StatusCodes.CONFLICT, 'This kind of flow saves straight to Live.')
    if (reason === 'publish-instantly') throw new AppError(StatusCodes.CONFLICT, 'This flow publishes instantly. Save it to Live instead.')
}

// A canvas the server can store: JSON with a nodes list and an edges list.
function checkCanvas(flowData: unknown): string {
    if (typeof flowData !== 'string' || !flowData) throw new AppError(StatusCodes.BAD_REQUEST, 'flowData is required.')
    let parsed: any
    try {
        parsed = JSON.parse(flowData)
    } catch {
        throw new AppError(StatusCodes.BAD_REQUEST, 'flowData is not valid JSON.')
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'flowData needs a nodes list and an edges list.')
    }
    return flowData
}

// A file uploaded into a draft gets its own name, such as draft-1a2b3c4d-report.pdf. Uploads are stored by
// name in the flow's folder, so keeping the original name would overwrite the file Live still reads.
const DATA_URI = /^data:[^,]*;base64,/i
export function uniqueUploadNames(flowData: string, tag: string): string {
    const rename = (value: string) =>
        DATA_URI.test(value) ? value.replace(/(,filename:)([^,]*)$/, (_m, head, name) => `${head}draft-${tag}-${name || 'file'}`) : value
    const parsed = JSON.parse(flowData)
    for (const node of parsed.nodes || []) {
        if (node?.data?.category !== 'Document Loaders' || !node.data.inputs) continue
        for (const [key, input] of Object.entries(node.data.inputs as Record<string, unknown>)) {
            if (typeof input !== 'string' || !input) continue
            if (input.startsWith('[')) {
                try {
                    const files = JSON.parse(input)
                    if (Array.isArray(files)) {
                        node.data.inputs[key] = JSON.stringify(files.map((file) => (typeof file === 'string' ? rename(file) : file)))
                    }
                } catch {
                    // Not a file list.
                }
            } else {
                node.data.inputs[key] = rename(input)
            }
        }
    }
    return JSON.stringify(parsed)
}

export interface SaveDraftContext {
    userId?: string | null
    orgId: string
    subscriptionId: string
    // Who saves the draft. A draft that names a harness needs a person, or an API key that lists every one of them.
    caller?: IHarnessCaller
    // The draft hash the canvas loaded. Null means it loaded with no draft. Leave it out when the caller
    // does not track the draft (an older client, an import, or an API save).
    expectedDraftHash?: unknown
    // Only literal true replaces a draft someone else saved after this canvas opened.
    overwriteDraftChanges?: unknown
}

const API_KEY_DRAFT_SAVER = 'Someone using an API key'

// Who last saved the stored draft, for the conflict answer. An API key has no user id.
// A lookup problem falls back to a short id label. The email is never used.
async function draftSaverName(userId: string | null): Promise<string> {
    if (!userId) return API_KEY_DRAFT_SAVER
    try {
        const user = await getRunningExpressApp().AppDataSource.getRepository(User).findOneBy({ id: userId })
        return versionAuthor({ id: userId, name: typeof user?.name === 'string' ? user.name : '' }).name
    } catch {
        return `User ${userId.slice(0, 8)}`
    }
}

function savedAtIso(value: Date | string | null): string | null {
    if (value == null || value === '') return null
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) return null
    return date.toISOString()
}

// Whether this save would replace a draft the caller has not seen.
// No conflict when the caller sends overwriteDraftChanges true, sends no expected hash, there is no
// stored draft, the stored draft is the one they loaded, or they saved it themselves. Null and undefined
// user ids count as the same saver. Any other overwriteDraftChanges value is ignored. A hash that is
// not a string or null is a 400.
export function draftChangedBy(
    state: { draftFlowData?: string | null; draftUpdatedBy?: string | null; draftUpdatedDate?: Date | string | null } | null | undefined,
    expectedDraftHash: unknown,
    userId: string | null | undefined,
    overwriteDraftChanges?: unknown
): { savedById: string | null; savedAt: Date | string | null } | null {
    if (expectedDraftHash !== undefined && expectedDraftHash !== null && typeof expectedDraftHash !== 'string') {
        throw new AppError(StatusCodes.BAD_REQUEST, 'expectedDraftHash must be a string or null.')
    }
    if (overwriteDraftChanges === true) return null
    if (expectedDraftHash === undefined) return null
    if (!state?.draftFlowData) return null
    if (canvasHash(state.draftFlowData) === expectedDraftHash) return null
    const storedBy = state.draftUpdatedBy ?? null
    const caller = userId ?? null
    if (storedBy === caller) return null
    return { savedById: storedBy, savedAt: state.draftUpdatedDate ?? null }
}

async function throwIfDraftChanged(state: FlowVersionState | null, context: SaveDraftContext): Promise<void> {
    const changed = draftChangedBy(state, context.expectedDraftHash, context.userId, context.overwriteDraftChanges)
    if (!changed) return
    const name = await draftSaverName(changed.savedById)
    throw new DraftChangedError({ id: changed.savedById, name }, savedAtIso(changed.savedAt))
}

// Saves the canvas as this flow's draft. Live is not touched. A canvas that matches Live clears the
// draft instead, so opening a flow and saving it without changes leaves nothing to publish.
export async function saveDraft(flow: DraftFlow, flowData: unknown, context: SaveDraftContext): Promise<DraftStatus> {
    const seen = await getState(flow.id)
    refuse(flow, seen)
    let canvas = checkCanvas(flowData)
    assertHarnessReferencesWellFormed(canvas)
    assertCallerMayUseHarnesses(context.caller, referencedHarnessNames(canvas))
    if (flow.type === 'HARNESS') await assertHarnessDraftLimits(flow.name || '', canvas)
    // Before any uploaded file is stored. The check inside the lock is the one that decides.
    await throwIfDraftChanged(seen, context)
    if (containsBase64File({ flowData: canvas } as any)) {
        const app = getRunningExpressApp()
        canvas = await updateFlowDataWithFilePaths(
            flow.id,
            uniqueUploadNames(canvas, crypto.randomBytes(4).toString('hex')),
            context.orgId,
            flow.workspaceId,
            context.subscriptionId,
            app.usageCacheManager
        )
    }
    // The type on the draft is the flow's type at this write. A type change that landed since the
    // canvas was loaded refuses the save, under the same row lock the type change takes.
    const saved = await withChatflowLock(flow.id, async (manager) => {
        if (draftWriteHooks.beforeDraftWrite) await draftWriteHooks.beforeDraftWrite()
        const chat = await manager.getRepository(ChatFlow).findOneBy({ id: flow.id })
        if (!chat || (chat.type || 'CHATFLOW') !== (flow.type || 'CHATFLOW')) {
            throw new AppError(StatusCodes.CONFLICT, TYPE_CHANGED)
        }
        const stateRepo = manager.getRepository(FlowVersionState)
        const state = await stateRepo.findOneBy({ chatflowId: flow.id })
        // The chatflow row lock, or the SQLite per-flow queue, makes this read the one to compare.
        // Checked before a canvas equal to Live can clear the draft.
        await throwIfDraftChanged(state, context)
        if (draftWriteHooks.afterStateRead) await draftWriteHooks.afterStateRead()
        const clearing = sameCanvas(canvas, flow.flowData)
        const draftPatch = clearing
            ? { ...NO_DRAFT }
            : {
                  draftFlowData: stampNodePack(canvas),
                  draftBaseHash: state?.draftFlowData ? state.draftBaseHash ?? null : draftBase(flow),
                  draftUpdatedDate: new Date(),
                  draftUpdatedBy: context.userId || null
              }
        if (!state && !draftPatch.draftFlowData) return statusFrom(flow, null)
        if (!state) {
            // SQLite takes no row lock, so a settings insert can win the first row. Keep that row
            // and write only the draft columns. On Postgres the unique violation aborts the
            // transaction, so the re-read runs only after rolling back to the savepoint.
            let saved: FlowVersionState | null = null
            await insertStateOrRecover(
                manager,
                async () => {
                    saved = await stateRepo.save(
                        stateRepo.create({
                            chatflowId: flow.id,
                            workspaceId: flow.workspaceId,
                            publishInstantly: false,
                            ...draftPatch
                        })
                    )
                },
                async () => {
                    const existing = await stateRepo.findOneBy({ chatflowId: flow.id })
                    if (!existing) throw new AppError(StatusCodes.CONFLICT, OVERLAPPED_SAVE)
                    await stateRepo.update({ chatflowId: flow.id }, draftPatch)
                    saved = await stateRepo.findOneBy({ chatflowId: flow.id })
                }
            )
            return statusFrom(flow, saved)
        }
        // Only the draft columns. A settings or gate-result write that landed after this read stays.
        await stateRepo.update({ chatflowId: flow.id }, draftPatch)
        return statusFrom(flow, await stateRepo.findOneBy({ chatflowId: flow.id }))
    })
    return withTestSet(flow, saved)
}

function clearDraft(row: FlowVersionState) {
    row.draftFlowData = null
    row.draftBaseHash = null
    row.draftUpdatedDate = null
    row.draftUpdatedBy = null
}

// Throws the draft away. Live is not touched.
export async function discardDraft(flow: DraftFlow): Promise<DraftStatus> {
    const state = await getState(flow.id)
    if (!state?.draftFlowData) return withTestSet(flow, statusFrom(flow, state))
    if (draftWriteHooks.afterStateRead) await draftWriteHooks.afterStateRead()
    await repo().update({ chatflowId: flow.id }, NO_DRAFT)
    return getDraftStatus(flow)
}

// The draft canvas to publish. Refused when drafts are off or there is nothing to publish, and when Live
// changed after the draft started (for example through the API) unless the caller chose to replace those
// changes, so nobody's Live edit is dropped without being asked. A draft left over from before Publish
// instantly was turned on can still be published, so it is never stranded.
export async function draftToPublish(flow: DraftFlow, overwriteLiveChanges?: unknown): Promise<string> {
    if (!isDraftsEnabled()) throw new AppError(StatusCodes.CONFLICT, 'Drafts are off on this server.')
    const state = await getState(flow.id)
    const draft = draftInfo(flow, state)
    if (!draft) throw new AppError(StatusCodes.CONFLICT, 'There are no unpublished changes to publish.')
    // Checked here, whatever the timing of a type change: a draft is only ever published as its own kind of flow.
    if (isOtherType(state?.draftBaseHash, flow)) {
        throw new AppError(
            StatusCodes.CONFLICT,
            "This flow changed to another kind of flow after these edits started, so they can't be published. Discard them to continue."
        )
    }
    if (draft.stale && overwriteLiveChanges !== true) {
        throw new AppError(
            StatusCodes.CONFLICT,
            'Live changed after these edits started, for example through the API. Publishing replaces those changes. Send overwriteLiveChanges: true to publish anyway.'
        )
    }
    const block = (await withTestSet(flow, statusFrom(flow, state))).publishGate.block
    if (block) throw new AppError(StatusCodes.CONFLICT, block)
    return draft.flowData
}

const NO_DRAFT = { draftFlowData: null, draftBaseHash: null, draftUpdatedDate: null, draftUpdatedBy: null }

// Clears the draft only while it is still exactly `expected`, in one conditional update, so a newer draft
// saved in the meantime is kept.
export async function clearDraftIfStill(flow: DraftFlow, expected: string): Promise<DraftStatus> {
    await repo().update({ chatflowId: flow.id, draftFlowData: expected }, NO_DRAFT)
    return getDraftStatus(flow)
}

// Bookkeeping after Publish or Roll back saved a new Live canvas (`flow.flowData`). Each step is a conditional
// update of its own columns, so a draft saved at the same moment is never overwritten.
// - Publish (`published` given): the draft is cleared while it is still the canvas that was published.
// - A draft that is kept now starts from the new Live, so it is not flagged stale: this Live was chosen.
// - Records the history version that is Live (null when it could not be recorded) and when.
// Promote passes keepDraftBase: Live came from another server, so a draft on this one stays marked as started
// from the old Live, and Publish asks before replacing what was promoted.
export async function afterLiveSet(
    flow: DraftFlow,
    sha: string | null,
    published?: string,
    options: { keepDraftBase?: boolean } = {}
): Promise<DraftStatus> {
    const write = () => writeAfterLiveSet(flow, sha, published, options)
    const driver = (getRunningExpressApp().AppDataSource as { options?: { type?: string } } | undefined)?.options?.type
    if (driver === 'sqlite' || driver === 'better-sqlite3') return enqueueSqliteStateWrite(flow.id, write)
    return write()
}

async function writeAfterLiveSet(
    flow: DraftFlow,
    sha: string | null,
    published: string | undefined,
    options: { keepDraftBase?: boolean }
): Promise<DraftStatus> {
    if (published !== undefined) await repo().update({ chatflowId: flow.id, draftFlowData: published }, NO_DRAFT)
    const publishedDate = new Date()
    const state = await getState(flow.id)
    if (!state) {
        const row = repo().create({
            chatflowId: flow.id,
            workspaceId: flow.workspaceId,
            publishInstantly: false,
            liveSha: sha,
            publishedDate
        })
        try {
            return statusFrom(flow, await repo().save(row))
        } catch (error) {
            // A draft or settings insert can win the row. Keep that row and write only the publication columns.
            if (!isUniqueViolation(error)) throw error
            const existing = await getState(flow.id)
            if (!existing) throw new AppError(StatusCodes.CONFLICT, OVERLAPPED_SAVE)
            await repo().update({ chatflowId: flow.id }, { liveSha: sha, publishedDate })
            if (existing.draftFlowData && !options.keepDraftBase && !isOtherType(existing.draftBaseHash, flow)) {
                await repo().update({ chatflowId: flow.id, draftFlowData: existing.draftFlowData }, { draftBaseHash: draftBase(flow) })
            }
            return getDraftStatus(flow)
        }
    }
    await repo().update({ chatflowId: flow.id }, { liveSha: sha, publishedDate })
    // Rebased only when it is a canvas of this flow's type; one of another type stays unpublishable.
    if (state.draftFlowData && !options.keepDraftBase && !isOtherType(state.draftBaseHash, flow)) {
        await repo().update({ chatflowId: flow.id, draftFlowData: state.draftFlowData }, { draftBaseHash: draftBase(flow) })
    }
    return getDraftStatus(flow)
}

// Publish instantly: every canvas save goes straight to Live, as before drafts. Turning it on while a
// draft exists is refused, so unpublished work is never dropped or published by surprise.
export async function setPublishInstantly(flow: DraftFlow, value: unknown): Promise<DraftStatus> {
    return updateDraftSettings(flow, { publishInstantly: value })
}

// Publish instantly and the passing-test gate share one save, so a request that sets both is checked
// against the end state. The two cannot be on together.
export async function updateDraftSettings(
    flow: DraftFlow,
    body: { publishInstantly?: unknown; publishGate?: unknown }
): Promise<DraftStatus> {
    const hasInstant = body.publishInstantly !== undefined
    const hasGate = body.publishGate !== undefined
    if (!hasInstant && !hasGate) throw new AppError(StatusCodes.BAD_REQUEST, 'Send publishInstantly or publishGate.')
    if (hasInstant && typeof body.publishInstantly !== 'boolean') {
        throw new AppError(StatusCodes.BAD_REQUEST, 'publishInstantly is true or false.')
    }
    const gate = hasGate ? parseGateInput(body.publishGate) : null
    const state = await getState(flow.id)
    const nextInstant = hasInstant ? (body.publishInstantly as boolean) : Boolean(state?.publishInstantly)
    const nextGate = gate ? gate.enabled : Boolean(state?.publishGate)
    if (nextInstant && nextGate) {
        throw new AppError(StatusCodes.BAD_REQUEST, conflictingSettingsMessage(Boolean(gate?.enabled)))
    }
    if (gate?.enabled) {
        if (!isDraftsEnabled()) throw new AppError(StatusCodes.BAD_REQUEST, 'Drafts are off on this server.')
        if (!publishGateApplies(flow.type)) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'A passing test set before Publish is for chatflows and agentflows.')
        }
        const refusal = datasetStartRefusal(flow.type, [flow.flowData, state?.draftFlowData])
        if (refusal) throw new AppError(StatusCodes.BAD_REQUEST, refusal)
    }
    if (nextInstant && state?.draftFlowData) {
        throw new AppError(
            StatusCodes.CONFLICT,
            'This flow has unpublished changes. Publish or discard them before turning on Publish instantly.'
        )
    }
    // The ids are resolved in this flow's workspace before anything is written. A missing id and an id
    // from another workspace are the same 404, and the stored settings stay as they were.
    if (gate?.enabled && gate.datasetId) await assertGateTargets(flow.workspaceId, gate.datasetId, gate.evaluatorIds)
    // A draft save or a publish can land during that lookup. Write only the settings columns, then
    // re-read, so the stale row from before the lookup cannot put the old draft or publication back.
    // Turning one setting on is conditional on the other still being off. A publish-instantly save
    // that commits during the lookup must not leave both flags true: publishInstantly would win and
    // the gate would never be consulted.
    await withChatflowLock(flow.id, async (manager) => {
        if (draftWriteHooks.beforeSettingsWrite) await draftWriteHooks.beforeSettingsWrite()
        const stateRepo = manager.getRepository(FlowVersionState)
        // A direct Live update can change the type or the start after the unlocked read.
        const lockedFlow = await flowUnderLock(manager, flow)
        let row = await stateRepo.findOneBy({ chatflowId: flow.id })
        if (!row) {
            if (!nextInstant && !nextGate) return
            refuseLockedSettings(lockedFlow, emptyLockedRow(), hasInstant, nextInstant, gate)
            let inserted = false
            await insertStateOrRecover(
                manager,
                async () => {
                    await stateRepo.save(stateRepo.create(newSettingsRow(flow, nextInstant, gate)))
                    inserted = true
                },
                async () => {
                    row = await stateRepo.findOneBy({ chatflowId: flow.id })
                    if (!row) throw new AppError(StatusCodes.CONFLICT, OVERLAPPED_SAVE)
                }
            )
            if (inserted) return
        }
        if (!row) throw new AppError(StatusCodes.CONFLICT, OVERLAPPED_SAVE)
        // The read above the lock can be stale. A draft, the other flag, or a start that cannot
        // take a dataset may have landed. Refuse before any settings column is written.
        refuseLockedSettings(lockedFlow, row, hasInstant, nextInstant, gate)
        await applySettingsUpdate(stateRepo, flow.id, hasInstant, nextInstant, gate)
    })
    return withTestSet(flow, statusFrom(flow, await getState(flow.id)))
}

function emptyLockedRow(): FlowVersionState {
    return { publishInstantly: false, publishGate: false, draftFlowData: null } as FlowVersionState
}

// The chatflow row this lock is holding. Type and Live canvas are whatever is stored now.
async function flowUnderLock(manager: EntityManager, flow: DraftFlow): Promise<DraftFlow> {
    const chat = await manager.getRepository(ChatFlow).findOneBy({ id: flow.id })
    if (!chat) throw new AppError(StatusCodes.NOT_FOUND, `Chatflow ${flow.id} not found`)
    return {
        ...flow,
        type: chat.type || flow.type,
        flowData: typeof chat.flowData === 'string' ? chat.flowData : flow.flowData
    }
}

function newSettingsRow(
    flow: DraftFlow,
    nextInstant: boolean,
    gate: { enabled: boolean; datasetId: string | null; evaluatorIds: string[]; threshold: number | null } | null
) {
    return {
        chatflowId: flow.id,
        workspaceId: flow.workspaceId,
        publishInstantly: Boolean(nextInstant),
        publishGate: Boolean(gate?.enabled),
        ...(gate?.enabled
            ? {
                  publishGateDatasetId: gate.datasetId,
                  publishGateEvaluatorIds: JSON.stringify(gate.evaluatorIds),
                  publishGateThreshold: gate.threshold
              }
            : {})
    }
}

// The same refusals as the unlocked read, using the row the lock just read. Nothing is written when one fails.
function refuseLockedSettings(
    flow: DraftFlow,
    row: FlowVersionState,
    hasInstant: boolean,
    nextInstant: boolean,
    gate: { enabled: boolean; datasetId: string | null; evaluatorIds: string[]; threshold: number | null } | null
): void {
    const endInstant = hasInstant ? nextInstant : Boolean(row.publishInstantly)
    const endGate = gate ? gate.enabled : Boolean(row.publishGate)
    if (endInstant && endGate) {
        throw new AppError(StatusCodes.BAD_REQUEST, conflictingSettingsMessage(Boolean(gate?.enabled)))
    }
    if (gate?.enabled) {
        if (!isDraftsEnabled()) throw new AppError(StatusCodes.BAD_REQUEST, 'Drafts are off on this server.')
        if (!publishGateApplies(flow.type)) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'A passing test set before Publish is for chatflows and agentflows.')
        }
        const refusal = datasetStartRefusal(flow.type, [flow.flowData, row.draftFlowData])
        if (refusal) throw new AppError(StatusCodes.BAD_REQUEST, refusal)
    }
    if (endInstant && row.draftFlowData) {
        throw new AppError(
            StatusCodes.CONFLICT,
            'This flow has unpublished changes. Publish or discard them before turning on Publish instantly.'
        )
    }
}

// Off flags go first, so one request can turn Publish instantly off and the passing test set on,
// or the reverse. The on is then conditional on the other flag still being off.
async function applySettingsUpdate(
    stateRepo: StateWriter,
    flowId: string,
    hasInstant: boolean,
    nextInstant: boolean,
    gate: { enabled: boolean; datasetId: string | null; evaluatorIds: string[]; threshold: number | null } | null
): Promise<void> {
    if (hasInstant && !nextInstant) await stateRepo.update({ chatflowId: flowId }, { publishInstantly: false })
    if (gate && !gate.enabled) await stateRepo.update({ chatflowId: flowId }, { publishGate: false })
    if (gate?.enabled) {
        await updateUnlessOtherFlag(
            stateRepo,
            flowId,
            { chatflowId: flowId, publishInstantly: false },
            {
                publishGate: true,
                publishGateDatasetId: gate.datasetId,
                publishGateEvaluatorIds: JSON.stringify(gate.evaluatorIds),
                publishGateThreshold: gate.threshold
            },
            (row) => Boolean(row.publishInstantly),
            true
        )
    }
    if (hasInstant && nextInstant) {
        await updateUnlessOtherFlag(
            stateRepo,
            flowId,
            { chatflowId: flowId, publishGate: false },
            { publishInstantly: true },
            (row) => Boolean(row.publishGate),
            false
        )
    }
}

function isUniqueViolation(error: unknown): boolean {
    const err = error as { code?: string; message?: string; driverError?: { code?: string } }
    const code = String(err?.code || err?.driverError?.code || '')
    if (['23505', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_UNIQUE'].includes(code)) return true
    return /unique constraint|duplicate key|duplicate entry/i.test(String(err?.message || ''))
}

// Postgres aborts the whole transaction on a unique violation. A savepoint lets the re-read and the
// column update run on the same connection. Other engines do not abort, so they only need the catch.
async function insertStateOrRecover(manager: EntityManager, insert: () => Promise<void>, recover: () => Promise<void>): Promise<void> {
    const driver = (getRunningExpressApp().AppDataSource as { options?: { type?: string } } | undefined)?.options?.type
    const query = driver === 'postgres' && typeof manager.query === 'function' ? (sql: string) => manager.query(sql) : null
    if (query) await query('SAVEPOINT cuttlely_state_insert')
    try {
        await insert()
        if (query) await query('RELEASE SAVEPOINT cuttlely_state_insert')
    } catch (error) {
        if (query) {
            try {
                await query('ROLLBACK TO SAVEPOINT cuttlely_state_insert')
            } catch {
                throw error
            }
        }
        if (!isUniqueViolation(error)) throw error
        await recover()
    }
}

type StateWriter = {
    update: (where: any, patch: any) => Promise<{ affected?: number | null }>
    findOneBy: (where: any) => Promise<FlowVersionState | null>
}

function patchAlreadyStored(row: FlowVersionState | null, patch: Partial<FlowVersionState>): boolean {
    if (!row) return false
    return (Object.keys(patch) as Array<keyof FlowVersionState>).every((key) => row[key] === patch[key])
}

// MySQL and MariaDB report 0 changed rows when the values are already stored. That is a save,
// not proof that the other flag is on. Re-read on this locked repository. When the values are
// not already stored, repeat the same conditional update. A 400 means the other flag is on, or
// the conditional update still matched no row.
async function updateUnlessOtherFlag(
    stateRepo: StateWriter,
    flowId: string,
    where: { chatflowId: string; publishInstantly?: boolean; publishGate?: boolean },
    patch: Partial<FlowVersionState>,
    otherFlagOn: (row: FlowVersionState) => boolean,
    turningGateOn: boolean
): Promise<void> {
    const refuse = () => {
        throw new AppError(StatusCodes.BAD_REQUEST, conflictingSettingsMessage(turningGateOn))
    }
    const read = () => stateRepo.findOneBy({ chatflowId: flowId })
    const updated = await stateRepo.update(where, patch)
    if (updated?.affected) return
    const row = await read()
    if (!row || otherFlagOn(row)) refuse()
    if (patchAlreadyStored(row, patch)) return
    const retried = await stateRepo.update(where, patch)
    if (retried?.affected) return
    const again = await read()
    if (patchAlreadyStored(again, patch)) return
    refuse()
}

export interface GateResultInput {
    draftHash: string
    datasetId: string
    evaluatorIds: string[]
    threshold: number
    passRate: number | null
    passed: number
    failed: number
    errored: number
    verdict: 'passed' | 'failed'
    contentHash?: string
    postProcessHash?: string
    checkId?: string
}

// The check run that must match the stored result. Set before the result is written, including when
// that write fails, so Publish can refuse an older pass that this run did not replace.
const gateCheckNotes = new Map<string, string>()

export function noteGateCheck(flowId: string, checkId: string): void {
    if (flowId && checkId) gateCheckNotes.set(flowId, checkId)
}

export function notedGateCheck(flowId: string): string | null {
    return gateCheckNotes.get(flowId) || null
}

export function clearGateCheckNote(flowId: string): void {
    gateCheckNotes.delete(flowId)
}

export function clearGateCheckNotes(): void {
    gateCheckNotes.clear()
}

export type GateWriteOutcome = 'stored' | 'ignored'

// Records the check when it matches the gate. A skipped write must not leave a note behind.
// A write that throws notes this check, then tries to clear the stored result. If that clear
// also throws, the note stays so Publish refuses the older pass.
export async function settlePublishGateCheck(flow: DraftFlow, input: GateResultInput): Promise<GateWriteOutcome> {
    let before: ReturnType<typeof readGateResult> = null
    let priorRead = false
    try {
        // A throw here is still this check's failure. The note has to be recorded, and the clear
        // can name the previous result only when this read actually returned it.
        before = readGateResult((await getState(flow.id))?.publishGateResult)
        priorRead = true
        const outcome = await recordPublishGateResult(flow, input)
        // A stored result replaces any failure note. An ignored check clears a note only when that
        // note is this check's. Another check's failure note stays, so its older pass stays refused.
        const noted = notedGateCheck(flow.id)
        if (outcome === 'stored' || (input.checkId && noted === input.checkId)) clearGateCheckNote(flow.id)
        return outcome
    } catch (error) {
        if (input.checkId) noteGateCheck(flow.id, input.checkId)
        if (priorRead) {
            try {
                await clearPublishGateResult(flow, { checkId: before?.checkId ?? null, checkedAt: before?.checkedAt ?? null })
            } catch {
                // The note stays. Publish refuses a stored pass that is not from this check.
            }
        }
        throw error
    }
}

// The same workspace lookup the dataset check uses. A missing id and an id from another workspace
// are both 404, and the caller has not written the settings yet.
async function assertGateTargets(workspaceId: string, datasetId: string, evaluatorIds: string[]): Promise<void> {
    await casesFromDataset(datasetId, workspaceId)
    await loadEvaluators(evaluatorIds, workspaceId)
}

// Writes the last gate result onto the flow row. A check that does not match the current gate settings
// is ignored, so an exploratory check does not replace a pass. Nothing in the row is an answer.
export async function recordPublishGateResult(flow: DraftFlow, input: GateResultInput): Promise<GateWriteOutcome> {
    if (!publishGateApplies(flow.type)) return 'ignored'
    const state = await getState(flow.id)
    if (!state?.publishGate) return 'ignored'
    const settings = gateSettingsOf(state)
    if (
        !sameGateSettings(settings, {
            datasetId: input.datasetId,
            evaluatorIds: input.evaluatorIds,
            threshold: input.threshold
        })
    ) {
        return 'ignored'
    }
    const record: Omit<GateResult, 'checkedAt'> = {
        draftHash: input.draftHash,
        datasetId: input.datasetId,
        evaluatorIds: input.evaluatorIds,
        threshold: input.threshold,
        passRate: input.passRate,
        passed: input.passed,
        failed: input.failed,
        errored: input.errored,
        verdict: input.verdict,
        contentHash: input.contentHash || '',
        postProcessHash: input.postProcessHash || '',
        ...(input.checkId ? { checkId: input.checkId } : {})
    }
    // The where is the gate this check read. A newer pass, or a gate that changed, does not match,
    // and this check leaves that row alone.
    const gateWhere: FindOptionsWhere<FlowVersionState> = {
        chatflowId: flow.id,
        publishGate: true,
        publishGateDatasetId: state.publishGateDatasetId == null ? IsNull() : state.publishGateDatasetId,
        publishGateEvaluatorIds: state.publishGateEvaluatorIds == null ? IsNull() : state.publishGateEvaluatorIds,
        publishGateThreshold: state.publishGateThreshold == null ? IsNull() : state.publishGateThreshold
    }
    const updated = await repo().update(gateWhere, { publishGateResult: gateResultRecord(record) })
    if (updated?.affected === 0) return 'ignored'
    return 'stored'
}

// Drops the stored gate result and leaves the draft and the other settings alone. A check whose
// write failed calls this so an older pass cannot publish. When `previous` is set, the clear runs
// only while the row still holds that result. A pass another process stored (a different check id
// or a different time) is left in place.
export async function clearPublishGateResult(
    flow: Pick<DraftFlow, 'id'>,
    previous?: { checkId?: string | null; checkedAt?: string | null } | null
): Promise<void> {
    const state = await getState(flow.id)
    const stored = state?.publishGateResult
    if (!stored) return
    if (previous) {
        const current = readGateResult(stored)
        if ((previous.checkId || null) !== (current?.checkId || null)) return
        if ((previous.checkedAt || null) !== (current?.checkedAt || null)) return
    }
    await repo().update({ chatflowId: flow.id, publishGateResult: stored }, { publishGateResult: null })
}

// The canvas the flow's own test runs: the draft when the flow saves to drafts and has one,
// otherwise Live. The canvas test chat calls this, and so does a pipeline preview that omits the canvas.
// Every other caller reads Live.
export async function flowDataForTestChat(flow: DraftFlow): Promise<string> {
    if (!isDraftsEnabled() || !typeHasDrafts(flow.type)) return flow.flowData
    const state = await getState(flow.id)
    if (!state || state.publishInstantly || !state.draftFlowData) return flow.flowData
    return state.draftFlowData
}

// Removes the flow's draft and settings, when the flow is deleted.
export async function deleteStateFor(chatflowId: string): Promise<void> {
    await repo().delete({ chatflowId })
}

export default {
    isDraftsEnabled,
    typeHasDrafts,
    getState,
    getDraftStatus,
    saveDraft,
    discardDraft,
    draftToPublish,
    clearDraftIfStill,
    afterLiveSet,
    sameCanvas,
    setPublishInstantly,
    updateDraftSettings,
    recordPublishGateResult,
    settlePublishGateCheck,
    clearPublishGateResult,
    noteGateCheck,
    clearGateCheckNote,
    flowDataForTestChat,
    deleteStateFor
}
