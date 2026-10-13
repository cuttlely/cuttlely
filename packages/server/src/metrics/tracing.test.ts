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
    finishTraceContinuation,
    flushCuttlelyTraces,
    installInMemoryTraces,
    keepPendingToolsForApproval,
    registerCuttlelyTraces,
    rememberTraceContinuation,
    resetHeldToolsForTests,
    setTraceParentClock,
    shutdownCuttlelyTraces,
    TRACE_PARENT_CAP,
    TRACE_PARENT_GRACE_MS,
    TRACE_PARENT_TTL_MS,
    traceContinuationFor,
    traceFlow,
    traceGraphNode,
    tracedNode,
    tracesInstalled,
    withNodeSpan,
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
                    const handler = callbacks.find((item) => item && typeof item.handleToolStart === 'function')
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

    async function runChat(enabled = true, replay = false) {
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
            productId: 'prod-1',
            replay
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

    it('gives overlapping executeAgentFlow runs and a chatflow their own roots', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const agentA = 'b7c1a6f2-1d9e-4a51-9a7e-3f1f0c2d4e5a'
        const agentB = 'c8d2b7a3-2e0f-4b62-8b8f-4a201d3e5f6b'
        const chatId = 'd9e3c8b4-3f10-4c73-9c90-5b312e4f607c'
        const entered = new Set<string>()
        let signalFirst: () => void = () => undefined
        const firstInNode = new Promise<void>((resolve) => {
            signalFirst = resolve
        })
        let release: () => void = () => undefined
        const ready = new Promise<void>((resolve) => {
            release = resolve
        })
        ;(globalThis as { __cuttlelyTraceGate?: { enter: (id: string) => Promise<void> } }).__cuttlelyTraceGate = {
            enter: async (id: string) => {
                entered.add(id)
                if (id === agentA) signalFirst()
                if (entered.size >= 3) release()
                await ready
            }
        }
        const write = (name: string, body: string) => {
            const file = path.join(dir, `${name}.js`)
            fs.writeFileSync(file, body)
            return { filePath: file }
        }
        const step = (body: string) => `exports.nodeClass = class { async run(nodeData, input, options) { ${body} } }\n`
        const blockingAgents = {
            startAgentflow: write(
                'overlap-start',
                step(`return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } }`)
            ),
            llmAgentflow: write(
                'overlap-llm',
                step(
                    `const gate = global.__cuttlelyTraceGate; if (gate) await gate.enter(options.chatflowid); return { id: nodeData.id, name: 'llmAgentflow', input: { question: input }, output: { content: 'Fresh bread at 7', usageMetadata: { input_tokens: 12, output_tokens: 9 } } }`
                )
            ),
            toolAgentflow: write(
                'overlap-tool',
                step(
                    `return { id: nodeData.id, name: 'toolAgentflow', input: { toolAgentflowSelectedTool: 'oven' }, output: { content: '350F' } }`
                )
            )
        }
        const blockingChat = {
            chatOpenAI: write(
                'overlap-model',
                `exports.nodeClass = class { constructor() {} async init() { return {} } async run() { return {} } }\n`
            ),
            llmChain: write(
                'overlap-chain',
                `exports.nodeClass = class { constructor() {} async init() { return {} } async run(nodeData, input, options) { const gate = global.__cuttlelyTraceGate; if (gate) await gate.enter(options.chatflowid); return { text: 'At 7.' } } }\n`
            )
        }
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
        const runAgentFlow = (id: string, chat: string) =>
            executeAgentFlow({
                componentNodes: blockingAgents,
                incomingInput: { question: 'When is the sourdough ready?', streaming: false },
                chatflow: { id, name: 'Bakery helper', type: 'AGENTFLOW', flowData, workspaceId: 'ws-1' },
                chatId: chat,
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
        const chatFlowData = JSON.stringify({
            nodes: [chatNode('chatOpenAI_0', 'chatOpenAI', 'Chat Models'), chatNode('llmChain_0', 'llmChain', 'Chains')],
            edges: [{ id: 'e1', source: 'chatOpenAI_0', target: 'llmChain_0' }]
        })
        try {
            const first = runAgentFlow(agentA, 'c0ffee00-0000-4000-8000-000000000011')
            await firstInNode
            await Promise.all([
                first,
                runAgentFlow(agentB, 'c0ffee00-0000-4000-8000-000000000012'),
                executeFlow({
                    componentNodes: blockingChat,
                    incomingInput: { question: 'When is the sourdough ready?', streaming: false },
                    chatflow: { id: chatId, name: 'Bakery chat', type: 'CHATFLOW', flowData: chatFlowData, workspaceId: 'ws-1' },
                    chatId: 'c0ffee00-0000-4000-8000-000000000013',
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
            ])
        } finally {
            delete (globalThis as { __cuttlelyTraceGate?: unknown }).__cuttlelyTraceGate
        }
        const spans = memory.spans()
        const roots = spans.filter((span) => !span.parentSpanId)
        const agentRoots = roots.filter((span) => span.name === 'agentflow.run')
        const chatRoots = roots.filter((span) => span.name === 'chatflow.prediction')
        expect(agentRoots.map((span) => span.attributes['flow.id']).sort()).toEqual([agentA, agentB])
        expect(chatRoots.map((span) => span.attributes['flow.id'])).toEqual([chatId])
        expect(new Set(roots.map((span) => span.traceId)).size).toBe(3)
        const byId = new Map(spans.map((span) => [span.spanId, span]))
        for (const root of roots) {
            const nodes = spans.filter((span) => span.traceId === root.traceId && span.name === 'node')
            expect(nodes.length).toBeGreaterThan(0)
            for (const node of nodes) {
                expect(node.attributes['flow.id']).toBe(root.attributes['flow.id'])
                expect(node.parentSpanId).toBe(root.spanId)
                const parentId = node.parentSpanId
                if (!parentId) throw new Error('node span has no parent')
                expect(byId.get(parentId)?.traceId).toBe(root.traceId)
            }
        }
        const sharedNodeId = 'llmAgentflow_0'
        const shared = spans.filter((span) => span.name === 'node' && span.attributes['node.id'] === sharedNodeId)
        expect(shared).toHaveLength(2)
        expect(new Set(shared.map((span) => span.attributes['flow.id']))).toEqual(new Set([agentA, agentB]))
        expect(new Set(shared.map((span) => span.traceId)).size).toBe(2)
    })

    it('keeps two concurrent runs on separate traces', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        let release: () => void = () => undefined
        const bothInside = new Promise<void>((resolve) => {
            release = resolve
        })
        let entered = 0
        const run = (flowId: string, waitMs: number) =>
            traceFlow('chatflow', flowId, async () => {
                entered += 1
                if (entered === 2) release()
                await bothInside
                await withNodeSpan(`${flowId}-node`, 'llmChain', async () => {
                    await tracedNode(`${flowId}-model`, 'llmAgentflow', { llmModelConfig: { modelName: 'gpt-4o-mini' } }, async () => {
                        await new Promise((done) => setTimeout(done, waitMs))
                        return { output: { content: flowId, usageMetadata: { input_tokens: 3, output_tokens: 1 } } }
                    })
                })
            })
        await Promise.all([run('flow-a', 25), run('flow-b', 5)])
        const spans = memory.spans()
        const roots = spans.filter((span) => span.name === 'chatflow.prediction')
        expect(roots.map((span) => span.attributes['flow.id']).sort()).toEqual(['flow-a', 'flow-b'])
        expect(new Set(roots.map((span) => span.traceId)).size).toBe(2)
        const byId = new Map(spans.map((span) => [span.spanId, span]))
        for (const root of roots) {
            const mine = spans.filter((span) => span.traceId === root.traceId)
            expect(mine.length).toBeGreaterThan(1)
            for (const span of mine) {
                expect(span.attributes['flow.id']).toBe(root.attributes['flow.id'])
                if (!span.parentSpanId) continue
                expect(byId.get(span.parentSpanId)?.traceId).toBe(root.traceId)
            }
            const node = mine.find((span) => span.attributes['node.id'] === `${root.attributes['flow.id']}-node`)
            expect(node?.parentSpanId).toBe(root.spanId)
            const model = mine.find((span) => span.name === 'model')
            expect(model?.attributes['node.id']).toBe(`${root.attributes['flow.id']}-model`)
            expect(model?.traceId).toBe(root.traceId)
        }
    })

    it('does not mark a tool that is waiting for approval as ok', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        await traceFlow('agentflow', 'flow-approve', async () => {
            await tracedNode('agentAgentflow_0', 'agentAgentflow', { agentModelConfig: { modelName: 'gpt-4o-mini' } }, async () => ({
                output: {
                    content: 'Need approval',
                    isWaitingForHumanInput: true,
                    calledTools: [{ name: 'oven', id: 'call-1' }],
                    usageMetadata: { input_tokens: 4, output_tokens: 2 }
                }
            }))
        })
        const tools = memory.spans().filter((span) => span.name === 'tool')
        expect(tools.map((span) => span.attributes['tool.name'])).toEqual(['oven'])
        expect(tools[0].attributes['status']).toBe('pending')
    })

    it('records a tool that ran once and leaves a call that did not run pending', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        await traceFlow('agentflow', 'flow-mixed', async () => {
            await tracedNode('agentAgentflow_0', 'agentAgentflow', { agentModelConfig: { modelName: 'gpt-4o-mini' } }, async () => ({
                output: {
                    usedTools: [{ tool: 'calculator', toolInput: '2+2', toolOutput: '4' }],
                    calledTools: [{ name: 'calculator' }, { name: 'oven' }],
                    usageMetadata: { input_tokens: 8, output_tokens: 3 }
                }
            }))
        })
        const tools = memory.spans().filter((span) => span.name === 'tool')
        const calculator = tools.filter((span) => span.attributes['tool.name'] === 'calculator')
        const oven = tools.filter((span) => span.attributes['tool.name'] === 'oven')
        expect(calculator).toHaveLength(1)
        expect(calculator[0].attributes['status']).toBe('ok')
        expect(oven).toHaveLength(1)
        expect(oven[0].attributes['status']).toBe('pending')
    })

    it('keeps model tokens and an error tool span when a tool throws', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const write = (name: string, body: string) => {
            const file = path.join(dir, `${name}.js`)
            fs.writeFileSync(file, body)
            return { filePath: file }
        }
        const step = (body: string) => `exports.nodeClass = class { async run(nodeData, input, options) { ${body} } }\n`
        const nodes = {
            startAgentflow: write(
                'throw-start',
                step(`return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } }`)
            ),
            llmAgentflow: write(
                'throw-llm',
                step(
                    `const failure = new Error('oven exploded'); failure.usedTools = [{ tool: 'oven', toolInput: 'heat', toolOutput: '', error: 'oven exploded' }]; failure.usageMetadata = { input_tokens: 15, output_tokens: 6 }; throw failure`
                )
            )
        }
        const flowData = JSON.stringify({
            nodes: [
                agentNode('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'chatInput' }),
                agentNode('llmAgentflow_0', 'llmAgentflow', 'Bakery helper', { llmModelConfig: { modelName: 'gpt-4o-mini' } })
            ],
            edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'llmAgentflow_0' }]
        })
        await expect(
            executeAgentFlow({
                componentNodes: nodes,
                incomingInput: { question: 'Heat the oven', streaming: false },
                chatflow: {
                    id: 'e0f4d9c5-4011-4d84-ad01-6c423f50618d',
                    name: 'Bakery helper',
                    type: 'AGENTFLOW',
                    flowData,
                    workspaceId: 'ws-1'
                },
                chatId: 'c0ffee00-0000-4000-8000-000000000021',
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
        ).rejects.toThrow('oven exploded')
        const spans = memory.spans()
        const root = spans.find((span) => span.name === 'agentflow.run')
        const model = spans.find((span) => span.name === 'model')
        const tool = spans.find((span) => span.name === 'tool')
        const node = spans.find((span) => span.name === 'node' && span.attributes['node.id'] === 'llmAgentflow_0')
        expect(root?.attributes['status']).toBe('error')
        expect(node?.attributes['status']).toBe('error')
        expect(model?.attributes['status']).toBe('error')
        expect(model?.attributes['tokens.input']).toBe(15)
        expect(model?.attributes['tokens.output']).toBe(6)
        expect(tool?.attributes['tool.name']).toBe('oven')
        expect(tool?.attributes['status']).toBe('error')
        expect(tool?.attributes['error']).toBe('oven exploded')
    })

    it('records a thrown tool through Agent.run', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const agentFile = path.join(__dirname, '../../../components/dist/nodes/agentflow/Agent/Agent.js')
        const write = (name: string, body: string) => {
            const file = path.join(dir, `${name}.js`)
            fs.writeFileSync(file, body)
            return { filePath: file }
        }
        const nodes = {
            startAgentflow: write(
                'agent-run-start',
                `exports.nodeClass = class { async run(nodeData, input) { return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } } } }\n`
            ),
            agentAgentflow: { filePath: agentFile },
            stubChatModel: write(
                'agent-run-model',
                `exports.nodeClass = class {
                    async init() {
                        return {
                            bindTools() { return this },
                            async invoke() {
                                return {
                                    content: '',
                                    tool_calls: [{ id: 'call-oven', name: 'oven', args: { heat: '350' } }],
                                    usage_metadata: { input_tokens: 15, output_tokens: 6, total_tokens: 21 }
                                }
                            }
                        }
                    }
                }\n`
            ),
            stubOven: write(
                'agent-run-oven',
                `exports.nodeClass = class {
                    async init() {
                        return { name: 'oven', description: 'Heat the oven', schema: null, async call() { throw new Error('oven exploded') } }
                    }
                }\n`
            )
        }
        const agent = {
            ...agentNode('agentAgentflow_0', 'agentAgentflow', 'Helper', {
                agentModel: 'stubChatModel',
                agentModelConfig: { modelName: 'gpt-4o-mini', streaming: false },
                agentTools: [{ agentSelectedTool: 'stubOven', agentSelectedToolConfig: {} }],
                agentMessages: []
            })
        }
        const flowData = JSON.stringify({
            nodes: [agentNode('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'chatInput' }), agent],
            edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'agentAgentflow_0' }]
        })
        await expect(
            executeAgentFlow({
                componentNodes: nodes,
                incomingInput: { question: 'Heat the oven', streaming: false },
                chatflow: {
                    id: 'a1b2c3d4-1111-4111-8111-111111111111',
                    name: 'Bakery helper',
                    type: 'AGENTFLOW',
                    flowData,
                    workspaceId: 'ws-1'
                },
                chatId: 'c0ffee00-0000-4000-8000-000000000041',
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
        ).rejects.toThrow('Error in Agent node: oven exploded')
        const spans = memory.spans()
        const root = spans.find((span) => span.name === 'agentflow.run')
        const model = spans.find((span) => span.name === 'model')
        const tool = spans.find((span) => span.name === 'tool')
        const node = spans.find((span) => span.name === 'node' && span.attributes['node.id'] === 'agentAgentflow_0')
        expect(root?.attributes['status']).toBe('error')
        expect(node?.attributes['status']).toBe('error')
        expect(model?.attributes['tokens.input']).toBe(15)
        expect(model?.attributes['tokens.output']).toBe(6)
        expect(model?.attributes['status']).toBe('error')
        expect(tool?.attributes['tool.name']).toBe('oven')
        expect(tool?.attributes['tool.id']).toBe('call-oven')
        expect(tool?.attributes['status']).toBe('error')
        expect(tool?.attributes['error']).toBe('oven exploded')
    })

    it('keeps the first tool and both model turns when a later tool throws', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        const agentFile = path.join(__dirname, '../../../components/dist/nodes/agentflow/Agent/Agent.js')
        const write = (name: string, body: string) => {
            const file = path.join(dir, `${name}.js`)
            fs.writeFileSync(file, body)
            return { filePath: file }
        }
        const nodes = {
            startAgentflow: write(
                'two-tool-start',
                `exports.nodeClass = class { async run(nodeData, input) { return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } } } }\n`
            ),
            agentAgentflow: { filePath: agentFile },
            stubChatModel: write(
                'two-tool-model',
                `exports.nodeClass = class {
                    async init() {
                        let turn = 0
                        return {
                            bindTools() { return this },
                            async invoke() {
                                turn += 1
                                if (turn === 1) {
                                    return {
                                        content: '',
                                        tool_calls: [{ id: 'call-mixer', name: 'mixer', args: { speed: 'low' }, type: 'tool_call' }],
                                        usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
                                    }
                                }
                                return {
                                    content: '',
                                    tool_calls: [{ id: 'call-oven', name: 'oven', args: { heat: '350' }, type: 'tool_call' }],
                                    usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 }
                                }
                            }
                        }
                    }
                }\n`
            ),
            stubMixer: write(
                'two-tool-mixer',
                `exports.nodeClass = class {
                    async init() {
                        return { name: 'mixer', description: 'Mix the dough', schema: null, async call() { return 'mixed' } }
                    }
                }\n`
            ),
            stubOven: write(
                'two-tool-oven',
                `exports.nodeClass = class {
                    async init() {
                        return { name: 'oven', description: 'Heat the oven', schema: null, async call() { throw new Error('oven exploded') } }
                    }
                }\n`
            )
        }
        const agent = agentNode('agentAgentflow_0', 'agentAgentflow', 'Helper', {
            agentModel: 'stubChatModel',
            agentModelConfig: { modelName: 'gpt-4o-mini', streaming: false },
            agentTools: [
                { agentSelectedTool: 'stubMixer', agentSelectedToolConfig: {} },
                { agentSelectedTool: 'stubOven', agentSelectedToolConfig: {} }
            ],
            agentMessages: []
        })
        const flowData = JSON.stringify({
            nodes: [agentNode('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'chatInput' }), agent],
            edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'agentAgentflow_0' }]
        })
        await expect(
            executeAgentFlow({
                componentNodes: nodes,
                incomingInput: { question: 'Heat the oven', streaming: false },
                chatflow: {
                    id: 'a1b2c3d4-2222-4222-8222-222222222222',
                    name: 'Bakery helper',
                    type: 'AGENTFLOW',
                    flowData,
                    workspaceId: 'ws-1'
                },
                chatId: 'c0ffee00-0000-4000-8000-000000000051',
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
        ).rejects.toThrow('Error in Agent node: oven exploded')
        const tools = memory.spans().filter((span) => span.name === 'tool')
        const mixer = tools.find((span) => span.attributes['tool.name'] === 'mixer')
        const oven = tools.find((span) => span.attributes['tool.name'] === 'oven')
        const model = memory.spans().find((span) => span.name === 'model')
        expect(mixer?.attributes['status']).toBe('ok')
        expect(mixer?.attributes['tool.id']).toBe('call-mixer')
        expect(oven?.attributes['status']).toBe('error')
        expect(oven?.attributes['tool.id']).toBe('call-oven')
        expect(oven?.attributes['error']).toBe('oven exploded')
        expect(model?.attributes['tokens.input']).toBe(22)
        expect(model?.attributes['tokens.output']).toBe(9)
        expect(model?.attributes['status']).toBe('error')
    })

    it('keeps the resumed tool and both model turns when the next tool throws', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        const agentFile = path.join(__dirname, '../../../components/dist/nodes/agentflow/Agent/Agent.js')
        const write = (name: string, body: string) => {
            const file = path.join(dir, `${name}.js`)
            fs.writeFileSync(file, body)
            return { filePath: file }
        }
        const chatId = 'c0ffee00-0000-4000-8000-000000000052'
        const flowId = 'a1b2c3d4-3333-4333-8333-333333333333'
        const execution = {
            id: 'exec-resume-1',
            state: 'STOPPED',
            workspaceId: 'ws-1',
            sessionId: chatId,
            agentflowId: flowId,
            executionData: JSON.stringify([
                {
                    nodeId: 'agentAgentflow_0',
                    nodeLabel: 'Helper',
                    status: 'STOPPED',
                    previousNodeIds: [],
                    data: {
                        id: 'agentAgentflow_0',
                        name: 'agentAgentflow',
                        state: {},
                        output: {
                            content: '',
                            isWaitingForHumanInput: true,
                            humanInputAction: {
                                id: 'action-1',
                                data: {
                                    nodeId: 'agentAgentflow_0',
                                    nodeLabel: 'Helper',
                                    input: {
                                        messages: [
                                            { role: 'user', content: 'Heat the oven' },
                                            {
                                                content: '',
                                                tool_calls: [
                                                    { id: 'call-mixer', name: 'mixer', args: { speed: 'low' }, type: 'tool_call' }
                                                ],
                                                usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }
            ])
        }
        const saved: Record<string, any> = { Execution: execution }
        const resumeSource = {
            getRepository: (entity: { name?: string } | string) => {
                const table = typeof entity === 'function' ? entity.name : String(entity)
                return {
                    find: async () => (table === 'Execution' ? [saved.Execution] : []),
                    findBy: async () => (table === 'Execution' ? [saved.Execution] : []),
                    findOne: async () => saved[table] ?? null,
                    findOneBy: async () => saved[table] ?? null,
                    create: (value: unknown) => value,
                    save: async (value: Record<string, unknown>) => {
                        saved[table] = { id: saved[table]?.id ?? `${table}-1`, ...value }
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
        }
        const nodes = {
            startAgentflow: write(
                'resume-throw-start',
                `exports.nodeClass = class { async run(nodeData, input) { return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } } } }\n`
            ),
            agentAgentflow: { filePath: agentFile },
            stubChatModel: write(
                'resume-throw-model',
                `exports.nodeClass = class {
                    async init() {
                        return {
                            bindTools() { return this },
                            async invoke() {
                                return {
                                    content: '',
                                    tool_calls: [{ id: 'call-oven', name: 'oven', args: { heat: '350' }, type: 'tool_call' }],
                                    usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 }
                                }
                            }
                        }
                    }
                }\n`
            ),
            stubMixer: write(
                'resume-throw-mixer',
                `exports.nodeClass = class {
                    async init() {
                        return { name: 'mixer', description: 'Mix the dough', schema: null, async call() { return 'mixed' } }
                    }
                }\n`
            ),
            stubOven: write(
                'resume-throw-oven',
                `exports.nodeClass = class {
                    async init() {
                        return { name: 'oven', description: 'Heat the oven', schema: null, async call() { throw new Error('oven exploded') } }
                    }
                }\n`
            )
        }
        const agent = agentNode('agentAgentflow_0', 'agentAgentflow', 'Helper', {
            agentModel: 'stubChatModel',
            agentModelConfig: { modelName: 'gpt-4o-mini', streaming: false },
            agentTools: [
                { agentSelectedTool: 'stubMixer', agentSelectedToolConfig: {} },
                { agentSelectedTool: 'stubOven', agentSelectedToolConfig: {} }
            ],
            agentMessages: []
        })
        const flowData = JSON.stringify({
            nodes: [agentNode('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'chatInput' }), agent],
            edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'agentAgentflow_0' }]
        })
        await expect(
            executeAgentFlow({
                componentNodes: nodes,
                incomingInput: {
                    question: 'Heat the oven',
                    streaming: false,
                    humanInput: { type: 'proceed', startNodeId: 'agentAgentflow_0' }
                },
                chatflow: {
                    id: flowId,
                    name: 'Bakery helper',
                    type: 'AGENTFLOW',
                    flowData,
                    workspaceId: 'ws-1'
                },
                chatId,
                appDataSource: resumeSource,
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
        ).rejects.toThrow('Error in Agent node: oven exploded')
        const tools = memory.spans().filter((span) => span.name === 'tool')
        const mixer = tools.find((span) => span.attributes['tool.name'] === 'mixer')
        const oven = tools.find((span) => span.attributes['tool.name'] === 'oven')
        const model = memory.spans().find((span) => span.name === 'model')
        expect(mixer?.attributes['status']).toBe('ok')
        expect(mixer?.attributes['tool.id']).toBe('call-mixer')
        expect(oven?.attributes['status']).toBe('error')
        expect(oven?.attributes['tool.id']).toBe('call-oven')
        expect(oven?.attributes['error']).toBe('oven exploded')
        expect(model?.attributes['tokens.input']).toBe(22)
        expect(model?.attributes['tokens.output']).toBe(9)
        expect(model?.attributes['status']).toBe('error')
    })

    function helperSource() {
        const saved: Record<string, any> = {}
        const source = {
            getRepository: (entity: { name?: string } | string) => {
                const table = typeof entity === 'function' ? entity.name : String(entity)
                return {
                    find: async () => [],
                    findBy: async () => [],
                    findOne: async () => saved[table] ?? null,
                    findOneBy: async () => saved[table] ?? null,
                    create: (value: unknown) => value,
                    save: async (value: Record<string, unknown>) => {
                        saved[table] = { id: saved[table]?.id ?? `${table}-1`, ...value }
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
        }
        return { saved, source }
    }

    function usageFromRun(saved: Record<string, any>) {
        const raw = saved.Execution?.executionData
        const rows = typeof raw === 'string' ? JSON.parse(raw) : []
        const agent = rows.find((row: { nodeId?: string }) => row.nodeId === 'agentAgentflow_0')
        return agent?.data?.output?.usageMetadata as
            | {
                  input_tokens?: number
                  output_tokens?: number
                  total_tokens?: number
                  input_cost?: number
                  output_cost?: number
                  tool_call_tokens?: number
              }
            | undefined
    }

    async function runHelper(label: string, modelSource: string, streaming: boolean, dataSource: unknown = recordingDataSource()) {
        const agentFile = path.join(__dirname, '../../../components/dist/nodes/agentflow/Agent/Agent.js')
        const write = (name: string, body: string) => {
            const file = path.join(dir, `${name}.js`)
            fs.writeFileSync(file, body)
            return { filePath: file }
        }
        const nodes = {
            startAgentflow: write(
                `${label}-start`,
                `exports.nodeClass = class { async run(nodeData, input) { return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } } } }\n`
            ),
            agentAgentflow: { filePath: agentFile },
            chatOpenAI: write(`${label}-model`, modelSource),
            stubMixer: write(
                `${label}-mixer`,
                `exports.nodeClass = class { async init() { return { name: 'mixer', description: 'Mix the dough', schema: null, async call() { return 'mixed' } } } }\n`
            ),
            stubOven: write(
                `${label}-oven`,
                `exports.nodeClass = class { async init() { return { name: 'oven', description: 'Heat the oven', schema: null, async call() { return '350F' } } } }\n`
            )
        }
        const agent = agentNode('agentAgentflow_0', 'agentAgentflow', 'Helper', {
            agentModel: 'chatOpenAI',
            agentModelConfig: { modelName: 'gpt-4o-mini', streaming },
            agentTools: [
                { agentSelectedTool: 'stubMixer', agentSelectedToolConfig: {} },
                { agentSelectedTool: 'stubOven', agentSelectedToolConfig: {} }
            ],
            agentMessages: []
        })
        const flowData = JSON.stringify({
            nodes: [agentNode('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'chatInput' }), agent],
            edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'agentAgentflow_0' }]
        })
        return executeAgentFlow({
            componentNodes: nodes,
            incomingInput: { question: 'Heat the oven', streaming: false },
            chatflow: {
                id: 'a1b2c3d4-4444-4444-8444-444444444444',
                name: 'Bakery helper',
                type: 'AGENTFLOW',
                flowData,
                workspaceId: 'ws-1'
            },
            chatId: `c0ffee00-0000-4000-8000-${label.length.toString(16).padStart(12, '0')}`,
            appDataSource: dataSource,
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

    it('keeps the tool and this turn tokens when the follow-up model call rejects', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        await expect(
            runHelper(
                'follow-up-reject',
                `exports.nodeClass = class {
                    async init() {
                        let turn = 0
                        return {
                            bindTools() { return this },
                            async invoke() {
                                turn += 1
                                if (turn === 1) {
                                    return {
                                        content: '',
                                        tool_calls: [{ id: 'call-mixer', name: 'mixer', args: { speed: 'low' }, type: 'tool_call' }],
                                        usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
                                    }
                                }
                                throw new Error('429 rate limit')
                            }
                        }
                    }
                }\n`,
                false
            )
        ).rejects.toThrow('Error in Agent node: 429 rate limit')
        const tools = memory.spans().filter((span) => span.name === 'tool')
        const model = memory.spans().find((span) => span.name === 'model')
        expect(tools.map((span) => span.attributes['tool.name'])).toEqual(['mixer'])
        expect(tools[0].attributes['status']).toBe('ok')
        expect(tools[0].attributes['tool.id']).toBe('call-mixer')
        expect(model?.attributes['tokens.input']).toBe(10)
        expect(model?.attributes['tokens.output']).toBe(4)
        expect(model?.attributes['status']).toBe('error')
    })

    it('keeps the tool and this turn tokens when the follow-up stream rejects', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        await expect(
            runHelper(
                'follow-up-stream',
                `exports.nodeClass = class {
                    async init() {
                        let turn = 0
                        return {
                            bindTools() { return this },
                            async stream() {
                                turn += 1
                                if (turn === 1) {
                                    const chunk = {
                                        content: '',
                                        tool_call_chunks: [{ name: 'mixer', args: '{"speed":"low"}', id: 'call-mixer', index: 0, type: 'tool_call_chunk' }],
                                        usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
                                    }
                                    return (async function* () { yield chunk })()
                                }
                                throw new Error('429 rate limit')
                            }
                        }
                    }
                }\n`,
                true
            )
        ).rejects.toThrow('Error in Agent node: 429 rate limit')
        const tools = memory.spans().filter((span) => span.name === 'tool')
        const model = memory.spans().find((span) => span.name === 'model')
        expect(tools.map((span) => span.attributes['tool.name'])).toEqual(['mixer'])
        expect(tools[0].attributes['status']).toBe('ok')
        expect(tools[0].attributes['tool.id']).toBe('call-mixer')
        expect(model?.attributes['tokens.input']).toBe(10)
        expect(model?.attributes['tokens.output']).toBe(4)
        expect(model?.attributes['status']).toBe('error')
    })

    it('keeps both earlier tools when the third model call rejects', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        await expect(
            runHelper(
                'third-turn-reject',
                `exports.nodeClass = class {
                    async init() {
                        let turn = 0
                        return {
                            bindTools() { return this },
                            async invoke() {
                                turn += 1
                                if (turn === 1) {
                                    return {
                                        content: '',
                                        tool_calls: [{ id: 'call-mixer', name: 'mixer', args: { speed: 'low' }, type: 'tool_call' }],
                                        usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
                                    }
                                }
                                if (turn === 2) {
                                    return {
                                        content: '',
                                        tool_calls: [{ id: 'call-oven', name: 'oven', args: { heat: '350' }, type: 'tool_call' }],
                                        usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 }
                                    }
                                }
                                throw new Error('429 rate limit')
                            }
                        }
                    }
                }\n`,
                false
            )
        ).rejects.toThrow('Error in Agent node: 429 rate limit')
        const tools = memory.spans().filter((span) => span.name === 'tool')
        const mixer = tools.find((span) => span.attributes['tool.name'] === 'mixer')
        const oven = tools.find((span) => span.attributes['tool.name'] === 'oven')
        const model = memory.spans().find((span) => span.name === 'model')
        expect(mixer?.attributes['status']).toBe('ok')
        expect(mixer?.attributes['tool.id']).toBe('call-mixer')
        expect(oven?.attributes['status']).toBe('ok')
        expect(oven?.attributes['tool.id']).toBe('call-oven')
        expect(model?.attributes['tokens.input']).toBe(22)
        expect(model?.attributes['tokens.output']).toBe(9)
        expect(model?.attributes['status']).toBe('error')
    })

    it('records summed tokens for a two-call run and prices that stored split', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        const captured = helperSource()
        await runHelper(
            'two-call-ok',
            `exports.nodeClass = class {
                async init() {
                    let turn = 0
                    return {
                        bindTools() { return this },
                        async invoke() {
                            turn += 1
                            if (turn === 1) {
                                return {
                                    content: '',
                                    tool_calls: [{ id: 'call-mixer', name: 'mixer', args: { speed: 'low' }, type: 'tool_call' }],
                                    usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
                                }
                            }
                            return { content: 'Baked', usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } }
                        }
                    }
                }
            }\n`,
            false,
            captured.source
        )
        const model = memory.spans().find((span) => span.name === 'model')
        const usage = usageFromRun(captured.saved)
        expect(model?.attributes['tokens.input']).toBe(22)
        expect(model?.attributes['tokens.output']).toBe(9)
        expect(model?.attributes['status']).toBe('ok')
        expect(usage?.input_tokens).toBe(22)
        expect(usage?.output_tokens).toBe(9)
        expect(usage?.total_tokens).toBe(31)
        expect(usage?.tool_call_tokens).toBe(31)
        const inputRate = 0.00000015
        const outputRate = 0.0000006
        expect(usage?.input_cost).toBeCloseTo(22 * inputRate, 12)
        expect(usage?.output_cost).toBeCloseTo(9 * outputRate, 12)
    })

    it('records summed tokens for a three-call run and prices that stored split', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        const captured = helperSource()
        await runHelper(
            'three-call-ok',
            `exports.nodeClass = class {
                async init() {
                    let turn = 0
                    return {
                        bindTools() { return this },
                        async invoke() {
                            turn += 1
                            if (turn === 1) {
                                return {
                                    content: '',
                                    tool_calls: [{ id: 'call-mixer', name: 'mixer', args: { speed: 'low' }, type: 'tool_call' }],
                                    usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
                                }
                            }
                            if (turn === 2) {
                                return {
                                    content: '',
                                    tool_calls: [{ id: 'call-oven', name: 'oven', args: { heat: '350' }, type: 'tool_call' }],
                                    usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 }
                                }
                            }
                            return { content: 'Baked', usage_metadata: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } }
                        }
                    }
                }
            }\n`,
            false,
            captured.source
        )
        const model = memory.spans().find((span) => span.name === 'model')
        const usage = usageFromRun(captured.saved)
        const tools = memory.spans().filter((span) => span.name === 'tool')
        expect(tools.map((span) => [span.attributes['tool.name'], span.attributes['status']])).toEqual([
            ['mixer', 'ok'],
            ['oven', 'ok']
        ])
        expect(model?.attributes['tokens.input']).toBe(30)
        expect(model?.attributes['tokens.output']).toBe(12)
        expect(model?.attributes['status']).toBe('ok')
        expect(usage?.input_tokens).toBe(30)
        expect(usage?.output_tokens).toBe(12)
        expect(usage?.total_tokens).toBe(42)
        expect(usage?.tool_call_tokens).toBe(42)
        const inputRate = 0.00000015
        const outputRate = 0.0000006
        expect(usage?.input_cost).toBeCloseTo(30 * inputRate, 12)
        expect(usage?.output_cost).toBeCloseTo(12 * outputRate, 12)
    })

    it('matches the agentflow span tree to the run card', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        const captured = helperSource()
        await runHelper(
            'run-card',
            `exports.nodeClass = class {
                async init() {
                    let turn = 0
                    return {
                        bindTools() { return this },
                        async invoke() {
                            turn += 1
                            if (turn === 1) {
                                return {
                                    content: '',
                                    tool_calls: [{ id: 'call-mixer', name: 'mixer', args: { speed: 'low' }, type: 'tool_call' }],
                                    usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
                                }
                            }
                            return { content: 'Baked', usage_metadata: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } }
                        }
                    }
                }
            }\n`,
            false,
            captured.source
        )
        const spans = memory.spans()
        const rows = JSON.parse(captured.saved.Execution.executionData) as Array<{
            nodeId: string
            data?: {
                name?: string
                output?: {
                    usageMetadata?: { input_tokens?: number; output_tokens?: number }
                    usedTools?: Array<{ tool?: string; id?: string }>
                }
            }
        }>
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
            const node = spans.find(
                (span) =>
                    span.name === 'node' && span.attributes['node.id'] === row.nodeId && span.attributes['node.type'] === row.data?.name
            )
            expect(node).toBeDefined()
            const usage = row.data?.output?.usageMetadata
            if (usage && (usage.input_tokens || usage.output_tokens)) {
                const model = spans.find((span) => span.name === 'model' && span.parentSpanId === node?.spanId)
                expect(model?.attributes['tokens.input']).toBe(usage.input_tokens)
                expect(model?.attributes['tokens.output']).toBe(usage.output_tokens)
            }
            for (const tool of row.data?.output?.usedTools ?? []) {
                const toolSpan = spans.find(
                    (span) => span.name === 'tool' && span.parentSpanId === node?.spanId && span.attributes['tool.name'] === tool.tool
                )
                expect(toolSpan?.attributes['status']).toBe('ok')
                if (tool.id) expect(toolSpan?.attributes['tool.id']).toBe(tool.id)
            }
        }
        expect(contentKeys(spans)).toEqual([])
    })

    it('keeps a second approval wait for the same tool pending', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        await traceFlow('agentflow', 'flow-again', async () => {
            await tracedNode('agentAgentflow_0', 'agentAgentflow', { agentModelConfig: { modelName: 'gpt-4o-mini' } }, async () => ({
                output: {
                    isWaitingForHumanInput: true,
                    usedTools: [{ id: 'call-1', tool: 'oven', toolInput: { heat: '350' }, toolOutput: '350F' }],
                    calledTools: [
                        { id: 'call-1', name: 'oven' },
                        { id: 'call-2', name: 'oven' }
                    ],
                    usageMetadata: { input_tokens: 9, output_tokens: 4 }
                }
            }))
        })
        const tools = memory.spans().filter((span) => span.name === 'tool' && span.attributes['tool.name'] === 'oven')
        const ok = tools.filter((span) => span.attributes['status'] === 'ok')
        const pending = tools.filter((span) => span.attributes['status'] === 'pending')
        expect(ok).toHaveLength(1)
        expect(ok[0].attributes['tool.id']).toBe('call-1')
        expect(pending).toHaveLength(1)
        expect(pending[0].attributes['tool.id']).toBe('call-2')
    })

    it('exports zero spans when a replay inits an output prediction chain', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const seen = { replay: false }
        ;(globalThis as { __cuttlelyReplayInit?: { replay: boolean } }).__cuttlelyReplayInit = seen
        const file = path.join(dir, 'output-prediction.js')
        fs.writeFileSync(
            file,
            `exports.nodeClass = class {
                constructor() {}
                async init(nodeData, input, options) {
                    global.__cuttlelyReplayInit.replay = options && options.cuttlelyReplay === true
                    const { additionalCallbacks } = require('@cuttlely/components')
                    const callbacks = await additionalCallbacks(nodeData, options || {})
                    const handler = callbacks && callbacks.find((item) => item && typeof item.handleToolStart === 'function')
                    if (handler) {
                        await handler.handleLLMStart({ kwargs: { modelName: 'gpt-4o-mini' } }, ['When is the sourdough ready?'], 'pred-model')
                        await handler.handleLLMEnd({ generations: [[{ text: 'At 7.' }]], llmOutput: { tokenUsage: { promptTokens: 3, completionTokens: 1 } } }, 'pred-model')
                        await handler.handleToolStart({ name: 'calculator' }, '2+2', 'pred-tool')
                        await handler.handleToolEnd('4', 'pred-tool')
                    }
                    return {}
                }
                async run() { return { text: 'At 7.' } }
            }\n`
        )
        const modelFile = path.join(dir, 'output-prediction-model.js')
        fs.writeFileSync(modelFile, `exports.nodeClass = class { constructor() {} async init() { return {} } async run() { return {} } }\n`)
        const endFile = path.join(dir, 'output-prediction-end.js')
        fs.writeFileSync(
            endFile,
            `exports.nodeClass = class { constructor() {} async init() { return {} } async run() { return { text: 'At 7.' } } }\n`
        )
        try {
            const result = await executeFlow({
                componentNodes: {
                    chatOpenAI: { filePath: modelFile },
                    llmChain: { filePath: file },
                    endChain: { filePath: endFile }
                },
                incomingInput: { question: 'When is the sourdough ready?', streaming: false },
                chatflow: {
                    id: 'f1a5e0d6-5122-4e95-be12-7d534061729e',
                    name: 'Bakery chat',
                    type: 'CHATFLOW',
                    workspaceId: 'ws-1',
                    flowData: JSON.stringify({
                        nodes: [
                            chatNode('chatOpenAI_0', 'chatOpenAI', 'Chat Models'),
                            {
                                ...chatNode('llmChain_0', 'llmChain', 'Chains'),
                                data: {
                                    ...chatNode('llmChain_0', 'llmChain', 'Chains').data,
                                    outputs: { output: 'outputPrediction' }
                                }
                            },
                            chatNode('endChain_0', 'endChain', 'Chains')
                        ],
                        edges: [
                            { id: 'e1', source: 'chatOpenAI_0', target: 'llmChain_0' },
                            { id: 'e2', source: 'llmChain_0', target: 'endChain_0' }
                        ]
                    })
                },
                chatId: 'c0ffee00-0000-4000-8000-000000000031',
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
                productId: 'prod-1',
                replay: true
            } as any)
            expect(result.text).toBe('At 7.')
            expect(seen.replay).toBe(true)
            expect(memory.spans()).toEqual([])
        } finally {
            delete (globalThis as { __cuttlelyReplayInit?: unknown }).__cuttlelyReplayInit
        }
    })

    it('emits no spans for a publish check replay (cuttlelyReplay)', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const result = await runChat(true, true)
        expect(result.text).toBe('At 7.')
        expect(memory.spans()).toEqual([])
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

    it('does not export a global tracer span when content is off', async () => {
        const bodies: Buffer[] = []
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk) => chunks.push(chunk))
            req.on('end', () => {
                bodies.push(Buffer.concat(chunks))
                res.writeHead(200)
                res.end()
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        try {
            process.env.CUTTLELY_OTEL_TRACES = 'true'
            process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
            process.env.CUTTLELY_OTEL_TRACES_ENDPOINT = `http://127.0.0.1:${port}/v1/traces`
            process.env.CUTTLELY_OTEL_TRACES_PROTOCOL = 'http'
            registerCuttlelyTraces()
            expect(tracesInstalled()).toBe(true)
            const { trace } = require('@opentelemetry/api') as {
                trace: {
                    getTracer: (name: string) => {
                        startSpan: (name: string) => { setAttribute: (k: string, v: string) => void; end: () => void }
                    }
                }
            }
            const foreign = trace.getTracer('openinference').startSpan('openinference.chain')
            foreign.setAttribute('input.value', 'secret prompt that must not export')
            foreign.end()
            await traceFlow('chatflow', 'flow-own-collector', async () => 'ok')
            await flushCuttlelyTraces()
            const payload = Buffer.concat(bodies).toString('utf8')
            expect(payload).toContain('chatflow.prediction')
            expect(payload).toContain('flow-own-collector')
            expect(payload).not.toContain('openinference.chain')
            expect(payload).not.toContain('secret prompt that must not export')
        } finally {
            await new Promise((resolve) => server.close(resolve))
        }
    })
})

describe('approval trace retention', () => {
    let now = 1_700_000_000_000
    let memory: { spans: () => FinishedTraceSpan[]; reset: () => void }

    beforeAll(() => {
        memory = installInMemoryTraces()
    })

    beforeEach(() => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        now = 1_700_000_000_000
        setTraceParentClock(() => now)
        resetHeldToolsForTests()
        memory.reset()
    })

    afterEach(() => {
        delete process.env.CUTTLELY_OTEL_TRACES
        setTraceParentClock()
        resetHeldToolsForTests()
    })

    async function remember(actionId: string): Promise<void> {
        await traceFlow('chatflow', 'flow-keep', async () => {
            rememberTraceContinuation('flow-keep', 'chat-keep', actionId)
        })
    }

    it('drops a parent after the resume grace period and keeps it for a retry until then', async () => {
        await remember('action-done')
        const parent = traceContinuationFor('flow-keep', 'chat-keep', 'action-done')
        expect(parent?.traceId).toBeTruthy()
        finishTraceContinuation('flow-keep', 'chat-keep', 'action-done')
        expect(traceContinuationFor('flow-keep', 'chat-keep', 'action-done')).toEqual(parent)
        now += TRACE_PARENT_GRACE_MS
        expect(traceContinuationFor('flow-keep', 'chat-keep', 'action-done')).toBeUndefined()
    })

    it('drops a parent when the day-long wait expires', async () => {
        await remember('action-old')
        expect(traceContinuationFor('flow-keep', 'chat-keep', 'action-old')).toBeDefined()
        now += TRACE_PARENT_TTL_MS
        expect(traceContinuationFor('flow-keep', 'chat-keep', 'action-old')).toBeUndefined()
    })

    it('evicts the oldest parent when the cap is full', async () => {
        await traceFlow('chatflow', 'flow-keep', async () => {
            for (let index = 0; index < TRACE_PARENT_CAP + 1; index += 1) {
                rememberTraceContinuation('flow-keep', 'chat-keep', `action-${index}`)
            }
        })
        expect(traceContinuationFor('flow-keep', 'chat-keep', 'action-0')).toBeUndefined()
        expect(traceContinuationFor('flow-keep', 'chat-keep', `action-${TRACE_PARENT_CAP}`)?.traceId).toBeTruthy()
    })

    async function holdTool(flowId: string, chatId: string, actionId: string, count: number): Promise<void> {
        await traceFlow('chatflow', flowId, async () => {
            for (let index = 0; index < count; index += 1) {
                const node = traceGraphNode(`node_${index}`, 'worker', async () => ({
                    messages: [{ tool_calls: [{ id: `call-${index}`, name: 'oven', type: 'tool_call' }] }]
                })) as (state: unknown, config: unknown) => Promise<unknown>
                await node({}, {})
            }
            rememberTraceContinuation(flowId, chatId, actionId)
            keepPendingToolsForApproval()
        })
    }

    it('ends a waiting tool span as pending when the continuation expires', async () => {
        const flowId = 'flow-held-expire'
        const chatId = 'chat-held-expire'
        await holdTool(flowId, chatId, 'action-held-expire', 1)
        expect(memory.spans().filter((span) => span.name === 'tool')).toEqual([])
        now += TRACE_PARENT_TTL_MS
        expect(traceContinuationFor(flowId, chatId, 'action-held-expire')).toBeUndefined()
        const tools = memory.spans().filter((span) => span.name === 'tool')
        expect(tools).toHaveLength(1)
        expect(tools[0].attributes['status']).toBe('pending')
        expect(tools[0].attributes['tool.id']).toBe('call-0')
    })

    it('ends the oldest waiting tool span as pending when a thousand are already held', async () => {
        await holdTool('flow-held-cap', 'chat-held-cap', 'action-held-cap', TRACE_PARENT_CAP + 1)
        const tools = memory.spans().filter((span) => span.name === 'tool')
        expect(tools).toHaveLength(1)
        expect(tools[0].attributes['status']).toBe('pending')
        expect(tools[0].attributes['tool.id']).toBe('call-0')
        expect(traceContinuationFor('flow-held-cap', 'chat-held-cap', 'action-held-cap')?.traceId).toBeTruthy()
    }, 120000)
})
