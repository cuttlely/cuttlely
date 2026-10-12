/**
 * Run traces: an in-memory exporter checks the span tree for one agentflow and one chatflow.
 * Traces are off unless CUTTLELY_OTEL_TRACES=true, and a disabled run exports nothing.
 */
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { executeAgentFlow } from '../utils/buildAgentflow'
import { executeFlow } from '../utils/buildChatflow'
import {
    flushCuttlelyTraces,
    installInMemoryTraces,
    registerCuttlelyTraces,
    shutdownCuttlelyTraces,
    traceFlow,
    tracesInstalled,
    type FinishedTraceSpan
} from './tracing'

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() }
}))

const TRACE_ENV = ['CUTTLELY_OTEL_TRACES', 'CUTTLELY_OTEL_TRACES_ENDPOINT', 'CUTTLELY_OTEL_TRACES_PROTOCOL', 'CUTTLELY_OTEL_TRACES_CONTENT']

function clearTraceEnv(): void {
    for (const key of TRACE_ENV) delete process.env[key]
}

function contentKeys(spans: FinishedTraceSpan[]): string[] {
    return spans.flatMap((span) => Object.keys(span.attributes).filter((key) => key.startsWith('content.')))
}

function children(spans: FinishedTraceSpan[], parentId: string | undefined): FinishedTraceSpan[] {
    return spans.filter((span) => (parentId ? span.parentSpanId === parentId : !span.parentSpanId))
}

describe('registerCuttlelyTraces', () => {
    afterEach(() => {
        clearTraceEnv()
    })

    it('does not register a provider when traces are off or the endpoint is missing', () => {
        expect(tracesInstalled()).toBe(false)
        registerCuttlelyTraces()
        expect(tracesInstalled()).toBe(false)

        process.env.CUTTLELY_OTEL_TRACES = 'true'
        registerCuttlelyTraces()
        expect(tracesInstalled()).toBe(false)
    })
})

describe('run trace spans', () => {
    let dir: string
    let memory: { spans: () => FinishedTraceSpan[]; reset: () => void }
    let agentNodes: Record<string, { filePath: string }>
    let chatNodes: Record<string, { filePath: string }>

    beforeAll(() => {
        memory = installInMemoryTraces()
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-traces-'))
        const write = (name: string, body: string) => {
            const file = path.join(dir, `${name}.js`)
            fs.writeFileSync(file, body)
            return { filePath: file }
        }
        const step = (body: string) => `exports.nodeClass = class { async run(nodeData, input, options) { ${body} } }\n`
        agentNodes = {
            startAgentflow: write(
                'start',
                step(`return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } }`)
            ),
            llmAgentflow: write(
                'llm',
                step(
                    `return { id: nodeData.id, name: 'llmAgentflow', input: { question: input }, output: { content: 'Fresh bread at 7', usageMetadata: { input_tokens: 12, output_tokens: 9 } } }`
                )
            ),
            toolAgentflow: write(
                'tool',
                step(
                    `return { id: nodeData.id, name: 'toolAgentflow', input: { toolAgentflowSelectedTool: 'oven' }, output: { content: '350F', usedTools: [{ tool: 'oven', toolInput: 'heat', toolOutput: '350F' }] } }`
                )
            )
        }
        const chatClass = (run: string) =>
            `exports.nodeClass = class { constructor() {} async init() { return {} } async run(nodeData, input, options) { ${run} } }\n`
        chatNodes = {
            chatOpenAI: write('chat-model', chatClass(`return {}`)),
            llmChain: write(
                'llm-chain',
                chatClass(`
                    const { additionalCallbacks } = require('@cuttlely/components')
                    const callbacks = await additionalCallbacks(nodeData, options)
                    const handler = callbacks[0]
                    if (!handler) return { text: 'At 7.' }
                    await handler.handleLLMStart({ kwargs: { modelName: 'gpt-4o-mini' } }, ['When is the sourdough ready?'], 'model-1')
                    await handler.handleLLMEnd({
                        generations: [[{ text: 'At 7.' }]],
                        llmOutput: { tokenUsage: { promptTokens: 11, completionTokens: 4 } }
                    }, 'model-1')
                    await handler.handleToolStart({ name: 'calculator' }, '2+2', 'tool-1')
                    await handler.handleToolEnd('4', 'tool-1')
                    return { text: 'At 7.' }
                `)
            )
        }
    })

    afterAll(async () => {
        clearTraceEnv()
        await shutdownCuttlelyTraces()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    beforeEach(() => {
        clearTraceEnv()
        memory.reset()
    })

    function recordingDataSource() {
        const saved: Record<string, any> = {}
        const repo = (entity: any) => {
            const table = typeof entity === 'function' ? entity.name : String(entity)
            return {
                find: async () => [],
                findBy: async () => [],
                findOne: async () => saved[table] ?? null,
                findOneBy: async () => saved[table] ?? null,
                create: (value: unknown) => value,
                save: async (value: Record<string, unknown>) => {
                    saved[table] = { id: `${table}-1`, ...value }
                    return saved[table]
                },
                merge: (target: any, value: any) => Object.assign(target, value),
                update: async () => ({ affected: 1 }),
                createQueryBuilder: () => {
                    const qb: any = { where: () => qb, orWhere: () => qb, orderBy: () => qb, getMany: async () => [] }
                    return qb
                }
            }
        }
        return { getRepository: repo }
    }

    const agentNode = (id: string, name: string, label: string, inputs: Record<string, unknown>) => ({
        id,
        type: 'agentFlow',
        position: { x: 0, y: 0 },
        data: { id, name, label, inputs, inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {} }
    })

    async function runAgent(enabled = true) {
        if (enabled) process.env.CUTTLELY_OTEL_TRACES = 'true'
        else delete process.env.CUTTLELY_OTEL_TRACES
        const flowData = JSON.stringify({
            nodes: [
                agentNode('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'chatInput' }),
                agentNode('llmAgentflow_0', 'llmAgentflow', 'Bakery helper', { llmModelConfig: { modelName: 'gpt-4o-mini' } }),
                agentNode('toolAgentflow_0', 'toolAgentflow', 'Oven', { toolAgentflowSelectedTool: 'oven' })
            ],
            edges: [
                { id: 'e1', source: 'startAgentflow_0', target: 'llmAgentflow_0' },
                { id: 'e2', source: 'llmAgentflow_0', target: 'toolAgentflow_0' }
            ]
        })
        return executeAgentFlow({
            componentNodes: agentNodes,
            incomingInput: { question: 'When is the sourdough ready?', streaming: false },
            chatflow: {
                id: 'b7c1a6f2-1d9e-4a51-9a7e-3f1f0c2d4e5a',
                name: 'Bakery helper',
                type: 'AGENTFLOW',
                flowData,
                workspaceId: 'ws-1'
            },
            chatId: 'c0ffee00-0000-4000-8000-000000000001',
            appDataSource: recordingDataSource(),
            telemetry: { sendTelemetry: jest.fn() },
            usageCacheManager: {},
            cachePool: {},
            sseStreamer: new Proxy({}, { get: () => () => undefined }),
            baseURL: 'http://127.0.0.1',
            isInternal: true,
            orgId: 'org-1',
            workspaceId: 'ws-1',
            subscriptionId: 'sub-1',
            productId: 'prod-1',
            replay: false
        } as any)
    }

    const chatNode = (id: string, name: string, category: string) => ({
        id,
        type: 'customNode',
        position: { x: 0, y: 0 },
        data: {
            id,
            name,
            label: name,
            category,
            inputs: {},
            inputParams: [],
            inputAnchors: [],
            outputAnchors: [],
            outputs: {}
        }
    })

    async function runChat(enabled = true) {
        if (enabled) process.env.CUTTLELY_OTEL_TRACES = 'true'
        else delete process.env.CUTTLELY_OTEL_TRACES
        const flowData = JSON.stringify({
            nodes: [chatNode('chatOpenAI_0', 'chatOpenAI', 'Chat Models'), chatNode('llmChain_0', 'llmChain', 'Chains')],
            edges: [{ id: 'e1', source: 'chatOpenAI_0', target: 'llmChain_0' }]
        })
        return executeFlow({
            componentNodes: chatNodes,
            incomingInput: { question: 'When is the sourdough ready?', streaming: false },
            chatflow: { id: 'a1b2c3d4-e5f6-4789-a012-3456789abcde', name: 'Bakery chat', type: 'CHATFLOW', flowData, workspaceId: 'ws-1' },
            chatId: 'c0ffee00-0000-4000-8000-000000000002',
            appDataSource: recordingDataSource(),
            telemetry: { sendTelemetry: jest.fn() },
            cachePool: {},
            usageCacheManager: {},
            sseStreamer: undefined,
            baseURL: 'http://127.0.0.1',
            isInternal: true,
            orgId: 'org-1',
            workspaceId: 'ws-1',
            subscriptionId: 'sub-1',
            productId: 'prod-1'
        } as any)
    }

    it('exports an agentflow tree with token counts and no content', async () => {
        await runAgent()
        const spans = memory.spans()
        const root = spans.find((span) => span.name === 'agentflow.run')
        expect(root).toBeDefined()
        expect(root?.attributes['flow.id']).toBe('b7c1a6f2-1d9e-4a51-9a7e-3f1f0c2d4e5a')
        expect(root?.attributes['flow.kind']).toBe('agentflow')
        expect(root?.attributes['status']).toBe('ok')

        const nodes = children(spans, root?.spanId).filter((span) => span.name === 'node')
        expect(nodes.map((span) => span.attributes['node.type'])).toEqual(['startAgentflow', 'llmAgentflow', 'toolAgentflow'])

        const modelNode = nodes.find((span) => span.attributes['node.type'] === 'llmAgentflow')
        const model = children(spans, modelNode?.spanId).find((span) => span.name === 'model')
        expect(model?.attributes['model.name']).toBe('gpt-4o-mini')
        expect(model?.attributes['tokens.input']).toBe(12)
        expect(model?.attributes['tokens.output']).toBe(9)
        expect(model?.attributes['node.id']).toBe('llmAgentflow_0')

        const toolNode = nodes.find((span) => span.attributes['node.type'] === 'toolAgentflow')
        const tool = children(spans, toolNode?.spanId).find((span) => span.name === 'tool')
        expect(tool?.attributes['tool.name']).toBe('oven')
        expect(contentKeys(spans)).toEqual([])
    })

    it('exports a chatflow tree with token counts and no content', async () => {
        const result = await runChat()
        expect(result.text).toBe('At 7.')
        const spans = memory.spans()
        const root = spans.find((span) => span.name === 'chatflow.prediction')
        expect(root?.attributes['flow.kind']).toBe('chatflow')
        expect(root?.attributes['flow.id']).toBe('a1b2c3d4-e5f6-4789-a012-3456789abcde')
        expect(root?.attributes['status']).toBe('ok')

        const nodes = spans.filter((span) => span.name === 'node')
        expect(nodes.map((span) => span.attributes['node.type'])).toEqual(expect.arrayContaining(['chatOpenAI', 'llmChain']))

        const model = spans.find((span) => span.name === 'model')
        expect(model?.attributes['model.name']).toBe('gpt-4o-mini')
        expect(model?.attributes['tokens.input']).toBe(11)
        expect(model?.attributes['tokens.output']).toBe(4)
        const modelParent = spans.find((span) => span.spanId === model?.parentSpanId)
        expect(modelParent?.name).toBe('node')
        expect(modelParent?.attributes['node.type']).toBe('llmChain')

        const tool = spans.find((span) => span.name === 'tool')
        expect(tool?.attributes['tool.name']).toBe('calculator')
        expect(tool?.parentSpanId).toBe(modelParent?.spanId)
        expect(contentKeys(spans)).toEqual([])
    })

    it('adds question and answer text only when content is turned on', async () => {
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'true'
        const result = await runAgent()
        const spans = memory.spans()
        const root = spans.find((span) => span.name === 'agentflow.run')
        expect(root?.attributes['content.input']).toBe('When is the sourdough ready?')
        expect(root?.attributes['content.output']).toBe(result.text)
        const model = spans.find((span) => span.name === 'model')
        expect(model?.attributes['content.output']).toBe('Fresh bread at 7')
    })

    it('exports nothing when traces are disabled', async () => {
        await runAgent(false)
        expect(memory.spans()).toEqual([])
        memory.reset()
        await runChat(false)
        expect(memory.spans()).toEqual([])
    })
})

describe('OTLP HTTP export', () => {
    afterEach(async () => {
        clearTraceEnv()
        await shutdownCuttlelyTraces()
    })

    it('posts a trace to the collector endpoint', async () => {
        const hits = { n: 0 }
        const server = http.createServer((req, res) => {
            hits.n += 1
            req.resume()
            res.writeHead(200)
            res.end()
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        try {
            process.env.CUTTLELY_OTEL_TRACES = 'true'
            process.env.CUTTLELY_OTEL_TRACES_ENDPOINT = `http://127.0.0.1:${port}/v1/traces`
            process.env.CUTTLELY_OTEL_TRACES_PROTOCOL = 'http'
            registerCuttlelyTraces()
            expect(tracesInstalled()).toBe(true)
            await traceFlow('chatflow', 'flow-local', async () => 'ok')
            await flushCuttlelyTraces()
            expect(hits.n).toBeGreaterThan(0)
        } finally {
            await new Promise((resolve) => server.close(resolve))
        }
    })
})
