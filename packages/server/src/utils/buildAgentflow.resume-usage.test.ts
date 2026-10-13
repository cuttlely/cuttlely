/**
 * A loop can finish an agent, then run it again and stop for approval. Resume must keep the finished pass
 * and count the stopped pass only through priorUsage, plus the calls after approval, once each.
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

const nodeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-resume-')), 'nodes.js')
fs.writeFileSync(
    nodeFile,
    `
global.__resumePasses = global.__resumePasses || { agent: 0, loop: 0 }
exports.nodeClass = class {
  async run(nodeData, input, options) {
    if (nodeData.name === 'startAgentflow') {
      return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } }
    }
    if (nodeData.name === 'loopAgentflow') {
      global.__resumePasses.loop += 1
      if (global.__resumePasses.loop > 1) {
        return { id: nodeData.id, name: 'loopAgentflow', input: {}, output: { content: 'loop done' } }
      }
      return { id: nodeData.id, name: 'loopAgentflow', input: {}, output: { nodeID: 'agentAgentflow_0', maxLoopCount: 5 } }
    }
    global.__resumePasses.agent += 1
    const human = nodeData.inputs && nodeData.inputs.humanInput
    if (human) {
      const prior = (options.humanInputAction && options.humanInputAction.data && options.humanInputAction.data.priorUsage) || {}
      const inputTokens = (prior.input_tokens || 0) + 5
      const outputTokens = (prior.output_tokens || 0) + 5
      return {
        id: nodeData.id,
        name: 'agentAgentflow',
        input: { agentModelConfig: { modelName: 'pass-two' } },
        output: {
          content: 'approved',
          usageMetadata: { input_tokens: inputTokens, output_tokens: outputTokens, tool_call_tokens: inputTokens + outputTokens }
        }
      }
    }
    if (global.__resumePasses.agent === 1) {
      return {
        id: nodeData.id,
        name: 'agentAgentflow',
        input: { agentModelConfig: { modelName: 'pass-one' } },
        output: { content: 'first', usageMetadata: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
      }
    }
    return {
      id: nodeData.id,
      name: 'agentAgentflow',
      input: { messages: [{ role: 'assistant', content: 'wait' }] },
      output: {
        content: 'need approval',
        isWaitingForHumanInput: true,
        usageMetadata: { input_tokens: 20, output_tokens: 20, tool_call_tokens: 40 }
      }
    }
  }
}
`
)

const componentNodes = {
    startAgentflow: { filePath: nodeFile },
    agentAgentflow: { filePath: nodeFile },
    loopAgentflow: { filePath: nodeFile }
}

const flowNode = (id: string, name: string, label: string, inputs: Record<string, unknown>) => ({
    id,
    data: { id, name, label, inputs, inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {} }
})

const canvas = JSON.stringify({
    nodes: [
        flowNode('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'chatInput' }),
        flowNode('agentAgentflow_0', 'agentAgentflow', 'Baker', {}),
        flowNode('loopAgentflow_0', 'loopAgentflow', 'Again', {})
    ],
    edges: [
        { id: 'e1', source: 'startAgentflow_0', target: 'agentAgentflow_0' },
        { id: 'e2', source: 'agentAgentflow_0', target: 'loopAgentflow_0' }
    ]
})

function dataSource() {
    const executions: Record<string, any>[] = []
    let nextId = 1
    const repo = (entity: any) => {
        const table = typeof entity === 'function' ? entity.name : String(entity)
        if (table === 'Execution') {
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
    return { executions, appDataSource: { getRepository: repo, options: { type: 'sqlite' }, query: async () => undefined } }
}

const chatflow = {
    id: 'b7c1a6f2-1d9e-4a51-9a7e-3f1f0c2d4e5a',
    name: 'Bakery helper',
    type: 'AGENTFLOW',
    flowData: canvas,
    workspaceId: 'ws-1'
}

async function run(appDataSource: any, humanInput?: { type: string; startNodeId: string }) {
    return executeAgentFlow({
        componentNodes,
        incomingInput: { question: 'When is the sourdough ready?', streaming: false, humanInput } as any,
        chatflow: chatflow as any,
        chatId: 'c0ffee00-0000-4000-8000-000000000001',
        appDataSource,
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
}

describe('loop resume keeps finished passes', () => {
    beforeEach(() => {
        ;(global as any).__resumePasses = { agent: 0, loop: 0 }
    })

    it('counts the finished pass, the stopped pass, and the calls after approval once each', async () => {
        const spy = jest.spyOn(usage, 'recordCompletedRun').mockImplementation(() => Promise.resolve())
        const { appDataSource } = dataSource()
        try {
            const stopped = await run(appDataSource)
            expect(stopped.agentFlowExecutedData.map((step: any) => `${step.nodeLabel}:${step.status}`)).toEqual([
                'Start:FINISHED',
                'Baker:FINISHED',
                'Again:FINISHED',
                'Baker:STOPPED'
            ])
            expect(spy).not.toHaveBeenCalled()

            spy.mockClear()
            const finished = await run(appDataSource, { type: 'proceed', startNodeId: 'agentAgentflow_0' })
            expect(finished.agentFlowExecutedData.map((step: any) => `${step.nodeLabel}:${step.status}`)).toEqual([
                'Start:FINISHED',
                'Baker:FINISHED',
                'Again:FINISHED',
                'Baker:FINISHED',
                'Again:FINISHED'
            ])
            expect(spy).toHaveBeenCalledTimes(1)
            const lines = usage.usageLinesFromRun(spy.mock.calls[0][1].result)
            expect(lines).toEqual([
                { model: 'pass-one', inputTokens: 10, outputTokens: 10 },
                { model: 'pass-two', inputTokens: 25, outputTokens: 25 }
            ])
            const total = lines.reduce((sum, line) => sum + line.inputTokens + line.outputTokens, 0)
            expect(total).toBe(70)
        } finally {
            spy.mockRestore()
        }
    })
})
