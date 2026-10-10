// The publish check: before Publish, replay a few recent real questions from this flow's chat history against
// Live and the draft, and show the answers, tokens and time side by side.
//
// A replay runs the canvas in memory through executeFlow with replay on: a new chat id, so memory starts
// empty; no chat messages, follow-ups, telemetry, usage counts or tracing are written; Live is never saved.
// Chatflows and agentflows can be checked. An agentflow replay also writes no execution record.
// Results stay in this server's memory for a short while and are never written to the database or logged.
// The check is optional and never blocks Publish.
import crypto from 'crypto'
import { StatusCodes } from 'http-status-codes'
import { v4 as uuidv4 } from 'uuid'
import { EvaluationRunner } from 'flowise-components'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { Organization, Workspace } from '../../database/entities/identity'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { ChatType, IChatFlow } from '../../Interface'
import { OSS_PRODUCT_ID } from '../../identity/ossPlatform'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import flowDraftsService, { canvasHash, DraftFlow } from '../flow-drafts'
import { CheckCase, CheckSummary, SideResult, pickQuestions, sameAnswer, stepTokens, summarize, totalTokens } from './compare'
import { RiskyStep, riskySteps } from './risk'
import { Unavailable, startUnavailable, typeUnavailable } from './kinds'

export const MAX_QUESTIONS = 10
export const MAX_QUESTION_CHARS = 2000
const MAX_ANSWER_CHARS = 4000
const MAX_RUNNING = 3
const KEEP_MS = 30 * 60 * 1000
const RUN_TIMEOUT_MS = 60 * 1000

function envNumber(name: string, fallback: number, min: number, max: number): number {
    const value = Number(process.env[name])
    if (!Number.isFinite(value) || value <= 0) return fallback
    return Math.min(Math.max(Math.round(value), min), max)
}

export function checkLimits() {
    return {
        maxQuestions: MAX_QUESTIONS,
        maxQuestionChars: MAX_QUESTION_CHARS,
        maxTokens: envNumber('CUTTLELY_CHECK_MAX_TOKENS', 100000, 1000, 2000000),
        maxSeconds: envNumber('CUTTLELY_CHECK_MAX_SECONDS', 180, 10, 1800)
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

export interface CheckSetup {
    unavailable: Unavailable | null
    // Recent real questions, newest first, then the starter questions nobody asked yet (marked starter).
    questions: Array<{ text: string; date: string; starter?: boolean }>
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
    controller: AbortController | null
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
            live: c.live && { ...c.live, text: clip(c.live.text) },
            draft: c.draft && { ...c.draft, text: clip(c.draft.text) },
            same: c.same
        })),
        summary: summarize(record.cases, record.liveEmpty)
    }
}

// What the check offers to ask: recent real questions, then the flow's starter questions not asked yet. A new flow
// has few or no recent questions, so its starter questions fill the list.
async function questionsFor(flow: DraftFlow & { chatbotConfig?: string | null }) {
    const recent = await recentQuestions(flow.id)
    const asked = new Set(recent.map((q) => q.text.toLowerCase()))
    const starters = starterQuestions(flow.chatbotConfig)
        .filter((text) => !asked.has(text.toLowerCase()))
        .map((text) => ({ text, date: '', starter: true }))
    return [...recent, ...starters].slice(0, MAX_QUESTIONS)
}

// Recent real questions for this flow: what people and the canvas test chat asked, newest first.
// Questions sent with files are left out, because the files are not replayed.
async function recentQuestions(flowId: string): Promise<Array<{ text: string; date: string }>> {
    const rows = await getRunningExpressApp()
        .AppDataSource.getRepository(ChatMessage)
        .createQueryBuilder('m')
        .select(['m.content', 'm.createdDate', 'm.fileUploads'])
        .where('m.chatflowid = :flowId', { flowId })
        .andWhere('m.role = :role', { role: 'userMessage' })
        .andWhere('m.chatType IN (:...types)', { types: [ChatType.EXTERNAL, ChatType.INTERNAL] })
        .orderBy('m.createdDate', 'DESC')
        .take(200)
        .getMany()
    const usable = rows.filter((row) => !row.fileUploads || row.fileUploads === '[]')
    const picked = pickQuestions(
        usable.map((row) => row.content),
        MAX_QUESTIONS,
        MAX_QUESTION_CHARS
    )
    return picked.map((text) => {
        const row = usable.find((r) => String(r.content).trim() === text)
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
    return {
        unavailable,
        questions: unavailable?.code === 'off' || unavailable?.code === 'type' ? [] : await questionsFor(flow),
        riskySteps: riskySteps(draft ? [flow.flowData, draft] : [flow.flowData], flow.chatbotConfig),
        limits: checkLimits(),
        liveEmpty: liveIsEmpty(flow.flowData),
        check: record ? view(record, draft ? canvasHash(draft) : null) : null
    }
}

export async function getCheck(flow: DraftFlow, checkId: string, given?: Candidate): Promise<CheckView> {
    const candidate = await candidateFor(flow, given)
    const record = checks.get(candidate.key)
    if (!record || record.id !== checkId) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'That check was not found. Run it again.')
    const draft = candidate.canvas
    return view(record, draft ? canvasHash(draft) : null)
}

export async function stopCheck(flow: DraftFlow, checkId: string, given?: Candidate): Promise<CheckView> {
    const candidate = await candidateFor(flow, given)
    const record = checks.get(candidate.key)
    if (!record || record.id !== checkId) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'That check was not found. Run it again.')
    if (record.status === 'running') {
        record.stopRequested = true
        record.controller?.abort()
    }
    const draft = candidate.canvas
    return view(record, draft ? canvasHash(draft) : null)
}

function cleanQuestions(input: unknown): string[] {
    if (!Array.isArray(input)) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Send the questions to check as a list.')
    const texts = input.map((q) => (typeof q === 'string' ? q.trim() : ''))
    if (texts.some((t) => !t)) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Each question must be text.')
    if (texts.some((t) => t.length > MAX_QUESTION_CHARS))
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `Each question can be at most ${MAX_QUESTION_CHARS} characters.`)
    const unique = pickQuestions(texts, Number.MAX_SAFE_INTEGER, MAX_QUESTION_CHARS)
    if (!unique.length) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Pick at least one question to check.')
    if (unique.length > MAX_QUESTIONS)
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `The check runs at most ${MAX_QUESTIONS} questions.`)
    return unique
}

export async function startCheck(
    flow: IChatFlow,
    body: { questions?: unknown; includeRiskySteps?: unknown },
    baseURL: string,
    given?: Candidate
): Promise<CheckView> {
    purge()
    const candidate = await candidateFor(flow as DraftFlow, given)
    const draft = candidate.canvas
    const unavailable = unavailableFor(flow as DraftFlow, candidate, Boolean(given))
    if (unavailable) throw new InternalFlowiseError(StatusCodes.CONFLICT, unavailable.message)
    const questions = cleanQuestions(body?.questions)
    if (body?.includeRiskySteps !== undefined && typeof body.includeRiskySteps !== 'boolean')
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'includeRiskySteps must be true or false.')
    const includeRiskySteps = body?.includeRiskySteps === true
    const risky = riskySteps([flow.flowData, draft as string], flow.chatbotConfig)
    if (risky.length && !includeRiskySteps) {
        throw new InternalFlowiseError(
            StatusCodes.CONFLICT,
            `This flow has steps that could send, write or post something for real: ${risky
                .map((s) => s.label)
                .join(', ')}. The check skips it unless you choose to run it anyway.`
        )
    }
    const current = checks.get(candidate.key)
    if (current?.status === 'running') throw new InternalFlowiseError(StatusCodes.CONFLICT, 'A check is already running for this flow.')
    const running = [...checks.values()].filter((r) => r.status === 'running').length
    if (running >= MAX_RUNNING)
        throw new InternalFlowiseError(StatusCodes.TOO_MANY_REQUESTS, 'Too many checks are running on this server. Try again in a minute.')

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
        cases: questions.map((question) => ({ question, live: null, draft: null, same: null })),
        controller: null,
        stopRequested: false
    }
    checks.set(candidate.key, record)
    // Runs in the background; the dialog polls GET for progress.
    void runCheck(record, flow, draft as string, baseURL)
    return view(record, record.draftHash)
}

async function runOne(record: CheckRecord, flow: IChatFlow, flowData: string, question: string, baseURL: string): Promise<SideResult> {
    const deadline = record.startedAt + record.limits.maxSeconds * 1000
    const controller = new AbortController()
    record.controller = controller
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
        record.controller = null
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

async function runCheck(record: CheckRecord, flow: IChatFlow, draft: string, baseURL: string) {
    try {
        for (const c of record.cases) {
            let stop = budgetLeft(record)
            if (stop) {
                record.stopReason = stop
                break
            }
            // Live and the draft run back to back on the same question, so they see the same data. An empty Live has
            // nothing to answer with, so only the draft runs.
            if (!record.liveEmpty) c.live = await runOne(record, flow, flow.flowData, c.question, baseURL)
            stop = budgetLeft(record)
            if (stop) {
                c.live = null
                record.stopReason = stop
                break
            }
            c.draft = await runOne(record, flow, draft, c.question, baseURL)
            if (record.stopRequested) {
                c.live = null
                c.draft = null
                record.stopReason = 'stopped'
                break
            }
            c.same = record.liveEmpty || !c.live ? null : sameAnswer(c.live, c.draft)
        }
        record.status = record.stopReason ? 'stopped' : 'done'
    } catch (error) {
        record.status = 'failed'
        record.error = 'The check could not run.'
        logger.error(`[server]: publish check failed for flow ${flow.id}: ${(error as Error)?.message || 'unknown error'}`)
    } finally {
        record.finishedAt = Date.now()
        record.controller = null
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
    if (!workspace) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Workspace not found.')
    const org = await app.AppDataSource.getRepository(Organization).findOneBy({ id: workspace.organizationId })
    if (!org) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Organization not found.')
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
