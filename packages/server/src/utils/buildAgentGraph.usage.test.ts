/**
 * Multi Agents and Sequential Agents used to return before any usage write. The graph attaches the same
 * in-process counter a chatflow uses, and a finished graph returns it for that write. An aborted graph does not.
 */
import { buildAgentGraph } from './buildAgentGraph'
import { ChatflowTokenUsage, recordCompletedRun } from '../services/usage'

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
