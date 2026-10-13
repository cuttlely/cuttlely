// Token lines a finished run already reported. Prices are not computed here.

export const USAGE_WINDOWS = [7, 30, 90] as const
export const USAGE_RANGE_MAX_DAYS = 366
export const UNKNOWN_MODEL = 'unknown'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const SECRET = /sk-|api[_-]?key|bearer\s|secret|password/i

export interface UsageLine {
    model: string
    inputTokens: number
    outputTokens: number
}

export interface UsageRange {
    startDate: string
    endDate: string
}

export function utcDay(at: Date = new Date()): string {
    return at.toISOString().slice(0, 10)
}

export function isUtcDay(value: string): boolean {
    if (!DAY.test(value)) return false
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function shiftUtcDay(day: string, delta: number): string {
    const cursor = new Date(`${day}T00:00:00.000Z`)
    cursor.setUTCDate(cursor.getUTCDate() + delta)
    return cursor.toISOString().slice(0, 10)
}

export function inclusiveDayCount(startDate: string, endDate: string): number {
    const start = new Date(`${startDate}T00:00:00.000Z`).getTime()
    const end = new Date(`${endDate}T00:00:00.000Z`).getTime()
    return Math.round((end - start) / 86400000) + 1
}

export function eachUtcDay(startDate: string, endDate: string): string[] {
    const days: string[] = []
    let cursor = startDate
    const count = inclusiveDayCount(startDate, endDate)
    for (let i = 0; i < count; i += 1) {
        days.push(cursor)
        cursor = shiftUtcDay(cursor, 1)
    }
    return days
}

function present(value: unknown): boolean {
    if (value == null) return false
    if (typeof value === 'string') return value.trim() !== ''
    return true
}

function oneString(value: unknown): string | null {
    if (typeof value === 'number' && Number.isInteger(value)) return String(value)
    if (typeof value !== 'string') return null
    return value.trim()
}

const RANGE_ALIAS: Record<string, string> = { '7d': '7', '30d': '30', '90d': '90' }

// `days` is 7, 30, or 90 ending today (UTC). `range` is the same window as 7d, 30d, or 90d.
// `startDate` and `endDate` are an inclusive custom range. A custom range replaces `days`.
// `range` cannot be combined with `days` or a custom date. A range longer than a year is refused.
export function usageRange(
    query: { days?: unknown; startDate?: unknown; endDate?: unknown; range?: unknown },
    now: Date = new Date()
): { ok: true; range: UsageRange } | { ok: false; message: string } {
    const today = utcDay(now)
    const hasStart = present(query.startDate)
    const hasEnd = present(query.endDate)
    const hasRange = present(query.range)
    const hasDays = present(query.days)
    if (hasRange && (hasDays || hasStart || hasEnd)) {
        return { ok: false, message: 'range cannot be combined with days, startDate, or endDate.' }
    }
    if (hasRange) {
        const alias = oneString(query.range)
        const days = alias ? RANGE_ALIAS[alias] : undefined
        if (!days) return { ok: false, message: 'range must be 7d, 30d, or 90d.' }
        const span = Number(days)
        return { ok: true, range: { startDate: shiftUtcDay(today, 1 - span), endDate: today } }
    }
    if (hasStart || hasEnd) {
        if (!hasStart || !hasEnd) return { ok: false, message: 'startDate and endDate are both required for a custom range.' }
        const startDate = oneString(query.startDate)
        const endDate = oneString(query.endDate)
        if (!startDate || !isUtcDay(startDate) || !endDate || !isUtcDay(endDate)) {
            return { ok: false, message: 'startDate and endDate must be UTC dates in the form YYYY-MM-DD.' }
        }
        if (endDate < startDate) return { ok: false, message: 'endDate must be on or after startDate.' }
        if (inclusiveDayCount(startDate, endDate) > USAGE_RANGE_MAX_DAYS) {
            return { ok: false, message: `A custom range can cover at most ${USAGE_RANGE_MAX_DAYS} days.` }
        }
        return { ok: true, range: { startDate, endDate } }
    }
    const raw = present(query.days) ? oneString(query.days) : '7'
    if (!raw || !USAGE_WINDOWS.some((window) => String(window) === raw)) {
        return { ok: false, message: 'days must be 7, 30, or 90.' }
    }
    const span = Number(raw)
    return { ok: true, range: { startDate: shiftUtcDay(today, 1 - span), endDate: today } }
}

export function cleanModel(value: unknown): string {
    const text = String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 255)
    if (!text || SECRET.test(text)) return UNKNOWN_MODEL
    return text
}

function whole(value: unknown): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.min(Math.round(n), Number.MAX_SAFE_INTEGER)
}

// An Agent step stores input and output as the sum of every model call, and total_tokens as that same
// sum. tool_call_tokens is the step total. When those add up, keep the split. Older steps stored only
// the final response's split, and total_tokens added that response again. tool_call_tokens was still
// the step total.
function tokenPair(value: unknown): { inputTokens: number; outputTokens: number } | null {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    const inputTokens = whole(record.prompt ?? record.promptTokens ?? record.input_tokens ?? record.inputTokens)
    const outputTokens = whole(record.completion ?? record.completionTokens ?? record.output_tokens ?? record.outputTokens)
    const toolTokens = whole(record.tool_call_tokens)
    // Sums of every model call in the step. When they add up to tool_call_tokens, keep that split.
    if (toolTokens > 0 && inputTokens + outputTokens === toolTokens) {
        return { inputTokens, outputTokens }
    }
    // Older steps stored only the final response's split. tool_call_tokens is still the step total.
    if (toolTokens > 0) {
        const input = Math.min(inputTokens, toolTokens)
        return { inputTokens: input, outputTokens: toolTokens - input }
    }
    if (inputTokens === 0 && outputTokens === 0) return null
    return { inputTokens, outputTokens }
}

export interface ReportedLlmUsage {
    model: string
    promptTokens: number
    completionTokens: number
}

function modelFromStart(llm: unknown, extra?: Record<string, unknown>, metadata?: Record<string, unknown>): string {
    const kwargs = (llm as { kwargs?: Record<string, unknown> } | undefined)?.kwargs
    const invocation = extra?.invocation_params as Record<string, unknown> | undefined
    return cleanModel(
        kwargs?.modelName ||
            kwargs?.model_name ||
            kwargs?.model ||
            invocation?.model ||
            invocation?.model_name ||
            metadata?.ls_model_name ||
            ''
    )
}

// What a chat model already reported on handleLLMEnd. No estimate and no extra provider call.
export function usageFromLlmEnd(output: unknown, modelHint?: string): ReportedLlmUsage | null {
    if (!output || typeof output !== 'object') return null
    const record = output as {
        generations?: Array<Array<{ message?: { usage_metadata?: Record<string, unknown>; response_metadata?: Record<string, unknown> } }>>
        llmOutput?: { tokenUsage?: Record<string, unknown>; model?: unknown }
    }
    const message = record.generations?.[0]?.[0]?.message
    const meta = message?.usage_metadata
    const tokenUsage = record.llmOutput?.tokenUsage
    const model = cleanModel(
        modelHint || message?.response_metadata?.model_name || message?.response_metadata?.model || record.llmOutput?.model || ''
    )
    if (meta && (meta.input_tokens != null || meta.output_tokens != null || meta.prompt_tokens != null)) {
        const promptTokens = whole(meta.input_tokens ?? meta.prompt_tokens)
        const completionTokens = whole(meta.output_tokens ?? meta.completion_tokens)
        if (promptTokens === 0 && completionTokens === 0) return null
        return { model, promptTokens, completionTokens }
    }
    if (tokenUsage) {
        const promptTokens = whole(tokenUsage.promptTokens ?? tokenUsage.input_tokens)
        const completionTokens = whole(tokenUsage.completionTokens ?? tokenUsage.output_tokens)
        if (promptTokens === 0 && completionTokens === 0) return null
        return { model, promptTokens, completionTokens }
    }
    return null
}

export function carriedUsageLines(usage: ChatflowTokenUsage): Array<{ model: string; promptTokens: number; completionTokens: number }> {
    return usage.sink.map((row) => ({ model: row.model, promptTokens: row.promptTokens, completionTokens: row.completionTokens }))
}

// Lines taken from the saved chat message for this action. The request's own priorUsage is not used.
export function applyCarriedUsage(usage: ChatflowTokenUsage, action: unknown) {
    const lines = action && typeof action === 'object' ? (action as { priorUsage?: unknown }).priorUsage : undefined
    if (!Array.isArray(lines)) return
    for (const line of lines) {
        if (!line || typeof line !== 'object') continue
        const row = line as { model?: unknown; promptTokens?: unknown; completionTokens?: unknown }
        const promptTokens = whole(row.promptTokens)
        const completionTokens = whole(row.completionTokens)
        if (!promptTokens && !completionTokens) continue
        usage.sink.push({ model: cleanModel(row.model), promptTokens, completionTokens })
    }
}

export function withCarriedUsage<T extends Record<string, any>>(
    action: T,
    usage: ChatflowTokenUsage
): T & { priorUsage?: Array<{ model: string; promptTokens: number; completionTokens: number }> } {
    const priorUsage = carriedUsageLines(usage)
    if (!priorUsage.length) return action
    return { ...action, priorUsage }
}

// An empty action is a finished graph. A tool interrupt has the approve and reject buttons.
export function waitingForApproval(action: unknown): boolean {
    return !!action && typeof action === 'object' && !Array.isArray(action) && Object.keys(action as object).length > 0
}

// In-process LangChain callback. The same instance can sit on a parent chain and a child chain, so a run id is counted once.
export class ChatflowTokenUsage {
    name = 'CuttlelyChatflowTokenUsage'
    readonly sink: ReportedLlmUsage[] = []
    private models = new Map<string, string>()
    private seen = new Set<string>()

    handleLLMStart(
        llm: unknown,
        _prompts: unknown,
        runId: string,
        _parent?: string,
        extra?: Record<string, unknown>,
        _tags?: unknown,
        metadata?: Record<string, unknown>
    ) {
        this.remember(runId, modelFromStart(llm, extra, metadata))
    }

    handleChatModelStart(
        llm: unknown,
        _messages: unknown,
        runId: string,
        _parent?: string,
        extra?: Record<string, unknown>,
        _tags?: unknown,
        metadata?: Record<string, unknown>
    ) {
        this.remember(runId, modelFromStart(llm, extra, metadata))
    }

    async handleLLMEnd(output: unknown, runId: string) {
        if (runId && this.seen.has(runId)) return
        if (runId) this.seen.add(runId)
        const usage = usageFromLlmEnd(output, runId ? this.models.get(runId) : undefined)
        this.models.delete(runId)
        if (usage) this.sink.push(usage)
    }

    private remember(runId: string, model: string) {
        if (runId && model && model !== 'unknown') this.models.set(runId, model)
    }
}

function pushLine(lines: UsageLine[], model: unknown, tokens: unknown) {
    const pair = tokenPair(tokens)
    if (!pair) return
    lines.push({ model: cleanModel(model), ...pair })
}

function fromTrace(trace: unknown): UsageLine[] {
    if (!trace || typeof trace !== 'object') return []
    const record = trace as Record<string, unknown>
    const lines: UsageLine[] = []
    const route = record.route as { model?: unknown; tokens?: unknown } | undefined
    if (route) pushLine(lines, route.model, route.tokens)
    const specialists = Array.isArray(record.specialists) ? record.specialists : []
    for (const specialist of specialists) {
        if (!specialist || typeof specialist !== 'object') continue
        const row = specialist as { model?: unknown; tokens?: unknown }
        pushLine(lines, row.model, row.tokens)
    }
    const handoff = record.handoff as { model?: unknown; tokens?: unknown; status?: unknown } | undefined
    if (handoff && handoff.status !== 'skipped') pushLine(lines, handoff.model, handoff.tokens)
    return lines
}

function fromAgents(agents: unknown): UsageLine[] {
    if (!Array.isArray(agents)) return []
    const lines: UsageLine[] = []
    for (const agent of agents) {
        if (!agent || typeof agent !== 'object') continue
        const row = agent as { model?: unknown; fallback?: unknown; tokens?: unknown }
        pushLine(lines, row.model || row.fallback, row.tokens)
    }
    return lines
}

function modelFromStep(step: Record<string, unknown>): string {
    const data = step.data as { input?: Record<string, unknown> } | undefined
    const input = data?.input || {}
    const configs = [input.llmModelConfig, input.agentModelConfig, input.conditionAgentModelConfig, input.humanInputModelConfig]
    for (const config of configs) {
        if (!config || typeof config !== 'object') continue
        const name = (config as { modelName?: unknown; model?: unknown }).modelName ?? (config as { model?: unknown }).model
        if (typeof name === 'string' && name.trim()) return name
    }
    return ''
}

function linesFromKnown(value: unknown): UsageLine[] {
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    const payload =
        record.harnessPayload && typeof record.harnessPayload === 'object' ? (record.harnessPayload as Record<string, unknown>) : null
    const traceLines = fromTrace(record.trace || payload?.trace)
    if (traceLines.length) return traceLines
    const agentLines = fromAgents(record.agents || payload?.agents)
    if (agentLines.length) return agentLines
    const report = (record.report || payload?.report) as { tokens?: unknown } | undefined
    if (report?.tokens) {
        const agents = (record.agents || payload?.agents) as Array<{ model?: unknown }> | undefined
        const lines: UsageLine[] = []
        pushLine(lines, agents?.[0]?.model, report.tokens)
        return lines
    }
    return []
}

function fromSteps(steps: unknown): UsageLine[] {
    if (!Array.isArray(steps)) return []
    const lines: UsageLine[] = []
    for (const step of steps) {
        if (!step || typeof step !== 'object') continue
        const row = step as Record<string, unknown>
        const output = (row.data as { output?: unknown } | undefined)?.output
        const nested = linesFromKnown(output)
        if (nested.length) {
            lines.push(...nested)
            continue
        }
        const usage = output && typeof output === 'object' ? (output as { usageMetadata?: unknown }).usageMetadata : undefined
        pushLine(lines, modelFromStep(row), usage)
    }
    return lines
}

function fromMetrics(metrics: unknown): UsageLine[] {
    if (!Array.isArray(metrics)) return []
    const lines: UsageLine[] = []
    for (const entry of metrics) {
        let metric: unknown = entry
        if (typeof entry === 'string') {
            try {
                metric = JSON.parse(entry)
            } catch {
                continue
            }
        }
        if (!metric || typeof metric !== 'object') continue
        const record = metric as { model?: unknown; cost_values?: unknown }
        if (record.cost_values) continue
        pushLine(lines, record.model, metric)
    }
    return lines
}

export function groupUsageLines(lines: UsageLine[]): UsageLine[] {
    const grouped = new Map<string, UsageLine>()
    for (const line of lines) {
        const model = cleanModel(line.model)
        const inputTokens = whole(line.inputTokens)
        const outputTokens = whole(line.outputTokens)
        if (inputTokens === 0 && outputTokens === 0) continue
        const prev = grouped.get(model)
        if (prev) {
            prev.inputTokens += inputTokens
            prev.outputTokens += outputTokens
        } else {
            grouped.set(model, { model, inputTokens, outputTokens })
        }
    }
    return [...grouped.values()]
}

// One source per run: canvas steps, otherwise the harness trace, otherwise evaluation metrics.
// Mixing them would count the same model call twice.
export function usageLinesFromRun(result: unknown): UsageLine[] {
    if (!result || typeof result !== 'object') return []
    const record = result as Record<string, unknown>
    const steps = fromSteps(record.agentFlowExecutedData)
    if (steps.length) return groupUsageLines(steps)
    const known = linesFromKnown(record)
    if (known.length) return groupUsageLines(known)
    return groupUsageLines(fromMetrics(record.metrics))
}
