/**
 * Multi Agents and Sequential Agents used to return before any usage write. The graph attaches the same
 * in-process counter a chatflow uses, and a finished graph returns it for that write. An aborted graph does not.
 */
import { buildAgentGraph } from './buildAgentGraph'
import { ChatflowTokenUsage, recordCompletedRun, waitingForApproval } from '../services/usage'

jest.mock('./logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn(), verbose: jest.fn() }
}))
jest.mock('typeorm', () => ({ ...jest.requireActual('typeorm'), Equal: (value: unknown) => value }))
jest.mock('@cuttlely/components', () => ({ ...jest.requireActual('@cuttlely/components'), tracingEnvEnabled: () => false }))

const FLOW_CONFIG = { chatflowid: 'f1', chatflowId: 'f1', chatId: 'c1', sessionId: 's1', chatHistory: [], apiMessageId: 'm1' }

const usageOutput = {
    generations: [
        [
            {
                message: {
                    usage_metadata: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
                    response_metadata: { model_name: 'gpt-4.1-mini' }
                }
            }
        ]
    ]
}

const canvasData = (id: string, name: string, inputs: Record<string, unknown>, instance: { name: string; label: string }) => ({
    id,
    data: {
        id,
        name,
        label: instance.label,
        inputs,
        inputParams: [],
        inputAnchors: [],
        outputAnchors: [],
        outputs: {},
        instance
    }
})

const workerNode = canvasData('worker_0', 'worker', {}, { name: 'w', label: 'Worker' })
const supervisorNode = canvasData('supervisor_0', 'supervisor', { supervisorName: 'Supervisor' }, { name: 'sup', label: 'Supervisor' })

function componentNodes(finish: 'ok' | 'abort') {
    const file = require('path').join(require('os').tmpdir(), `usage-graph-${finish}-${process.pid}.js`)
    require('fs').writeFileSync(
        file,
        `class Node {
  async init(nodeData) {
    if (nodeData.name === 'worker') {
      return { name: 'w', type: 'worker', parentSupervisorName: 'sup', node: async () => ({ messages: [] }) }
    }
    return {
      name: 'sup',
      workers: ['w'],
      recursionLimit: 5,
      node: async (_state, config) => {
        if (${finish === 'abort' ? 'true' : 'false'}) {
          const error = new Error('Aborted')
          throw error
        }
        const callbacks = config && config.callbacks
        const handlers = callbacks && callbacks.handlers ? callbacks.handlers : Array.isArray(callbacks) ? callbacks : []
        for (const handler of handlers) {
          if (typeof handler.handleLLMEnd !== 'function') continue
          try { await handler.handleLLMEnd(${JSON.stringify(usageOutput)}, 'run-usage-1') } catch (error) {}
        }
        return { next: 'FINISH', messages: [] }
      }
    }
  }
}
module.exports = { nodeClass: Node }
`
    )
    return {
        worker: { filePath: file },
        supervisor: { filePath: file }
    }
}

async function runGraph(finish: 'ok' | 'abort') {
    return buildAgentGraph({
        agentflow: { id: 'f1', name: 'team', flowData: '{}', workspaceId: 'w1' } as any,
        flowConfig: { ...FLOW_CONFIG } as any,
        incomingInput: { question: 'hi', history: [], overrideConfig: {} } as any,
        nodes: [],
        edges: [],
        initializedNodes: [workerNode, supervisorNode] as any,
        endingNodeIds: ['worker_0'],
        startingNodeIds: ['supervisor_0'],
        depthQueue: { worker_0: 1, supervisor_0: 0 },
        chatHistory: [],
        uploadedFilesContent: '',
        appDataSource: { getRepository: () => ({ findBy: async () => [] }) } as any,
        componentNodes: componentNodes(finish) as any,
        sseStreamer: new Proxy({}, { get: () => jest.fn() }) as any,
        shouldStreamResponse: false,
        cachePool: {} as any,
        baseURL: 'http://127.0.0.1',
        orgId: 'o1',
        workspaceId: 'w1'
    })
}

describe('Multi Agents usage', () => {
    it('returns the model calls the graph reported, and that result can be stored', async () => {
        const result = await runGraph('ok')
        expect(result.tokenUsage).toBeInstanceOf(ChatflowTokenUsage)
        expect(result.tokenUsage.sink).toEqual([{ model: 'gpt-4.1-mini', promptTokens: 5, completionTokens: 2 }])
        const queries: unknown[][] = []
        const dataSource = {
            options: { type: 'sqlite' },
            query: async (...args: unknown[]) => {
                queries.push(args)
            }
        }
        await recordCompletedRun(dataSource, {
            workspaceId: 'w1',
            flowId: 'f1',
            result: {
                metrics: result.tokenUsage.sink.map((row: { model: string; promptTokens: number; completionTokens: number }) => ({
                    model: row.model,
                    promptTokens: row.promptTokens,
                    completionTokens: row.completionTokens
                }))
            }
        })
        expect(String(queries[0][0])).toContain('token_usage_day')
        expect(queries[0][1]).toEqual(expect.arrayContaining(['w1', 'f1', 'gpt-4.1-mini', 5, 2]))
    })

    it('does not return a counter when the graph is aborted', async () => {
        const result = await runGraph('abort')
        expect(result.tokenUsage).toBeUndefined()
        expect(result.finalResult).toBe('')
    })
})

const seqNodeFile = require('path').join(require('os').tmpdir(), `seq-interrupt-${process.pid}.js`)
const seqRequireFrom = JSON.stringify(require('path').join(__dirname, 'buildAgentGraph.usage.test.ts'))
require('fs').writeFileSync(
    seqNodeFile,
    `
const { createRequire } = require('module')
const req = createRequire(${seqRequireFrom})
const { AIMessage } = req('@langchain/core/messages')
const { START } = req('@langchain/langgraph')
class Node {
  async init(nodeData) {
    if (nodeData.name === 'seqEnd') {
      const { END } = req('@langchain/langgraph')
      return { id: nodeData.id, node: END, name: END, label: END, type: 'end', predecessorAgents: [{ name: 'baker' }] }
    }
    return {
      id: 'seqLLM_0',
      name: 'baker',
      type: 'llm',
      llm: { bindTools() { return this } },
      predecessorAgents: [{ name: START }],
      node: async (_state, config) => {
        try {
        const plan = global.__seqPlan || []
        const round = plan[(global.__seqRound = (global.__seqRound || 0) + 1) - 1] || plan[plan.length - 1]
        const handlers = config && config.callbacks && config.callbacks.handlers ? config.callbacks.handlers : []
        const reported = {
          generations: [[{
            message: {
              usage_metadata: { input_tokens: round.input, output_tokens: round.output, total_tokens: round.input + round.output },
              response_metadata: { model_name: 'gpt-4.1-mini' }
            }
          }]]
        }
        for (const handler of handlers) {
          if (typeof handler.handleLLMEnd !== 'function') continue
          try { await handler.handleLLMEnd(reported, 'seq-run-' + global.__seqRound) } catch (error) {}
        }
        return {
          messages: [new AIMessage({
            content: round.tools ? '' : 'Loaf is ready.',
            tool_calls: round.tools ? [{ id: 'call-' + global.__seqRound, name: 'lookup', args: { q: 'loaf' }, type: 'tool_call' }] : [],
            additional_kwargs: { nodeId: 'seqLLM_0' }
          })]
        }
        } catch (error) { throw new Error('node-failed ' + (error && error.message)) }
      }
    }
  }
}
module.exports = { nodeClass: Node }
`
)

const seqCanvas = () => {
    const blank = { inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {} }
    return [
        {
            id: 'seqStart_0',
            data: {
                id: 'seqStart_0',
                name: 'seqStart',
                label: 'Start',
                category: 'Sequential Agents',
                inputs: {},
                instance: { name: 'start', label: 'Start' },
                ...blank
            }
        },
        {
            id: 'seqLLM_0',
            data: {
                id: 'seqLLM_0',
                name: 'seqLLMNode',
                label: 'Baker',
                category: 'Sequential Agents',
                inputs: {},
                instance: {
                    name: 'baker',
                    label: 'Baker',
                    agentInterruptToolNode: { seekPermissionMessage: async () => 'Approve the lookup?' }
                },
                ...blank
            }
        },
        {
            id: 'seqEnd_0',
            data: {
                id: 'seqEnd_0',
                name: 'seqEnd',
                label: 'End',
                category: 'Sequential Agents',
                inputs: {},
                instance: { name: 'end', label: 'End' },
                ...blank
            }
        }
    ]
}

function chatStore() {
    const messages: Array<{ id?: string; action?: string; chatId: string; sessionId: string }> = []
    const chatRepo = {
        create: (row: { id?: string; action?: string; chatId?: string; sessionId?: string }) => row,
        save: async (row: { id?: string; action?: string; chatId?: string; sessionId?: string }) => {
            const stored = { id: row.id, action: row.action, chatId: row.chatId || '', sessionId: row.sessionId || '' }
            const index = messages.findIndex((message) => message.id && message.id === stored.id)
            if (index >= 0) messages[index] = { ...messages[index], ...stored }
            else messages.push(stored)
            return stored
        },
        createQueryBuilder: () => {
            const qb: any = {
                where: () => qb,
                orWhere: () => qb,
                orderBy: () => qb,
                getMany: async () => [...messages].reverse()
            }
            return qb
        }
    }
    const appDataSource = {
        options: { type: 'sqlite' },
        query: async () => undefined,
        getRepository: (entity: { name?: string }) => {
            if (entity?.name === 'ChatMessage') return chatRepo
            return { findBy: async () => [] }
        }
    }
    return { messages, appDataSource }
}

function streamer(onAction?: (data: any) => void) {
    const actions: any[] = []
    const sseStreamer = new Proxy(
        {},
        {
            get: (_target, name) => {
                if (name === 'streamActionEvent') {
                    return (_chatId: string, data: any) => {
                        actions.push(data)
                        if (onAction) onAction(data)
                    }
                }
                return () => undefined
            }
        }
    )
    return { actions, sseStreamer }
}

async function runSequential(appDataSource: any, sseStreamer: any, action?: Record<string, unknown>) {
    return buildAgentGraph({
        agentflow: { id: 'f1', name: 'team', flowData: '{}', workspaceId: 'w1' } as any,
        flowConfig: { ...FLOW_CONFIG } as any,
        incomingInput: { question: 'hi', history: [], overrideConfig: {}, ...(action ? { action } : {}) } as any,
        nodes: [],
        edges: [],
        initializedNodes: seqCanvas() as any,
        endingNodeIds: ['seqEnd_0'],
        startingNodeIds: ['seqStart_0'],
        depthQueue: { seqLLM_0: 0, seqEnd_0: 1 },
        chatHistory: [],
        uploadedFilesContent: '',
        appDataSource,
        componentNodes: { seqLLMNode: { filePath: seqNodeFile }, seqEnd: { filePath: seqNodeFile } } as any,
        sseStreamer,
        shouldStreamResponse: true,
        cachePool: {} as any,
        baseURL: 'http://127.0.0.1',
        orgId: 'o1',
        workspaceId: 'w1'
    })
}

async function storedTotal(usage: ChatflowTokenUsage) {
    const queries: unknown[][] = []
    await recordCompletedRun(
        {
            options: { type: 'sqlite' },
            query: async (...args: unknown[]) => {
                queries.push(args)
            }
        },
        {
            workspaceId: 'w1',
            flowId: 'f1',
            result: {
                metrics: usage.sink.map((row) => ({
                    model: row.model,
                    promptTokens: row.promptTokens,
                    completionTokens: row.completionTokens
                }))
            }
        }
    )
    const amounts = queries.map((query) => query[1] as unknown[])
    const input = amounts.reduce((sum, row) => sum + Number(row[5] || 0), 0)
    const output = amounts.reduce((sum, row) => sum + Number(row[6] || 0), 0)
    return { queries, input, output }
}

describe('Sequential Agents interrupt on the streaming path', () => {
    const forged = [{ model: 'gpt-4.1-mini', promptTokens: 999, completionTokens: 999 }]

    beforeEach(() => {
        ;(global as any).__seqRound = 0
    })

    it('stores 60 in and 24 out when approval is posted on the action event', async () => {
        ;(global as any).__seqPlan = [
            { input: 50, output: 20, tools: true },
            { input: 10, output: 4, tools: false }
        ]
        const { messages, appDataSource } = chatStore()
        const writes: unknown[][] = []
        appDataSource.query = async (...args: unknown[]) => {
            writes.push(args)
        }
        let approval: Promise<any> | undefined
        const quiet = streamer().sseStreamer
        const { actions, sseStreamer } = streamer((data) => {
            expect(messages).toHaveLength(1)
            expect(JSON.parse(messages[0].action || '').priorUsage).toEqual([
                { model: 'gpt-4.1-mini', promptTokens: 50, completionTokens: 20 }
            ])
            approval = runSequential(appDataSource, quiet, { ...data, priorUsage: forged })
        })
        const waiting = await runSequential(appDataSource, sseStreamer)
        expect(actions).toHaveLength(1)
        expect(actions[0]).toBe(waiting.finalAction)
        expect(waitingForApproval(waiting.finalAction)).toBe(true)
        expect(approval).toBeDefined()
        const finished = await approval
        expect(waitingForApproval(finished.finalAction)).toBe(false)
        expect(await storedTotal(finished.tokenUsage)).toMatchObject({ input: 60, output: 24 })
        expect(writes).toEqual([])
    })

    it('keeps every round across two interrupts', async () => {
        ;(global as any).__seqPlan = [
            { input: 50, output: 20, tools: true },
            { input: 10, output: 4, tools: true },
            { input: 8, output: 3, tools: false }
        ]
        const { appDataSource } = chatStore()
        const { actions, sseStreamer } = streamer()
        const first = await runSequential(appDataSource, sseStreamer)
        const second = await runSequential(appDataSource, sseStreamer, { ...first.finalAction, priorUsage: forged })
        expect(actions[1]).toBe(second.finalAction)
        expect(actions[1].priorUsage).toEqual([
            { model: 'gpt-4.1-mini', promptTokens: 50, completionTokens: 20 },
            { model: 'gpt-4.1-mini', promptTokens: 10, completionTokens: 4 }
        ])
        const finished = await runSequential(appDataSource, sseStreamer, { ...second.finalAction, priorUsage: forged })
        expect(waitingForApproval(finished.finalAction)).toBe(false)
        expect(await storedTotal(finished.tokenUsage)).toMatchObject({ input: 68, output: 27 })
    })

    it('ignores a forged priorUsage and uses the saved message', async () => {
        ;(global as any).__seqPlan = [
            { input: 50, output: 20, tools: true },
            { input: 10, output: 4, tools: false }
        ]
        const { appDataSource } = chatStore()
        const { sseStreamer } = streamer()
        const waiting = await runSequential(appDataSource, sseStreamer)
        const finished = await runSequential(appDataSource, sseStreamer, {
            id: waiting.finalAction.id,
            mapping: waiting.finalAction.mapping,
            elements: waiting.finalAction.elements,
            priorUsage: forged
        })
        const total = await storedTotal(finished.tokenUsage)
        expect(total).toMatchObject({ input: 60, output: 24 })
        expect(total.input).not.toBe(999)
    })

    it('fails the resume when the waiting usage cannot be read and stores nothing', async () => {
        const writes: unknown[][] = []
        const appDataSource = {
            options: { type: 'sqlite' },
            query: async (...args: unknown[]) => {
                writes.push(args)
            },
            getRepository: () => ({
                createQueryBuilder: () => {
                    throw new Error('db down')
                }
            })
        }
        await expect(
            runSequential(appDataSource, streamer().sseStreamer, {
                id: 'action-1',
                mapping: { approve: 'Yes', reject: 'No', toolCalls: [] },
                elements: [],
                priorUsage: forged
            })
        ).rejects.toThrow(/waiting usage could not be read/)
        expect(writes).toEqual([])
    })

    it('fails the resume when the waiting action was not saved and stores nothing', async () => {
        const writes: unknown[][] = []
        const { appDataSource } = chatStore()
        appDataSource.query = async (...args: unknown[]) => {
            writes.push(args)
        }
        await expect(
            runSequential(appDataSource, streamer().sseStreamer, {
                id: 'missing-action',
                mapping: { approve: 'Yes', reject: 'No', toolCalls: [] },
                elements: [],
                priorUsage: forged
            })
        ).rejects.toThrow(/waiting usage was not saved/)
        expect(writes).toEqual([])
    })
})
