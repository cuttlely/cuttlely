import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { context, SpanStatusCode, trace } from '@opentelemetry/api'

/** The span methods this module uses. A full SDK span satisfies it. */
interface TraceSpan {
    setAttribute(key: string, value: string | number | boolean): void
    setStatus(status: { code: number; message?: string }): void
    end(): void
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
    if (!tracer()) return undefined
    return new CuttlelyOtelHandler()
}
