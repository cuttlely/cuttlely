import { AsyncLocalStorage } from 'async_hooks'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { context, SpanStatusCode, trace } from '@opentelemetry/api'

const replaySilence = new AsyncLocalStorage<true>()

export function replaySilenced(): boolean {
    return replaySilence.getStore() === true
}

/** A publish-check replay runs inside this store so its spans are not exported. */
export function silenceRunTraces<T>(fn: () => Promise<T>): Promise<T> {
    return replaySilence.run(true, fn)
}

/** The span methods this module uses. A full SDK span satisfies it. */
interface TraceSpan {
    setAttribute(key: string, value: string | number | boolean): void
    setStatus(status: { code: number; message?: string }): void
    end(endTime?: number | Date): void
    attributes?: Record<string, unknown>
}

/**
 * Run traces are off unless CUTTLELY_OTEL_TRACES=true and the server has installed a tracer.
 * This module does not create a provider. The server does, and only when traces are on.
 */

const CONTENT_MAX = 4000

type TracerLike = {
    startSpan: (name: string, options?: object, ctx?: unknown) => TraceSpan
}

let tracerGetter: (() => TracerLike | undefined) | undefined

export function setCuttlelyTracer(getter: (() => TracerLike | undefined) | undefined): void {
    tracerGetter = getter
}

export function traceContentOn(): boolean {
    return process.env.CUTTLELY_OTEL_TRACES === 'true' && process.env.CUTTLELY_OTEL_TRACES_CONTENT === 'true'
}

export function capTraceText(value: string): string {
    return value.length > CONTENT_MAX ? value.slice(0, CONTENT_MAX) : value
}

export function tokenCount(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
    return undefined
}

/** A prompt or an answer. Objects that are not message-shaped are left out so a span does not pick up credentials. */
export function traceText(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim()
        return trimmed ? trimmed : undefined
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (Array.isArray(value)) {
        const parts = value.map((part) => traceText(part)).filter((part): part is string => Boolean(part))
        return parts.length ? parts.join('\n') : undefined
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if ('text' in record) return traceText(record.text)
        if ('content' in record) return traceText(record.content)
        if ('question' in record) return traceText(record.question)
    }
    return undefined
}

export function writeContent(span: TraceSpan, input: unknown, output: unknown): void {
    if (!traceContentOn()) return
    const inputText = traceText(input)
    const outputText = traceText(output)
    if (inputText) span.setAttribute('content.input', capTraceText(inputText))
    if (outputText) span.setAttribute('content.output', capTraceText(outputText))
}

function tracer(): TracerLike | undefined {
    return tracerGetter?.()
}

function parentNodeAttrs(): { id?: string; type?: string } {
    const parent = trace.getActiveSpan() as (TraceSpan & { attributes?: Record<string, unknown> }) | undefined
    const attributes = parent?.attributes
    if (!attributes) return {}
    const id = attributes['node.id']
    const type = attributes['node.type']
    return {
        id: typeof id === 'string' ? id : undefined,
        type: typeof type === 'string' ? type : undefined
    }
}

function startChild(name: string): TraceSpan | undefined {
    const current = tracer()
    if (!current) return undefined
    const span = current.startSpan(name, {}, context.active())
    const node = parentNodeAttrs()
    if (node.id) span.setAttribute('node.id', node.id)
    if (node.type) span.setAttribute('node.type', node.type)
    const parent = trace.getActiveSpan() as (TraceSpan & { attributes?: Record<string, unknown> }) | undefined
    const flowId = parent?.attributes?.['flow.id']
    const flowKind = parent?.attributes?.['flow.kind']
    if (typeof flowId === 'string') span.setAttribute('flow.id', flowId)
    if (typeof flowKind === 'string') span.setAttribute('flow.kind', flowKind)
    return span
}

function endOk(span: TraceSpan | undefined): void {
    if (!span) return
    span.setAttribute('status', 'ok')
    span.setStatus({ code: SpanStatusCode.OK })
    span.end()
}

function endError(span: TraceSpan | undefined, error: unknown): void {
    if (!span) return
    const message = error instanceof Error ? error.message : String(error)
    span.setAttribute('status', 'error')
    span.setAttribute('error', message)
    span.setStatus({ code: SpanStatusCode.ERROR, message })
    span.end()
}

function modelNameOf(llm: { kwargs?: Record<string, unknown>; id?: string[] } | undefined): string | undefined {
    const kwargs = llm?.kwargs
    const name = kwargs?.modelName ?? kwargs?.model_name ?? kwargs?.model
    if (typeof name === 'string' && name) return name
    const id = llm?.id
    if (Array.isArray(id) && id.length) return String(id[id.length - 1])
    return undefined
}

/**
 * LangChain callback for one prediction. Created only when run traces are on.
 * Prompt and answer text are attributes only when CUTTLELY_OTEL_TRACES_CONTENT is true.
 */
export class CuttlelyOtelHandler extends BaseCallbackHandler {
    name = 'cuttlely_otel'
    private spans = new Map<string, TraceSpan>()

    private startModel(llm: { kwargs?: Record<string, unknown>; id?: string[] } | undefined, runId: string, input: unknown): void {
        if (this.spans.has(runId)) return
        const span = startChild('model')
        if (!span) return
        const modelName = modelNameOf(llm)
        if (modelName) span.setAttribute('model.name', modelName)
        writeContent(span, input, undefined)
        this.spans.set(runId, span)
    }

    async handleChatModelStart(
        llm: { kwargs?: Record<string, unknown>; id?: string[] },
        messages: unknown[][],
        runId: string
    ): Promise<void> {
        this.startModel(llm, runId, Array.isArray(messages) ? messages.flat() : messages)
    }

    async handleLLMStart(llm: { kwargs?: Record<string, unknown>; id?: string[] }, prompts: string[], runId: string): Promise<void> {
        this.startModel(llm, runId, prompts)
    }

    async handleLLMEnd(output: any, runId: string): Promise<void> {
        const span = this.spans.get(runId)
        if (!span) return
        this.spans.delete(runId)
        const usage = output?.llmOutput?.tokenUsage ?? output?.llmOutput?.usage
        const generation = output?.generations?.[0]?.[0]
        const meta = generation?.message?.usage_metadata
        const inputTokens = tokenCount(usage?.promptTokens ?? meta?.input_tokens)
        const outputTokens = tokenCount(usage?.completionTokens ?? meta?.output_tokens)
        if (inputTokens !== undefined) span.setAttribute('tokens.input', inputTokens)
        if (outputTokens !== undefined) span.setAttribute('tokens.output', outputTokens)
        if (traceContentOn()) {
            const text = traceText(generation?.text ?? generation?.message?.content)
            if (text) span.setAttribute('content.output', capTraceText(text))
        }
        endOk(span)
    }

    async handleLLMError(error: unknown, runId: string): Promise<void> {
        const span = this.spans.get(runId)
        this.spans.delete(runId)
        endError(span, error)
    }

    async handleToolStart(tool: { name?: string; id?: string[] }, input: string, runId: string): Promise<void> {
        const span = startChild('tool')
        if (!span) return
        const name = tool?.name || (Array.isArray(tool?.id) ? tool.id[tool.id.length - 1] : undefined) || 'tool'
        span.setAttribute('tool.name', String(name))
        writeContent(span, input, undefined)
        this.spans.set(runId, span)
    }

    async handleToolEnd(output: unknown, runId: string): Promise<void> {
        const span = this.spans.get(runId)
        if (!span) return
        this.spans.delete(runId)
        if (traceContentOn()) {
            const text = traceText(output)
            if (text) span.setAttribute('content.output', capTraceText(text))
        }
        endOk(span)
    }

    async handleToolError(error: unknown, runId: string): Promise<void> {
        const span = this.spans.get(runId)
        this.spans.delete(runId)
        endError(span, error)
    }
}

/** Undefined when traces are off, so callers do not construct a handler on the normal path. */
export function otelRunCallback(): CuttlelyOtelHandler | undefined {
    if (process.env.CUTTLELY_OTEL_TRACES !== 'true') return undefined
    if (replaySilenced()) return undefined
    if (!tracer()) return undefined
    return new CuttlelyOtelHandler()
}

export interface HarnessTraceInfo {
    name: string
    workspaceId?: string
    question?: string
    /** Publish-check replay. Exports nothing. */
    replay?: boolean
    /** Canvas draft try. Exports nothing. */
    draft?: boolean
    /** Chatflow publish check. Exports nothing. */
    cuttlelyReplay?: boolean
}

export interface HarnessTraceSession {
    event(event: Record<string, unknown>): void
    finish(extra?: { text?: string; runId?: string }): void
    fail(error: unknown): void
}

/**
 * A harness run's span tree, built from the events the run card already records.
 * Undefined when traces are off, so the caller does no span work.
 * A draft try and a publish-check replay export nothing.
 */
export function openHarnessRunTrace(info: HarnessTraceInfo): HarnessTraceSession | undefined {
    if (info.replay === true || info.draft === true || info.cuttlelyReplay === true) return undefined
    if (process.env.CUTTLELY_OTEL_TRACES !== 'true') return undefined
    if (replaySilenced()) return undefined
    if (!tracer()) return undefined
    return new HarnessTraceSessionImpl(info)
}

type ToolHold = {
    name: string
    span: TraceSpan
    endAt?: number
    failed?: boolean
    detail?: string
}

class HarnessTraceSessionImpl implements HarnessTraceSession {
    private readonly parentCtx: unknown
    private readonly flow: { id?: string; kind?: string }
    private readonly harnessName: string
    private readonly workspaceId?: string
    private readonly question?: string
    private root?: TraceSpan
    private route?: TraceSpan
    private handoff?: TraceSpan
    private readonly specialists = new Map<string, TraceSpan>()
    private readonly tools = new Map<string, ToolHold[]>()
    private answer?: string
    private finalAt?: number
    private traceStatus?: string
    private traceError?: string
    private traceTokens?: unknown
    private closed = false

    constructor(info: HarnessTraceInfo) {
        this.parentCtx = context.active()
        this.harnessName = info.name
        this.workspaceId = info.workspaceId
        this.question = info.question
        const parent = trace.getActiveSpan() as { attributes?: Record<string, unknown> } | undefined
        const attributes = parent?.attributes
        this.flow = {
            id: typeof attributes?.['flow.id'] === 'string' ? attributes['flow.id'] : undefined,
            kind: typeof attributes?.['flow.kind'] === 'string' ? attributes['flow.kind'] : undefined
        }
    }

    event(event: Record<string, unknown>): void {
        if (this.closed || !event || typeof event !== 'object') return
        try {
            this.apply(event)
        } catch {
            // A span must not fail the harness turn.
        }
    }

    finish(extra?: { text?: string; runId?: string }): void {
        if (this.closed) return
        this.closed = true
        try {
            const at = this.finalAt ?? Date.now()
            this.ensureRoot(at)
            this.closeLeftovers(at, false)
            if (!this.root) return
            const runId = extra?.runId
            if (runId && /^run_[A-Za-z0-9-]{8,80}$/.test(runId)) this.root.setAttribute('run.id', runId)
            setHarnessTokens(this.root, this.traceTokens)
            writeContent(this.root, this.question, extra?.text ?? this.answer)
            const failed = this.traceStatus === 'failed' || this.traceStatus === 'partial'
            if (failed) endHarnessSpan(this.root, at, 'error', this.traceError || 'A specialist failed.')
            else endHarnessSpan(this.root, at, 'ok')
        } catch {
            // The run already finished. A span error stays here.
        }
    }

    fail(error: unknown): void {
        if (this.closed) return
        this.closed = true
        try {
            const at = Date.now()
            this.ensureRoot(at)
            this.closeLeftovers(at, true)
            if (!this.root) return
            const message = error instanceof Error ? error.message : String(error || 'The harness run failed.')
            writeContent(this.root, this.question, this.answer)
            endHarnessSpan(this.root, at, 'error', message)
        } catch {
            // The run is already failing. Do not hide that error with a span error.
        }
    }

    private apply(event: Record<string, unknown>): void {
        const type = event.type
        const phase = event.phase
        const at = eventTime(event)
        if (type === 'partial') return
        if (type === 'final') {
            this.ensureRoot(at)
            this.finalAt = at
            if (typeof event.text === 'string') this.answer = event.text
            const body = event.trace
            if (body && typeof body === 'object') {
                const traceBody = body as Record<string, unknown>
                if (typeof traceBody.status === 'string') this.traceStatus = traceBody.status
                if (typeof traceBody.error === 'string') this.traceError = traceBody.error
                this.traceTokens = traceBody.tokens
            }
            return
        }
        if (type === 'route' && phase === 'start') {
            this.ensureRoot(at)
            if (!this.route && this.root) this.route = this.child('harness.route', at, this.root)
            return
        }
        if (type === 'route' && phase === 'done') {
            const start = at - Math.max(0, numberOr(event.ms, 0))
            this.ensureRoot(this.root ? at : start)
            if (!this.route && this.root) this.route = this.child('harness.route', start, this.root)
            this.finishPhase(this.route, event, at)
            this.route = undefined
            return
        }
        if (type === 'specialist' && phase === 'start') {
            this.ensureRoot(at)
            const name = specialistName(event)
            if (!this.specialists.has(name) && this.root) {
                const span = this.child('harness.specialist', at, this.root)
                if (span) {
                    span.setAttribute('specialist.name', name.slice(0, 200))
                    const model = stringAttr(event.model)
                    if (model) span.setAttribute('model.name', model)
                    this.specialists.set(name, span)
                }
            }
            return
        }
        if (type === 'specialist' && (phase === 'done' || phase === 'failed')) {
            const name = specialistName(event)
            const start = at - Math.max(0, numberOr(event.ms, 0))
            this.ensureRoot(this.root ? at : start)
            let span = this.specialists.get(name)
            if (!span && this.root) {
                span = this.child('harness.specialist', start, this.root)
                if (span) {
                    span.setAttribute('specialist.name', name.slice(0, 200))
                    this.specialists.set(name, span)
                }
            }
            if (span) {
                const model = stringAttr(event.model)
                if (model) span.setAttribute('model.name', model)
                setHarnessTokens(span, event.tokens)
                if (traceContentOn()) {
                    const task = stringAttr(event.task)
                    if (task) span.setAttribute('content.input', capTraceText(task))
                }
            }
            this.finishTools(name, Array.isArray(event.tools) ? event.tools : undefined, at)
            this.addModels(span, event.calls, at)
            const failed = phase === 'failed' || event.status === 'failed'
            endHarnessSpan(span, at, failed ? 'error' : 'ok', typeof event.error === 'string' ? event.error : undefined)
            this.specialists.delete(name)
            return
        }
        if (type === 'tool') {
            this.noteTool(event, at)
            return
        }
        if (type === 'handoff' && phase === 'start') {
            this.ensureRoot(at)
            if (!this.handoff && this.root) {
                this.handoff = this.child('harness.handoff', at, this.root)
                const model = stringAttr(event.model)
                if (this.handoff && model) this.handoff.setAttribute('model.name', model)
            }
            return
        }
        if (type === 'handoff' && phase === 'done') {
            const start = at - Math.max(0, numberOr(event.ms, 0))
            this.ensureRoot(this.root ? at : start)
            if (!this.handoff && this.root) this.handoff = this.child('harness.handoff', start, this.root)
            this.finishPhase(this.handoff, event, at)
            this.handoff = undefined
        }
    }

    private finishPhase(span: TraceSpan | undefined, event: Record<string, unknown>, at: number): void {
        if (!span) return
        const model = stringAttr(event.model)
        if (model) span.setAttribute('model.name', model)
        setHarnessTokens(span, event.tokens)
        this.addModels(span, event.calls, at)
        endHarnessSpan(span, at, 'ok')
    }

    private noteTool(event: Record<string, unknown>, at: number): void {
        const specialist = typeof event.specialist === 'string' ? event.specialist : ''
        const name = stringAttr(event.name) || 'tool'
        this.ensureRoot(at)
        const parent = this.specialists.get(specialist) || this.root
        const list = this.tools.get(specialist) || []
        if (event.phase === 'start') {
            const span = this.child('tool', at, parent)
            if (!span) return
            span.setAttribute('tool.name', name.slice(0, 200))
            list.push({ name, span })
            this.tools.set(specialist, list)
            return
        }
        let hold: ToolHold | undefined
        for (let index = list.length - 1; index >= 0; index -= 1) {
            if (list[index].name === name && list[index].endAt === undefined) {
                hold = list[index]
                break
            }
        }
        if (!hold) {
            const span = this.child('tool', at, parent)
            if (!span) return
            span.setAttribute('tool.name', name.slice(0, 200))
            hold = { name, span }
            list.push(hold)
            this.tools.set(specialist, list)
        }
        hold.endAt = at
        hold.failed = event.error === true
        if (typeof event.detail === 'string') hold.detail = event.detail
    }

    // Tool chips on the run card are settled when the specialist finishes (a rejected batch becomes retried).
    // Hold the span until then so its status matches that chip.
    private finishTools(specialist: string, settled: unknown[] | undefined, at: number): void {
        const list = this.tools.get(specialist) || []
        this.tools.delete(specialist)
        list.forEach((hold, index) => {
            const chip =
                settled && settled[index] && typeof settled[index] === 'object' ? (settled[index] as Record<string, unknown>) : undefined
            const status = typeof chip?.status === 'string' ? chip.status : hold.failed ? 'failed' : 'done'
            const detail = typeof chip?.detail === 'string' ? chip.detail : hold.detail
            decorateTool(hold.span, hold.name, detail)
            const spanStatus = status === 'failed' ? 'error' : status === 'running' ? 'pending' : 'ok'
            endHarnessSpan(hold.span, hold.endAt ?? at, spanStatus, spanStatus === 'error' ? toolErrorText(detail) : undefined)
        })
    }

    private addModels(parent: TraceSpan | undefined, calls: unknown, fallbackAt: number): void {
        if (!parent || !Array.isArray(calls)) return
        for (const call of calls) {
            if (!call || typeof call !== 'object') continue
            const record = call as Record<string, unknown>
            const start = numberOr(record.startedAt, fallbackAt)
            const end = numberOr(record.endedAt, start)
            const span = this.child('model', start, parent)
            if (!span) continue
            const model = stringAttr(record.model)
            if (model) span.setAttribute('model.name', model)
            setHarnessTokens(span, record.tokens)
            endHarnessSpan(span, end, 'ok')
        }
    }

    private ensureRoot(at: number): void {
        if (this.root) return
        const current = tracer()
        if (!current) return
        const span = current.startSpan('harness.run', { startTime: new Date(at) }, this.parentCtx)
        const name = this.harnessName.trim()
        if (name) span.setAttribute('harness.name', name.slice(0, 200))
        const workspace = this.workspaceId?.trim()
        if (workspace) span.setAttribute('workspace.id', workspace.slice(0, 80))
        if (this.flow.id) span.setAttribute('flow.id', this.flow.id)
        if (this.flow.kind) span.setAttribute('flow.kind', this.flow.kind)
        this.root = span
    }

    private child(name: string, at: number, parent: TraceSpan | undefined): TraceSpan | undefined {
        const current = tracer()
        if (!current || !parent) return undefined
        const ctx = trace.setSpan(this.parentCtx as never, parent as never)
        const span = current.startSpan(name, { startTime: new Date(at) }, ctx)
        if (this.flow.id) span.setAttribute('flow.id', this.flow.id)
        if (this.flow.kind) span.setAttribute('flow.kind', this.flow.kind)
        return span
    }

    private closeLeftovers(at: number, failed: boolean): void {
        const status = failed ? 'error' : 'pending'
        if (this.route) endHarnessSpan(this.route, at, status, failed ? 'The harness run stopped.' : undefined)
        this.route = undefined
        if (this.handoff) endHarnessSpan(this.handoff, at, status, failed ? 'The harness run stopped.' : undefined)
        this.handoff = undefined
        for (const span of this.specialists.values()) endHarnessSpan(span, at, status, failed ? 'Stopped before it finished.' : undefined)
        this.specialists.clear()
        for (const list of this.tools.values()) {
            for (const hold of list) {
                decorateTool(hold.span, hold.name, hold.detail)
                endHarnessSpan(
                    hold.span,
                    hold.endAt ?? at,
                    failed || hold.failed ? 'error' : 'pending',
                    failed ? 'Stopped before it finished.' : undefined
                )
            }
        }
        this.tools.clear()
    }
}

function eventTime(event: Record<string, unknown>): number {
    return numberOr(event.at, Date.now())
}

function numberOr(value: unknown, fallback: number): number {
    const parsed = tokenCount(value)
    return parsed === undefined ? fallback : parsed
}

function stringAttr(value: unknown): string {
    return typeof value === 'string' ? value.slice(0, 200) : ''
}

function specialistName(event: Record<string, unknown>): string {
    return stringAttr(event.name) || 'specialist'
}

function setHarnessTokens(span: TraceSpan, tokens: unknown): void {
    if (!tokens || typeof tokens !== 'object') return
    const record = tokens as Record<string, unknown>
    const input = tokenCount(record.prompt ?? record.input)
    const output = tokenCount(record.completion ?? record.output)
    if (input !== undefined) span.setAttribute('tokens.input', input)
    if (output !== undefined) span.setAttribute('tokens.output', output)
}

function endHarnessSpan(span: TraceSpan | undefined, at: number, status: 'ok' | 'error' | 'pending', error?: string): void {
    if (!span) return
    if (status === 'pending') {
        span.setAttribute('status', 'pending')
        span.end(new Date(at))
        return
    }
    if (status === 'error') {
        const message = (error || 'error').slice(0, 300)
        span.setAttribute('status', 'error')
        span.setAttribute('error', message)
        span.setStatus({ code: SpanStatusCode.ERROR, message })
        span.end(new Date(at))
        return
    }
    span.setAttribute('status', 'ok')
    span.setStatus({ code: SpanStatusCode.OK })
    span.end(new Date(at))
}

function isAnalystQueryName(name: string): boolean {
    const value = name.trim().toLowerCase()
    if (!value || value === 'tool_call' || value === 'tool_search' || value === 'tool_describe') return false
    return value === 'query' || value.endsWith('__query')
}

function analystFacts(name: string, detail: string | undefined): { rows?: number; sql?: string; rowText?: string } {
    if (!detail || !isAnalystQueryName(name)) return {}
    let body: unknown
    try {
        let parsed: unknown = JSON.parse(detail)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'result' in parsed) {
            parsed = (parsed as { result: unknown }).result
        }
        if (typeof parsed === 'string') parsed = JSON.parse(parsed)
        body = parsed
    } catch {
        return {}
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
    const record = body as Record<string, unknown>
    let sql: string | undefined
    for (const key of ['sql', 'statement', 'query']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) {
            sql = value
            break
        }
    }
    let rows: number | undefined
    if (Array.isArray(record.rows)) rows = record.rows.length
    else if (typeof record.rowCount === 'number' && Number.isFinite(record.rowCount)) rows = record.rowCount
    return { rows, sql, rowText: Array.isArray(record.rows) ? JSON.stringify(record.rows) : undefined }
}

function looksLikeSql(text: string): boolean {
    return /^\s*(select|insert|update|delete|drop|create|alter|with)\b/i.test(text)
}

function toolErrorText(detail: string | undefined): string {
    if (!detail) return 'failed'
    const text = detail.trim()
    if (!text || text.startsWith('{') || text.startsWith('[')) return 'failed'
    if (looksLikeSql(text)) return 'failed'
    return text.slice(0, 300)
}

function decorateTool(span: TraceSpan, name: string, detail: string | undefined): void {
    const facts = analystFacts(name, detail)
    if (facts.rows !== undefined) span.setAttribute('tool.rows', facts.rows)
    if (!traceContentOn()) return
    if (facts.sql) span.setAttribute('content.input', capTraceText(facts.sql))
    if (facts.rowText) span.setAttribute('content.output', capTraceText(facts.rowText))
    else if (detail && facts.rows === undefined && !detail.trim().startsWith('{') && !looksLikeSql(detail)) {
        span.setAttribute('content.output', capTraceText(detail))
    }
}
