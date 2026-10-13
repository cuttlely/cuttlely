import { replaySilenced, setCuttlelyTracer, silenceRunTraces, tokenCount, writeContent } from '@cuttlely/components'
import logger from '../utils/logger'

export { silenceRunTraces }

/**
 * Optional OpenTelemetry traces for chatflow predictions and agentflow runs.
 * Off unless CUTTLELY_OTEL_TRACES=true. The provider is created only then.
 * Call sites check that variable and return before any span work.
 */

const MODEL_NODES = new Set(['llmAgentflow', 'agentAgentflow', 'conditionAgentAgentflow'])

let provider: any
let installed = false
const failedSpans = new WeakSet<object>()

function tracesRequested(): boolean {
    if (process.env.CUTTLELY_OTEL_TRACES !== 'true') return false
    return !replaySilenced()
}

type SpanLike = {
    setAttribute: (key: string, value: string | number | boolean) => void
    setStatus: (status: { code: number; message?: string }) => void
    end: () => void
    attributes?: Record<string, unknown>
}

export interface FinishedTraceSpan {
    name: string
    traceId: string
    spanId: string
    parentSpanId?: string
    attributes: Record<string, string | number | boolean>
}

export function tracesInstalled(): boolean {
    return installed
}

function serviceVersion(): string {
    try {
        return require('../../package.json').version || '0.0.0'
    } catch {
        return '0.0.0'
    }
}

let contextManagerReady = false

/** context.with is a no-op until a context manager is installed, so child spans would all be roots. */
function ensureContextManager(): void {
    if (contextManagerReady) return
    const { context } = require('@opentelemetry/api')
    const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks')
    const manager = new AsyncLocalStorageContextManager()
    manager.enable()
    if (!context.setGlobalContextManager(manager)) manager.disable()
    contextManagerReady = true
}

function api(): {
    context: { active: () => unknown; with: <T>(ctx: unknown, fn: () => Promise<T>) => Promise<T> }
    trace: { setSpan: (ctx: unknown, span: SpanLike) => unknown; getActiveSpan: () => SpanLike | undefined }
    SpanStatusCode: { OK: number; ERROR: number }
} {
    return require('@opentelemetry/api')
}

export function registerCuttlelyTraces(): void {
    if (process.env.CUTTLELY_OTEL_TRACES !== 'true') return
    if (installed) return

    const endpoint = process.env.CUTTLELY_OTEL_TRACES_ENDPOINT
    if (!endpoint) {
        logger.error('Run traces are on but CUTTLELY_OTEL_TRACES_ENDPOINT is not set. Run traces stay off.')
        return
    }

    const protocol = process.env.CUTTLELY_OTEL_TRACES_PROTOCOL || 'http'
    let Exporter: new (config: { url: string }) => unknown
    if (protocol === 'http') {
        Exporter = require('@opentelemetry/exporter-trace-otlp-http').OTLPTraceExporter
    } else if (protocol === 'grpc') {
        Exporter = require('@opentelemetry/exporter-trace-otlp-grpc').OTLPTraceExporter
    } else if (protocol === 'proto') {
        Exporter = require('@opentelemetry/exporter-trace-otlp-proto').OTLPTraceExporter
    } else {
        logger.error('CUTTLELY_OTEL_TRACES_PROTOCOL must be http, grpc, or proto. Run traces stay off.')
        return
    }

    try {
        ensureContextManager()
        const { Resource } = require('@opentelemetry/resources')
        const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions')
        const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
        const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base')
        const exporter = new Exporter({ url: endpoint })
        const resource = new Resource({
            [ATTR_SERVICE_NAME]: process.env.METRICS_SERVICE_NAME || 'cuttlely',
            [ATTR_SERVICE_VERSION]: serviceVersion()
        })
        const next = new NodeTracerProvider({ resource })
        next.addSpanProcessor(new BatchSpanProcessor(exporter))
        // Do not call register(). That claims the process-wide tracer, and a later analytics
        // callback would export its spans, including prompts, through this processor.
        // Spans below are created with provider.getTracer, so they still export.
        provider = next
        installed = true
        setCuttlelyTracer(() => provider.getTracer('cuttlely'))
        logger.info(`Run traces: sending with ${protocol}.`)
    } catch (error) {
        installed = false
        provider = undefined
        logger.error(`Run traces could not start (${error instanceof Error ? error.name : 'error'}). Run traces stay off.`)
    }
}

export async function flushCuttlelyTraces(): Promise<void> {
    try {
        await provider?.forceFlush?.()
    } catch {
        // The collector can be down. The run already finished.
    }
}

export async function shutdownCuttlelyTraces(): Promise<void> {
    const current = provider
    provider = undefined
    installed = false
    setCuttlelyTracer(undefined)
    try {
        await current?.shutdown?.()
    } catch {
        // A second shutdown is not a failed run.
    }
}

function plainAttributes(attributes: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
    const plain: Record<string, string | number | boolean> = {}
    if (!attributes) return plain
    for (const [key, value] of Object.entries(attributes)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') plain[key] = value
    }
    return plain
}

/** Test hook. Does not read CUTTLELY_OTEL_TRACES_ENDPOINT and does not register a global provider. */
export function installInMemoryTraces(): { spans: () => FinishedTraceSpan[]; reset: () => void } {
    ensureContextManager()
    const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
    const exporter = new InMemorySpanExporter()
    const memory = new BasicTracerProvider()
    memory.addSpanProcessor(new SimpleSpanProcessor(exporter))
    provider = memory
    installed = true
    setCuttlelyTracer(() => provider.getTracer('cuttlely'))
    return {
        spans: () =>
            exporter
                .getFinishedSpans()
                .map(
                    (span: {
                        name: string
                        parentSpanId?: string
                        attributes: Record<string, unknown>
                        spanContext: () => { spanId: string; traceId: string }
                    }) => ({
                        name: span.name,
                        traceId: span.spanContext().traceId,
                        spanId: span.spanContext().spanId,
                        parentSpanId: span.parentSpanId,
                        attributes: plainAttributes(span.attributes)
                    })
                ),
        reset: () => exporter.reset()
    }
}

function copyFlow(span: SpanLike): void {
    const parent = api().trace.getActiveSpan()
    const attributes = parent?.attributes
    if (!attributes) return
    if (typeof attributes['flow.id'] === 'string') span.setAttribute('flow.id', attributes['flow.id'])
    if (typeof attributes['flow.kind'] === 'string') span.setAttribute('flow.kind', attributes['flow.kind'])
}

function endOk(span: SpanLike | undefined): void {
    if (!span) return
    span.setAttribute('status', 'ok')
    span.setStatus({ code: api().SpanStatusCode.OK })
    span.end()
}

function endPending(span: SpanLike | undefined): void {
    if (!span) return
    span.setAttribute('status', 'pending')
    span.end()
}

function endError(span: SpanLike | undefined, error: unknown): void {
    if (!span) return
    const message = error instanceof Error ? error.message : String(error)
    span.setAttribute('status', 'error')
    span.setAttribute('error', message)
    span.setStatus({ code: api().SpanStatusCode.ERROR, message })
    span.end()
}

const TRACE_ID = /^[0-9a-f]{32}$/i
const SPAN_ID = /^[0-9a-f]{16}$/i

interface TraceParent {
    traceId: string
    spanId: string
}

/** Waiting-run trace, keyed by flow, chat and action id. Not part of the action sent to the client. */
const traceParents = new Map<string, TraceParent>()

function continuationKey(flowId: string, chatId: string, actionId: string): string {
    return `${flowId}\n${chatId}\n${actionId}`
}

function activeTraceParent(): TraceParent | undefined {
    const span = api().trace.getActiveSpan() as { spanContext?: () => { traceId?: string; spanId?: string } } | undefined
    const current = span?.spanContext?.()
    if (!current?.traceId || !current.spanId) return undefined
    if (!TRACE_ID.test(current.traceId) || !SPAN_ID.test(current.spanId)) return undefined
    return { traceId: current.traceId.toLowerCase(), spanId: current.spanId.toLowerCase() }
}

/**
 * Remember the active run for an approval that was just stored.
 * The ids stay here. They are not written onto the action.
 */
export function rememberTraceContinuation(flowId: string, chatId: string, actionId: string): void {
    if (!tracesRequested() || !installed) return
    if (!flowId || !chatId || !actionId) return
    const parent = activeTraceParent()
    if (!parent) return
    traceParents.set(continuationKey(flowId, chatId, actionId), parent)
}

/** The parent recorded for this stored approval. A request cannot supply one. */
export function traceContinuationFor(flowId: string, chatId: string, actionId: string): TraceParent | undefined {
    if (!flowId || !chatId || !actionId) return undefined
    return traceParents.get(continuationKey(flowId, chatId, actionId))
}

function continuedContext(continuedFrom?: { traceId: string; spanId: string }): unknown {
    const otel = require('@opentelemetry/api')
    if (!continuedFrom) return otel.context.active()
    return otel.trace.setSpanContext(otel.ROOT_CONTEXT, {
        traceId: continuedFrom.traceId,
        spanId: continuedFrom.spanId,
        traceFlags: otel.TraceFlags.SAMPLED,
        isRemote: true
    })
}

export async function traceFlow<T>(
    kind: 'agentflow' | 'chatflow',
    flowId: string,
    fn: () => Promise<T>,
    continuedFrom?: { traceId: string; spanId: string }
): Promise<T> {
    if (!tracesRequested()) return fn()
    registerCuttlelyTraces()
    if (!installed || !provider) return await fn()
    const { context, trace, SpanStatusCode } = api()
    const span = provider
        .getTracer('cuttlely')
        .startSpan(kind === 'agentflow' ? 'agentflow.run' : 'chatflow.prediction', {}, continuedContext(continuedFrom))
    span.setAttribute('flow.id', flowId)
    span.setAttribute('flow.kind', kind)
    const ctx = trace.setSpan(context.active(), span)
    try {
        const result = await context.with(ctx, fn)
        if (failedSpans.has(span)) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(span.attributes?.error ?? 'error') })
        } else {
            span.setAttribute('status', 'ok')
            span.setStatus({ code: SpanStatusCode.OK })
        }
        span.end()
        return result
    } catch (error) {
        endError(span, error)
        throw error
    }
}

export async function traceChatflowPrediction<T>(
    replay: boolean,
    flowId: string,
    question: () => unknown,
    fn: () => Promise<T>,
    continuedFrom?: { traceId: string; spanId: string }
): Promise<T> {
    if (replay) return silenceRunTraces(fn)
    if (!tracesRequested()) return fn()
    return traceFlow(
        'chatflow',
        flowId,
        async () => {
            const result = await fn()
            noteFlowOutcome(question(), (result as { text?: unknown } | undefined)?.text)
            return result
        },
        continuedFrom
    )
}

export function noteFlowOutcome(input: unknown, output: unknown, status?: string): void {
    if (!tracesRequested() || !installed) return
    const span = api().trace.getActiveSpan()
    if (!span) return
    if (status === 'ERROR' || status === 'TERMINATED') {
        span.setAttribute('status', 'error')
        span.setAttribute('error', status)
        failedSpans.add(span)
    }
    writeContent(span, input, output)
}

export async function withNodeSpan<T>(nodeId: string, nodeType: string, fn: () => Promise<T>): Promise<T> {
    if (!tracesRequested() || !installed) return fn()
    const { context, trace, SpanStatusCode } = api()
    const span = provider.getTracer('cuttlely').startSpan('node', {}, context.active())
    span.setAttribute('node.id', nodeId)
    span.setAttribute('node.type', nodeType)
    copyFlow(span)
    const ctx = trace.setSpan(context.active(), span)
    try {
        const value = await context.with(ctx, fn)
        span.setAttribute('status', 'ok')
        span.setStatus({ code: SpanStatusCode.OK })
        span.end()
        return value
    } catch (error) {
        endError(span, error)
        throw error
    }
}

function openChild(name: string, nodeId: string, nodeType: string, extra: Record<string, string | undefined>): SpanLike | undefined {
    if (!installed || !provider) return undefined
    const span = provider.getTracer('cuttlely').startSpan(name, {}, api().context.active())
    span.setAttribute('node.id', nodeId)
    span.setAttribute('node.type', nodeType)
    copyFlow(span)
    for (const [key, value] of Object.entries(extra)) {
        if (value) span.setAttribute(key, value)
    }
    return span
}

export function modelNameFromInputs(inputs: Record<string, unknown> | undefined): string | undefined {
    if (!inputs) return undefined
    const configs = [inputs.llmModelConfig, inputs.agentModelConfig, inputs.conditionAgentModelConfig]
    for (const config of configs) {
        if (!config || typeof config !== 'object') continue
        const record = config as Record<string, unknown>
        const name = record.modelName ?? record.model
        if (typeof name === 'string' && name) return name
    }
    return undefined
}

function toolNameFromInputs(inputs: Record<string, unknown> | undefined): string {
    const selected = inputs?.toolAgentflowSelectedTool ?? inputs?.selectedTool
    if (typeof selected === 'string' && selected) return selected
    if (selected && typeof selected === 'object') {
        const name = (selected as { name?: unknown }).name
        if (typeof name === 'string' && name) return name
    }
    return 'tool'
}

function usageOf(result: unknown): { input?: number; output?: number } | undefined {
    const output = (result as { output?: { usageMetadata?: Record<string, unknown> }; usageMetadata?: Record<string, unknown> } | undefined)
        ?.output
    const usage = output?.usageMetadata ?? (result as { usageMetadata?: Record<string, unknown> } | undefined)?.usageMetadata
    if (!usage) return undefined
    const input = tokenCount(usage.input_tokens ?? usage.promptTokens)
    const outputTokens = tokenCount(usage.output_tokens ?? usage.completionTokens)
    if (input === undefined && outputTokens === undefined) return undefined
    return { input, output: outputTokens }
}

function finishModel(span: SpanLike | undefined, result: unknown): void {
    if (!span) return
    const usage = usageOf(result)
    if (usage?.input !== undefined) span.setAttribute('tokens.input', usage.input)
    if (usage?.output !== undefined) span.setAttribute('tokens.output', usage.output)
    const output = (result as { output?: { content?: unknown }; input?: unknown } | undefined)?.output
    const input = (result as { input?: unknown } | undefined)?.input
    writeContent(span, input, output?.content)
    endOk(span)
}

function finishTool(span: SpanLike | undefined, result: unknown): void {
    if (!span) return
    const output = (result as { output?: { content?: unknown }; input?: unknown } | undefined)?.output
    writeContent(span, (result as { input?: unknown } | undefined)?.input, output?.content)
    endOk(span)
}

function recordLateModel(result: unknown, nodeId: string, nodeType: string, inputs: Record<string, unknown> | undefined): void {
    const usage = usageOf(result)
    if (!usage) return
    const span = openChild('model', nodeId, nodeType, { 'model.name': modelNameFromInputs(inputs) })
    finishModel(span, result)
}

function executedToolName(record: { tool?: unknown; name?: unknown } | undefined): string {
    if (typeof record?.tool === 'string' && record.tool) return record.tool
    if (typeof record?.name === 'string' && record.name) return record.name
    return 'tool'
}

function toolCallId(record: { id?: unknown } | undefined): string | undefined {
    return typeof record?.id === 'string' && record.id ? record.id : undefined
}

function toolSpanAttrs(name: string, id?: string): Record<string, string | undefined> {
    return { 'tool.name': name, ...(id ? { 'tool.id': id } : {}) }
}

function recordLateTools(result: unknown, nodeId: string, nodeType: string): void {
    const output = (result as { output?: { usedTools?: unknown; calledTools?: unknown } } | undefined)?.output
    const used = Array.isArray(output?.usedTools) ? output.usedTools : []
    const called = Array.isArray(output?.calledTools) ? output.calledTools : []
    const ranIds = new Set<string>()
    const namelessRan = new Map<string, number>()
    for (const tool of used) {
        const record = tool as { tool?: unknown; name?: unknown; id?: unknown; error?: unknown; toolInput?: unknown; toolOutput?: unknown }
        const name = executedToolName(record)
        const id = toolCallId(record)
        if (id) ranIds.add(id)
        else namelessRan.set(name, (namelessRan.get(name) || 0) + 1)
        const span = openChild('tool', nodeId, nodeType, toolSpanAttrs(name, id))
        if (!span) continue
        if (record?.error) {
            endError(span, record.error)
            continue
        }
        writeContent(span, record?.toolInput, record?.toolOutput)
        endOk(span)
    }
    // calledTools is the model's request list. Match a request to a run by tool-call id.
    // The same tool name can run once and then be requested again while it waits for approval.
    for (const tool of called) {
        const record = tool as { name?: unknown; id?: unknown }
        const name = executedToolName(record)
        const id = toolCallId(record)
        if (id) {
            if (ranIds.has(id)) continue
        } else {
            const left = namelessRan.get(name) || 0
            if (left > 0) {
                namelessRan.set(name, left - 1)
                continue
            }
        }
        endPending(openChild('tool', nodeId, nodeType, toolSpanAttrs(name, id)))
    }
}

function wholeCount(value: unknown): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    if (!Number.isFinite(n) || n <= 0) return 0
    return Math.min(Math.round(n), Number.MAX_SAFE_INTEGER)
}

function cleanTraceModel(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const text = value.replace(/\s+/g, ' ').trim().slice(0, 255)
    if (!text || /sk-|api[_-]?key|bearer\s|secret|password/i.test(text)) return undefined
    return text
}

/**
 * Token counts a usage record stores for one model callback.
 * Message usage comes first, then the callback's tokenUsage. A call that reports nothing is left out.
 */
function reportedModelUsage(output: unknown, modelHint?: string): { model?: string; input: number; output: number } | undefined {
    if (!output || typeof output !== 'object') return undefined
    const record = output as {
        generations?: Array<
            Array<{
                message?: { usage_metadata?: Record<string, unknown>; response_metadata?: Record<string, unknown> }
            }>
        >
        llmOutput?: { tokenUsage?: Record<string, unknown>; model?: unknown }
    }
    const message = record.generations?.[0]?.[0]?.message
    const meta = message?.usage_metadata
    const tokenUsage = record.llmOutput?.tokenUsage
    const responseModel = message?.response_metadata?.model_name ?? message?.response_metadata?.model ?? record.llmOutput?.model
    const model = cleanTraceModel(modelHint) ?? cleanTraceModel(responseModel)
    let input = 0
    let outputTokens = 0
    if (meta && (meta.input_tokens != null || meta.output_tokens != null || meta.prompt_tokens != null)) {
        input = wholeCount(meta.input_tokens ?? meta.prompt_tokens)
        outputTokens = wholeCount(meta.output_tokens ?? meta.completion_tokens)
    } else if (tokenUsage) {
        input = wholeCount(tokenUsage.promptTokens ?? tokenUsage.input_tokens)
        outputTokens = wholeCount(tokenUsage.completionTokens ?? tokenUsage.output_tokens)
    } else {
        return undefined
    }
    if (input === 0 && outputTokens === 0) return undefined
    return { model, input, output: outputTokens }
}

function modelHintOf(llm: unknown): string | undefined {
    const kwargs = (llm as { kwargs?: Record<string, unknown> } | undefined)?.kwargs
    return cleanTraceModel(kwargs?.modelName ?? kwargs?.model_name ?? kwargs?.model)
}

interface GraphModelCall {
    runId: string
    model?: string
    input: number
    output: number
    error?: unknown
    done: boolean
    inputText?: unknown
    outputText?: unknown
}

interface GraphToolCall {
    runId: string
    name: string
    id?: string
    error?: unknown
    done: boolean
    inputText?: unknown
    outputText?: unknown
}

function stepCollector(bucket: { models: GraphModelCall[]; tools: GraphToolCall[] }) {
    const models = new Map<string, GraphModelCall>()
    const tools = new Map<string, GraphToolCall>()
    const content = process.env.CUTTLELY_OTEL_TRACES_CONTENT === 'true'
    const sync = () => {
        bucket.models = [...models.values()]
        bucket.tools = [...tools.values()]
    }
    return {
        name: 'cuttlely_graph_step',
        handleLLMStart(llm: unknown, prompts: unknown, runId: string) {
            if (!runId || models.has(runId)) return
            models.set(runId, {
                runId,
                model: modelHintOf(llm),
                input: 0,
                output: 0,
                done: false,
                inputText: content ? prompts : undefined
            })
            sync()
        },
        handleChatModelStart(llm: unknown, messages: unknown, runId: string) {
            this.handleLLMStart(llm, messages, runId)
        },
        async handleLLMEnd(output: unknown, runId: string) {
            if (!runId || models.get(runId)?.done) return
            const row = models.get(runId) ?? { runId, input: 0, output: 0, done: false }
            const usage = reportedModelUsage(output, row.model)
            if (usage) {
                row.input = usage.input
                row.output = usage.output
                if (usage.model) row.model = usage.model
            }
            if (content) {
                const generation = (
                    output as { generations?: Array<Array<{ text?: unknown; message?: { content?: unknown } }>> } | undefined
                )?.generations?.[0]?.[0]
                row.outputText = generation?.text ?? generation?.message?.content
            }
            row.done = true
            models.set(runId, row)
            sync()
        },
        async handleLLMError(error: unknown, runId: string) {
            if (!runId || models.get(runId)?.done) return
            const row = models.get(runId) ?? { runId, input: 0, output: 0, done: false }
            row.error = error
            row.done = true
            models.set(runId, row)
            sync()
        },
        async handleToolStart(
            tool: { name?: string; id?: string[] },
            input: unknown,
            runId: string,
            _parent?: string,
            _tags?: string[],
            metadata?: Record<string, unknown>
        ) {
            if (!runId || tools.has(runId)) return
            const metaId = metadata?.tool_call_id ?? metadata?.toolCallId
            const name = tool?.name || (Array.isArray(tool?.id) ? String(tool.id[tool.id.length - 1]) : '') || 'tool'
            tools.set(runId, {
                runId,
                name: String(name),
                id: typeof metaId === 'string' && metaId ? metaId : undefined,
                done: false,
                inputText: content ? input : undefined
            })
            sync()
        },
        async handleToolEnd(output: unknown, runId: string) {
            const row = tools.get(runId)
            if (!row || row.done) return
            row.done = true
            if (content) row.outputText = output
            sync()
        },
        async handleToolError(error: unknown, runId: string) {
            const row = tools.get(runId)
            if (!row || row.done) return
            row.error = error
            row.done = true
            sync()
        }
    }
}

function messageList(result: unknown): Array<Record<string, any>> {
    if (!result || typeof result !== 'object') return []
    const messages = (result as { messages?: unknown }).messages
    return Array.isArray(messages) ? messages : []
}

function usedToolRows(messages: Array<Record<string, any>>): GraphToolCall[] {
    const rows: GraphToolCall[] = []
    for (const message of messages) {
        const used = message?.additional_kwargs?.usedTools
        const list = Array.isArray(used) ? used.flat() : []
        for (const tool of list) {
            if (!tool || typeof tool !== 'object') continue
            const name = typeof tool.tool === 'string' && tool.tool ? tool.tool : typeof tool.name === 'string' ? tool.name : ''
            if (!name) continue
            rows.push({
                runId: typeof tool.id === 'string' && tool.id ? tool.id : name,
                name,
                id: typeof tool.id === 'string' && tool.id ? tool.id : undefined,
                error: tool.error,
                done: !tool.error
            })
        }
    }
    return rows
}

function requestedToolCalls(messages: Array<Record<string, any>>): Array<{ name: string; id?: string }> {
    const rows: Array<{ name: string; id?: string }> = []
    for (const message of messages) {
        const calls = message?.tool_calls
        if (!Array.isArray(calls)) continue
        for (const call of calls) {
            if (!call || typeof call.name !== 'string' || !call.name) continue
            rows.push({ name: call.name, id: typeof call.id === 'string' && call.id ? call.id : undefined })
        }
    }
    return rows
}

function fillToolIds(tools: GraphToolCall[], donors: Array<{ name: string; id?: string }>): void {
    const pool = donors.filter((donor) => donor.id)
    for (const tool of tools) {
        if (tool.id) continue
        const index = pool.findIndex((donor) => donor.name === tool.name && donor.id)
        if (index < 0) continue
        tool.id = pool[index].id
        pool.splice(index, 1)
    }
}

function pendingToolCalls(calls: Array<{ name: string; id?: string }>, ran: GraphToolCall[]): Array<{ name: string; id?: string }> {
    const ranIds = new Set(ran.map((tool) => tool.id).filter((id): id is string => Boolean(id)))
    const nameless = new Map<string, number>()
    for (const tool of ran) {
        if (tool.id) continue
        nameless.set(tool.name, (nameless.get(tool.name) || 0) + 1)
    }
    const pending: Array<{ name: string; id?: string }> = []
    for (const call of calls) {
        if (call.id) {
            if (ranIds.has(call.id)) continue
            pending.push(call)
            continue
        }
        const left = nameless.get(call.name) || 0
        if (left > 0) {
            nameless.set(call.name, left - 1)
            continue
        }
        pending.push(call)
    }
    return pending
}

function emitGraphStep(
    nodeId: string,
    nodeType: string,
    bucket: { models: GraphModelCall[]; tools: GraphToolCall[] },
    result: unknown
): void {
    const messages = messageList(result)
    // usedTools on a message can be a copy of a tool an earlier step already ran. Only this step's callbacks are spans.
    fillToolIds(bucket.tools, [...requestedToolCalls(messages), ...usedToolRows(messages)])
    for (const call of bucket.models) {
        if (!call.error && call.input === 0 && call.output === 0) continue
        const span = openChild('model', nodeId, nodeType, { 'model.name': call.model })
        if (!span) continue
        if (call.input || call.output) {
            span.setAttribute('tokens.input', call.input)
            span.setAttribute('tokens.output', call.output)
        }
        writeContent(span, call.inputText, call.outputText)
        if (call.error) endError(span, call.error)
        else endOk(span)
    }
    const ran = bucket.tools.filter((tool) => tool.done || tool.error)
    for (const tool of ran) {
        const span = openChild('tool', nodeId, nodeType, { 'tool.name': tool.name, ...(tool.id ? { 'tool.id': tool.id } : {}) })
        if (!span) continue
        writeContent(span, tool.inputText, tool.outputText)
        if (tool.error) endError(span, tool.error)
        else endOk(span)
    }
    for (const call of pendingToolCalls(requestedToolCalls(messages), ran)) {
        endPending(openChild('tool', nodeId, nodeType, { 'tool.name': call.name, ...(call.id ? { 'tool.id': call.id } : {}) }))
    }
}

function attachCollector(config: unknown, collector: object): unknown {
    const record = config && typeof config === 'object' ? (config as { callbacks?: unknown }) : undefined
    const callbacks = record?.callbacks
    if (callbacks && typeof callbacks === 'object' && Array.isArray((callbacks as { handlers?: unknown }).handlers)) {
        ;(callbacks as { handlers: object[] }).handlers.push(collector)
        return config
    }
    if (Array.isArray(callbacks)) return { ...(record ?? {}), callbacks: [...callbacks, collector] }
    return { ...(record ?? {}), callbacks: [collector] }
}

function detachCollector(config: unknown, collector: object): void {
    const callbacks = (config as { callbacks?: { handlers?: object[] } } | undefined)?.callbacks
    const handlers = callbacks?.handlers
    if (!Array.isArray(handlers)) return
    const index = handlers.lastIndexOf(collector)
    if (index >= 0) handlers.splice(index, 1)
}

async function traceNodeBody(
    nodeId: string,
    nodeType: string,
    run: (config: unknown) => Promise<unknown>,
    config: unknown
): Promise<unknown> {
    if (!tracesRequested() || !installed) return run(config)
    const bucket = { models: [] as GraphModelCall[], tools: [] as GraphToolCall[] }
    const collector = stepCollector(bucket)
    const next = attachCollector(config, collector)
    try {
        return await withNodeSpan(nodeId, nodeType, async () => {
            try {
                const result = await run(next)
                emitGraphStep(nodeId, nodeType, bucket, result)
                return result
            } catch (error) {
                emitGraphStep(nodeId, nodeType, bucket, undefined)
                throw error
            }
        })
    } finally {
        detachCollector(next, collector)
    }
}

/**
 * Wraps one graph node so its model and tool calls are children of a node span.
 * When traces are off the action is returned unchanged: no wrapper and no collector.
 */
export function traceGraphNode(nodeId: string, nodeType: string, action: unknown): unknown {
    if (process.env.CUTTLELY_OTEL_TRACES !== 'true') return action
    if (typeof action === 'function') {
        return (state: unknown, config: unknown) => traceNodeBody(nodeId, nodeType, (next) => action(state, next), config)
    }
    if (action && typeof action === 'object' && typeof (action as { invoke?: unknown }).invoke === 'function') {
        const runnable = action as { invoke: (input: unknown, config?: unknown) => Promise<unknown>; __cuttlelyTraced?: boolean }
        if (runnable.__cuttlelyTraced) return action
        const original = runnable.invoke.bind(runnable)
        runnable.__cuttlelyTraced = true
        runnable.invoke = (input: unknown, config?: unknown) => traceNodeBody(nodeId, nodeType, (next) => original(input, next), config)
        return action
    }
    return action
}

/**
 * One node span, plus a model span and a tool span when this node calls them.
 * When traces are off this returns fn() after one environment check.
 */
export async function tracedNode<T>(
    nodeId: string,
    nodeType: string,
    inputs: Record<string, unknown> | undefined,
    fn: () => Promise<T>
): Promise<T> {
    if (!tracesRequested()) return fn()
    return withNodeSpan(nodeId, nodeType, async () => {
        const modelSpan = MODEL_NODES.has(nodeType)
            ? openChild('model', nodeId, nodeType, { 'model.name': modelNameFromInputs(inputs) })
            : undefined
        const toolSpan =
            nodeType === 'toolAgentflow' ? openChild('tool', nodeId, nodeType, { 'tool.name': toolNameFromInputs(inputs) }) : undefined
        try {
            const result = await fn()
            finishModel(modelSpan, result)
            if (!modelSpan) recordLateModel(result, nodeId, nodeType, inputs)
            finishTool(toolSpan, result)
            if (!toolSpan) recordLateTools(result, nodeId, nodeType)
            return result
        } catch (error) {
            const failure = error as { usedTools?: unknown; usageMetadata?: unknown }
            if (modelSpan && failure?.usageMetadata) {
                const usage = usageOf({ usageMetadata: failure.usageMetadata })
                if (usage?.input !== undefined) modelSpan.setAttribute('tokens.input', usage.input)
                if (usage?.output !== undefined) modelSpan.setAttribute('tokens.output', usage.output)
            }
            if (!toolSpan && failure?.usedTools) recordLateTools({ output: { usedTools: failure.usedTools } }, nodeId, nodeType)
            endError(modelSpan, error)
            endError(toolSpan, error)
            throw error
        }
    })
}
