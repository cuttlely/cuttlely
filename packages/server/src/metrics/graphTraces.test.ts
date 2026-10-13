/**
 * Multi Agents and Sequential Agents span trees. Traces are off unless CUTTLELY_OTEL_TRACES=true.
 */
import fs from 'fs'
import { createRequire } from 'module'
import os from 'os'
import path from 'path'
import { executeFlow } from '../utils/buildChatflow'
import { executeAgentFlow } from '../utils/buildAgentflow'
import { PredictionQueue } from '../queue/PredictionQueue'
import { ChatflowTokenUsage } from '../services/usage'
import logger from '../utils/logger'
import {
    installInMemoryTraces,
    rememberTraceContinuation,
    resetHeldToolsForTests,
    setTraceParentClock,
    shutdownCuttlelyTraces,
    TRACE_PARENT_TTL_MS,
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
                                await report(config, { tool: { name: 'Calculator', output: '4', runId: 'tool-calc' } })
                                return {
                                    messages: [new ToolMessage({
                                        name: 'Calculator',
                                        content: '4',
                                        tool_call_id: 'call-oven',
                                        additional_kwargs: {
                                            nodeId: nodeData.id,
                                            usedTools: [{ tool: 'Calculator', toolInput: { q: '2+2' }, toolOutput: '4' }]
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
                                    tool_calls: [{ id: 'call-oven', name: 'calculator', args: { q: '2+2' }, type: 'tool_call' }],
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
                            const metadata = call.tool.id ? { tool_call_id: call.tool.id } : undefined
                            await handler.handleToolStart({ name: call.tool.name }, '2+2', call.tool.runId, undefined, undefined, metadata)
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
        resetHeldToolsForTests()
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

    async function runConditionCanvas(
        outputAnchors: unknown[] | undefined,
        sourceHandle: string,
        flowId: string,
        chatId: string,
        route = 'Yes',
        moreHandles: string[] = []
    ) {
        const chainFile = path.join(dir, `chain-gate-${chatId.slice(-4)}.js`)
        fs.writeFileSync(chainFile, chainNodeSource(route))
        ;(global as { __chainModelSeen?: unknown[] }).__chainModelSeen = []
        const flowData = JSON.stringify({
            nodes: [
                canvasNode('seqStart_0', 'seqStart', 'Sequential Agents'),
                canvasNode('seqLLM_0', 'seqLLMNode', 'Sequential Agents'),
                {
                    ...canvasNode('seqConditionAgent_0', 'seqConditionAgent', 'Sequential Agents'),
                    data: {
                        ...canvasNode('seqConditionAgent_0', 'seqConditionAgent', 'Sequential Agents').data,
                        outputAnchors
                    }
                },
                canvasNode('seqEnd_0', 'seqEnd', 'Sequential Agents')
            ],
            edges: [
                { id: 'e1', source: 'seqStart_0', target: 'seqLLM_0', targetHandle: 'seqLLM_0-input-sequentialNode' },
                { id: 'e2', source: 'seqLLM_0', target: 'seqConditionAgent_0', targetHandle: 'seqConditionAgent_0-input-sequentialNode' },
                ...[sourceHandle, ...moreHandles].map((handle, index) => ({
                    id: `e3-${index}`,
                    source: 'seqConditionAgent_0',
                    target: 'seqEnd_0',
                    sourceHandle: handle,
                    targetHandle: 'seqEnd_0-input-sequentialNode'
                }))
            ]
        })
        await executeFlow({
            componentNodes: {
                seqStart: { filePath: chainFile },
                seqLLMNode: { filePath: chainFile },
                seqConditionAgent: { filePath: chainFile },
                seqEnd: { filePath: chainFile }
            },
            incomingInput: { question: 'Which way?', history: [] },
            chatflow: { id: flowId, name: 'Gate', type: 'MULTIAGENT', flowData, workspaceId: 'ws-1' },
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
        expect(spans.filter((span) => span.name === 'model' && span.attributes['node.id'] === 'supervisor_0')).toHaveLength(1)
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
        const action = waiting.action as {
            id?: string
            traceId?: string
            spanId?: string
            mapping?: { approve?: string }
            priorUsage?: Array<{ model: string; promptTokens: number; completionTokens: number }>
        }
        const waitingRoot = memory.spans().find((span) => span.name === 'chatflow.prediction' && !span.parentSpanId)
        expect(action.id).toBeTruthy()
        expect(action.traceId).toBeUndefined()
        expect(action.spanId).toBeUndefined()
        expect(action.mapping?.approve).toBe('Yes')
        expect(action.priorUsage).toEqual([{ model: 'gpt-4o-mini', promptTokens: 50, completionTokens: 20 }])
        expect(streamed[0]?.traceId).toBeUndefined()
        expect(streamed[0]?.spanId).toBeUndefined()
        const savedActions = source.messages.map((message) => message.action).filter((value) => typeof value === 'string')
        expect(savedActions.length).toBeGreaterThan(0)
        for (const saved of savedActions) {
            const parsed = JSON.parse(saved) as {
                traceId?: string
                spanId?: string
                priorUsage?: Array<{ model: string; promptTokens: number; completionTokens: number }>
            }
            expect(parsed.traceId).toBeUndefined()
            expect(parsed.spanId).toBeUndefined()
            if (parsed.priorUsage) expect(parsed.priorUsage).toEqual([{ model: 'gpt-4o-mini', promptTokens: 50, completionTokens: 20 }])
        }
        expect(savedActions.some((saved) => JSON.parse(saved).priorUsage)).toBe(true)

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
        const toolSpans = spans.filter((span) => span.name === 'tool')
        const ran = toolSpans.filter((span) => span.attributes['status'] === 'ok')
        expect(toolSpans.filter((span) => span.attributes['status'] === 'pending')).toEqual([])
        expect(ran).toHaveLength(1)
        const card = (resumed.agentReasoning as Array<{ nodeId?: string; usedTools?: unknown[] }>).find((step) => step.usedTools?.length)
        expect(ran[0].attributes['node.id']).toBe('seqLLM_0')
        expect(ran[0].attributes['node.id']).toBe(card?.nodeId)
        expect(ran[0].attributes['tool.id']).toBe('call-oven')
        expect(spans.filter((span) => span.name === 'tool' && String(span.attributes['node.id']).startsWith('tool_'))).toEqual([])
        expect(contentKeys(spans)).toEqual([])
    })

    it('ends a rejected Sequential Agents tool span as denied', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const chatId = 'c0ffee00-0000-4000-8000-00000000006a'
        const source = dataSource()
        const waiting = await runSeq('When is the loaf ready?', chatId, undefined, source, [])
        const resumed = await runSeq('No', chatId, waiting.action as Record<string, unknown>, source, [])
        expect(resumed.text).toBeTruthy()
        const tools = memory.spans().filter((span) => span.name === 'tool')
        expect(tools).toHaveLength(1)
        expect(tools[0].attributes['status']).toBe('denied')
        expect(tools[0].attributes['error']).toBe('denied')
        expect(tools[0].attributes['tool.id']).toBe('call-oven')
        expect(tools.filter((span) => span.attributes['status'] === 'pending')).toEqual([])
        expect(tools.filter((span) => span.attributes['status'] === 'ok')).toEqual([])
    })

    it('ends the waiting tool span as pending when the approval is not saved', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const chatId = 'c0ffee00-0000-4000-8000-00000000006b'
        const source = dataSource()
        const repo = source.getRepository.bind(source)
        source.getRepository = (entity: { name?: string } | string) => {
            const inner = repo(entity)
            const table = typeof entity === 'function' ? entity.name : String(entity)
            if (table !== 'ChatMessage') return inner
            return {
                ...inner,
                save: async (value: Record<string, any>) => {
                    if (value.action) throw new Error('approval was not saved')
                    return inner.save(value)
                }
            }
        }
        await expect(runSeq('When is the loaf ready?', chatId, undefined, source, [])).rejects.toThrow(/approval was not saved/)
        const tools = memory.spans().filter((span) => span.name === 'tool')
        expect(tools).toHaveLength(1)
        expect(tools[0].attributes['status']).toBe('pending')
        expect(tools[0].attributes['tool.id']).toBe('call-oven')
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

    it('exports one model span for a Condition Agent and does not record a wrapped step twice', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const gateFile = path.join(dir, 'gate.js')
        const anchor = JSON.stringify(path.join(__dirname, 'graphTraces.test.ts'))
        fs.writeFileSync(
            gateFile,
            `const { createRequire } = require('module')
            const req = createRequire(${anchor})
            const { START, END } = req('@langchain/langgraph')
            const { AIMessage } = req('@langchain/core/messages')
            exports.nodeClass = class {
                async init(nodeData) {
                    if (nodeData.name === 'seqStart') return { name: 'start', label: 'Start' }
                    if (nodeData.name === 'seqEnd') {
                        return { id: nodeData.id, node: END, name: END, label: 'End', type: 'end', predecessorAgents: [{ name: 'gate', type: 'condition' }] }
                    }
                    if (nodeData.name === 'seqConditionAgent') {
                        return {
                            id: nodeData.id,
                            name: 'gate',
                            label: 'Gate',
                            type: 'condition',
                            predecessorAgents: [{ name: 'baker' }],
                            node: async (_state, config) => {
                                await report(config, { model: 'gpt-4o-mini', input: 7, output: 3, runId: 'cond-1', prompt: 'Which way?' })
                                return 'Yes'
                            }
                        }
                    }
                    return {
                        id: nodeData.id,
                        name: 'baker',
                        label: 'Baker',
                        type: 'llm',
                        predecessorAgents: [{ name: START }],
                        node: async (_state, config) => {
                            await report(config, { model: 'gpt-4o-mini', input: 4, output: 1, runId: 'step-1', prompt: 'Ask' })
                            return { messages: [new AIMessage({ content: 'ask', additional_kwargs: { nodeId: nodeData.id } })] }
                        }
                    }
                }
            }
            async function report(config, call) {
                const callbacks = config && config.callbacks
                const handlers = callbacks && callbacks.handlers ? callbacks.handlers : Array.isArray(callbacks) ? callbacks : []
                for (const handler of handlers) {
                    try {
                        if (typeof handler.handleLLMStart === 'function') await handler.handleLLMStart({ kwargs: { modelName: call.model } }, [call.prompt], call.runId)
                        if (typeof handler.handleLLMEnd === 'function') {
                            await handler.handleLLMEnd({
                                generations: [[{ text: 'Yes', message: { usage_metadata: { input_tokens: call.input, output_tokens: call.output }, response_metadata: { model_name: call.model } } }]]
                            }, call.runId)
                        }
                    } catch (error) {}
                }
            }
            `
        )
        const flowData = JSON.stringify({
            nodes: [
                canvasNode('seqStart_0', 'seqStart', 'Sequential Agents'),
                canvasNode('seqLLM_0', 'seqLLMNode', 'Sequential Agents'),
                {
                    ...canvasNode('seqConditionAgent_0', 'seqConditionAgent', 'Sequential Agents'),
                    data: {
                        ...canvasNode('seqConditionAgent_0', 'seqConditionAgent', 'Sequential Agents').data,
                        outputAnchors: [{ options: [{ id: 'yes-handle', label: 'Yes' }] }]
                    }
                },
                canvasNode('seqEnd_0', 'seqEnd', 'Sequential Agents')
            ],
            edges: [
                { id: 'e1', source: 'seqStart_0', target: 'seqLLM_0', targetHandle: 'seqLLM_0-input-sequentialNode' },
                { id: 'e2', source: 'seqLLM_0', target: 'seqConditionAgent_0', targetHandle: 'seqConditionAgent_0-input-sequentialNode' },
                {
                    id: 'e3',
                    source: 'seqConditionAgent_0',
                    target: 'seqEnd_0',
                    sourceHandle: 'yes-handle',
                    targetHandle: 'seqEnd_0-input-sequentialNode'
                }
            ]
        })
        await executeFlow({
            componentNodes: {
                seqStart: { filePath: gateFile },
                seqLLMNode: { filePath: gateFile },
                seqConditionAgent: { filePath: gateFile },
                seqEnd: { filePath: gateFile }
            },
            incomingInput: { question: 'Which way?', history: [] },
            chatflow: {
                id: 'c8d2b7a3-5555-4555-8555-555555555555',
                name: 'Gate',
                type: 'MULTIAGENT',
                flowData,
                workspaceId: 'ws-1'
            },
            chatId: 'c0ffee00-0000-4000-8000-000000000069',
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
        const spans = memory.spans()
        const condition = spans.filter((span) => span.name === 'model' && span.attributes['node.id'] === 'seqConditionAgent_0')
        expect(condition).toHaveLength(1)
        expect(condition[0].attributes['tokens.input']).toBe(7)
        expect(condition[0].attributes['tokens.output']).toBe(3)
        const step = spans.filter((span) => span.name === 'model' && span.attributes['node.id'] === 'seqLLM_0')
        expect(step).toHaveLength(1)
        expect(step[0].attributes['tokens.input']).toBe(4)
        expect(step[0].attributes['tokens.output']).toBe(1)
    })

    it('starts a new agentflow trace when only an older stop is still stored', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const flowId = 'b7c1a6f2-6666-4666-8666-666666666666'
        const chatId = 'c0ffee00-0000-4000-8000-000000000070'
        const source = dataSource()
        const nodeFile = path.join(dir, 'two-stop.js')
        fs.writeFileSync(
            nodeFile,
            `exports.nodeClass = class { async run(nodeData, input) { return { id: nodeData.id, name: nodeData.name, input: { question: input }, output: { content: 'ok' } } } }\n`
        )
        await traceFlow('agentflow', flowId, async () => {
            rememberTraceContinuation(flowId, chatId, 'old-action')
        })
        const oldRoot = memory.spans().find((span) => span.name === 'agentflow.run')
        source.executions.push({
            id: 'exec-two',
            state: 'STOPPED',
            sessionId: chatId,
            agentflowId: flowId,
            workspaceId: 'ws-1',
            executionData: JSON.stringify([
                {
                    nodeId: 'humanA',
                    nodeLabel: 'First',
                    status: 'STOPPED',
                    data: { name: 'humanInputAgentflow', output: { humanInputAction: { id: 'old-action' } } },
                    previousNodeIds: []
                },
                {
                    nodeId: 'humanB',
                    nodeLabel: 'Second',
                    status: 'STOPPED',
                    data: { name: 'humanInputAgentflow', output: { humanInputAction: { id: 'new-action' } } },
                    previousNodeIds: []
                }
            ])
        })
        const human = (id: string, label: string) => ({
            id,
            type: 'agentFlow',
            position: { x: 0, y: 0 },
            data: {
                id,
                name: 'humanInputAgentflow',
                label,
                inputs: {},
                inputParams: [],
                inputAnchors: [],
                outputAnchors: [],
                outputs: {}
            }
        })
        const flowData = JSON.stringify({
            nodes: [
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
                human('humanA', 'First'),
                human('humanB', 'Second')
            ],
            edges: []
        })
        await executeAgentFlow({
            componentNodes: { startAgentflow: { filePath: nodeFile }, humanInputAgentflow: { filePath: nodeFile } },
            incomingInput: { question: 'Proceed', humanInput: { type: 'proceed', startNodeId: 'humanB' } },
            chatflow: { id: flowId, name: 'Two stops', type: 'AGENTFLOW', flowData, workspaceId: 'ws-1' },
            chatId,
            appDataSource: source,
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
        const resumed = memory.spans().filter((span) => span.name === 'agentflow.run' && span.spanId !== oldRoot?.spanId)
        expect(resumed).toHaveLength(1)
        expect(resumed[0].parentSpanId).toBeUndefined()
        expect(resumed[0].traceId).not.toBe(oldRoot?.traceId)
    })

    it('starts a new trace when the stored parent has expired', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const flowId = 'a1b2c3d4-7777-4777-8777-777777777777'
        const chatId = 'c0ffee00-0000-4000-8000-000000000071'
        const source = dataSource()
        const chatFile = path.join(dir, 'expired-chat.js')
        fs.writeFileSync(chatFile, `exports.nodeClass = class { async init() { return this } async run() { return { text: 'ok' } } }\n`)
        let now = 1_800_000_000_000
        setTraceParentClock(() => now)
        try {
            await traceFlow('chatflow', flowId, async () => {
                rememberTraceContinuation(flowId, chatId, 'action-expired')
            })
            source.messages.push({
                id: 'msg-expired',
                chatId,
                chatflowid: flowId,
                action: JSON.stringify({ id: 'action-expired' })
            })
            now += TRACE_PARENT_TTL_MS
            await executeFlow({
                componentNodes: { llmChain: { filePath: chatFile } },
                incomingInput: {
                    question: 'Yes',
                    history: [],
                    action: { id: 'action-expired', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
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
        } finally {
            setTraceParentClock()
        }
        const fresh = memory
            .spans()
            .filter((span) => span.name === 'chatflow.prediction')
            .at(-1)
        expect(fresh?.parentSpanId).toBeUndefined()
        expect(fresh?.traceId).not.toBe('a'.repeat(32))
    })

    it('exports nothing for a Multi Agents run when traces are off', async () => {
        const node = async () => 'ok'
        expect(traceGraphNode('worker_0', 'worker', node)).toBe(node)
        await runMulti(false, 'c0ffee00-0000-4000-8000-000000000066')
        expect(memory.spans()).toEqual([])
    })

    it('records one usage line and one model span from the same nested chain', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const lc = loadLangChain()
        const otel = countingOtel(lc.BaseCallbackHandler)
        const usage = new ChatflowTokenUsage()
        const parent = new lc.CallbackManager()
        parent.addHandler(otel, true)
        parent.addHandler(usage, true)
        const modelSeen: Array<{ step: number; otel: number }> = []
        const model = fakeChat(lc, { text: 'Yes', input: 7, output: 3, model: 'gpt-4o-mini', seen: modelSeen })
        const chain = lc.ChatPromptTemplate.fromMessages([['human', '{question}']]).pipe(model)
        let step: { handlers: Array<{ name?: string }>; inheritableHandlers: Array<{ name?: string }> } | undefined
        const node = traceGraphNode('worker_0', 'worker', async (_state: unknown, config: { callbacks?: typeof step }) => {
            step = config.callbacks
            await chain.invoke({ question: 'When is the loaf ready?' }, config)
            return 'ok'
        })
        await compileGraph(lc, node).invoke({ question: 'When is the loaf ready?' }, { callbacks: parent })
        expect(modelSeen).toEqual([{ step: 1, otel: 0 }])
        expect(otel.chats).toBe(0)
        expect(usage.sink).toEqual([{ model: 'gpt-4o-mini', promptTokens: 7, completionTokens: 3 }])
        const models = memory.spans().filter((span) => span.name === 'model')
        expect(models).toHaveLength(1)
        expect(models[0].attributes['tokens.input']).toBe(7)
        expect(models[0].attributes['tokens.output']).toBe(3)
        expect(handlerNames(step!.handlers)).toEqual(['cuttlely_otel', 'CuttlelyChatflowTokenUsage'])
        expect(handlerNames(step!.inheritableHandlers)).toEqual(['cuttlely_otel', 'CuttlelyChatflowTokenUsage'])
    })

    it('records one chat event from a nested chain and restores both callback lists', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const seen = await runNestedChain(false)
        expect(seen.model).toEqual([{ step: 1, otel: 0 }])
        expect(seen.otel.chats).toBe(0)
        expect(seen.otel.tools).toBe(0)
        expect(handlerNames(seen.step.handlers)).toEqual(['cuttlely_otel'])
        expect(handlerNames(seen.step.inheritableHandlers)).toEqual(['cuttlely_otel'])
        expect(handlerNames(seen.parent.handlers)).toEqual(['cuttlely_otel'])
        expect(handlerNames(seen.parent.inheritableHandlers)).toEqual(['cuttlely_otel'])
        const models = memory.spans().filter((span) => span.name === 'model')
        expect(models).toHaveLength(1)
        expect(models[0].attributes['model.name']).toBe('gpt-4o-mini')
        expect(models[0].attributes['tokens.input']).toBe(7)
        expect(models[0].attributes['tokens.output']).toBe(3)
        expect(models[0].attributes['node.id']).toBe('worker_0')
    })

    it('restores both callback lists when the graph node throws', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const seen = await runNestedChain(true)
        expect(seen.model).toEqual([{ step: 1, otel: 0 }])
        expect(seen.otel.chats).toBe(0)
        expect(handlerNames(seen.step.handlers)).toEqual(['cuttlely_otel'])
        expect(handlerNames(seen.step.inheritableHandlers)).toEqual(['cuttlely_otel'])
        expect(memory.spans().filter((span) => span.name === 'model')).toHaveLength(1)
    })

    it('records one tool event from an AgentExecutor call inside a graph node', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const lc = loadLangChain()
        const otel = countingOtel(lc.BaseCallbackHandler)
        const parent = new lc.CallbackManager()
        parent.addHandler(otel, true)
        const toolSeen: Array<{ step: number; otel: number }> = []
        let step: { handlers: Array<{ name?: string }>; inheritableHandlers: Array<{ name?: string }> } | undefined
        const tool = new lc.DynamicTool({
            name: 'oven',
            description: 'Heat the oven',
            func: async (_input: string, runManager: { handlers?: Array<{ name?: string }> }) => {
                toolSeen.push(countTraceHandlers(runManager?.handlers))
                return '350F'
            }
        })
        const executor = lc.AgentExecutor.fromAgentAndTools({
            agent: {
                inputKeys: ['input'],
                returnValues: ['output'],
                prepareForOutput: async () => ({}),
                plan: async (steps: unknown[]) =>
                    steps.length ? { returnValues: { output: 'ready' }, log: '' } : { tool: 'oven', toolInput: '350', log: 'heat' }
            },
            tools: [tool],
            maxIterations: 2
        })
        const node = traceGraphNode('worker_0', 'worker', async (_state: unknown, config: { callbacks?: unknown }) => {
            step = config.callbacks as typeof step
            await executor.invoke({ input: 'heat the oven' }, config)
            return 'ok'
        })
        await compileGraph(lc, node).invoke({ question: 'heat' }, { callbacks: parent })
        expect(toolSeen).toEqual([{ step: 1, otel: 0 }])
        expect(otel.tools).toBe(0)
        expect(otel.chats).toBe(0)
        expect(handlerNames(step!.handlers)).toEqual(['cuttlely_otel'])
        expect(handlerNames(step!.inheritableHandlers)).toEqual(['cuttlely_otel'])
        const tools = memory.spans().filter((span) => span.name === 'tool')
        expect(tools).toHaveLength(1)
        expect(tools[0].attributes['tool.name']).toBe('oven')
        expect(tools[0].attributes['node.id']).toBe('worker_0')
        expect(tools[0].attributes['status']).toBe('ok')
    })

    it('copies the tool call id when the callback name differs only by case', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const lc = loadLangChain()
        const node = traceGraphNode('worker_0', 'worker', async (_state: unknown, config: { callbacks?: { handlers?: any[] } }) => {
            const handlers = config.callbacks?.handlers ?? []
            for (const handler of handlers) {
                if (typeof handler.handleToolStart === 'function')
                    await handler.handleToolStart({ name: 'Calculator' }, '2+2', 'tool-run-1')
                if (typeof handler.handleToolEnd === 'function') await handler.handleToolEnd('4', 'tool-run-1')
            }
            return {
                messages: [
                    new lc.AIMessage({
                        content: '',
                        tool_calls: [{ id: 'call-oven', name: 'calculator', args: {}, type: 'tool_call' }]
                    })
                ]
            }
        }) as (state: unknown, config: unknown) => Promise<unknown>
        await traceFlow('chatflow', 'c8d2b7a3-5555-4555-8555-555555555591', async () => {
            await node({}, { callbacks: new lc.CallbackManager() })
            return { text: '4' }
        })
        const tools = memory.spans().filter((span) => span.name === 'tool')
        expect(tools).toHaveLength(1)
        expect(tools[0].attributes['tool.name']).toBe('Calculator')
        expect(tools[0].attributes['tool.id']).toBe('call-oven')
        expect(tools[0].attributes['status']).toBe('ok')
    })

    it('records the model tool call id when the worker returns usedTools without an id', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const lc = loadLangChain()
        const node = traceGraphNode('worker_0', 'worker', async (_state: unknown, config: { callbacks?: { handlers?: any[] } }) => {
            const handlers = config.callbacks?.handlers ?? []
            for (const handler of handlers) {
                if (typeof handler.handleLLMEnd === 'function') {
                    await handler.handleLLMEnd(
                        {
                            generations: [
                                [
                                    {
                                        message: {
                                            tool_calls: [{ id: 'call-oven', name: 'calculator', args: { q: '2+2' }, type: 'tool_call' }],
                                            usage_metadata: { input_tokens: 3, output_tokens: 1 }
                                        }
                                    }
                                ]
                            ]
                        },
                        'worker-model'
                    )
                }
                if (typeof handler.handleToolStart === 'function')
                    await handler.handleToolStart({ name: 'Calculator' }, '2+2', 'worker-tool')
                if (typeof handler.handleToolEnd === 'function') await handler.handleToolEnd('4', 'worker-tool')
            }
            return {
                messages: [
                    new lc.HumanMessage({
                        content: '4',
                        name: 'baker',
                        additional_kwargs: {
                            nodeId: 'worker_0',
                            type: 'worker',
                            usedTools: [{ tool: 'Calculator', toolInput: { q: '2+2' }, toolOutput: '4' }]
                        }
                    })
                ]
            }
        }) as (state: unknown, config: unknown) => Promise<unknown>
        await traceFlow('chatflow', 'c8d2b7a3-5555-4555-8555-555555555595', async () => {
            await node({}, { callbacks: new lc.CallbackManager() })
            return { text: '4' }
        })
        const tools = memory.spans().filter((span) => span.name === 'tool')
        expect(tools).toHaveLength(1)
        expect(tools[0].attributes['tool.name']).toBe('Calculator')
        expect(tools[0].attributes['tool.id']).toBe('call-oven')
        expect(tools[0].attributes['node.id']).toBe('worker_0')
        expect(tools[0].attributes['status']).toBe('ok')
    })

    async function toolSpansFor(
        flowId: string,
        starts: Array<{ name: string; runId: string; metadata?: Record<string, string> }>,
        calls: Array<{ id: string; name: string }>
    ) {
        const lc = loadLangChain()
        const node = traceGraphNode('worker_0', 'worker', async (_state: unknown, config: { callbacks?: { handlers?: any[] } }) => {
            const handlers = config.callbacks?.handlers ?? []
            for (const handler of handlers) {
                for (const start of starts) {
                    if (typeof handler.handleToolStart === 'function') {
                        await handler.handleToolStart({ name: start.name }, 'x', start.runId, undefined, undefined, start.metadata)
                    }
                    if (typeof handler.handleToolEnd === 'function') await handler.handleToolEnd('ok', start.runId)
                }
            }
            return {
                messages: [
                    new lc.AIMessage({
                        content: '',
                        tool_calls: calls.map((call) => ({ id: call.id, name: call.name, args: {}, type: 'tool_call' }))
                    })
                ]
            }
        }) as (state: unknown, config: unknown) => Promise<unknown>
        await traceFlow('chatflow', flowId, async () => {
            await node({}, { callbacks: new lc.CallbackManager() })
            return { text: 'ok' }
        })
        return memory.spans().filter((span) => span.name === 'tool')
    }

    it('does not reuse a tool call id that another callback in the step already has', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const tools = await toolSpansFor(
            'c8d2b7a3-5555-4555-8555-555555555592',
            [
                { name: 'calculator', runId: 'run-lower', metadata: { tool_call_id: 'call-lower' } },
                { name: 'Calculator', runId: 'run-upper' }
            ],
            [
                { id: 'call-lower', name: 'calculator' },
                { id: 'call-upper', name: 'Calculator' }
            ]
        )
        expect(tools.map((span) => [span.attributes['tool.name'], span.attributes['tool.id'], span.attributes['status']])).toEqual([
            ['calculator', 'call-lower', 'ok'],
            ['Calculator', 'call-upper', 'ok']
        ])
        expect(tools.filter((span) => span.attributes['status'] === 'pending')).toEqual([])
    })

    it('keeps separate call ids for Read and read', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const tools = await toolSpansFor(
            'c8d2b7a3-5555-4555-8555-555555555593',
            [
                { name: 'Read', runId: 'run-read' },
                { name: 'read', runId: 'run-lower' }
            ],
            [
                { id: 'call-lower', name: 'read' },
                { id: 'call-upper', name: 'Read' }
            ]
        )
        expect(tools.map((span) => [span.attributes['tool.name'], span.attributes['tool.id']])).toEqual([
            ['Read', 'call-upper'],
            ['read', 'call-lower']
        ])
    })

    it('gives each oven call its own id and leaves neither pending', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const tools = await toolSpansFor(
            'c8d2b7a3-5555-4555-8555-555555555594',
            [
                { name: 'oven', runId: 'run-1', metadata: { tool_call_id: 'call-1' } },
                { name: 'oven', runId: 'run-2' }
            ],
            [
                { id: 'call-1', name: 'oven' },
                { id: 'call-2', name: 'oven' }
            ]
        )
        expect(tools.map((span) => [span.attributes['tool.id'], span.attributes['status']])).toEqual([
            ['call-1', 'ok'],
            ['call-2', 'ok']
        ])
    })

    it('marks the run span error when a graph node throws and the run continues', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        await traceFlow('chatflow', 'c8d2b7a3-5555-4555-8555-555555555590', async () => {
            const node = traceGraphNode('supervisor_0', 'supervisor', async () => {
                throw new Error('Aborted!')
            }) as (state: unknown, config: unknown) => Promise<unknown>
            try {
                await node({}, {})
            } catch {
                // A graph that stops on this error still returns the steps it finished.
            }
            return { text: '' }
        })
        const root = memory.spans().find((span) => span.name === 'chatflow.prediction')
        const node = memory.spans().find((span) => span.name === 'node' && span.attributes['node.id'] === 'supervisor_0')
        expect(node?.attributes['status']).toBe('error')
        expect(node?.attributes['error']).toBe('Aborted!')
        expect(root?.attributes['status']).toBe('error')
        expect(root?.attributes['error']).toBe('Aborted!')
    })

    it('does not attach the collector twice when the callback lists are one array', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const lc = loadLangChain()
        const otel = countingOtel(lc.BaseCallbackHandler)
        const shared: object[] = [otel]
        const parent = new lc.CallbackManager(undefined, { handlers: shared, inheritableHandlers: shared })
        const modelSeen: Array<{ step: number; otel: number }> = []
        const model = fakeChat(lc, { text: 'Yes', input: 7, output: 3, model: 'gpt-4o-mini', seen: modelSeen })
        const chain = lc.ChatPromptTemplate.fromMessages([['human', '{question}']]).pipe(model)
        const node = traceGraphNode('seqConditionAgent_0', 'seqConditionAgent', async (_state: unknown, config: unknown) => {
            await chain.invoke({ question: 'Which way?' }, config)
            return 'Yes'
        }) as (state: unknown, config: unknown) => Promise<unknown>
        await node({}, { callbacks: parent })
        expect(modelSeen).toEqual([{ step: 1, otel: 0 }])
        expect(otel.chats).toBe(0)
        expect(parent.handlers).toBe(parent.inheritableHandlers)
        expect(handlerNames(parent.handlers)).toEqual(['cuttlely_otel'])
        expect(memory.spans().filter((span) => span.name === 'model')).toHaveLength(1)
    })

    it('exports a Condition Agent model span from the route chain', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const chainFile = path.join(dir, 'chain-gate.js')
        fs.writeFileSync(chainFile, chainNodeSource())
        ;(global as { __chainModelSeen?: unknown[] }).__chainModelSeen = []
        const flowData = JSON.stringify({
            nodes: [
                canvasNode('seqStart_0', 'seqStart', 'Sequential Agents'),
                canvasNode('seqLLM_0', 'seqLLMNode', 'Sequential Agents'),
                {
                    ...canvasNode('seqConditionAgent_0', 'seqConditionAgent', 'Sequential Agents'),
                    data: {
                        ...canvasNode('seqConditionAgent_0', 'seqConditionAgent', 'Sequential Agents').data,
                        outputAnchors: [{ options: [{ id: 'yes-handle', label: 'Yes' }] }]
                    }
                },
                canvasNode('seqEnd_0', 'seqEnd', 'Sequential Agents')
            ],
            edges: [
                { id: 'e1', source: 'seqStart_0', target: 'seqLLM_0', targetHandle: 'seqLLM_0-input-sequentialNode' },
                { id: 'e2', source: 'seqLLM_0', target: 'seqConditionAgent_0', targetHandle: 'seqConditionAgent_0-input-sequentialNode' },
                {
                    id: 'e3',
                    source: 'seqConditionAgent_0',
                    target: 'seqEnd_0',
                    sourceHandle: 'yes-handle',
                    targetHandle: 'seqEnd_0-input-sequentialNode'
                }
            ]
        })
        await executeFlow({
            componentNodes: {
                seqStart: { filePath: chainFile },
                seqLLMNode: { filePath: chainFile },
                seqConditionAgent: { filePath: chainFile },
                seqEnd: { filePath: chainFile }
            },
            incomingInput: { question: 'Which way?', history: [] },
            chatflow: {
                id: 'c8d2b7a3-5555-4555-8555-555555555581',
                name: 'Gate',
                type: 'MULTIAGENT',
                flowData,
                workspaceId: 'ws-1'
            },
            chatId: 'c0ffee00-0000-4000-8000-000000000081',
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
        const seen = (global as { __chainModelSeen?: Array<{ step: number; otel: number; node: string }> }).__chainModelSeen ?? []
        expect(seen.filter((row) => row.node === 'seqConditionAgent')).toEqual([{ step: 1, otel: 0, node: 'seqConditionAgent' }])
        expect(seen.filter((row) => row.node === 'seqLLMNode')).toEqual([{ step: 1, otel: 0, node: 'seqLLMNode' }])
        const spans = memory.spans()
        const condition = spans.filter((span) => span.name === 'model' && span.attributes['node.id'] === 'seqConditionAgent_0')
        expect(condition).toHaveLength(1)
        expect(condition[0].attributes['tokens.input']).toBe(7)
        expect(condition[0].attributes['tokens.output']).toBe(3)
        const step = spans.filter((span) => span.name === 'model' && span.attributes['node.id'] === 'seqLLM_0')
        expect(step).toHaveLength(1)
        expect(step[0].attributes['tokens.input']).toBe(4)
        expect(step[0].attributes['tokens.output']).toBe(1)
    })

    it('exports a Condition Agent model span from the anchors the canvas saves', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        await runConditionCanvas(
            [
                {
                    name: 'output',
                    label: 'Output',
                    type: 'options',
                    options: [
                        {
                            id: 'seqConditionAgent_0-output-yes-Condition',
                            name: 'yes',
                            label: 'Yes',
                            type: 'Condition',
                            isAnchor: true
                        }
                    ]
                }
            ],
            'seqConditionAgent_0-output-yes-Condition',
            'c8d2b7a3-5555-4555-8555-555555555582',
            'c0ffee00-0000-4000-8000-000000000083'
        )
        const condition = memory.spans().filter((span) => span.name === 'model' && span.attributes['node.id'] === 'seqConditionAgent_0')
        expect(condition).toHaveLength(1)
        expect(condition[0].attributes['tokens.input']).toBe(7)
        expect(condition[0].attributes['tokens.output']).toBe(3)
    })

    it('routes a Condition Agent to Concierge from the option label and records the model span', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const handle = 'seqConditionAgent_0-output-concierge-Condition'
        await runConditionCanvas(
            [
                {
                    name: 'output',
                    label: 'Output',
                    type: 'options',
                    options: [{ id: handle, name: 'concierge', label: 'Concierge', type: 'Condition', isAnchor: true }]
                }
            ],
            handle,
            'c8d2b7a3-5555-4555-8555-555555555584',
            'c0ffee00-0000-4000-8000-000000000085',
            'Concierge'
        )
        const condition = memory.spans().filter((span) => span.name === 'model' && span.attributes['node.id'] === 'seqConditionAgent_0')
        expect(condition).toHaveLength(1)
    })

    it.each([
        ['yes', 'seqConditionAgent_0-output-yes-Condition', 'c8d2b7a3-5555-4555-8555-555555555591', 'c0ffee00-0000-4000-8000-000000000091'],
        ['YES', 'seqConditionAgent_0-output-yes-Condition', 'c8d2b7a3-5555-4555-8555-555555555592', 'c0ffee00-0000-4000-8000-000000000092'],
        ['OK', 'seqConditionAgent_0-output-ok-Condition', 'c8d2b7a3-5555-4555-8555-555555555593', 'c0ffee00-0000-4000-8000-000000000093'],
        [
            'foo_bar',
            'seqConditionAgent_0-output-foo_bar-Condition',
            'c8d2b7a3-5555-4555-8555-555555555594',
            'c0ffee00-0000-4000-8000-000000000094'
        ],
        [
            'well-known',
            'seqConditionAgent_0-output-well-known-Condition',
            'c8d2b7a3-5555-4555-8555-555555555595',
            'c0ffee00-0000-4000-8000-000000000095'
        ]
    ])('does not guess a condition route for %s', async (route, handle, flowId, chatId) => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const warnBefore = (logger.warn as unknown as jest.Mock).mock.calls.length
        await expect(runConditionCanvas(undefined, handle, flowId, chatId, route)).rejects.toThrow(/dead-end/)
        const warnings = (logger.warn as unknown as jest.Mock).mock.calls.slice(warnBefore).map((call: unknown[]) => String(call[0]))
        expect(warnings.filter((line: string) => line.includes('condition route'))).toEqual([
            'Skipped a condition route because its label is not stored on the canvas.'
        ])
        expect(memory.spans().filter((span) => span.name === 'model' && span.attributes['node.id'] === 'seqConditionAgent_0')).toEqual([])
    })

    it('logs one skipped condition route when several edges have no stored label', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const warnBefore = (logger.warn as unknown as jest.Mock).mock.calls.length
        await expect(
            runConditionCanvas(
                undefined,
                'seqConditionAgent_0-output-yes-Condition',
                'c8d2b7a3-5555-4555-8555-555555555596',
                'c0ffee00-0000-4000-8000-000000000096',
                'yes',
                ['seqConditionAgent_0-output-foo_bar-Condition', 'seqConditionAgent_0-output-well-known-Condition']
            )
        ).rejects.toThrow(/dead-end/)
        const warnings = (logger.warn as unknown as jest.Mock).mock.calls
            .slice(warnBefore)
            .map((call: unknown[]) => String(call[0]))
            .filter((line: string) => line.includes('condition route'))
        expect(warnings).toHaveLength(1)
    })

    it.each([
        ['yes', 'yes', 'c8d2b7a3-5555-4555-8555-5555555555a1', 'c0ffee00-0000-4000-8000-0000000000a1'],
        ['YES', 'yes', 'c8d2b7a3-5555-4555-8555-5555555555a2', 'c0ffee00-0000-4000-8000-0000000000a2'],
        ['OK', 'ok', 'c8d2b7a3-5555-4555-8555-5555555555a3', 'c0ffee00-0000-4000-8000-0000000000a3'],
        ['foo_bar', 'foo_bar', 'c8d2b7a3-5555-4555-8555-5555555555a4', 'c0ffee00-0000-4000-8000-0000000000a4'],
        ['well-known', 'well-known', 'c8d2b7a3-5555-4555-8555-5555555555a5', 'c0ffee00-0000-4000-8000-0000000000a5'],
        ['Yes', 'yes', 'c8d2b7a3-5555-4555-8555-5555555555a6', 'c0ffee00-0000-4000-8000-0000000000a6'],
        ['Ok', 'ok', 'c8d2b7a3-5555-4555-8555-5555555555a7', 'c0ffee00-0000-4000-8000-0000000000a7'],
        ['No', 'no', 'c8d2b7a3-5555-4555-8555-5555555555a8', 'c0ffee00-0000-4000-8000-0000000000a8'],
        ['Concierge', 'concierge', 'c8d2b7a3-5555-4555-8555-5555555555a9', 'c0ffee00-0000-4000-8000-0000000000a9']
    ])('routes a saved condition option for %s', async (route, name, flowId, chatId) => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const handle = `seqConditionAgent_0-output-${name}-Condition`
        const warnBefore = (logger.warn as unknown as jest.Mock).mock.calls.length
        await runConditionCanvas(
            [
                {
                    name: 'output',
                    label: 'Output',
                    type: 'options',
                    options: [{ id: handle, name, label: route, type: 'Condition', isAnchor: true }]
                }
            ],
            handle,
            flowId,
            chatId,
            route
        )
        const warnings = (logger.warn as unknown as jest.Mock).mock.calls
            .slice(warnBefore)
            .map((call: unknown[]) => String(call[0]))
            .filter((line: string) => line.includes('condition route'))
        expect(warnings).toEqual([])
        const condition = memory.spans().filter((span) => span.name === 'model' && span.attributes['node.id'] === 'seqConditionAgent_0')
        expect(condition).toHaveLength(1)
    })

    it.each([
        ['yes', 'seqConditionAgent_0-output-yes-Condition', 'c8d2b7a3-5555-4555-8555-5555555555b1', 'c0ffee00-0000-4000-8000-0000000000b1'],
        ['YES', 'seqConditionAgent_0-output-yes-Condition', 'c8d2b7a3-5555-4555-8555-5555555555b2', 'c0ffee00-0000-4000-8000-0000000000b2'],
        ['OK', 'seqConditionAgent_0-output-ok-Condition', 'c8d2b7a3-5555-4555-8555-5555555555b3', 'c0ffee00-0000-4000-8000-0000000000b3'],
        [
            'foo_bar',
            'seqConditionAgent_0-output-foo_bar-Condition',
            'c8d2b7a3-5555-4555-8555-5555555555b4',
            'c0ffee00-0000-4000-8000-0000000000b4'
        ],
        [
            'well-known',
            'seqConditionAgent_0-output-well-known-Condition',
            'c8d2b7a3-5555-4555-8555-5555555555b5',
            'c0ffee00-0000-4000-8000-0000000000b5'
        ]
    ])('routes a condition anchor whose stored label is %s', async (route, handle, flowId, chatId) => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        await runConditionCanvas([{ id: handle, label: route }], handle, flowId, chatId, route)
        const condition = memory.spans().filter((span) => span.name === 'model' && span.attributes['node.id'] === 'seqConditionAgent_0')
        expect(condition).toHaveLength(1)
    })

    it('exports Multi Agents model spans from the supervisor chain and the worker tool', async () => {
        process.env.CUTTLELY_OTEL_TRACES = 'true'
        const chainFile = path.join(dir, 'chain-multi.js')
        fs.writeFileSync(chainFile, multiChainSource())
        ;(global as { __chainModelSeen?: unknown[]; __chainToolSeen?: unknown[]; __leadRound?: number }).__chainModelSeen = []
        ;(global as { __chainToolSeen?: unknown[] }).__chainToolSeen = []
        ;(global as { __leadRound?: number }).__leadRound = 0
        await executeFlow({
            componentNodes: { worker: { filePath: chainFile }, supervisor: { filePath: chainFile } },
            incomingInput: { question: 'When is the loaf ready?', history: [] },
            chatflow: {
                id: 'a1b2c3d4-1111-4111-8111-111111111181',
                name: 'Bakery team',
                type: 'MULTIAGENT',
                flowData: multiFlowData(),
                workspaceId: 'ws-1'
            },
            chatId: 'c0ffee00-0000-4000-8000-000000000082',
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
        const modelsSeen = (global as { __chainModelSeen?: Array<{ step: number; otel: number; node: string }> }).__chainModelSeen ?? []
        const toolsSeen = (global as { __chainToolSeen?: Array<{ step: number; otel: number }> }).__chainToolSeen ?? []
        expect(modelsSeen).toEqual([
            { step: 1, otel: 0, node: 'supervisor' },
            { step: 1, otel: 0, node: 'worker' }
        ])
        expect(toolsSeen).toEqual([{ step: 1, otel: 0 }])
        const spans = memory.spans()
        const lead = spans.filter((span) => span.name === 'model' && span.attributes['node.id'] === 'supervisor_0')
        expect(lead).toHaveLength(1)
        expect(lead[0].attributes['tokens.input']).toBe(5)
        expect(lead[0].attributes['tokens.output']).toBe(2)
        const worker = spans.filter((span) => span.name === 'model' && span.attributes['node.id'] === 'worker_0')
        expect(worker).toHaveLength(1)
        expect(worker[0].attributes['tokens.input']).toBe(11)
        expect(worker[0].attributes['tokens.output']).toBe(4)
        const tool = spans.filter((span) => span.name === 'tool' && span.attributes['node.id'] === 'worker_0')
        expect(tool).toHaveLength(1)
        expect(tool[0].attributes['tool.name']).toBe('oven')
        expect(tool[0].attributes['status']).toBe('ok')
    })
})

const requireHere = createRequire(__filename)

function loadLangChain() {
    return {
        Graph: requireHere('@langchain/langgraph').Graph,
        START: requireHere('@langchain/langgraph').START,
        END: requireHere('@langchain/langgraph').END,
        CallbackManager: requireHere('@langchain/core/callbacks/manager').CallbackManager,
        BaseCallbackHandler: requireHere('@langchain/core/callbacks/base').BaseCallbackHandler,
        ChatPromptTemplate: requireHere('@langchain/core/prompts').ChatPromptTemplate,
        BaseChatModel: requireHere('@langchain/core/language_models/chat_models').BaseChatModel,
        AIMessage: requireHere('@langchain/core/messages').AIMessage,
        HumanMessage: requireHere('@langchain/core/messages').HumanMessage,
        DynamicTool: requireHere('@langchain/core/tools').DynamicTool,
        AgentExecutor: requireHere(path.join(__dirname, '../../../components/dist/src/agents.js')).AgentExecutor
    }
}

function handlerNames(list: Array<{ name?: string }> | undefined): string[] {
    return (list ?? []).map((handler) => handler?.name ?? '')
}

function countTraceHandlers(list: Array<{ name?: string }> | undefined): { step: number; otel: number } {
    const names = handlerNames(list)
    return {
        step: names.filter((name) => name === 'cuttlely_graph_step').length,
        otel: names.filter((name) => name === 'cuttlely_otel').length
    }
}

function countingOtel(BaseCallbackHandler: new () => { name: string }) {
    return new (class extends BaseCallbackHandler {
        name = 'cuttlely_otel'
        chats = 0
        tools = 0
        async handleChatModelStart() {
            this.chats += 1
        }
        async handleLLMStart() {
            this.chats += 1
        }
        async handleToolStart() {
            this.tools += 1
        }
    })()
}

function fakeChat(
    lc: ReturnType<typeof loadLangChain>,
    fields: { text: string; input: number; output: number; model: string; seen: Array<{ step: number; otel: number }> }
) {
    const Model = class extends lc.BaseChatModel {
        constructor() {
            super({})
        }
        _llmType() {
            return 'fake-chat'
        }
        async _generate(_messages: unknown, _options: unknown, runManager?: { handlers?: Array<{ name?: string }> }) {
            fields.seen.push(countTraceHandlers(runManager?.handlers))
            return {
                llmOutput: { tokenUsage: { promptTokens: fields.input, completionTokens: fields.output } },
                generations: [
                    {
                        text: fields.text,
                        message: new lc.AIMessage({
                            content: fields.text,
                            usage_metadata: {
                                input_tokens: fields.input,
                                output_tokens: fields.output,
                                total_tokens: fields.input + fields.output
                            },
                            response_metadata: { model_name: fields.model }
                        })
                    }
                ]
            }
        }
    }
    return new Model()
}

function compileGraph(lc: ReturnType<typeof loadLangChain>, node: unknown) {
    return new lc.Graph().addNode('step', node).addEdge(lc.START, 'step').addEdge('step', lc.END).compile()
}

async function runNestedChain(throwAfter: boolean) {
    const lc = loadLangChain()
    const otel = countingOtel(lc.BaseCallbackHandler)
    const parent = new lc.CallbackManager()
    parent.addHandler(otel, true)
    const modelSeen: Array<{ step: number; otel: number }> = []
    const model = fakeChat(lc, { text: 'Yes', input: 7, output: 3, model: 'gpt-4o-mini', seen: modelSeen })
    const chain = lc.ChatPromptTemplate.fromMessages([['human', '{question}']]).pipe(model)
    let step: { handlers: Array<{ name?: string }>; inheritableHandlers: Array<{ name?: string }> } | undefined
    const node = traceGraphNode('worker_0', 'worker', async (_state: unknown, config: { callbacks?: typeof step }) => {
        step = config.callbacks
        await chain.invoke({ question: 'When is the loaf ready?' }, config)
        if (throwAfter) throw new Error('step failed')
        return 'ok'
    })
    const graph = compileGraph(lc, node)
    if (throwAfter)
        await expect(graph.invoke({ question: 'When is the loaf ready?' }, { callbacks: parent })).rejects.toThrow('step failed')
    else await graph.invoke({ question: 'When is the loaf ready?' }, { callbacks: parent })
    return { model: modelSeen, otel, step: step!, parent }
}

function chainNodeSource(route = 'Yes'): string {
    const anchor = JSON.stringify(path.join(__dirname, 'graphTraces.test.ts'))
    return `const { createRequire } = require('module')
const req = createRequire(${anchor})
const { START, END } = req('@langchain/langgraph')
const { AIMessage } = req('@langchain/core/messages')
const { ChatPromptTemplate } = req('@langchain/core/prompts')
const { BaseChatModel } = req('@langchain/core/language_models/chat_models')
function fake(nodeName, text, input, output) {
    return new (class extends BaseChatModel {
        constructor() { super({}) }
        _llmType() { return 'fake-chat' }
        async _generate(_messages, _options, runManager) {
            const names = (runManager && runManager.handlers ? runManager.handlers : []).map((handler) => handler && handler.name)
            global.__chainModelSeen.push({
                step: names.filter((name) => name === 'cuttlely_graph_step').length,
                otel: names.filter((name) => name === 'cuttlely_otel').length,
                node: nodeName
            })
            return {
                llmOutput: { tokenUsage: { promptTokens: input, completionTokens: output } },
                generations: [{
                    text,
                    message: new AIMessage({
                        content: text,
                        usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
                        response_metadata: { model_name: 'gpt-4o-mini' }
                    })
                }]
            }
        }
    })()
}
exports.nodeClass = class {
    async init(nodeData) {
        if (nodeData.name === 'seqStart') return { name: 'start', label: 'Start' }
        if (nodeData.name === 'seqEnd') {
            return { id: nodeData.id, node: END, name: END, label: 'End', type: 'end', predecessorAgents: [{ name: 'gate', type: 'condition' }] }
        }
        if (nodeData.name === 'seqConditionAgent') {
            return {
                id: nodeData.id,
                name: 'gate',
                label: 'Gate',
                type: 'condition',
                predecessorAgents: [{ name: 'baker' }],
                node: async (_state, config) => {
                    await ChatPromptTemplate.fromMessages([['human', '{question}']]).pipe(fake('seqConditionAgent', ${JSON.stringify(
                        route
                    )}, 7, 3)).invoke({ question: 'Which way?' }, config)
                    return ${JSON.stringify(route)}
                }
            }
        }
        return {
            id: nodeData.id,
            name: 'baker',
            label: 'Baker',
            type: 'llm',
            predecessorAgents: [{ name: START }],
            node: async (_state, config) => {
                await ChatPromptTemplate.fromMessages([['human', '{question}']]).pipe(fake('seqLLMNode', 'ask', 4, 1)).invoke({ question: 'Ask' }, config)
                return { messages: [new AIMessage({ content: 'ask', additional_kwargs: { nodeId: nodeData.id } })] }
            }
        }
    }
}
`
}

function multiChainSource(): string {
    const anchor = JSON.stringify(path.join(__dirname, 'graphTraces.test.ts'))
    const agents = JSON.stringify(path.join(__dirname, '../../../components/dist/src/agents.js'))
    return `const { createRequire } = require('module')
const req = createRequire(${anchor})
const { HumanMessage, AIMessage } = req('@langchain/core/messages')
const { ChatPromptTemplate } = req('@langchain/core/prompts')
const { BaseChatModel } = req('@langchain/core/language_models/chat_models')
const { DynamicTool } = req('@langchain/core/tools')
const { AgentExecutor } = req(${agents})
function fake(nodeName, text, input, output) {
    return new (class extends BaseChatModel {
        constructor() { super({}) }
        _llmType() { return 'fake-chat' }
        async _generate(_messages, _options, runManager) {
            const names = (runManager && runManager.handlers ? runManager.handlers : []).map((handler) => handler && handler.name)
            global.__chainModelSeen.push({
                step: names.filter((name) => name === 'cuttlely_graph_step').length,
                otel: names.filter((name) => name === 'cuttlely_otel').length,
                node: nodeName
            })
            return {
                llmOutput: { tokenUsage: { promptTokens: input, completionTokens: output } },
                generations: [{
                    text,
                    message: new AIMessage({
                        content: text,
                        usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
                        response_metadata: { model_name: 'gpt-4o-mini' }
                    })
                }]
            }
        }
    })()
}
exports.nodeClass = class {
    async init(nodeData) {
        if (nodeData.name === 'worker') {
            return {
                name: 'baker',
                label: 'Baker',
                type: 'worker',
                parentSupervisorName: 'lead',
                node: async (_state, config) => {
                    const tool = new DynamicTool({
                        name: 'oven',
                        description: 'Heat the oven',
                        func: async (_input, runManager) => {
                            const names = (runManager && runManager.handlers ? runManager.handlers : []).map((handler) => handler && handler.name)
                            global.__chainToolSeen.push({
                                step: names.filter((name) => name === 'cuttlely_graph_step').length,
                                otel: names.filter((name) => name === 'cuttlely_otel').length
                            })
                            return '350F'
                        }
                    })
                    const executor = AgentExecutor.fromAgentAndTools({
                        agent: {
                            inputKeys: ['input'],
                            returnValues: ['output'],
                            prepareForOutput: async () => ({}),
                            plan: async (steps) => steps.length ? { returnValues: { output: 'ready' }, log: '' } : { tool: 'oven', toolInput: '350', log: 'heat' }
                        },
                        tools: [tool],
                        maxIterations: 2
                    })
                    await executor.invoke({ input: 'heat the oven' }, config)
                    await ChatPromptTemplate.fromMessages([['human', '{question}']]).pipe(fake('worker', 'Loaf is ready.', 11, 4)).invoke({ question: 'When?' }, config)
                    return {
                        messages: [new HumanMessage({
                            content: 'Loaf is ready.',
                            additional_kwargs: { nodeId: nodeData.id, type: 'worker' }
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
                    await ChatPromptTemplate.fromMessages([['human', '{question}']]).pipe(fake('supervisor', 'baker', 5, 2)).invoke({ question: 'Ask the baker' }, config)
                    return { next: 'baker', messages: [] }
                }
                return { next: 'FINISH', messages: [] }
            }
        }
    }
}
`
}
