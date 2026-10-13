/**
 * Multi Agents and Sequential Agents span trees. Traces are off unless CUTTLELY_OTEL_TRACES=true.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { executeFlow } from '../utils/buildChatflow'
import { executeAgentFlow } from '../utils/buildAgentflow'
import { PredictionQueue } from '../queue/PredictionQueue'
import {
    installInMemoryTraces,
    rememberTraceContinuation,
    shutdownCuttlelyTraces,
    traceFlow,
    traceGraphNode,
    type FinishedTraceSpan
} from './tracing'

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn(), verbose: jest.fn() }
}))

const TRACE_ENV = ['CUTTLELY_OTEL_TRACES', 'CUTTLELY_OTEL_TRACES_ENDPOINT', 'CUTTLELY_OTEL_TRACES_PROTOCOL', 'CUTTLELY_OTEL_TRACES_CONTENT']

function clearTraceEnv(): void {
    for (const key of TRACE_ENV) delete process.env[key]
}

function contentKeys(spans: FinishedTraceSpan[]): string[] {
    return spans.flatMap((span) => Object.keys(span.attributes).filter((key) => key.startsWith('content.')))
}

function tokenSum(spans: FinishedTraceSpan[], nodeId: string): { input: number; output: number } {
    return spans
        .filter((span) => span.name === 'model' && span.attributes['node.id'] === nodeId)
        .reduce(
            (sum, span) => ({
                input: sum.input + Number(span.attributes['tokens.input'] || 0),
                output: sum.output + Number(span.attributes['tokens.output'] || 0)
            }),
            { input: 0, output: 0 }
        )
}

const blank = {
    inputParams: [],
    inputAnchors: [],
    outputAnchors: [],
    outputs: {}
}

function canvasNode(id: string, name: string, category: string, inputs: Record<string, unknown> = {}) {
    return {
        id,
        type: 'customNode',
        position: { x: 0, y: 0 },
        data: { id, name, label: name, category, inputs, ...blank }
    }
}

describe('graph run traces', () => {
    let dir: string
    let memory: { spans: () => FinishedTraceSpan[]; reset: () => void }
    let multiFile: string
    let seqFile: string

    beforeAll(() => {
        memory = installInMemoryTraces()
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-graph-traces-'))
        multiFile = path.join(dir, 'multi.js')
        seqFile = path.join(dir, 'seq.js')
        const anchor = JSON.stringify(path.join(__dirname, 'graphTraces.test.ts'))
        fs.writeFileSync(
            multiFile,
            `const { createRequire } = require('module')
            const req = createRequire(${anchor})
            exports.nodeClass = class {
                async init(nodeData) {
                    if (nodeData.name === 'worker') {
                        return {
                            name: 'baker',
                            label: 'Baker',
                            type: 'worker',
                            parentSupervisorName: 'lead',
                            node: async (_state, config) => {
                                await report(config, { model: 'gpt-4o-mini', input: 10, output: 4, runId: 'worker-1', prompt: 'When is the loaf ready?' })
                                await report(config, {
                                    model: 'gpt-4o-mini',
                                    input: 12,
                                    output: 5,
                                    runId: 'worker-2',
                                    prompt: 'Heat the oven',
                                    tool: { name: 'oven', id: 'call-oven', output: '350F', runId: 'tool-oven' }
                                })
                                const { HumanMessage } = req('@langchain/core/messages')
                                return {
                                    messages: [new HumanMessage({
                                        content: 'Loaf is ready.',
                                        additional_kwargs: {
                                            nodeId: nodeData.id,
                                            type: 'worker',
                                            usedTools: [{ tool: 'oven', toolInput: { heat: '350' }, toolOutput: '350F', id: 'call-oven' }]
                                        }
                                    })]
                                }
                            }
                        }
                    }
                    return {
                        name: 'lead',
                        label: 'Lead',
                        workers: ['baker'],
                        recursionLimit: 5,
                        node: async (_state, config) => {
                            const round = (global.__leadRound = (global.__leadRound || 0) + 1)
                            if (round === 1) {
                                await report(config, { model: 'gpt-4o-mini', input: 5, output: 2, runId: 'lead-1', prompt: 'Ask the baker' })
                                return { next: 'baker', messages: [] }
                            }
                            return { next: 'FINISH', messages: [] }
                        }
                    }
                }
            }
            async function report(config, call) {
                const callbacks = config && config.callbacks
                const handlers = callbacks && callbacks.handlers ? callbacks.handlers : Array.isArray(callbacks) ? callbacks : []
                for (const handler of handlers) {
                    try {
                        if (call.model && typeof handler.handleLLMStart === 'function') {
                            await handler.handleLLMStart({ kwargs: { modelName: call.model } }, [call.prompt], call.runId)
                        }
                        if (call.model && typeof handler.handleLLMEnd === 'function') {
                            await handler.handleLLMEnd({
                                generations: [[{
                                    text: 'Loaf is ready.',
                                    message: {
                                        usage_metadata: { input_tokens: call.input, output_tokens: call.output },
                                        response_metadata: { model_name: call.model }
                                    }
                                }]]
                            }, call.runId)
                        }
                        if (call.tool && typeof handler.handleToolStart === 'function') {
                            await handler.handleToolStart({ name: call.tool.name }, 'heat', call.tool.runId, undefined, undefined, { tool_call_id: call.tool.id })
                        }
                        if (call.tool && typeof handler.handleToolEnd === 'function') {
                            await handler.handleToolEnd(call.tool.output, call.tool.runId)
                        }
                    } catch (error) {}
                }
            }
            `
        )
        fs.writeFileSync(
            seqFile,
            `const { createRequire } = require('module')
            const req = createRequire(${anchor})
            const { START, END, MemorySaver } = req('@langchain/langgraph')
            const { AIMessage, ToolMessage } = req('@langchain/core/messages')
            if (!global.__cuttlelySeqMemory) global.__cuttlelySeqMemory = new MemorySaver()
            exports.nodeClass = class {
                async init(nodeData) {
                    if (nodeData.name === 'seqStart') {
                        return { name: 'start', label: 'Start', checkpointMemory: global.__cuttlelySeqMemory }
                    }
                    if (nodeData.name === 'seqEnd') {
                        return {
                            id: nodeData.id,
                            node: END,
                            name: END,
                            label: 'End',
                            type: 'end',
                            predecessorAgents: [{ name: 'baker', agentInterruptToolNode: { name: 'tool_' + 'seqLLM_0' } }]
                        }
                    }
                    const toolName = 'tool_' + nodeData.id
                    return {
                        id: nodeData.id,
                        name: 'baker',
                        label: 'Baker',
                        type: 'agent',
                        predecessorAgents: [{ name: START }],
                        agentInterruptToolNode: { name: toolName, seekPermissionMessage: async () => 'Approve the lookup?' },
                        agentInterruptToolFunc: async (graph, nextNodeName) => {
                            graph.addNode(toolName, async (_state, config) => {
                                await report(config, { tool: { name: 'lookup', id: 'call-lookup', output: 'rye', runId: 'tool-lookup' } })
                                return {
                                    messages: [new ToolMessage({
                                        name: 'lookup',
                                        content: 'rye',
                                        tool_call_id: 'call-lookup',
                                        additional_kwargs: {
                                            nodeId: nodeData.id,
                                            usedTools: [{ tool: 'lookup', toolInput: { q: 'rye' }, toolOutput: 'rye', id: 'call-lookup' }]
                                        }
                                    })]
                                }
                            })
                            const route = (state) => {
                                const messages = state.messages || []
                                const last = messages[messages.length - 1]
                                if (last && last.tool_calls && last.tool_calls.length) return toolName
                                return nextNodeName || END
                            }
                            const paths = { [toolName]: toolName, [END]: END }
                            if (nextNodeName) paths[nextNodeName] = nextNodeName
                            graph.addConditionalEdges('baker', route, paths)
                            graph.addEdge(toolName, 'baker')
                            return graph
                        },
                        node: async (state, config) => {
                            const messages = (state && state.messages) || []
                            const last = messages[messages.length - 1]
                            if (last && typeof last._getType === 'function' && last._getType() === 'tool') {
                                const copied = last.additional_kwargs && last.additional_kwargs.usedTools
                                return {
                                    messages: [new AIMessage({
                                        content: 'Loaf is ready.',
                                        additional_kwargs: { nodeId: nodeData.id, usedTools: copied || [] }
                                    })]
                                }
                            }
                            await report(config, { model: 'gpt-4o-mini', input: 50, output: 20, runId: 'seq-1', prompt: 'When is the loaf ready?' })
                            return {
                                messages: [new AIMessage({
                                    content: '',
                                    tool_calls: [{ id: 'call-lookup', name: 'lookup', args: { q: 'rye' }, type: 'tool_call' }],
                                    additional_kwargs: { nodeId: nodeData.id }
                                })]
                            }
                        }
                    }
                }
            }
            async function report(config, call) {
                const callbacks = config && config.callbacks
                const handlers = callbacks && callbacks.handlers ? callbacks.handlers : Array.isArray(callbacks) ? callbacks : []
                for (const handler of handlers) {
                    try {
                        if (call.model && typeof handler.handleLLMStart === 'function') {
                            await handler.handleLLMStart({ kwargs: { modelName: call.model } }, [call.prompt], call.runId)
                        }
                        if (call.model && typeof handler.handleLLMEnd === 'function') {
                            await handler.handleLLMEnd({
                                generations: [[{
                                    text: 'Loaf is ready.',
                                    message: {
                                        usage_metadata: { input_tokens: call.input, output_tokens: call.output },
                                        response_metadata: { model_name: call.model }
                                    }
                                }]]
                            }, call.runId)
                        }
                        if (call.tool && typeof handler.handleToolStart === 'function') {
                            await handler.handleToolStart({ name: call.tool.name }, 'rye', call.tool.runId, undefined, undefined, { tool_call_id: call.tool.id })
                        }
                        if (call.tool && typeof handler.handleToolEnd === 'function') {
                            await handler.handleToolEnd(call.tool.output, call.tool.runId)
                        }
                    } catch (error) {}
                }
            }
            `
        )
    })

    afterAll(async () => {
        clearTraceEnv()
        delete (global as { __cuttlelySeqMemory?: unknown }).__cuttlelySeqMemory
        delete (global as { __cuttlelySeqRound?: unknown }).__cuttlelySeqRound
        await shutdownCuttlelyTraces()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    beforeEach(() => {
        clearTraceEnv()
        memory.reset()
        ;(global as { __cuttlelySeqRound?: number }).__cuttlelySeqRound = 0
        ;(global as { __leadRound?: number }).__leadRound = 0
    })

    function dataSource() {
        const messages: Array<Record<string, any>> = []
        const executions: Array<Record<string, any>> = []
        const repo = (entity: { name?: string } | string) => {
            const table = typeof entity === 'function' ? entity.name : String(entity)
            if (table === 'ChatMessage') {
                return {
                    find: async () => messages,
                    findBy: async () => messages,
                    findOne: async () => messages[messages.length - 1] ?? null,
                    findOneBy: async () => messages[messages.length - 1] ?? null,
                    create: (value: unknown) => value,
                    save: async (value: Record<string, any>) => {
                        const row = { id: value.id || `msg-${messages.length + 1}`, ...value }
                        const index = messages.findIndex((message) => message.id === row.id)
                        if (index >= 0) messages[index] = { ...messages[index], ...row }
                        else messages.push(row)
                        return row
                    },
                    merge: (target: any, value: any) => Object.assign(target, value),
                    update: async () => ({ affected: 1 }),
                    createQueryBuilder: () => {
                        const qb: any = {
                            where: () => qb,
                            andWhere: () => qb,
                            orWhere: () => qb,
                            orderBy: () => qb,
                            getMany: async () => [...messages]
                        }
                        return qb
                    }
                }
            }
            if (table === 'Execution') {
                return {
                    find: async () => [...executions].reverse(),
                    findBy: async () => executions,
                    findOne: async () => executions[executions.length - 1] ?? null,
                    findOneBy: async (where?: { id?: string }) => executions.find((row) => !where?.id || row.id === where.id) ?? null,
                    create: (value: unknown) => value,
                    save: async (value: Record<string, any>) => {
                        const row = { id: value.id || `exec-${executions.length + 1}`, ...value }
                        const index = executions.findIndex((rowSaved) => rowSaved.id === row.id)
                        if (index >= 0) executions[index] = { ...executions[index], ...row }
                        else executions.push(row)
                        return row
                    },
                    merge: (target: any, value: any) => Object.assign(target, value),
                    update: async () => ({ affected: 1 }),
                    createQueryBuilder: () => {
                        const qb: any = {
                            where: () => qb,
                            andWhere: () => qb,
                            orWhere: () => qb,
                            orderBy: () => qb,
                            getMany: async () => []
                        }
                        return qb
                    }
                }
            }
            return {
                find: async () => [],
                findBy: async () => [],
                findOne: async () => null,
                findOneBy: async () => null,
                create: (value: unknown) => value,
                save: async (value: Record<string, unknown>) => value,
                merge: (target: any, value: any) => Object.assign(target, value),
                update: async () => ({ affected: 1 }),
                createQueryBuilder: () => {
                    const qb: any = { where: () => qb, andWhere: () => qb, orWhere: () => qb, orderBy: () => qb, getMany: async () => [] }
                    return qb
                }
            }
        }
        return { getRepository: repo, messages, executions }
    }

    function multiFlowData() {
        return JSON.stringify({
            nodes: [
                canvasNode('supervisor_0', 'supervisor', 'Multi Agents', { supervisorName: 'Lead' }),
                canvasNode('worker_0', 'worker', 'Multi Agents')
            ],
            edges: [{ id: 'e1', source: 'supervisor_0', target: 'worker_0' }]
        })
    }

    function seqFlowData() {
        return JSON.stringify({
            nodes: [
                canvasNode('seqStart_0', 'seqStart', 'Sequential Agents'),
                canvasNode('seqLLM_0', 'seqLLMNode', 'Sequential Agents', { interrupt: true, agentName: 'Baker' }),
                canvasNode('seqEnd_0', 'seqEnd', 'Sequential Agents')
            ],
            edges: [
                {
                    id: 'e1',
                    source: 'seqStart_0',
                    target: 'seqLLM_0',
                    sourceHandle: 'seqStart_0-output',
                    targetHandle: 'seqLLM_0-input-sequentialNode'
                },
                {
                    id: 'e2',
                    source: 'seqLLM_0',
                    target: 'seqEnd_0',
                    sourceHandle: 'seqLLM_0-output',
                    targetHandle: 'seqEnd_0-input-sequentialNode'
                }
            ]
        })
    }

    async function runMulti(streaming: boolean, chatId: string) {
        return executeFlow({
            componentNodes: { worker: { filePath: multiFile }, supervisor: { filePath: multiFile } },
            incomingInput: { question: 'When is the loaf ready?', streaming, history: [] },
            chatflow: {
                id: 'a1b2c3d4-1111-4111-8111-111111111111',
                name: 'Bakery team',
                type: 'MULTIAGENT',
                flowData: multiFlowData(),
                workspaceId: 'ws-1'
            },
            chatId,
            appDataSource: dataSource(),
            telemetry: { sendTelemetry: jest.fn() },
            cachePool: {},
            usageCacheManager: {},
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

    async function runSeq(
        question: string,
        chatId: string,
        action: Record<string, unknown> | undefined,
        source: ReturnType<typeof dataSource>,
        streamed: Array<Record<string, unknown>>
    ) {
        return executeFlow({
            componentNodes: {
                seqStart: { filePath: seqFile },
                seqLLMNode: { filePath: seqFile },
                seqEnd: { filePath: seqFile }
            },
            incomingInput: { question, streaming: false, history: [], ...(action ? { action } : {}) },
            chatflow: {
                id: 'b7c1a6f2-2222-4222-8222-222222222222',
                name: 'Bakery steps',
                type: 'MULTIAGENT',
                flowData: seqFlowData(),
                workspaceId: 'ws-1'
            },
            chatId,
            appDataSource: source,
            telemetry: { sendTelemetry: jest.fn() },
            cachePool: {},
            usageCacheManager: {},
            sseStreamer: new Proxy(
                {},
                {
                    get: (_target, name) => {
                        if (name === 'streamActionEvent') return (_chatId: string, data: Record<string, unknown>) => streamed.push(data)
                        return () => undefined
                    }
                }
            ),
            baseURL: 'http://127.0.0.1',
            isInternal: true,
            orgId: 'org-1',
            workspaceId: 'ws-1',
            subscriptionId: 'sub-1',
            productId: 'prod-1',
            replay: false
        } as any)
    }

    it('exports a Multi Agents tree whose model tokens sum to the step total', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        await runMulti(false, 'c0ffee00-0000-4000-8000-000000000061')
        const spans = memory.spans()
        const root = spans.find((span) => span.name === 'chatflow.prediction')
        expect(root?.attributes['flow.kind']).toBe('chatflow')
        expect(root?.attributes['flow.id']).toBe('a1b2c3d4-1111-4111-8111-111111111111')
        expect(root?.attributes['status']).toBe('ok')

        const executed = (id: string) =>
            spans.find(
                (span) =>
                    span.name === 'node' &&
                    span.attributes['node.id'] === id &&
                    spans.some((child) => child.parentSpanId === span.spanId && (child.name === 'model' || child.name === 'tool'))
            )
        const worker = executed('worker_0')
        const lead = executed('supervisor_0')
        expect(worker?.parentSpanId).toBe(root?.spanId)
        expect(lead?.parentSpanId).toBe(root?.spanId)
        expect(worker?.attributes['flow.id']).toBe(root?.attributes['flow.id'])

        const workerModels = spans.filter((span) => span.name === 'model' && span.parentSpanId === worker?.spanId)
        expect(workerModels.map((span) => span.attributes['model.name'])).toEqual(['gpt-4o-mini', 'gpt-4o-mini'])
        expect(tokenSum(spans, 'worker_0')).toEqual({ input: 22, output: 9 })
        expect(tokenSum(spans, 'supervisor_0')).toEqual({ input: 5, output: 2 })

        const tool = spans.find((span) => span.name === 'tool' && span.parentSpanId === worker?.spanId)
        expect(tool?.attributes['tool.name']).toBe('oven')
        expect(tool?.attributes['tool.id']).toBe('call-oven')
        expect(tool?.attributes['status']).toBe('ok')
        expect(contentKeys(spans)).toEqual([])
    })

    it('exports the same Multi Agents tree when the prediction streams', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        await runMulti(true, 'c0ffee00-0000-4000-8000-000000000062')
        expect(tokenSum(memory.spans(), 'worker_0')).toEqual({ input: 22, output: 9 })
        expect(memory.spans().find((span) => span.name === 'tool')?.attributes['tool.id']).toBe('call-oven')
    })

    it('exports that tree from the queue worker', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const queue = Object.create(PredictionQueue.prototype) as PredictionQueue
        ;(queue as any).redisPublisher = new Proxy(
            { connect: async () => undefined },
            { get: (target, prop) => (prop in target ? (target as any)[prop] : () => undefined) }
        )
        ;(queue as any).appDataSource = dataSource()
        ;(queue as any).componentNodes = { worker: { filePath: multiFile }, supervisor: { filePath: multiFile } }
        ;(queue as any).telemetry = { sendTelemetry: jest.fn() }
        ;(queue as any).cachePool = {}
        ;(queue as any).usageCacheManager = {}
        await queue.processJob({
            componentNodes: { worker: { filePath: multiFile }, supervisor: { filePath: multiFile } },
            incomingInput: { question: 'When is the loaf ready?', streaming: false, history: [] },
            chatflow: {
                id: 'a1b2c3d4-1111-4111-8111-111111111111',
                name: 'Bakery team',
                type: 'MULTIAGENT',
                flowData: multiFlowData(),
                workspaceId: 'ws-1'
            },
            chatId: 'c0ffee00-0000-4000-8000-000000000063',
            isInternal: true,
            orgId: 'org-1',
            workspaceId: 'ws-1',
            subscriptionId: 'sub-1',
            productId: 'prod-1',
            baseURL: 'http://127.0.0.1'
        } as any)
        const spans = memory.spans()
        expect(spans.find((span) => span.name === 'chatflow.prediction')?.attributes['status']).toBe('ok')
        expect(tokenSum(spans, 'worker_0')).toEqual({ input: 22, output: 9 })
        expect(spans.find((span) => span.name === 'tool')?.attributes['tool.name']).toBe('oven')
    })

    it('adds prompt text only when content is turned on', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'true'
        await runMulti(false, 'c0ffee00-0000-4000-8000-000000000064')
        const model = memory.spans().find((span) => span.name === 'model' && span.attributes['node.id'] === 'worker_0')
        expect(model?.attributes['content.input']).toContain('When is the loaf ready?')
        expect(model?.attributes['content.output']).toBe('Loaf is ready.')
    })

    it('continues a Sequential Agents approval on the same trace without putting trace ids on the action', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        process.env.CUTTLELY_OTEL_TRACES_CONTENT = 'false'
        const chatId = 'c0ffee00-0000-4000-8000-000000000065'
        const source = dataSource()
        const streamed: Array<Record<string, unknown>> = []
        const waiting = await runSeq('When is the loaf ready?', chatId, undefined, source, streamed)
        const action = waiting.action as { id?: string; traceId?: string; spanId?: string; mapping?: { approve?: string } }
        const waitingRoot = memory.spans().find((span) => span.name === 'chatflow.prediction' && !span.parentSpanId)
        expect(action.id).toBeTruthy()
        expect(action.traceId).toBeUndefined()
        expect(action.spanId).toBeUndefined()
        expect(action.mapping?.approve).toBe('Yes')
        expect(streamed[0]?.traceId).toBeUndefined()
        expect(streamed[0]?.spanId).toBeUndefined()
        const savedActions = source.messages.map((message) => message.action).filter((value) => typeof value === 'string')
        expect(savedActions.length).toBeGreaterThan(0)
        for (const saved of savedActions) {
            const parsed = JSON.parse(saved) as { traceId?: string; spanId?: string }
            expect(parsed.traceId).toBeUndefined()
            expect(parsed.spanId).toBeUndefined()
        }
        const pending = memory.spans().find((span) => span.name === 'tool' && span.attributes['tool.name'] === 'lookup')
        expect(pending?.attributes['status']).toBe('pending')
        expect(pending?.attributes['node.id']).toBe('seqLLM_0')

        const forged = { ...action, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
        const resumed = await runSeq('Yes', chatId, forged, source, streamed)
        expect(resumed.text).toBeTruthy()
        const spans = memory.spans()
        const roots = spans.filter((span) => span.name === 'chatflow.prediction')
        expect(roots).toHaveLength(2)
        expect(new Set(roots.map((span) => span.traceId)).size).toBe(1)
        const child = roots.find((span) => span.parentSpanId === waitingRoot?.spanId)
        expect(child?.traceId).toBe(waitingRoot?.traceId)
        expect(child?.traceId).not.toBe(forged.traceId)
        expect(child?.attributes['status']).toBe('ok')
        const ran = spans.filter((span) => span.name === 'tool' && span.attributes['status'] === 'ok')
        expect(ran).toHaveLength(1)
        const card = (resumed.agentReasoning as Array<{ nodeId?: string; usedTools?: unknown[] }>).find((step) => step.usedTools?.length)
        expect(ran[0].attributes['node.id']).toBe('seqLLM_0')
        expect(ran[0].attributes['node.id']).toBe(card?.nodeId)
        expect(ran[0].attributes['tool.id']).toBe('call-lookup')
        expect(spans.filter((span) => span.name === 'tool' && String(span.attributes['node.id']).startsWith('tool_'))).toEqual([])
        expect(contentKeys(spans)).toEqual([])
    })

    it('ignores a forged trace id on a chatflow approval and still continues the stored trace', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const flowId = 'a1b2c3d4-3333-4333-8333-333333333333'
        const chatId = 'c0ffee00-0000-4000-8000-000000000067'
        const source = dataSource()
        const chatFile = path.join(dir, 'plain-chat.js')
        fs.writeFileSync(chatFile, `exports.nodeClass = class { async init() { return this } async run() { return { text: 'ok' } } }\n`)
        await traceFlow('chatflow', flowId, async () => {
            rememberTraceContinuation(flowId, chatId, 'action-keep')
        })
        const waitingRoot = memory.spans().find((span) => span.name === 'chatflow.prediction')
        source.messages.push({
            id: 'msg-keep',
            chatId,
            chatflowid: flowId,
            action: JSON.stringify({ id: 'action-keep', mapping: { approve: 'Yes', reject: 'No', toolCalls: [] } })
        })
        const forgedTrace = 'a'.repeat(32)
        const forgedSpan = 'b'.repeat(16)
        await executeFlow({
            componentNodes: { llmChain: { filePath: chatFile } },
            incomingInput: {
                question: 'Yes',
                history: [],
                action: { id: 'action-keep', traceId: forgedTrace, spanId: forgedSpan }
            },
            chatflow: {
                id: flowId,
                name: 'Bakery chat',
                type: 'CHATFLOW',
                flowData: JSON.stringify({ nodes: [canvasNode('llmChain_0', 'llmChain', 'Chains')], edges: [] }),
                workspaceId: 'ws-1'
            },
            chatId,
            appDataSource: source,
            telemetry: { sendTelemetry: jest.fn() },
            cachePool: {},
            usageCacheManager: {},
            baseURL: 'http://127.0.0.1',
            isInternal: true,
            orgId: 'org-1',
            workspaceId: 'ws-1',
            subscriptionId: 'sub-1',
            productId: 'prod-1',
            replay: false
        } as any)
        const child = memory.spans().find((span) => span.name === 'chatflow.prediction' && span.parentSpanId === waitingRoot?.spanId)
        expect(child?.traceId).toBe(waitingRoot?.traceId)
        expect(child?.traceId).not.toBe(forgedTrace)
        expect(child?.parentSpanId).not.toBe(forgedSpan)

        memory.reset()
        await executeFlow({
            componentNodes: { llmChain: { filePath: chatFile } },
            incomingInput: {
                question: 'Yes',
                history: [],
                action: { id: 'not-stored', traceId: forgedTrace, spanId: forgedSpan }
            },
            chatflow: {
                id: flowId,
                name: 'Bakery chat',
                type: 'CHATFLOW',
                flowData: JSON.stringify({ nodes: [canvasNode('llmChain_0', 'llmChain', 'Chains')], edges: [] }),
                workspaceId: 'ws-1'
            },
            chatId,
            appDataSource: source,
            telemetry: { sendTelemetry: jest.fn() },
            cachePool: {},
            usageCacheManager: {},
            baseURL: 'http://127.0.0.1',
            isInternal: true,
            orgId: 'org-1',
            workspaceId: 'ws-1',
            subscriptionId: 'sub-1',
            productId: 'prod-1',
            replay: false
        } as any)
        const fresh = memory.spans().find((span) => span.name === 'chatflow.prediction')
        expect(fresh?.parentSpanId).toBeUndefined()
        expect(fresh?.traceId).not.toBe(forgedTrace)
    })

    it('continues an agentflow approval from the stored execution and ignores ids on that action', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const flowId = 'b7c1a6f2-4444-4444-8444-444444444444'
        const chatId = 'c0ffee00-0000-4000-8000-000000000068'
        const source = dataSource()
        const streamed: Array<Record<string, unknown>> = []
        const nodeFile = path.join(dir, 'human.js')
        fs.writeFileSync(
            nodeFile,
            `exports.nodeClass = class { async run(nodeData, input) { return { id: nodeData.id, name: nodeData.name, input: { question: input }, output: { content: 'ok' } } } }\n`
        )
        const nodes = [
            {
                id: 'startAgentflow_0',
                type: 'agentFlow',
                position: { x: 0, y: 0 },
                data: {
                    id: 'startAgentflow_0',
                    name: 'startAgentflow',
                    label: 'Start',
                    inputs: { startInputType: 'chatInput' },
                    inputParams: [],
                    inputAnchors: [],
                    outputAnchors: [],
                    outputs: {}
                }
            },
            {
                id: 'humanInputAgentflow_0',
                type: 'agentFlow',
                position: { x: 0, y: 0 },
                data: {
                    id: 'humanInputAgentflow_0',
                    name: 'humanInputAgentflow',
                    label: 'Ask',
                    inputs: {},
                    inputParams: [],
                    inputAnchors: [],
                    outputAnchors: [],
                    outputs: {}
                }
            }
        ]
        const flowData = JSON.stringify({
            nodes,
            edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'humanInputAgentflow_0' }]
        })
        const sseStreamer = new Proxy(
            {},
            {
                get: (_target, name) => {
                    if (name === 'streamActionEvent') return (_chatId: string, data: Record<string, unknown>) => streamed.push(data)
                    return () => undefined
                }
            }
        )
        const waiting = await executeAgentFlow({
            componentNodes: { startAgentflow: { filePath: nodeFile }, humanInputAgentflow: { filePath: nodeFile } },
            incomingInput: { question: 'When is the loaf ready?', streaming: false },
            chatflow: { id: flowId, name: 'Ask first', type: 'AGENTFLOW', flowData, workspaceId: 'ws-1' },
            chatId,
            appDataSource: source,
            telemetry: { sendTelemetry: jest.fn() },
            usageCacheManager: {},
            cachePool: {},
            sseStreamer,
            baseURL: 'http://127.0.0.1',
            isInternal: true,
            orgId: 'org-1',
            workspaceId: 'ws-1',
            subscriptionId: 'sub-1',
            productId: 'prod-1',
            replay: false
        } as any)
        const action = waiting.action as { id?: string; traceId?: string; spanId?: string }
        const waitingRoot = memory.spans().find((span) => span.name === 'agentflow.run' && !span.parentSpanId)
        expect(action.id).toBeTruthy()
        expect(action.traceId).toBeUndefined()
        expect(action.spanId).toBeUndefined()
        expect(streamed[0]?.traceId).toBeUndefined()
        const savedExecution = source.executions[source.executions.length - 1]
        const savedSteps = JSON.parse(savedExecution.executionData) as Array<{
            data?: { output?: { humanInputAction?: { traceId?: string; spanId?: string } } }
        }>
        const savedAction = [...savedSteps].reverse().find((step) => step.data?.output?.humanInputAction)?.data?.output?.humanInputAction
        expect(savedAction?.traceId).toBeUndefined()
        expect(savedAction?.spanId).toBeUndefined()
        savedAction!.traceId = 'c'.repeat(32)
        savedAction!.spanId = 'd'.repeat(16)
        savedExecution.executionData = JSON.stringify(savedSteps)

        const resumed = await executeAgentFlow({
            componentNodes: { startAgentflow: { filePath: nodeFile }, humanInputAgentflow: { filePath: nodeFile } },
            incomingInput: {
                question: 'Proceed',
                streaming: false,
                humanInput: { type: 'proceed', startNodeId: 'humanInputAgentflow_0' }
            },
            chatflow: { id: flowId, name: 'Ask first', type: 'AGENTFLOW', flowData, workspaceId: 'ws-1' },
            chatId,
            appDataSource: source,
            telemetry: { sendTelemetry: jest.fn() },
            usageCacheManager: {},
            cachePool: {},
            sseStreamer,
            baseURL: 'http://127.0.0.1',
            isInternal: true,
            orgId: 'org-1',
            workspaceId: 'ws-1',
            subscriptionId: 'sub-1',
            productId: 'prod-1',
            replay: false
        } as any)
        expect(resumed.text).toBeTruthy()
        const child = memory.spans().find((span) => span.name === 'agentflow.run' && span.parentSpanId === waitingRoot?.spanId)
        expect(child?.traceId).toBe(waitingRoot?.traceId)
        expect(child?.traceId).not.toBe('c'.repeat(32))
        expect(child?.parentSpanId).not.toBe('d'.repeat(16))
    })

    it('exports nothing for a Multi Agents run when traces are off', async () => {
        const node = async () => 'ok'
        expect(traceGraphNode('worker_0', 'worker', node)).toBe(node)
        await runMulti(false, 'c0ffee00-0000-4000-8000-000000000066')
        expect(memory.spans()).toEqual([])
    })
})
