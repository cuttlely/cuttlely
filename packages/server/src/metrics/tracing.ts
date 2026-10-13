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
        // Publishes this provider as the process tracer. Spans below are created from this
        // provider directly, so a flow analytics provider that registered first does not drop them.
        try {
            next.register()
        } catch {
            // Already registered by another provider. This exporter still receives our spans.
        }
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

export async function traceFlow<T>(kind: 'agentflow' | 'chatflow', flowId: string, fn: () => Promise<T>): Promise<T> {
    if (!tracesRequested()) return fn()
    registerCuttlelyTraces()
    if (!installed || !provider) return await fn()
    const { context, trace, SpanStatusCode } = api()
    const span = provider
        .getTracer('cuttlely')
        .startSpan(kind === 'agentflow' ? 'agentflow.run' : 'chatflow.prediction', {}, context.active())
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
    fn: () => Promise<T>
): Promise<T> {
    if (replay) return silenceRunTraces(fn)
    if (!tracesRequested()) return fn()
    return traceFlow('chatflow', flowId, async () => {
        const result = await fn()
        noteFlowOutcome(question(), (result as { text?: unknown } | undefined)?.text)
        return result
    })
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

function recordLateTools(result: unknown, nodeId: string, nodeType: string): void {
    const output = (result as { output?: { usedTools?: unknown; calledTools?: unknown } } | undefined)?.output
    const used = Array.isArray(output?.usedTools) ? output.usedTools : []
    const called = Array.isArray(output?.calledTools) ? output.calledTools : []
    const ran = new Set<string>()
    for (const tool of used) {
        const record = tool as { tool?: unknown; name?: unknown; error?: unknown; toolInput?: unknown; toolOutput?: unknown }
        const name = executedToolName(record)
        ran.add(name)
        const span = openChild('tool', nodeId, nodeType, { 'tool.name': name })
        if (!span) continue
        if (record?.error) {
            endError(span, record.error)
            continue
        }
        writeContent(span, record?.toolInput, record?.toolOutput)
        endOk(span)
    }
    // calledTools is the model's request list. A tool that did not run (it is waiting for approval) is not a success.
    for (const tool of called) {
        const name = executedToolName(tool as { name?: unknown })
        if (ran.has(name)) continue
        endPending(openChild('tool', nodeId, nodeType, { 'tool.name': name }))
    }
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
