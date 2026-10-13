// A Tool Agent puts the chatflow token counter on the async-local config. The harness tool is a
// DynamicTool, so its model calls used to inherit that counter and get stored again by the payload write.
// Tool Agent, Conversational Agent, Conversational Retrieval Tool Agent, XML Agent, and both ReAct agents
// pass that callback list into executor.invoke. They share this model path.
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

const root = path.join(import.meta.dirname, '..')
const serverRequire = createRequire(path.join(root, 'packages', 'server', 'package.json'))
serverRequire('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
        module: 'commonjs',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        strict: false,
        skipLibCheck: true,
        target: 'ES2022'
    }
})

const { AIMessage } = serverRequire('@langchain/core/messages')
const { DynamicTool } = serverRequire('@langchain/core/tools')
const { AsyncLocalStorageProviderSingleton } = serverRequire('@langchain/core/singletons')
const { ensureConfig } = serverRequire('@langchain/core/runnables')
const { ChatflowTokenUsage } = serverRequire('./src/services/usage/lines.ts')
const { recordCompletedRun } = serverRequire('./src/services/usage/store.ts')
const { executeAgentFlow } = serverRequire('./src/utils/buildAgentflow.ts')
const { invokeChat } = await import(pathToFileURL(path.join(root, 'packages', 'harness', 'model.mjs')).href)

AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage())

const HARNESS_CALLS = [
    { model: 'route-model', input: 7, output: 3 },
    { model: 'specialist-model', input: 11, output: 5 },
    { model: 'handoff-model', input: 4, output: 2 }
]
const PAYLOAD = {
    text: 'Loaf is ready.',
    trace: {
        route: { model: 'route-model', tokens: { input_tokens: 7, output_tokens: 3 } },
        specialists: [{ model: 'specialist-model', tokens: { input_tokens: 11, output_tokens: 5 } }],
        handoff: { status: 'done', model: 'handoff-model', tokens: { input_tokens: 4, output_tokens: 2 } }
    }
}

async function reportModel(modelName, input, output, options, extra = {}) {
    const config = ensureConfig(options)
    const message = new AIMessage({
        content: extra.content || 'ok',
        ...(extra.tool_calls ? { tool_calls: extra.tool_calls } : {}),
        usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
        response_metadata: { model_name: modelName }
    })
    const handlers = Array.isArray(config.callbacks) ? config.callbacks : []
    for (const handler of handlers) {
        if (typeof handler?.handleLLMEnd === 'function') {
            await handler.handleLLMEnd({ generations: [[{ message, text: 'ok' }]] }, `${modelName}-${input}-${output}-${Math.random()}`)
        }
    }
    return message
}

async function harnessModelCalls() {
    for (const call of HARNESS_CALLS) {
        await invokeChat(
            {
                chat: {
                    invoke: (_messages, options) => reportModel(call.model, call.input, call.output, options)
                },
                label: call.model,
                nodeName: 'scriptedChat',
                toolCalling: false
            },
            { messages: [{ role: 'user', content: 'bake' }] }
        )
    }
}

function writer() {
    const queries = []
    return {
        queries,
        dataSource: {
            options: { type: 'sqlite' },
            query: async (...args) => {
                queries.push(args)
            }
        }
    }
}

function totals(queries) {
    const byModel = new Map()
    for (const query of queries) {
        const row = query[1]
        const model = String(row[3])
        const prev = byModel.get(model) || { input: 0, output: 0 }
        prev.input += Number(row[5] || 0)
        prev.output += Number(row[6] || 0)
        byModel.set(model, prev)
    }
    return byModel
}

function expectOnce(stored, model, input, output) {
    assert.deepEqual(stored.get(model), { input, output }, model)
}

describe('harness model calls under a chatflow counter', () => {
    it('stores a Tool Agent harness payload once next to the agent call', async () => {
        const usage = new ChatflowTokenUsage()
        const { queries, dataSource } = writer()
        const tool = new DynamicTool({
            name: 'harness',
            description: 'named harness',
            func: async () => {
                await harnessModelCalls()
                await recordCompletedRun(dataSource, { workspaceId: 'ws-1', flowId: 'flow-tool', result: PAYLOAD })
                return 'the loaf'
            }
        })
        await AsyncLocalStorageProviderSingleton.runWithConfig({ callbacks: [usage] }, async () => {
            await reportModel('baker-model', 40, 10)
            await tool.call('bake')
        })
        await recordCompletedRun(dataSource, {
            workspaceId: 'ws-1',
            flowId: 'flow-tool',
            result: {
                text: 'Loaf is ready.',
                metrics: usage.sink.map((row) => ({
                    model: row.model,
                    promptTokens: row.promptTokens,
                    completionTokens: row.completionTokens
                }))
            }
        })
        const stored = totals(queries)
        expectOnce(stored, 'baker-model', 40, 10)
        expectOnce(stored, 'route-model', 7, 3)
        expectOnce(stored, 'specialist-model', 11, 5)
        expectOnce(stored, 'handoff-model', 4, 2)
        const tokens = [...stored.values()].reduce((sum, row) => sum + row.input + row.output, 0)
        assert.equal(tokens, 82)
        assert.deepEqual(
            usage.sink.map((row) => row.model),
            ['baker-model']
        )
    })

    it('stores an agentflow Agent harness payload once next to the Agent calls', async () => {
        const usage = new ChatflowTokenUsage()
        const dir = mkdtempSync(path.join(tmpdir(), 'cuttlely-harness-callback-'))
        const requireFrom = JSON.stringify(path.join(root, 'packages', 'server', 'src', 'utils', 'buildAgentflow.ts'))
        const modelFile = path.join(dir, 'model.js')
        writeFileSync(
            modelFile,
            `
const { createRequire } = require('module')
const req = createRequire(${requireFrom})
const { AIMessage } = req('@langchain/core/messages')
const { ensureConfig } = req('@langchain/core/runnables')
let calls = 0
async function report(modelName, input, output, options, toolCall) {
  const config = ensureConfig(options)
  const message = new AIMessage({
    content: toolCall ? '' : 'Loaf is ready.',
    tool_calls: toolCall ? [{ id: 'call-harness', name: 'harness', args: { input: 'bake' }, type: 'tool_call' }] : [],
    usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    response_metadata: { model_name: modelName }
  })
  const handlers = Array.isArray(config.callbacks) ? config.callbacks : []
  for (const handler of handlers) {
    if (typeof handler.handleLLMEnd === 'function') {
      await handler.handleLLMEnd({ generations: [[{ message, text: 'ok' }]] }, modelName + '-' + calls)
    }
  }
  return message
}
exports.nodeClass = class {
  constructor() { this.inputs = [] }
  async init() {
    return {
      bindTools() { return this },
      async invoke(_messages, options) {
        calls += 1
        if (calls === 1) return report('baker-model', 40, 10, options, true)
        return report('baker-model', 12, 6, options, false)
      }
    }
  }
}
`
        )
        const harnessFile = path.join(dir, 'harness.js')
        writeFileSync(
            harnessFile,
            `
const { createRequire } = require('module')
const req = createRequire(${requireFrom})
const { DynamicTool } = req('@langchain/core/tools')
const payload = ${JSON.stringify(PAYLOAD)}
exports.nodeClass = class {
  async init(_nodeData, _input, options) {
    return new DynamicTool({
      name: 'harness',
      description: 'named harness',
      func: async () => {
        await global.__cuttlelyHarnessModelCalls()
        if (typeof options.recordTokenUsage === 'function') {
          await options.recordTokenUsage(options.appDataSource, {
            workspaceId: options.workspaceId,
            flowId: options.chatflowid,
            result: payload
          })
        }
        return 'the loaf'
      }
    })
  }
}
`
        )
        const startFile = path.join(dir, 'start.js')
        writeFileSync(
            startFile,
            `exports.nodeClass = class { async run(nodeData, input) { return { id: nodeData.id, name: 'startAgentflow', input: { question: input }, output: { question: input } } } }\n`
        )
        const blank = { inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {} }
        const canvas = JSON.stringify({
            nodes: [
                {
                    id: 'startAgentflow_0',
                    data: {
                        id: 'startAgentflow_0',
                        name: 'startAgentflow',
                        label: 'Start',
                        inputs: { startInputType: 'chatInput' },
                        ...blank
                    }
                },
                {
                    id: 'agentAgentflow_0',
                    data: {
                        id: 'agentAgentflow_0',
                        name: 'agentAgentflow',
                        label: 'Baker',
                        inputs: {
                            agentModel: 'stubModel',
                            agentModelConfig: { modelName: 'baker-model', streaming: false },
                            agentTools: [
                                {
                                    agentSelectedTool: 'harness',
                                    agentSelectedToolConfig: { harnessName: 'bakery', returnDirect: false },
                                    agentSelectedToolRequiresHumanInput: false
                                }
                            ]
                        },
                        ...blank
                    }
                }
            ],
            edges: [{ id: 'e1', source: 'startAgentflow_0', target: 'agentAgentflow_0' }]
        })
        const { queries, dataSource } = writer()
        global.__cuttlelyHarnessModelCalls = harnessModelCalls
        await AsyncLocalStorageProviderSingleton.runWithConfig({ callbacks: [usage] }, () =>
            executeAgentFlow({
                componentNodes: {
                    startAgentflow: { filePath: startFile },
                    agentAgentflow: { filePath: path.join(root, 'packages', 'components', 'nodes', 'agentflow', 'Agent', 'Agent.ts') },
                    stubModel: { filePath: modelFile, label: 'Stub', name: 'stubModel' },
                    harness: { filePath: harnessFile, label: 'Harness', name: 'harness' }
                },
                incomingInput: { question: 'Bake the rye', streaming: false },
                chatflow: {
                    id: 'b7c1a6f2-1d9e-4a51-9a7e-3f1f0c2d4e5a',
                    name: 'Bakery helper',
                    type: 'AGENTFLOW',
                    flowData: canvas,
                    workspaceId: 'ws-1'
                },
                chatId: 'c0ffee00-0000-4000-8000-000000000001',
                appDataSource: executionStore(dataSource),
                telemetry: { sendTelemetry: () => undefined },
                usageCacheManager: {},
                cachePool: {},
                sseStreamer: new Proxy({}, { get: () => () => undefined }),
                baseURL: 'http://127.0.0.1',
                isInternal: true,
                orgId: 'org-1',
                workspaceId: 'ws-1',
                subscriptionId: 'sub-1',
                productId: 'prod-1'
            })
        )
        const stored = totals(queries)
        expectOnce(stored, 'baker-model', 52, 16)
        expectOnce(stored, 'route-model', 7, 3)
        expectOnce(stored, 'specialist-model', 11, 5)
        expectOnce(stored, 'handoff-model', 4, 2)
        const tokens = [...stored.values()].reduce((sum, row) => sum + row.input + row.output, 0)
        assert.equal(tokens, 100)
        assert.deepEqual(
            usage.sink.map((row) => row.model).filter((model) => model !== 'baker-model'),
            []
        )
    })
})

function executionStore(dataSource) {
    const executions = []
    let nextId = 1
    const empty = () => ({
        find: async () => [],
        findBy: async () => [],
        findOne: async () => null,
        findOneBy: async () => null,
        create: (value) => value,
        save: async (value) => value,
        merge: (target, value) => Object.assign(target, value),
        update: async () => ({ affected: 1 }),
        createQueryBuilder: () => {
            const qb = { where: () => qb, orWhere: () => qb, orderBy: () => qb, getMany: async () => [] }
            return qb
        }
    })
    return {
        ...dataSource,
        getRepository: (entity) => {
            if (entity?.name !== 'Execution') return empty()
            return {
                find: async () => [...executions].reverse(),
                findOne: async () => executions[executions.length - 1] || null,
                findOneBy: async (where) =>
                    executions.find(
                        (row) => (!where?.id || row.id === where.id) && (!where?.workspaceId || row.workspaceId === where.workspaceId)
                    ) || null,
                create: (value) => value,
                save: async (value) => {
                    if (!value.id) value.id = `exec-${nextId++}`
                    const existing = executions.find((row) => row.id === value.id)
                    if (existing) Object.assign(existing, value)
                    else executions.push(value)
                    return value
                },
                merge: (target, value) => Object.assign(target, value),
                update: async () => ({ affected: 1 }),
                createQueryBuilder: () => empty().createQueryBuilder()
            }
        }
    }
}
