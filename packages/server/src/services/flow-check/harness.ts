// Harness questions for the publish check, and the replay that runs one side.
// Questions are the full user turns stored for this harness, newest distinct first, with the same caps
// as chat questions. Secrets are redacted the same way as a run preview, then the text is cut at 2,000
// characters. The short preview on the Runs list is not replayed.
// A request that sends datasetId is resolved before this module runs. A harness accepts it.
import { randomUUID } from 'crypto'
import { StatusCodes } from 'http-status-codes'
import { AppError } from '../../errors/appError'
import { COMPARE_COUNT_MAX, pickQuestions, parseCompareCount } from './compare'

// The same character cap the chat question check uses.
const MAX_QUESTION_CHARS = 2000

export interface UserTurn {
    content?: string
    createdAt?: string
}

// Tests stand in for the session transcript. Production reads the harness session messages.
export const harnessCheckHooks: {
    listUserTurns: null | ((name: string, opts?: { limit?: number }) => UserTurn[])
} = { listUserTurns: null }

// Newest user turns read from the session file. Past that, older questions may exist.
const TURN_SCAN_CAP = 2000

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

// The same replacements as a run-history preview. Whitespace is left as the person typed it.
export function redactSecrets(text: string): string {
    return String(text ?? '')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
        .replace(/\bxai-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, '[redacted]')
}

// Redact first, then cut. A cut does not add the preview ellipsis.
export function questionTextFromTurn(content: string): string {
    const redacted = redactSecrets(content).trim()
    if (!redacted) return ''
    return redacted.length > MAX_QUESTION_CHARS ? redacted.slice(0, MAX_QUESTION_CHARS) : redacted
}

export function questionsFromUserTurns(rows: UserTurn[], max: number, maxChars: number): Array<{ text: string; date: string }> {
    const prepared = rows
        .map((row) => ({ text: questionTextFromTurn(String(row.content || '')), date: row.createdAt || '' }))
        .filter((row) => row.text)
    const picked = pickQuestions(
        prepared.map((row) => row.text),
        max,
        maxChars
    )
    return picked.map((text) => {
        const row = prepared.find((item) => item.text === text)
        return { text, date: row?.date || '' }
    })
}

export async function loadHarnessUserTurns(name: string | null | undefined): Promise<{ rows: UserTurn[]; truncated: boolean }> {
    const harnessName = String(name || '').trim()
    if (!harnessName) return { rows: [], truncated: false }
    const list = harnessCheckHooks.listUserTurns || (await sessionUserTurns())
    const rows = list(harnessName, { limit: TURN_SCAN_CAP }) || []
    const distinct = questionsFromUserTurns(rows, COMPARE_COUNT_MAX, MAX_QUESTION_CHARS)
    return { rows, truncated: rows.length >= TURN_SCAN_CAP && distinct.length < COMPARE_COUNT_MAX }
}

async function sessionUserTurns(): Promise<(name: string, opts?: { limit?: number }) => UserTurn[]> {
    const { loadHarness } = await import('../harnesses')
    const session = await loadHarness('session.mjs')
    return (name: string, opts?: { limit?: number }) => session.listUserTurns(name, opts)
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
    const loaded = await loadHarnessUserTurns(flow.name)
    const recent = questionsFromUserTurns(loaded.rows, COMPARE_COUNT_MAX, MAX_QUESTION_CHARS)
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

export async function harnessQuestionsToRun(
    flow: { id: string; name?: string | null; workspaceId?: string | null },
    body: { questions?: unknown; count?: unknown }
): Promise<{ questions: string[]; selection: { requested: number; available: number; used: number; truncated: boolean } | null }> {
    const parsed = parseCompareCount(body?.count)
    if (!parsed.ok) throw new AppError(StatusCodes.BAD_REQUEST, parsed.message)
    if (parsed.count === null) return { questions: cleanQuestions(body?.questions, 10, false), selection: null }
    const loaded = await loadHarnessUserTurns(flow.name)
    const texts = loaded.rows.map((row) => questionTextFromTurn(String(row.content || '')))
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
