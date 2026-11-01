/**
 * An agentflow Agent initializes its tools with the run params. The harness tool records only when
 * those params include recordTokenUsage. The finished total is the Agent's own calls plus that payload, once each.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { executeAgentFlow } from './buildAgentflow'
import * as usage from '../services/usage'

jest.mock('./logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn(), verbose: jest.fn() }
}))
jest.mock('@cuttlely/components', () => ({ ...jest.requireActual('@cuttlely/components'), tracingEnvEnabled: () => false }))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-harness-usage-'))
const requireFrom = JSON.stringify(path.join(__dirname, 'buildAgentflow.harness-usage.test.ts'))

const startFile = path.join(dir, 'start.js')
fs.writeFileSync(
    startFile,
    `exports.nodeClass = class {
  async run(nodeData, input) {
    return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } }
  }
}
`
)

const modelFile = path.join(dir, 'model.js')
fs.writeFileSync(
    modelFile,
    `
const { createRequire } = require('module')
const { AIMessageChunk } = createRequire(${requireFrom})('@langchain/core/messages')
let calls = 0
exports.nodeClass = class {
  constructor() { this.inputs = [] }
  async init() {
    return {
      bindTools() { return this },
      async invoke() {
        calls += 1
        if (calls === 1) {
          return new AIMessageChunk({
            content: '',
            tool_calls: [{ id: 'call-harness', name: 'harness', args: { input: 'bake' }, type: 'tool_call' }],
            usage_metadata: { input_tokens: 40, output_tokens: 10, total_tokens: 50 }
          })
        }
        return new AIMessageChunk({
          content: 'Loaf is ready.',
          usage_metadata: { input_tokens: 12, output_tokens: 6, total_tokens: 18 }
        })
      }
    }
  }
}
`
)

const harnessFile = path.join(dir, 'harness.js')
fs.writeFileSync(
    harnessFile,
    `exports.nodeClass = class {
  async init(_nodeData, _input, options) {
    return {
      name: 'harness',
      description: 'named harness',
      returnDirect: false,
      schema: { type: 'object', properties: { input: { type: 'string' } } },
      async call() {
        const record = options && options.recordTokenUsage
        if (typeof record === 'function') {
          await record(options.appDataSource, {
            workspaceId: options.workspaceId,
            flowId: options.chatflowid,
            result: {
              trace: {
                route: { model: 'route-model', tokens: { input_tokens: 7, output_tokens: 3 } },
                specialists: [{ model: 'specialist-model', tokens: { input_tokens: 11, output_tokens: 5 } }],
                handoff: { status: 'done', model: 'handoff-model', tokens: { input_tokens: 4, output_tokens: 2 } }
              }
            }
          })
        }
        return 'the loaf'
      }
    }
  }
}
`
)

const agentSource = path.join(__dirname, '../../../components/nodes/agentflow/Agent/Agent.ts')

const componentNodes = {
    startAgentflow: { filePath: startFile },
    agentAgentflow: { filePath: agentSource },
    stubModel: { filePath: modelFile, label: 'Stub', name: 'stubModel' },
    harness: { filePath: harnessFile, label: 'Harness', name: 'harness' }
}

const flowNode = (id: string, name: string, label: string, inputs: Record<string, unknown>) => ({
    id,
    data: { id, name, label, inputs, inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {} }
})

const canvas = JSON.stringify({
    nodes: [
        flowNode('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'chatInput' }),
        flowNode('agentAgentflow_0', 'agentAgentflow', 'Baker', {
            agentModel: 'stubModel',
            agentModelConfig: { modelName: 'baker-model', streaming: false },
            agentTools: [
                {
                    agentSelectedTool: 'harness',
                    agentSelectedToolConfig: { harnessName: 'bakery', returnDirect: false },
                    agentSelectedToolRequiresHumanInput: false
                }
            ]
        })
    ],
    edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'agentAgentflow_0' }]
})

function dataSource() {
    const executions: Record<string, any>[] = []
    let nextId = 1
    const repo = (entity: { name?: string }) => {
        if (entity?.name === 'Execution') {
            return {
                find: async () => [...executions].reverse(),
                findOne: async () => executions[executions.length - 1] || null,
                findOneBy: async (where: { id?: string; workspaceId?: string }) =>
                    executions.find(
                        (row) => (!where?.id || row.id === where.id) && (!where?.workspaceId || row.workspaceId === where.workspaceId)
                    ) || null,
                create: (value: any) => value,
                save: async (value: any) => {
                    if (!value.id) value.id = `exec-${nextId++}`
                    const existing = executions.find((row) => row.id === value.id)
                    if (existing) Object.assign(existing, value)
                    else executions.push(value)
                    return value
                },
                merge: (target: any, value: any) => Object.assign(target, value),
                update: async () => ({ affected: 1 }),
                createQueryBuilder: () => {
                    const qb: any = { where: () => qb, orWhere: () => qb, orderBy: () => qb, getMany: async () => [] }
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
            save: async (value: unknown) => value,
            merge: (target: any, value: any) => Object.assign(target, value),
            update: async () => ({ affected: 1 }),
            createQueryBuilder: () => {
                const qb: any = { where: () => qb, orWhere: () => qb, orderBy: () => qb, getMany: async () => [] }
                return qb
            }
        }
    }
    return { getRepository: repo, options: { type: 'sqlite' }, query: async () => undefined }
}

describe('agentflow harness tool usage', () => {
    beforeEach(() => {
        const model = require(modelFile) as { calls?: number }
        // The model file keeps its own counter. Reset it by rewriting is unnecessary if we re-require after deleting cache.
        delete require.cache[modelFile]
        void model
    })

    // The real Agent module is cold-loaded inside this integration test before the accounting assertions.
    it('stores the Agent calls and the harness tool calls once each', async () => {
        delete require.cache[modelFile]
        const spy = jest.spyOn(usage, 'recordCompletedRun').mockImplementation(() => Promise.resolve())
        try {
            const result = await executeAgentFlow({
                componentNodes,
                incomingInput: { question: 'Bake the rye', streaming: false } as any,
                chatflow: {
                    id: 'b7c1a6f2-1d9e-4a51-9a7e-3f1f0c2d4e5a',
                    name: 'Bakery helper',
                    type: 'AGENTFLOW',
                    flowData: canvas,
                    workspaceId: 'ws-1'
                } as any,
                chatId: 'c0ffee00-0000-4000-8000-000000000001',
                appDataSource: dataSource() as any,
                telemetry: { sendTelemetry: jest.fn() } as any,
                usageCacheManager: {} as any,
                cachePool: {} as any,
                sseStreamer: new Proxy({}, { get: () => () => undefined }) as any,
                baseURL: 'http://127.0.0.1',
                isInternal: true,
                orgId: 'org-1',
                workspaceId: 'ws-1',
                subscriptionId: 'sub-1',
                productId: 'prod-1'
            } as any)

            const lines = spy.mock.calls.flatMap((call) => usage.usageLinesFromRun(call[1].result))
            const total = (model: string) => lines.filter((line) => line.model === model)
            expect(total('baker-model')).toEqual([{ model: 'baker-model', inputTokens: 52, outputTokens: 16 }])
            expect(total('route-model')).toEqual([{ model: 'route-model', inputTokens: 7, outputTokens: 3 }])
            expect(total('specialist-model')).toEqual([{ model: 'specialist-model', inputTokens: 11, outputTokens: 5 }])
            expect(total('handoff-model')).toEqual([{ model: 'handoff-model', inputTokens: 4, outputTokens: 2 }])
            const tokens = lines.reduce((sum, line) => sum + line.inputTokens + line.outputTokens, 0)
            expect(tokens).toBe(100)
            expect(result.agentFlowExecutedData.some((step: { nodeLabel: string }) => step.nodeLabel === 'Baker')).toBe(true)
        } finally {
            spy.mockRestore()
        }
    }, 15000)
})
