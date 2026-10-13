// Harness questions for the publish check, and the replay that runs one side.
// Questions come from the harness's run history (newest distinct input previews, same caps as chat questions).
// A dataset loader is not on this server yet. `questionSources.dataset` is the seam: when it is set, a
// request that sends `datasetId` replays those rows on Live and the draft. Until then that request is refused.
import { randomUUID } from 'crypto'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { COMPARE_COUNT_MAX, pickQuestions, parseCompareCount } from './compare'

// The same character cap the chat question check uses.
const MAX_QUESTION_CHARS = 2000

export interface RunPreview {
    inputPreview?: string
    startedAt?: string
}

export interface DatasetRow {
    text: string
}

export interface QuestionSource {
    dataset:
        | null
        | ((
              flow: { id: string; name?: string | null; workspaceId?: string | null },
              body: Record<string, unknown>
          ) => Promise<DatasetRow[] | null>)
}

// Unset until a dataset check is on main. A harness request that sends datasetId uses this when it is set.
export const questionSources: QuestionSource = { dataset: null }

export interface ListedRun {
    inputPreview?: string
    startedAt?: string
}

// Tests stand in for run history. Production reads the harness history module.
export const harnessCheckHooks: {
    listRuns: null | ((name: string, opts?: { limit?: number }) => ListedRun[])
} = { listRuns: null }

export interface ReplayCall {
    name: string
    flowData: string
    question: string
    signal: AbortSignal
}

// Tests stand in for the try-profile replay. Production calls the harness service.
export const harnessReplayHooks: {
    run:
        | null
        | ((call: ReplayCall) => Promise<{ text?: string; report?: { tokens?: { prompt?: number | null; completion?: number | null } } }>)
} = { run: null }

export function questionsFromRunPreviews(rows: RunPreview[], max: number, maxChars: number): Array<{ text: string; date: string }> {
    const texts = rows.map((row) => String(row.inputPreview || ''))
    const picked = pickQuestions(texts, max, maxChars)
    return picked.map((text) => {
        const row = rows.find((item) => String(item.inputPreview || '').trim() === text)
        return { text, date: row?.startedAt || '' }
    })
}

// Run history keeps 100 rows. Reading that many is the whole store, so the scan is truncated only when
// those 100 rows did not yield 100 different questions (older wordings were already dropped).
export async function loadHarnessRunPreviews(name: string | null | undefined): Promise<{ rows: RunPreview[]; truncated: boolean }> {
    const harnessName = String(name || '').trim()
    if (!harnessName) return { rows: [], truncated: false }
    const list = harnessCheckHooks.listRuns || (await historyListRuns())
    const rows = list(harnessName, { limit: COMPARE_COUNT_MAX }) || []
    const distinct = questionsFromRunPreviews(rows, COMPARE_COUNT_MAX, MAX_QUESTION_CHARS)
    return { rows, truncated: rows.length >= COMPARE_COUNT_MAX && distinct.length < COMPARE_COUNT_MAX }
}

async function historyListRuns(): Promise<(name: string, opts?: { limit?: number }) => ListedRun[]> {
    const { loadHarness } = await import('../harnesses')
    const history = await loadHarness('history.mjs')
    return (name: string, opts?: { limit?: number }) => history.listRuns(name, opts)
}

function starterQuestions(chatbotConfig?: string | null): string[] {
    try {
        const config = chatbotConfig ? JSON.parse(chatbotConfig) : {}
        const prompts = Object.values(config?.starterPrompts || {}).map((entry: any) => String(entry?.prompt || '').trim())
        return [...new Set(prompts.filter((text) => text && text.length <= MAX_QUESTION_CHARS))].slice(0, 10)
    } catch {
        return []
    }
}

export async function harnessQuestionsFor(flow: { name?: string | null; chatbotConfig?: string | null }) {
    const loaded = await loadHarnessRunPreviews(flow.name)
    const recent = questionsFromRunPreviews(loaded.rows, COMPARE_COUNT_MAX, MAX_QUESTION_CHARS)
    const asked = new Set(recent.map((q) => q.text.toLowerCase()))
    const starters = starterQuestions(flow.chatbotConfig)
        .filter((text) => !asked.has(text.toLowerCase()))
        .map((text) => ({ text, date: '', starter: true as const }))
    return {
        questions: [...recent, ...starters],
        pastCount: recent.length,
        pastTruncated: loaded.truncated
    }
}

function cleanQuestions(input: unknown, max: number, allowEmpty: boolean): string[] {
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

function datasetRequested(body: { datasetId?: unknown }): boolean {
    return body?.datasetId !== undefined && body.datasetId !== null && body.datasetId !== ''
}

// Dataset rows stay in the order the loader returns. Empty questions and questions over the cap are skipped.
// This does not apply the newest-distinct rule: a dataset can ask the same wording twice.
async function questionsFromDataset(
    flow: { id: string; name?: string | null; workspaceId?: string | null },
    body: Record<string, unknown>
): Promise<string[]> {
    if (body.questions !== undefined || body.count !== undefined) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'Send a datasetId on its own. Do not send questions or count with it.')
    }
    if (!questionSources.dataset) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'A dataset check is not available on this server yet.')
    }
    const rows = (await questionSources.dataset(flow, body)) || []
    const questions: string[] = []
    for (const row of rows) {
        const text = String(row?.text || '').trim()
        if (!text || text.length > MAX_QUESTION_CHARS) continue
        questions.push(text)
        if (questions.length >= COMPARE_COUNT_MAX) break
    }
    if (!questions.length) throw new AppError(StatusCodes.BAD_REQUEST, 'That dataset has no question the check can ask.')
    return questions
}

export async function harnessQuestionsToRun(
    flow: { id: string; name?: string | null; workspaceId?: string | null },
    body: { questions?: unknown; count?: unknown; datasetId?: unknown }
): Promise<{ questions: string[]; selection: { requested: number; available: number; used: number; truncated: boolean } | null }> {
    if (datasetRequested(body)) {
        return { questions: await questionsFromDataset(flow, body as Record<string, unknown>), selection: null }
    }
    const parsed = parseCompareCount(body?.count)
    if (!parsed.ok) throw new AppError(StatusCodes.BAD_REQUEST, parsed.message)
    if (parsed.count === null) return { questions: cleanQuestions(body?.questions, 10, false), selection: null }
    const loaded = await loadHarnessRunPreviews(flow.name)
    const texts = loaded.rows.map((row) => String(row.inputPreview || ''))
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

// Route, specialist and handoff tokens are already summed on the run report. Cached tokens are part of prompt.
export function harnessReplayMetrics(report?: { tokens?: { prompt?: number | null; completion?: number | null } } | null) {
    const tokens = report?.tokens
    if (!tokens || (tokens.prompt == null && tokens.completion == null)) return undefined
    const total = (Number(tokens.prompt) || 0) + (Number(tokens.completion) || 0)
    if (!Number.isFinite(total) || total <= 0) return undefined
    return [{ totalTokens: total }]
}

function abortSignalOf(signal: AbortSignal | AbortController): AbortSignal {
    if (typeof (signal as AbortController).abort === 'function' && (signal as AbortController).signal) {
        return (signal as AbortController).signal
    }
    return signal as AbortSignal
}

// One side of one question. A new chat id, the canvas roster, and the canvas try profile.
// The caller passes Live's canvas or the draft's. Cleanup of the try profile happens inside the run.
export async function replayHarnessQuestion(args: {
    flow: { id: string; name: string; workspaceId?: string | null; flowData?: string }
    flowData: string
    question: string
    signal: AbortSignal | AbortController
}): Promise<{ text: string; metrics?: unknown[] }> {
    const signal = abortSignalOf(args.signal)
    if (harnessReplayHooks.run) {
        const outcome = await harnessReplayHooks.run({
            name: args.flow.name,
            flowData: args.flowData,
            question: args.question,
            signal
        })
        return { text: String(outcome?.text ?? ''), metrics: harnessReplayMetrics(outcome?.report) }
    }
    const harnesses = (await import('../harnesses')).default
    const outcome = await harnesses.replayCheck(
        {
            id: args.flow.id,
            name: args.flow.name,
            flowData: args.flowData,
            workspaceId: String(args.flow.workspaceId || '')
        },
        args.flowData,
        { question: args.question, chatId: `check-${randomUUID()}` },
        { signal }
    )
    const payload = outcome?.payload as
        | { text?: string; report?: { tokens?: { prompt?: number | null; completion?: number | null } } }
        | undefined
    return { text: String(payload?.text ?? ''), metrics: harnessReplayMetrics(payload?.report) }
}
