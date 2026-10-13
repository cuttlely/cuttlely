// The publish check: before Publish, replay recent real questions from this flow's chat history against
// Live and the draft, and show the answers, tokens and time side by side.
// `count` (1 to 100, 4 in the dialog) selects the newest distinct questions. A few run at a time.
//
// A replay runs the canvas in memory through executeFlow with replay on: a new chat id, so memory starts
// empty; no chat messages, follow-ups, telemetry, usage counts or tracing are written; Live is never saved.
// Chatflows and agentflows can be checked. An agentflow replay also writes no execution record.
// Results stay in this server's memory for a short while and are never written to the database or logged.
// The check is optional and never blocks Publish.
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
import flowDraftsService, { canvasHash, DraftFlow } from '../flow-drafts'
import {
    COMPARE_COUNT_DEFAULT,
    COMPARE_COUNT_MAX,
    CheckCase,
    CheckSummary,
    SideResult,
    parseCompareCount,
    pickQuestions,
    sameAnswer,
    stepTokens,
    summarize,
    totalTokens
} from './compare'
import { RiskyStep, riskySteps } from './risk'
import { Unavailable, datasetStartRefusal, startUnavailable, typeUnavailable } from './kinds'
import { casesFromDataset, CheckEvaluator, loadEvaluators, readDatasetId, readEvaluatorIds, scoreAnswer } from './score'

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
    questions: Array<{ text: string; date: string; starter?: boolean }>
    // Distinct past questions found, not counting starter questions. At most 100.
    pastCount: number
    pastTruncated: boolean
    riskySteps: RiskyStep[]
    limits: CheckLimits
    // Live has no cards yet (the flow was never published), so the check asks only the draft.
    liveEmpty: boolean
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
    evaluators: CheckEvaluator[]
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

function shownSide(side: SideResult | null): SideResult | null {
    if (!side) return null
    const shown: SideResult = { text: clip(side.text), error: side.error, tokens: side.tokens, ms: side.ms }
    if (side.scores) shown.scores = side.scores
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

function view(record: CheckRecord, currentDraftHash: string | null): CheckView {
    const ran = record.cases.filter((c) => (record.liveEmpty || c.live) && c.draft).length
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
            question: c.question,
            expected: c.expected ?? null,
            live: shownSide(c.live),
            draft: shownSide(c.draft),
            same: c.same
        })),
        summary: summarize(record.cases, record.liveEmpty),
        selection: record.selection
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

export async function getCheckSetup(flow: DraftFlow & { chatbotConfig?: string | null }, given?: Candidate): Promise<CheckSetup> {
    purge()
    const candidate = await candidateFor(flow, given)
    const draft = candidate.canvas
    const unavailable = unavailableFor(flow, candidate, Boolean(given))
    const record = checks.get(candidate.key)
    const offered =
        unavailable?.code === 'off' || unavailable?.code === 'type'
            ? { questions: [], pastCount: 0, pastTruncated: false }
            : await questionsFor(flow)
    return {
        unavailable,
        questions: offered.questions,
        pastCount: offered.pastCount,
        pastTruncated: offered.pastTruncated,
        riskySteps: riskySteps(draft ? [flow.flowData, draft] : [flow.flowData], flow.chatbotConfig),
        limits: checkLimits(),
        liveEmpty: liveIsEmpty(flow.flowData),
        check: record ? view(record, draft ? canvasHash(draft) : null) : null
    }
}

export async function getCheck(flow: DraftFlow, checkId: string, given?: Candidate): Promise<CheckView> {
    const candidate = await candidateFor(flow, given)
    const record = checks.get(candidate.key)
    if (!record || record.id !== checkId) throw new AppError(StatusCodes.NOT_FOUND, 'That check was not found. Run it again.')
    const draft = candidate.canvas
    return view(record, draft ? canvasHash(draft) : null)
}

export async function stopCheck(flow: DraftFlow, checkId: string, given?: Candidate): Promise<CheckView> {
    const candidate = await candidateFor(flow, given)
    const record = checks.get(candidate.key)
    if (!record || record.id !== checkId) throw new AppError(StatusCodes.NOT_FOUND, 'That check was not found. Run it again.')
    if (record.status === 'running') {
        record.stopRequested = true
        for (const controller of record.inflight) controller.abort()
    }
    const draft = candidate.canvas
    return view(record, draft ? canvasHash(draft) : null)
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

export async function startCheck(
    flow: IChatFlow,
    body: { questions?: unknown; includeRiskySteps?: unknown; count?: unknown; datasetId?: unknown; evaluatorIds?: unknown },
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
    if (closed()) throw new AppError(StatusCodes.BAD_REQUEST, 'The check was cancelled before it started.')
    const unavailable = unavailableFor(flow as DraftFlow, candidate, Boolean(given))
    if (unavailable) throw new AppError(StatusCodes.CONFLICT, unavailable.message)
    const { questions, selection } = fromDataset
        ? { questions: fromDataset.map((row) => row.question), selection: null }
        : await questionsToRun(flow.id, request)
    // The client left during the question scan. Same rule: nothing from this request is left running.
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
            live: null,
            draft: null,
            same: null
        })),
        selection,
        evaluators,
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
    const used = record.cases.reduce((sum, c) => sum + (c.live?.tokens || 0) + (c.draft?.tokens || 0), 0)
    if (used >= record.limits.maxTokens) return 'tokens'
    return null
}

// One question: Live, then the draft, so the two sides see the data as close together as they can.
// A failure is stored on that question. It does not stop the others.
async function attachScores(record: CheckRecord, side: SideResult | null, question: string, expected: string | null, flowData: string) {
    if (!side || !record.evaluators.length) return
    try {
        side.scores = await scoreAnswer({
            evaluators: record.evaluators,
            question,
            expected,
            text: side.text,
            error: side.error,
            tokens: side.tokens,
            ms: side.ms,
            workspaceId: record.workspaceId,
            flowData
        })
    } catch {
        side.scores = record.evaluators.map((evaluator) => ({ id: evaluator.id, name: evaluator.name, result: 'Error' as const }))
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
        record.status = record.stopReason ? 'stopped' : 'done'
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
    try {
        const result = await executeFlow({
            incomingInput: { question, streaming: false, history: [] } as any,
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
            chatType: ChatType.INTERNAL,
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
