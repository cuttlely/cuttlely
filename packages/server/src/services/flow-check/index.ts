// The publish check: before Publish, replay recent real questions from this flow's chat history against
// Live and the draft, and show the answers, tokens and time side by side.
// `count` (1 to 100, 4 in the dialog) selects the newest distinct questions. A few run at a time.
//
// An agentflow that starts from a form, a webhook or a schedule has no chat questions. The same check
// reads recent execution records and replays those recorded inputs (the form payload, the webhook
// payload, or the schedule trigger input), capped by the same count. With no past runs it says so.
// It does not refuse the flow. Legacy multi-agent flows stay out of this check.
//
// A replay runs the canvas in memory through executeFlow with replay on: a new chat id, so memory starts
// empty; no chat messages, follow-ups, telemetry, usage counts or tracing are written; Live is never saved.
// Chatflows and agentflows can be checked. An agentflow replay also writes no execution record.
// Results stay in this server's memory for a short while and are never written to the database or logged.
// The check itself does not block Publish. A flow can require a passing dataset result before Publish;
// that verdict is stored on the flow, without the answers, and Publish reads it from there.
import crypto from 'crypto'
import { StatusCodes } from 'http-status-codes'
import { v4 as uuidv4 } from 'uuid'
import { EvaluationRunner } from '@cuttlely/components'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { Organization, Workspace } from '../../database/entities/identity'
import { AppError } from '../../errors/appError'
import { ChatType, IChatFlow } from '../../Interface'
import { OSS_PRODUCT_ID } from '../../identity/ossPlatform'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import executionsService from '../executions'
import flowDraftsService, { canvasHash, DraftFlow } from '../flow-drafts'
import {
    COMPARE_COUNT_DEFAULT,
    COMPARE_COUNT_MAX,
    CheckCase,
    CheckScore,
    CheckSummary,
    SideResult,
    draftVerdict,
    parseCheckThreshold,
    parseCompareCount,
    pickQuestions,
    DraftVerdict,
    sameAnswer,
    stepTokens,
    summarize,
    totalTokens
} from './compare'
import { RiskyStep, riskySteps } from './risk'
import { RecordedRow, applyPreviews, noPastRunsMessage, recordedDraft, replayFromQuestion } from './inputs'
import {
    ReplaySource,
    TriggerStart,
    Unavailable,
    datasetStartRefusal,
    sourceOf,
    startUnavailable,
    triggerStart,
    typeUnavailable
} from './kinds'
import { casesFromDataset, CheckEvaluator, currentTestSetHash, loadEvaluators, readDatasetId, readEvaluatorIds, scoreAnswer } from './score'

// A question list sent without `count` stays capped at 10, which is what this route accepted before.
export const MAX_QUESTIONS = 10
export const MAX_QUESTION_CHARS = 2000
const MAX_ANSWER_CHARS = 4000
const MAX_RUNNING = 3
const KEEP_MS = 30 * 60 * 1000
const RUN_TIMEOUT_MS = 60 * 1000
// Two questions at a time is four model calls (Live and the draft). Enough to finish a long compare
// without opening a hundred calls at once. Raised only through the same env pattern as the other caps.
export const DEFAULT_CHECK_CONCURRENCY = 2
const MAX_CHECK_CONCURRENCY = 8
// Newest messages, read in pages, until 100 different questions or the history ends.
// The cap stops a huge chat history from being loaded to answer "how many".
const SCAN_PAGE = 200
const SCAN_CAP = 2000

function envNumber(name: string, fallback: number, min: number, max: number): number {
    const value = Number(process.env[name])
    if (!Number.isFinite(value) || value <= 0) return fallback
    return Math.min(Math.max(Math.round(value), min), max)
}

export function checkLimits() {
    return {
        maxQuestions: COMPARE_COUNT_MAX,
        defaultQuestions: COMPARE_COUNT_DEFAULT,
        maxQuestionChars: MAX_QUESTION_CHARS,
        maxTokens: envNumber('CUTTLELY_CHECK_MAX_TOKENS', 100000, 1000, 2000000),
        maxSeconds: envNumber('CUTTLELY_CHECK_MAX_SECONDS', 180, 10, 1800),
        concurrency: envNumber('CUTTLELY_CHECK_CONCURRENCY', DEFAULT_CHECK_CONCURRENCY, 1, MAX_CHECK_CONCURRENCY)
    }
}

export type CheckLimits = ReturnType<typeof checkLimits>

export type { Unavailable }

// What the check compares with Live. By default the flow's draft; promoting a version from Dev compares
// that version instead, in a check of its own (key), so a draft check and a promote check never mix.
export interface Candidate {
    key: string
    canvas: string | null
    // Why this candidate cannot be checked, when it cannot. Checked after the flow type.
    unavailable?: Unavailable | null
}

// What a `count` request resolved to. Null when the caller sent a question list and no count.
export interface CheckSelection {
    requested: number
    available: number
    used: number
    // True when the history scan stopped early and may have missed older questions.
    truncated: boolean
}

export interface CheckSetup {
    unavailable: Unavailable | null
    // Recent real questions, newest first, then the starter questions nobody asked yet (marked starter).
    questions: Array<{ text: string; date: string; starter?: boolean; preview?: string; source?: ReplaySource }>
    // Distinct past questions found, not counting starter questions. At most 100.
    pastCount: number
    pastTruncated: boolean
    riskySteps: RiskyStep[]
    limits: CheckLimits
    // Live has no cards yet (the flow was never published), so the check asks only the draft.
    liveEmpty: boolean
    // True when this agentflow starts from a form, a webhook or a schedule, so `questions` are recorded
    // inputs (canonical JSON) rather than chat questions. False for chatflows and chat-started agentflows.
    replayInputs: boolean
    // Which start those recorded inputs came from. Null for a chatflow or a chat-started agentflow.
    replaySource: ReplaySource | null
    check: CheckView | null
}

export interface CheckView {
    id: string
    status: 'running' | 'done' | 'stopped' | 'failed'
    stopReason: 'tokens' | 'time' | 'stopped' | null
    error: string | null
    startedDate: string
    finishedDate: string | null
    total: number
    completed: number
    // The draft changed after this check started, so its answers may be out of date.
    draftChanged: boolean
    includeRiskySteps: boolean
    limits: CheckLimits
    liveEmpty: boolean
    cases: CheckCase[]
    summary: CheckSummary
    selection: CheckSelection | null
    // Set when a dataset check has finished. Null for any other check, and while a dataset check is still running.
    verdict: DraftVerdict | null
}

interface CheckRecord {
    id: string
    flowId: string
    workspaceId: string
    draftHash: string
    status: CheckView['status']
    stopReason: CheckView['stopReason']
    error: string | null
    startedAt: number
    finishedAt: number | null
    includeRiskySteps: boolean
    limits: CheckLimits
    liveEmpty: boolean
    cases: CheckCase[]
    selection: CheckSelection | null
    // True when the questions are dataset rows. A read hides those rows without datasets:view.
    fromDataset: boolean
    datasetId: string | null
    threshold: number | null
    // Hash of the rows and evaluators this check asked. Empty when the check did not use a dataset.
    contentHash: string
    evaluators: CheckEvaluator[]
    // Tokens from a side that was dropped when the cap was hit. The case no longer shows them, but they still count.
    spentTokens: number
    inflight: Set<AbortController>
    stopRequested: boolean
}

// One check per flow, kept in memory. Test seam: tests reset it.
export const checks = new Map<string, CheckRecord>()

// Test seam: tests replace the runner so no model is called.
export const replayHooks: {
    run: null | ((input: ReplayInput) => Promise<{ text: string; metrics?: unknown[] }>)
} = { run: null }

export interface ReplayInput {
    flow: IChatFlow
    flowData: string
    question: string
    signal: AbortController
    baseURL: string
}

function purge(now = Date.now()) {
    for (const [key, record] of checks) {
        if (record.status !== 'running' && record.finishedAt && now - record.finishedAt > KEEP_MS) checks.delete(key)
    }
}

function clip(text: string | null): string | null {
    if (text == null) return null
    return text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)}…` : text
}

export interface CheckReveal {
    datasets: boolean
    evaluators: boolean
}

function shownScores(scores: CheckScore[] | undefined, showEvaluators: boolean): CheckScore[] | undefined {
    if (!scores) return undefined
    if (showEvaluators) return scores
    return scores.map((score) => ({ result: score.result, ...(score.message ? { message: score.message } : {}) }))
}

function shownSide(side: SideResult | null, showEvaluators: boolean): SideResult | null {
    if (!side) return null
    const shown: SideResult = { text: clip(side.text), error: side.error, tokens: side.tokens, ms: side.ms }
    const scores = shownScores(side.scores, showEvaluators)
    if (scores) shown.scores = scores
    return shown
}

async function draftCanvas(flow: DraftFlow): Promise<string | null> {
    const state = await flowDraftsService.getState(flow.id)
    if (!state || state.publishInstantly || !state.draftFlowData) return null
    return state.draftFlowData
}

async function candidateFor(flow: DraftFlow, given?: Candidate): Promise<Candidate> {
    if (given) return given
    return { key: flow.id, canvas: await draftCanvas(flow) }
}

// A Live canvas with no cards: a flow saved only as a draft so far.
export function liveIsEmpty(flowData: string | null | undefined): boolean {
    try {
        const nodes = JSON.parse(String(flowData || '{}'))?.nodes
        return !Array.isArray(nodes) || nodes.length === 0
    } catch {
        return false
    }
}

function unavailableFor(flow: DraftFlow, candidate: Candidate, custom: boolean): Unavailable | null {
    if (!custom && !flowDraftsService.isDraftsEnabled()) return { code: 'off', message: 'Drafts are off on this server.' }
    const wrongType = typeUnavailable(flow.type)
    if (wrongType) return wrongType
    if (candidate.unavailable) return candidate.unavailable
    if (!candidate.canvas) return { code: 'no-draft', message: 'There are no unpublished changes to check.' }
    return startUnavailable(flow.type, [flow.flowData, candidate.canvas])
}

function view(record: CheckRecord, currentDraftHash: string | null, reveal?: CheckReveal): CheckView {
    // A caller that did not pass a reveal (the start response, and tests) sees the stored check.
    // A read passes the caller's permissions. Dataset rows and evaluator names stay out otherwise.
    const showRows = !reveal || !record.fromDataset || reveal.datasets
    const showEvaluators = !reveal || reveal.evaluators
    const ran = record.cases.filter((c) => (record.liveEmpty || c.live) && c.draft).length
    const summary = summarize(record.cases, record.liveEmpty)
    const verdict =
        record.fromDataset && record.threshold != null && record.status === 'done'
            ? draftVerdict(summary.scores?.draft, record.threshold)
            : null
    return {
        id: record.id,
        status: record.status,
        stopReason: record.stopReason,
        error: record.error,
        startedDate: new Date(record.startedAt).toISOString(),
        finishedDate: record.finishedAt ? new Date(record.finishedAt).toISOString() : null,
        total: record.cases.length,
        completed: ran,
        draftChanged: currentDraftHash !== record.draftHash,
        includeRiskySteps: record.includeRiskySteps,
        limits: record.limits,
        liveEmpty: record.liveEmpty,
        cases: record.cases.map((c) => ({
            question: showRows ? c.question : '',
            expected: showRows ? c.expected ?? null : null,
            ...(showRows && c.preview ? { preview: c.preview } : {}),
            ...(showRows && c.source ? { source: c.source } : {}),
            ...(showRows && c.date ? { date: c.date } : {}),
            live: shownSide(c.live, showEvaluators),
            draft: shownSide(c.draft, showEvaluators),
            same: c.same
        })),
        summary,
        selection: record.selection,
        verdict
    }
}

// What the check offers to ask: recent real questions (up to 100), then the flow's starter questions nobody
// asked yet. A new flow has few or no recent questions, so its starter questions fill the list.
async function questionsFor(flow: DraftFlow & { chatbotConfig?: string | null }) {
    const loaded = await loadRecent(flow.id)
    const recent = questionsFromRows(loaded.rows, COMPARE_COUNT_MAX)
    const asked = new Set(recent.map((q) => q.text.toLowerCase()))
    const starters = starterQuestions(flow.chatbotConfig)
        .filter((text) => !asked.has(text.toLowerCase()))
        .map((text) => ({ text, date: '', starter: true as const }))
    return {
        questions: [...recent, ...starters],
        pastCount: recent.length,
        pastTruncated: loaded.truncated && recent.length < COMPARE_COUNT_MAX
    }
}

interface RecentRow {
    id?: string
    content: string
    createdDate?: Date | string
    fileUploads?: string | null
}

// Newest user messages for this flow, paged, until 100 different questions or the history ends.
// Questions sent with files are left out later, because the files are not replayed.
async function loadRecent(flowId: string): Promise<{ rows: RecentRow[]; truncated: boolean }> {
    const repo = getRunningExpressApp().AppDataSource.getRepository(ChatMessage)
    const rows: RecentRow[] = []
    let truncated = false
    for (let skip = 0; skip < SCAN_CAP; skip += SCAN_PAGE) {
        const page = await repo
            .createQueryBuilder('m')
            .select(['m.id', 'm.content', 'm.createdDate', 'm.fileUploads'])
            .where('m.chatflowid = :flowId', { flowId })
            .andWhere('m.role = :role', { role: 'userMessage' })
            .andWhere('m.chatType IN (:...types)', { types: [ChatType.EXTERNAL, ChatType.INTERNAL] })
            .orderBy('m.createdDate', 'DESC')
            .addOrderBy('m.id', 'DESC')
            .skip(skip)
            .take(SCAN_PAGE)
            .getMany()
        rows.push(...page)
        const distinct = pickQuestions(usableTexts(rows), COMPARE_COUNT_MAX, MAX_QUESTION_CHARS)
        if (distinct.length >= COMPARE_COUNT_MAX || page.length < SCAN_PAGE) break
        if (skip + SCAN_PAGE >= SCAN_CAP) {
            truncated = true
            break
        }
    }
    return { rows, truncated }
}

function usableTexts(rows: RecentRow[]): string[] {
    return rows.filter((row) => !row.fileUploads || row.fileUploads === '[]').map((row) => row.content)
}

// Newest execution records for this flow, paged, until 100 different inputs or the history ends.
// The executions service orders by the record's update time, newest first. A payload counts once.
const EXEC_PAGE = 50

async function loadInputs(
    flow: { id: string; workspaceId?: string | null },
    kind: TriggerStart
): Promise<{ questions: Array<{ text: string; date: string; preview: string; source: ReplaySource }>; truncated: boolean }> {
    const found: RecordedRow[] = []
    const seen = new Set<string>()
    let scanned = 0
    let truncated = false
    for (let page = 1; scanned < SCAN_CAP && found.length < COMPARE_COUNT_MAX; page++) {
        const { data, total } = await executionsService.getAllExecutions({
            agentflowId: flow.id,
            workspaceId: flow.workspaceId || undefined,
            page,
            limit: EXEC_PAGE
        })
        if (!data.length) break
        for (const row of data) {
            scanned += 1
            const recorded = recordedDraft(row.executionData, kind)
            if (recorded && !seen.has(recorded.key)) {
                seen.add(recorded.key)
                found.push({ ...recorded, date: row.createdDate ? new Date(row.createdDate).toISOString() : '' })
                if (found.length >= COMPARE_COUNT_MAX) break
            }
            if (scanned >= SCAN_CAP) {
                truncated = true
                break
            }
        }
        if (found.length >= COMPARE_COUNT_MAX || scanned >= SCAN_CAP) break
        if (page * EXEC_PAGE >= total) break
    }
    const source = sourceOf(kind)
    const questions = applyPreviews(found).map(({ text, date, preview }) => ({ text, date: date || '', preview, source }))
    return { questions, truncated: truncated && questions.length < COMPARE_COUNT_MAX }
}

function questionsFromRows(rows: RecentRow[], max: number): Array<{ text: string; date: string }> {
    const usable = rows.filter((row) => !row.fileUploads || row.fileUploads === '[]')
    const picked = pickQuestions(usableTexts(rows), max, MAX_QUESTION_CHARS)
    return picked.map((text) => {
        const row = usable.find((item) => String(item.content).trim() === text)
        return { text, date: row?.createdDate ? new Date(row.createdDate).toISOString() : '' }
    })
}

// The flow's starter questions (chat settings), cleaned the way the check cleans questions.
export function starterQuestions(chatbotConfig?: string | null): string[] {
    try {
        const config = chatbotConfig ? JSON.parse(chatbotConfig) : {}
        const prompts = Object.values(config?.starterPrompts || {}).map((entry: any) => String(entry?.prompt || '').trim())
        return [...new Set(prompts.filter((text) => text && text.length <= MAX_QUESTION_CHARS))].slice(0, MAX_QUESTIONS)
    } catch {
        return []
    }
}

export async function getCheckSetup(
    flow: DraftFlow & { chatbotConfig?: string | null },
    given?: Candidate,
    reveal?: CheckReveal
): Promise<CheckSetup> {
    purge()
    const candidate = await candidateFor(flow, given)
    const draft = candidate.canvas
    const unavailable = unavailableFor(flow, candidate, Boolean(given))
    const record = checks.get(candidate.key)
    const kind = unavailable ? null : triggerStart(flow.type, [flow.flowData, draft])
    const offered =
        unavailable?.code === 'off' || unavailable?.code === 'type'
            ? { questions: [], pastCount: 0, pastTruncated: false }
            : kind
            ? await inputsFor(flow, kind)
            : await questionsFor(flow)
    return {
        unavailable,
        questions: offered.questions,
        pastCount: offered.pastCount,
        pastTruncated: offered.pastTruncated,
        riskySteps: riskySteps(draft ? [flow.flowData, draft] : [flow.flowData], flow.chatbotConfig),
        limits: checkLimits(),
        liveEmpty: liveIsEmpty(flow.flowData),
        replayInputs: Boolean(kind),
        replaySource: kind ? sourceOf(kind) : null,
        check: record ? view(record, draft ? canvasHash(draft) : null, reveal) : null
    }
}

async function inputsFor(flow: DraftFlow, kind: TriggerStart) {
    const loaded = await loadInputs(flow, kind)
    return { questions: loaded.questions, pastCount: loaded.questions.length, pastTruncated: loaded.truncated }
}

export async function getCheck(flow: DraftFlow, checkId: string, given?: Candidate, reveal?: CheckReveal): Promise<CheckView> {
    const candidate = await candidateFor(flow, given)
    const record = checks.get(candidate.key)
    if (!record || record.id !== checkId) throw new AppError(StatusCodes.NOT_FOUND, 'That check was not found. Run it again.')
    const draft = candidate.canvas
    return view(record, draft ? canvasHash(draft) : null, reveal)
}

export async function stopCheck(flow: DraftFlow, checkId: string, given?: Candidate, reveal?: CheckReveal): Promise<CheckView> {
    const candidate = await candidateFor(flow, given)
    const record = checks.get(candidate.key)
    if (!record || record.id !== checkId) throw new AppError(StatusCodes.NOT_FOUND, 'That check was not found. Run it again.')
    if (record.status === 'running') {
        record.stopRequested = true
        for (const controller of record.inflight) controller.abort()
    }
    const draft = candidate.canvas
    return view(record, draft ? canvasHash(draft) : null, reveal)
}

function cleanQuestions(input: unknown, max = MAX_QUESTIONS, allowEmpty = false): string[] {
    if (input === undefined && allowEmpty) return []
    if (!Array.isArray(input)) throw new AppError(StatusCodes.BAD_REQUEST, 'Send the questions to check as a list.')
    const texts = input.map((q) => (typeof q === 'string' ? q.trim() : ''))
    if (texts.some((t) => !t)) throw new AppError(StatusCodes.BAD_REQUEST, 'Each question must be text.')
    if (texts.some((t) => t.length > MAX_QUESTION_CHARS))
        throw new AppError(StatusCodes.BAD_REQUEST, `Each question can be at most ${MAX_QUESTION_CHARS} characters.`)
    const unique = pickQuestions(texts, Number.MAX_SAFE_INTEGER, MAX_QUESTION_CHARS)
    if (!unique.length) {
        if (allowEmpty) return []
        throw new AppError(StatusCodes.BAD_REQUEST, 'Pick at least one question to check.')
    }
    if (unique.length > max) throw new AppError(StatusCodes.BAD_REQUEST, `The check runs at most ${max} questions.`)
    return unique
}

// `count` selects the newest distinct past questions. Extra `questions` are added after those, still within 100.
async function questionsToRun(
    flowId: string,
    body: { questions?: unknown; count?: unknown }
): Promise<{ questions: string[]; selection: CheckSelection | null }> {
    const parsed = parseCompareCount(body?.count)
    if (!parsed.ok) throw new AppError(StatusCodes.BAD_REQUEST, parsed.message)
    if (parsed.count === null) return { questions: cleanQuestions(body?.questions), selection: null }
    const loaded = await loadRecent(flowId)
    const texts = usableTexts(loaded.rows)
    const available = pickQuestions(texts, COMPARE_COUNT_MAX, MAX_QUESTION_CHARS)
    const past = pickQuestions(texts, parsed.count, MAX_QUESTION_CHARS)
    const extras = cleanQuestions(body?.questions, COMPARE_COUNT_MAX, true)
    const questions = pickQuestions([...past, ...extras], COMPARE_COUNT_MAX, MAX_QUESTION_CHARS)
    if (!questions.length) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'No past questions to compare. Add a question to check.')
    }
    return {
        questions,
        selection: {
            requested: parsed.count,
            available: available.length,
            used: past.length,
            truncated: loaded.truncated && available.length < COMPARE_COUNT_MAX
        }
    }
}

// The caller (the HTTP handler) reports this when the client has already gone away.
export interface StartWatch {
    closed?: () => boolean
}

// A record that never started its replay must not keep the flow's one running slot.
function abandonUnstarted(record: CheckRecord) {
    record.stopRequested = true
    record.stopReason = 'stopped'
    record.status = 'stopped'
    record.finishedAt = Date.now()
    for (const controller of record.inflight) controller.abort()
}

// `count` selects the newest distinct recorded inputs. A question list, when `count` is omitted, is the
// older path and still runs those strings. Extra questions sent with `count` are not mixed in: a typed
// sentence is not a form payload or a webhook body.
async function inputsToRun(
    flow: { id: string; workspaceId?: string | null },
    kind: TriggerStart,
    body: { questions?: unknown; count?: unknown }
): Promise<{
    questions: string[]
    previews: string[]
    sources: ReplaySource[]
    dates: string[]
    selection: CheckSelection | null
}> {
    const parsed = parseCompareCount(body?.count)
    if (!parsed.ok) throw new AppError(StatusCodes.BAD_REQUEST, parsed.message)
    if (parsed.count !== null && body?.questions !== undefined) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'Questions are not used for a form, webhook or schedule start. Send count on its own.')
    }
    if (parsed.count === null) return { questions: cleanQuestions(body?.questions), previews: [], sources: [], dates: [], selection: null }
    const loaded = await loadInputs(flow, kind)
    const inputs = loaded.questions.slice(0, parsed.count)
    if (!inputs.length) throw new AppError(StatusCodes.BAD_REQUEST, noPastRunsMessage(kind))
    return {
        questions: inputs.map((item) => item.text),
        previews: inputs.map((item) => item.preview || item.text),
        sources: inputs.map((item) => item.source),
        dates: inputs.map((item) => item.date),
        selection: {
            requested: parsed.count,
            available: loaded.questions.length,
            used: inputs.length,
            truncated: loaded.truncated && loaded.questions.length < COMPARE_COUNT_MAX
        }
    }
}

export async function startCheck(
    flow: IChatFlow,
    body: {
        questions?: unknown
        includeRiskySteps?: unknown
        count?: unknown
        datasetId?: unknown
        evaluatorIds?: unknown
        threshold?: unknown
    },
    baseURL: string,
    given?: Candidate,
    watch?: StartWatch
): Promise<CheckView> {
    purge()
    const closed = () => Boolean(watch?.closed?.())
    const candidate = await candidateFor(flow as DraftFlow, given)
    const draft = candidate.canvas
    const request = body || {}
    const datasetId = readDatasetId(request)
    const evaluatorIds = readEvaluatorIds(request)
    const parsedThreshold = parseCheckThreshold(request.threshold, Boolean(datasetId))
    if (!parsedThreshold.ok) throw new AppError(StatusCodes.BAD_REQUEST, parsedThreshold.message)
    const threshold = parsedThreshold.threshold
    if (datasetId && (request.questions !== undefined || request.count !== undefined)) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'Send a datasetId on its own. Do not send questions or count with it.')
    }
    // Resolve the dataset and the evaluators before any other refusal, so a missing one is 404 and starts nothing.
    const workspaceId = String(flow.workspaceId || '')
    const fromDataset = datasetId ? await casesFromDataset(datasetId, workspaceId) : null
    // The client left while the dataset was loading. Do not store a record or start a replay,
    // and do not stop a check this request did not create.
    if (closed()) throw new AppError(StatusCodes.BAD_REQUEST, 'The check was cancelled before it started.')
    if (fromDataset) {
        const refusal = datasetStartRefusal(flow.type, [flow.flowData, draft])
        if (refusal) throw new AppError(StatusCodes.BAD_REQUEST, refusal)
    }
    const evaluators = await loadEvaluators(evaluatorIds, workspaceId)
    const contentHash = datasetId ? (await currentTestSetHash(datasetId, evaluatorIds, workspaceId)) || '' : ''
    if (closed()) throw new AppError(StatusCodes.BAD_REQUEST, 'The check was cancelled before it started.')
    const unavailable = unavailableFor(flow as DraftFlow, candidate, Boolean(given))
    if (unavailable) throw new AppError(StatusCodes.CONFLICT, unavailable.message)
    const kind = fromDataset ? null : triggerStart(flow.type, [flow.flowData, draft])
    let questions: string[]
    let selection: CheckSelection | null
    let previews: string[] = []
    let sources: ReplaySource[] = []
    let dates: string[] = []
    if (fromDataset) {
        questions = fromDataset.map((row) => row.question)
        selection = null
    } else if (kind) {
        const resolved = await inputsToRun(flow, kind, request)
        questions = resolved.questions
        selection = resolved.selection
        previews = resolved.previews
        sources = resolved.sources
        dates = resolved.dates
    } else {
        const resolved = await questionsToRun(flow.id, request)
        questions = resolved.questions
        selection = resolved.selection
    }
    // The client left during the question or input scan. Nothing from this request is left running.
    if (closed()) throw new AppError(StatusCodes.BAD_REQUEST, 'The check was cancelled before it started.')
    if (body?.includeRiskySteps !== undefined && typeof body.includeRiskySteps !== 'boolean')
        throw new AppError(StatusCodes.BAD_REQUEST, 'includeRiskySteps must be true or false.')
    const includeRiskySteps = body?.includeRiskySteps === true
    const risky = riskySteps([flow.flowData, draft as string], flow.chatbotConfig)
    if (risky.length && !includeRiskySteps) {
        throw new AppError(
            StatusCodes.CONFLICT,
            `This flow has steps that could send, write or post something for real: ${risky
                .map((s) => s.label)
                .join(', ')}. The check skips it unless you choose to run it anyway.`
        )
    }
    const current = checks.get(candidate.key)
    if (current?.status === 'running') throw new AppError(StatusCodes.CONFLICT, 'A check is already running for this flow.')
    const running = [...checks.values()].filter((r) => r.status === 'running').length
    if (running >= MAX_RUNNING)
        throw new AppError(StatusCodes.TOO_MANY_REQUESTS, 'Too many checks are running on this server. Try again in a minute.')

    const record: CheckRecord = {
        id: uuidv4(),
        flowId: flow.id,
        workspaceId: String(flow.workspaceId || ''),
        draftHash: canvasHash(draft as string),
        status: 'running',
        stopReason: null,
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
        includeRiskySteps,
        limits: checkLimits(),
        liveEmpty: liveIsEmpty(flow.flowData),
        cases: questions.map((question, index) => ({
            question,
            expected: fromDataset ? fromDataset[index].expected : null,
            ...(previews[index] ? { preview: previews[index] } : {}),
            ...(sources[index] ? { source: sources[index] } : {}),
            ...(dates[index] ? { date: dates[index] } : {}),
            live: null,
            draft: null,
            same: null
        })),
        selection,
        fromDataset: Boolean(fromDataset),
        datasetId,
        threshold,
        contentHash,
        evaluators,
        spentTokens: 0,
        inflight: new Set<AbortController>(),
        stopRequested: false
    }
    checks.set(candidate.key, record)
    // The socket closed after the record was stored and before the 202 was written.
    // Stop this record only. A check already running for the flow was refused above.
    if (closed()) {
        abandonUnstarted(record)
        return view(record, record.draftHash)
    }
    // Runs in the background; the dialog polls GET for progress.
    void runCheck(record, flow, draft as string, baseURL)
    return view(record, record.draftHash)
}

async function runOne(record: CheckRecord, flow: IChatFlow, flowData: string, question: string, baseURL: string): Promise<SideResult> {
    const deadline = record.startedAt + record.limits.maxSeconds * 1000
    const controller = new AbortController()
    record.inflight.add(controller)
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(RUN_TIMEOUT_MS, deadline - Date.now())))
    timer.unref?.()
    const started = Date.now()
    try {
        const run = replayHooks.run || replayFlow
        const { text, metrics } = await run({ flow, flowData, question, signal: controller, baseURL })
        return { text: String(text ?? ''), error: null, tokens: totalTokens(metrics), ms: Date.now() - started }
    } catch (error) {
        const timedOut = controller.signal.aborted && !record.stopRequested
        const message = record.stopRequested
            ? 'Stopped.'
            : timedOut
            ? 'Took too long, so it was stopped.'
            : (error as Error)?.message || 'This run failed.'
        return { text: null, error: message.slice(0, 500), tokens: null, ms: Date.now() - started }
    } finally {
        clearTimeout(timer)
        record.inflight.delete(controller)
    }
}

function budgetLeft(record: CheckRecord): CheckView['stopReason'] {
    if (record.stopRequested) return 'stopped'
    if (Date.now() >= record.startedAt + record.limits.maxSeconds * 1000) return 'time'
    // Every run so far counts, including the Live half of a question whose draft has not run yet.
    const used =
        record.spentTokens +
        record.cases.reduce(
            (sum, c) => sum + (c.live?.tokens || 0) + (c.draft?.tokens || 0) + (c.live?.graderTokens || 0) + (c.draft?.graderTokens || 0),
            0
        )
    if (used >= record.limits.maxTokens) return 'tokens'
    return null
}

// One question: Live, then the draft, so the two sides see the data as close together as they can.
// A failure is stored on that question. It does not stop the others.
async function attachScores(record: CheckRecord, side: SideResult | null, question: string, expected: string | null, flowData: string) {
    if (!side || !record.evaluators.length) return
    // The same per-run limit as the answer itself: 60 seconds, or whatever the check has left.
    // Stop aborts this controller because it is in the check's in-flight set.
    const deadline = record.startedAt + record.limits.maxSeconds * 1000
    const controller = new AbortController()
    record.inflight.add(controller)
    const timeoutMs = Math.max(1, Math.min(RUN_TIMEOUT_MS, deadline - Date.now()))
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
        const graded = await scoreAnswer({
            evaluators: record.evaluators,
            question,
            expected,
            text: side.text,
            error: side.error,
            tokens: side.tokens,
            ms: side.ms,
            workspaceId: record.workspaceId,
            flowData,
            signal: controller.signal,
            timeoutMs
        })
        side.scores = graded.scores
        side.graderTokens = graded.tokens
    } catch (error) {
        // Stop clears the case after this returns. A grader that timed out is Error, and the check moves on.
        // Scores already computed for text, JSON and numeric evaluators stay. Only a model score is replaced.
        if (!record.stopRequested) {
            const aborted = error instanceof Error && /aborted/i.test(error.message)
            const message = aborted ? 'The grading model did not finish.' : 'The grading model could not be started.'
            const kept = new Map((side.scores || []).filter((score) => score.id).map((score) => [score.id, score]))
            side.scores = record.evaluators.map((evaluator) => {
                if (evaluator.type !== 'llm') {
                    return kept.get(evaluator.id) || { id: evaluator.id, name: evaluator.name, result: 'Error' as const }
                }
                return { id: evaluator.id, name: evaluator.name, result: 'Error' as const, message }
            })
        }
    } finally {
        clearTimeout(timer)
        record.inflight.delete(controller)
    }
}

async function runCase(record: CheckRecord, c: CheckCase, flow: IChatFlow, draft: string, baseURL: string) {
    if (!record.liveEmpty) {
        c.live = await runOne(record, flow, flow.flowData, c.question, baseURL)
        await attachScores(record, c.live, c.question, c.expected ?? null, flow.flowData)
    }
    if (record.stopRequested) {
        c.live = null
        c.draft = null
        record.stopReason = 'stopped'
        return
    }
    const stop = budgetLeft(record)
    if (stop) {
        // The side is not shown, but its replay and grader tokens still count toward the next question.
        record.spentTokens += (c.live?.tokens || 0) + (c.live?.graderTokens || 0)
        c.live = null
        record.stopReason = record.stopReason || stop
        return
    }
    c.draft = await runOne(record, flow, draft, c.question, baseURL)
    await attachScores(record, c.draft, c.question, c.expected ?? null, draft)
    if (record.stopRequested) {
        c.live = null
        c.draft = null
        record.stopReason = 'stopped'
        return
    }
    c.same = record.liveEmpty || !c.live ? null : sameAnswer(c.live, c.draft)
}

function claimCase(record: CheckRecord, cursor: { next: number }): CheckCase | null {
    if (cursor.next >= record.cases.length) return null
    if (record.stopRequested) {
        record.stopReason = 'stopped'
        return null
    }
    const stop = budgetLeft(record)
    if (stop) {
        record.stopReason = record.stopReason || stop
        return null
    }
    return record.cases[cursor.next++]
}

async function runCheck(record: CheckRecord, flow: IChatFlow, draft: string, baseURL: string) {
    const cursor = { next: 0 }
    const workers = Math.min(record.limits.concurrency, record.cases.length)
    const worker = async () => {
        for (;;) {
            const mine = claimCase(record, cursor)
            if (!mine) return
            try {
                await runCase(record, mine, flow, draft, baseURL)
            } catch (error) {
                // One question must not fail the compare. The row keeps the error; the other workers continue.
                if (!mine.draft) {
                    mine.draft = {
                        text: null,
                        error: ((error as Error)?.message || 'This run failed.').slice(0, 500),
                        tokens: null,
                        ms: 0
                    }
                }
                if (!record.liveEmpty && mine.live && mine.draft) mine.same = false
                logger.error(`[server]: publish check question failed for flow ${flow.id}: ${(error as Error)?.message || 'unknown error'}`)
            }
        }
    }
    try {
        await Promise.all(Array.from({ length: workers }, () => worker()))
        if (record.stopReason) {
            record.status = 'stopped'
        } else {
            // Store the verdict before status is done, so a poll cannot see a finished check with nothing saved yet.
            if (record.fromDataset && record.datasetId && record.threshold != null && flowDraftsService.recordPublishGateResult) {
                const verdict = draftVerdict(summarize(record.cases, record.liveEmpty).scores?.draft, record.threshold)
                await flowDraftsService
                    .recordPublishGateResult(flow as DraftFlow, {
                        draftHash: record.draftHash,
                        datasetId: record.datasetId,
                        evaluatorIds: record.evaluators.map((evaluator) => evaluator.id),
                        threshold: record.threshold,
                        passRate: verdict.passRate,
                        passed: verdict.passed,
                        failed: verdict.failed,
                        errored: verdict.errored,
                        verdict: verdict.result,
                        contentHash: record.contentHash
                    })
                    .catch((error: Error) => {
                        logger.error(
                            `[server]: could not store the publish gate result for flow ${flow.id}: ${error?.message || 'unknown error'}`
                        )
                    })
            }
            record.status = 'done'
        }
    } catch (error) {
        record.status = 'failed'
        record.error = 'The check could not run.'
        logger.error(`[server]: publish check failed for flow ${flow.id}: ${(error as Error)?.message || 'unknown error'}`)
    } finally {
        record.finishedAt = Date.now()
        record.inflight.clear()
    }
}

// Runs one question through a canvas without saving anything. For a chatflow the token counter is Cuttlely's
// evaluation tracer, the only analytics provider on the copy, so the flow's own tracing providers are not called.
// An agentflow replay calls no tracing provider and keeps its run in memory; its steps report their tokens.
async function replayFlow({ flow, flowData, question, signal, baseURL }: ReplayInput): Promise<{ text: string; metrics?: unknown[] }> {
    // Imported here so loading this module does not load the whole prediction path.
    const { executeFlow } = await import('../../utils/buildChatflow')
    const app = getRunningExpressApp()
    const workspace = await app.AppDataSource.getRepository(Workspace).findOneBy({ id: flow.workspaceId as string })
    if (!workspace) throw new AppError(StatusCodes.NOT_FOUND, 'Workspace not found.')
    const org = await app.AppDataSource.getRepository(Organization).findOneBy({ id: workspace.organizationId })
    if (!org) throw new AppError(StatusCodes.NOT_FOUND, 'Organization not found.')
    const runId = `cuttlely-check-${crypto.randomUUID()}`
    const copy = { ...flow, flowData, analytic: JSON.stringify({ evaluation: { status: true } }) } as IChatFlow
    // A form, webhook or schedule canvas replays the recorded input. A chat canvas replays the question.
    const replay = replayFromQuestion(question, triggerStart(flow.type, [flowData]))
    try {
        const result = await executeFlow({
            incomingInput: replay.incoming as any,
            chatflow: copy,
            chatId: uuidv4(),
            baseURL,
            isInternal: true,
            evaluationRunId: runId,
            appDataSource: app.AppDataSource,
            sseStreamer: app.sseStreamer,
            telemetry: app.telemetry,
            cachePool: app.cachePool,
            componentNodes: app.nodesPool.componentNodes,
            usageCacheManager: app.usageCacheManager,
            orgId: org.id,
            workspaceId: workspace.id,
            subscriptionId: org.subscriptionId as string,
            productId: OSS_PRODUCT_ID,
            chatType: replay.chatType as ChatType,
            signal,
            replay: true
        })
        // An agentflow reports tokens on each step; a chatflow through the evaluation tracer.
        const metrics = flow.type === 'AGENTFLOW' ? stepTokens(result?.agentFlowExecutedData) : EvaluationRunner.metrics.get(runId)
        return { text: result?.text ?? '', metrics }
    } finally {
        EvaluationRunner.metrics.delete(runId)
    }
}

export default { getCheckSetup, getCheck, startCheck, stopCheck, checkLimits }
