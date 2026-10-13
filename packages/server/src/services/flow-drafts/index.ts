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
import { type EntityManager } from 'typeorm'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { FlowVersionState } from '../../database/entities/FlowVersionState'
import { AppError } from '../../errors/appError'
import { containsBase64File, updateFlowDataWithFilePaths } from '../../utils/fileRepository'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { stampNodePack } from '../../utils/nodePacks'
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

// Test seam. A race test changes the flow's type after a draft save has started and before it writes.
export const draftWriteHooks: { beforeDraftWrite: null | (() => Promise<void>) } = { beforeDraftWrite: null }

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

// Postgres, MySQL and MariaDB: lock the chatflow row so a draft save and a type change cannot pass
// each other's check. SQLite has no SELECT FOR UPDATE, and this driver uses one connection, so a
// transaction here would pull other requests' statements into it. SQLite relies on the conditional
// UPDATE (no draft, or the type still matches) instead.
export async function withChatflowLock<T>(chatflowId: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    const ds = getRunningExpressApp().AppDataSource as any
    const driver = ds.options?.type
    const sqlite = driver === 'sqlite' || driver === 'better-sqlite3'
    if (!driver || sqlite || !ds.createQueryRunner) {
        if (!sqlite && typeof ds.transaction === 'function') return ds.transaction(fn)
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
}

export interface DraftInfo {
    flowData: string
    updatedDate: string | null
    // User id of the last person who saved the draft. Null for an API key.
    updatedBy: string | null
    // Live changed after the draft started, for example through the API.
    stale: boolean
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
        stale: Boolean(state.draftBaseHash) && !baseMatches(state.draftBaseHash as string, flow)
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
        publishGate: gateStatusFor(flow, state, state?.draftFlowData),
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
}

// Saves the canvas as this flow's draft. Live is not touched. A canvas that matches Live clears the
// draft instead, so opening a flow and saving it without changes leaves nothing to publish.
export async function saveDraft(flow: DraftFlow, flowData: unknown, context: SaveDraftContext): Promise<DraftStatus> {
    refuse(flow, await getState(flow.id))
    let canvas = checkCanvas(flowData)
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
        const row = state || stateRepo.create({ chatflowId: flow.id, workspaceId: flow.workspaceId, publishInstantly: false })
        if (sameCanvas(canvas, flow.flowData)) {
            clearDraft(row)
        } else {
            if (!row.draftFlowData) row.draftBaseHash = draftBase(flow)
            row.draftFlowData = stampNodePack(canvas)
            row.draftUpdatedDate = new Date()
            row.draftUpdatedBy = context.userId || null
        }
        if (!state && !row.draftFlowData) return statusFrom(flow, null)
        return statusFrom(flow, await stateRepo.save(row))
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
    clearDraft(state)
    return withTestSet(flow, statusFrom(flow, await repo().save(state)))
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
        return statusFrom(flow, await repo().save(row))
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
    const patch = settingsPatch(hasInstant, nextInstant, gate)
    const current = await getState(flow.id)
    if (!current) {
        if (!nextInstant && !nextGate) return withTestSet(flow, statusFrom(flow, null))
        await repo().save(
            repo().create({
                chatflowId: flow.id,
                workspaceId: flow.workspaceId,
                publishInstantly: false,
                publishGate: false,
                ...patch
            })
        )
    } else if (Object.keys(patch).length) {
        await repo().update({ chatflowId: flow.id }, patch)
    }
    return withTestSet(flow, statusFrom(flow, await getState(flow.id)))
}

function settingsPatch(
    hasInstant: boolean,
    nextInstant: boolean,
    gate: { enabled: boolean; datasetId: string | null; evaluatorIds: string[]; threshold: number | null } | null
): Partial<FlowVersionState> {
    const patch: Partial<FlowVersionState> = {}
    if (hasInstant) patch.publishInstantly = nextInstant
    if (gate?.enabled) {
        patch.publishGate = true
        patch.publishGateDatasetId = gate.datasetId
        patch.publishGateEvaluatorIds = JSON.stringify(gate.evaluatorIds)
        patch.publishGateThreshold = gate.threshold
    } else if (gate && !gate.enabled) {
        patch.publishGate = false
    }
    return patch
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
}

// The same workspace lookup the dataset check uses. A missing id and an id from another workspace
// are both 404, and the caller has not written the settings yet.
async function assertGateTargets(workspaceId: string, datasetId: string, evaluatorIds: string[]): Promise<void> {
    await casesFromDataset(datasetId, workspaceId)
    await loadEvaluators(evaluatorIds, workspaceId)
}

// Writes the last gate result onto the flow row. A check that does not match the current gate settings
// is ignored, so an exploratory check does not replace a pass. Nothing in the row is an answer.
export async function recordPublishGateResult(flow: DraftFlow, input: GateResultInput): Promise<void> {
    if (!publishGateApplies(flow.type)) return
    const state = await getState(flow.id)
    if (!state?.publishGate) return
    const settings = gateSettingsOf(state)
    if (
        !sameGateSettings(settings, {
            datasetId: input.datasetId,
            evaluatorIds: input.evaluatorIds,
            threshold: input.threshold
        })
    ) {
        return
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
        postProcessHash: input.postProcessHash || ''
    }
    await repo().update({ chatflowId: flow.id }, { publishGateResult: gateResultRecord(record) })
}

// Drops the stored gate result and leaves the draft and the other settings alone. A check whose
// write failed calls this so an older pass cannot publish.
export async function clearPublishGateResult(flow: Pick<DraftFlow, 'id'>): Promise<void> {
    await repo().update({ chatflowId: flow.id }, { publishGateResult: null })
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
    clearPublishGateResult,
    flowDataForTestChat,
    deleteStateFor
}
