import { AIMessageChunk } from '@langchain/core/messages'

const { nodeClass: AgentNode, completeStepUsage } = require('./Agent')

function modelCall(total: number, toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
    const input = Math.floor(total / 2)
    const output = total - input
    return new AIMessageChunk({
        content: toolCalls?.length ? '' : 'done',
        tool_calls: toolCalls,
        usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: total }
    })
}

function lookupTool(returnDirect = false) {
    return {
        name: 'lookup',
        returnDirect,
        call: async () => (returnDirect ? 'the loaf' : 'found')
    }
}

function llm(responses: AIMessageChunk[]) {
    let index = 0
    const model = {
        calls: 0,
        invoke: async () => {
            model.calls += 1
            const next = responses[index]
            index += 1
            if (!next) throw new Error('the test model ran out of responses')
            return next
        }
    }
    return model
}

async function runTools(first: AIMessageChunk, followUps: AIMessageChunk[], returnDirect = false) {
    const agent = new AgentNode()
    const model = llm(followUps)
    const result = await agent.handleToolCalls({
        response: first,
        messages: [],
        toolsInstance: [lookupTool(returnDirect)],
        sseStreamer: undefined,
        chatId: 'chat-1',
        input: 'loaf',
        options: { chatflowid: 'flow-1', sessionId: 'session-1', chatId: 'chat-1' },
        abortController: new AbortController(),
        llmNodeInstance: model,
        isStreamable: false,
        isLastNode: false,
        iterationContext: {}
    })
    return { agent, model, result }
}

describe('Agent tool-call token totals', () => {
    const toolCall = [{ id: 'call-1', name: 'lookup', args: { q: 'loaf' } }]

    it('counts two model calls once each', async () => {
        const { model, result } = await runTools(modelCall(100, toolCall), [modelCall(40)])
        expect(model.calls).toBe(1)
        expect(result.totalTokens).toBe(140)
        expect(result.inputTokens).toBe(70)
        expect(result.outputTokens).toBe(70)
    })

    it('counts three model calls once each', async () => {
        const { model, result } = await runTools(modelCall(100, toolCall), [modelCall(40, toolCall), modelCall(20)])
        expect(model.calls).toBe(2)
        expect(result.totalTokens).toBe(160)
        expect(result.inputTokens).toBe(80)
        expect(result.outputTokens).toBe(80)
        const stored = result.response
        const output = new AgentNode().prepareOutputObject(
            stored,
            [],
            'done',
            0,
            1,
            1,
            result.usedTools,
            [],
            [],
            result.totalTokens,
            false,
            [],
            false,
            undefined,
            undefined,
            { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
        )
        expect(output.usageMetadata.tool_call_tokens).toBe(160)
        expect(output.usageMetadata.total_tokens).toBe(160)
        expect(output.usageMetadata.input_tokens + output.usageMetadata.output_tokens).toBe(160)
    })

    it('keeps the model call input and output on a return-direct answer', async () => {
        const { model, result } = await runTools(modelCall(40, toolCall), [], true)
        expect(model.calls).toBe(0)
        expect(String(result.response.content)).toBe('the loaf')
        expect(result.response.usage_metadata).toMatchObject({ input_tokens: 20, output_tokens: 20, total_tokens: 40 })
        expect(result.totalTokens).toBe(40)
        const output = new AgentNode().prepareOutputObject(
            result.response,
            [],
            'the loaf',
            0,
            1,
            1,
            result.usedTools,
            [],
            [],
            result.totalTokens,
            false,
            [],
            false,
            undefined,
            undefined,
            { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
        )
        expect(output.usageMetadata.input_tokens).toBe(20)
        expect(output.usageMetadata.output_tokens).toBe(20)
        expect(output.usageMetadata.total_tokens).toBe(40)
        expect(output.usageMetadata.tool_call_tokens).toBe(40)
        expect(output.usageMetadata.input_tokens + output.usageMetadata.output_tokens).toBe(output.usageMetadata.tool_call_tokens)
    })
})

function resumableModel(responses: AIMessageChunk[]) {
    let index = 0
    const model: {
        calls: number
        bindTools: () => typeof model
        invoke: () => Promise<AIMessageChunk>
    } = {
        calls: 0,
        bindTools: () => model,
        invoke: async () => {
            model.calls += 1
            const next = responses[index]
            index += 1
            if (!next) throw new Error('the test model ran out of responses')
            return next
        }
    }
    return model
}

function storedUsage(result: {
    response: AIMessageChunk
    totalTokens: number
    inputTokens: number
    outputTokens: number
    usedTools: unknown[]
}) {
    return new AgentNode().prepareOutputObject(
        result.response,
        [],
        String(result.response.content || ''),
        0,
        1,
        1,
        result.usedTools,
        [],
        [],
        result.totalTokens,
        false,
        [],
        false,
        undefined,
        undefined,
        result.inputTokens > 0 || result.outputTokens > 0
            ? { inputTokens: result.inputTokens, outputTokens: result.outputTokens }
            : undefined
    ).usageMetadata
}

async function resume(args: {
    prior: { input_tokens: number; output_tokens: number; tool_call_tokens: number }
    waiting: AIMessageChunk
    followUps: AIMessageChunk[]
    tools: Array<Record<string, unknown>>
    type?: 'proceed' | 'reject'
}) {
    const agent = new AgentNode()
    const model = resumableModel(args.followUps)
    const result = await agent.handleResumedToolCalls({
        humanInput: { type: args.type || 'proceed' },
        humanInputAction: {
            data: {
                priorUsage: args.prior,
                input: { messages: [{ role: 'user', content: 'loaf' }, args.waiting] }
            }
        },
        messages: [],
        toolsInstance: args.tools,
        sseStreamer: undefined,
        chatId: 'chat-1',
        input: 'loaf',
        options: { chatflowid: 'flow-1', sessionId: 'session-1', chatId: 'chat-1' },
        abortController: new AbortController(),
        llmWithoutToolsBind: model,
        isStreamable: false,
        isLastNode: false,
        iterationContext: {}
    })
    return { model, result, usage: storedUsage(result) }
}

describe('Agent approval resume token totals', () => {
    const lookup = () => ({ name: 'lookup', call: async () => 'found' })
    const directLookup = () => ({ name: 'lookup', returnDirect: true, call: async () => 'the loaf' })
    const approveTool = (requiresHumanInput = false) => ({
        name: 'approve',
        requiresHumanInput,
        call: async () => 'approved'
    })

    it('keeps earlier rounds when approval follows more than one model call', async () => {
        // 50/50, then 20/20 waiting, then 10/10 after approval. The stored split is 80/80, not 10/50.
        const { model, usage } = await resume({
            prior: { input_tokens: 70, output_tokens: 70, tool_call_tokens: 140 },
            waiting: modelCall(40, [{ id: 'call-wait', name: 'lookup', args: { q: 'loaf' } }]),
            followUps: [modelCall(20)],
            tools: [lookup()]
        })
        expect(model.calls).toBe(1)
        expect(usage.input_tokens).toBe(80)
        expect(usage.output_tokens).toBe(80)
        expect(usage.input_tokens + usage.output_tokens).toBe(160)
        expect(usage.tool_call_tokens).toBe(160)
    })

    it('keeps the single round from before approval', async () => {
        const { usage } = await resume({
            prior: { input_tokens: 50, output_tokens: 50, tool_call_tokens: 100 },
            waiting: modelCall(100, [{ id: 'call-wait', name: 'lookup', args: { q: 'loaf' } }]),
            followUps: [modelCall(20)],
            tools: [lookup()]
        })
        expect(usage.input_tokens).toBe(60)
        expect(usage.output_tokens).toBe(60)
        expect(usage.input_tokens + usage.output_tokens).toBe(usage.tool_call_tokens)
    })

    it('keeps the pre-approval split on a return-direct resume', async () => {
        const { model, result, usage } = await resume({
            prior: { input_tokens: 70, output_tokens: 70, tool_call_tokens: 140 },
            waiting: modelCall(40, [{ id: 'call-wait', name: 'lookup', args: { q: 'loaf' } }]),
            followUps: [],
            tools: [directLookup()]
        })
        expect(model.calls).toBe(0)
        expect(String(result.response.content)).toBe('the loaf')
        expect(result.response.usage_metadata).toMatchObject({ input_tokens: 20, output_tokens: 20 })
        expect(usage.input_tokens).toBe(70)
        expect(usage.output_tokens).toBe(70)
        expect(usage.input_tokens + usage.output_tokens).toBe(usage.tool_call_tokens)
    })

    it('keeps every model call across two approvals', async () => {
        const first = await resume({
            prior: { input_tokens: 70, output_tokens: 70, tool_call_tokens: 140 },
            waiting: modelCall(40, [{ id: 'call-1', name: 'lookup', args: { q: 'loaf' } }]),
            followUps: [modelCall(20, [{ id: 'call-2', name: 'approve', args: { q: 'oven' } }])],
            tools: [lookup(), approveTool(true)]
        })
        expect(first.result.isWaitingForHumanInput).toBe(true)
        expect(first.usage.input_tokens).toBe(80)
        expect(first.usage.output_tokens).toBe(80)
        expect(first.usage.input_tokens + first.usage.output_tokens).toBe(160)

        const second = await resume({
            prior: {
                input_tokens: first.usage.input_tokens,
                output_tokens: first.usage.output_tokens,
                tool_call_tokens: first.usage.tool_call_tokens
            },
            waiting: first.result.response,
            followUps: [modelCall(20)],
            tools: [approveTool()]
        })
        expect(second.result.isWaitingForHumanInput).toBeFalsy()
        expect(second.usage.input_tokens).toBe(90)
        expect(second.usage.output_tokens).toBe(90)
        expect(second.usage.input_tokens + second.usage.output_tokens).toBe(180)
        expect(second.usage.tool_call_tokens).toBe(180)
    })

    it('keeps the pre-approval calls when the tool is rejected', async () => {
        const { model, usage } = await resume({
            prior: { input_tokens: 70, output_tokens: 70, tool_call_tokens: 140 },
            waiting: modelCall(40, [{ id: 'call-wait', name: 'lookup', args: { q: 'loaf' } }]),
            followUps: [modelCall(20)],
            tools: [lookup()],
            type: 'reject'
        })
        expect(model.calls).toBe(1)
        expect(usage.input_tokens).toBe(80)
        expect(usage.output_tokens).toBe(80)
        expect(usage.input_tokens + usage.output_tokens).toBe(usage.tool_call_tokens)
    })
})

function storedFrom(
    responseUsage: { input_tokens: number; output_tokens: number; total_tokens: number },
    completed: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
        counted: boolean
    }
) {
    const response = new AIMessageChunk({ content: 'done', usage_metadata: responseUsage })
    return new AgentNode().prepareOutputObject(
        response,
        [],
        'done',
        0,
        1,
        1,
        [],
        [],
        [],
        completed.counted ? completed.totalTokens : 0,
        false,
        [],
        false,
        undefined,
        undefined,
        completed.counted ? { inputTokens: completed.inputTokens, outputTokens: completed.outputTokens } : undefined
    ).usageMetadata
}

describe('Agent calls outside the tool loop', () => {
    it('adds the structured-output conversion on top of the tool calls', () => {
        const completed = completeStepUsage({
            toolInput: 50,
            toolOutput: 50,
            toolTotal: 100,
            generation: { input_tokens: 50, output_tokens: 50, total_tokens: 100 },
            conversion: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            structured: true
        })
        const usage = storedFrom({ input_tokens: 10, output_tokens: 10, total_tokens: 20 }, completed)
        expect(usage.input_tokens).toBe(60)
        expect(usage.output_tokens).toBe(60)
        expect(usage.input_tokens + usage.output_tokens).toBe(120)
        expect(usage.tool_call_tokens).toBe(120)
    })

    it('keeps the generation call and the structured-output conversion when there are no tools', () => {
        const completed = completeStepUsage({
            toolInput: 0,
            toolOutput: 0,
            toolTotal: 0,
            generation: { input_tokens: 40, output_tokens: 40, total_tokens: 80 },
            conversion: { input_tokens: 8, output_tokens: 8, total_tokens: 16 },
            structured: true
        })
        const usage = storedFrom({ input_tokens: 8, output_tokens: 8, total_tokens: 16 }, completed)
        expect(usage.input_tokens).toBe(48)
        expect(usage.output_tokens).toBe(48)
        expect(usage.input_tokens + usage.output_tokens).toBe(96)
        expect(usage.tool_call_tokens).toBe(96)
    })

    it('adds the memory summarizer to the generation call', async () => {
        const agent = new AgentNode()
        const summary = await agent.handleSummaryBuffer(
            [],
            [
                { role: 'user', content: 'rye'.repeat(40) },
                { role: 'assistant', content: 'spelt'.repeat(40) }
            ],
            {
                getNumTokens: async (text: string) => text.length,
                invoke: async () =>
                    new AIMessageChunk({
                        content: 'summary',
                        usage_metadata: { input_tokens: 30, output_tokens: 10, total_tokens: 40 }
                    })
            },
            { inputs: { agentMemoryMaxTokenLimit: 50 } },
            new AbortController()
        )
        expect(summary).toMatchObject({ input_tokens: 30, output_tokens: 10, total_tokens: 40 })
        const completed = completeStepUsage({
            toolInput: 0,
            toolOutput: 0,
            toolTotal: 0,
            generation: { input_tokens: 20, output_tokens: 20, total_tokens: 40 },
            summarizer: summary,
            structured: false
        })
        const usage = storedFrom({ input_tokens: 20, output_tokens: 20, total_tokens: 40 }, completed)
        expect(usage.input_tokens).toBe(50)
        expect(usage.output_tokens).toBe(30)
        expect(usage.input_tokens + usage.output_tokens).toBe(80)
        expect(usage.tool_call_tokens).toBe(80)
    })
})

const structuredModelFile = require('path').join(require('os').tmpdir(), `agent-structured-${process.pid}.js`)
const structuredRequireFrom = JSON.stringify(require('path').join(__dirname, 'Agent.tokens.test.ts'))
require('fs').writeFileSync(
    structuredModelFile,
    `
const { createRequire } = require('module')
const req = createRequire(${structuredRequireFrom})
const { AIMessageChunk } = req('@langchain/core/messages')
class Node {
  constructor() { this.inputs = [] }
  async init() {
    return {
      async invoke() {
        return new AIMessageChunk({
          content: 'rye loaf',
          usage_metadata: { input_tokens: 40, output_tokens: 20, total_tokens: 60 }
        })
      },
      withStructuredOutput(_schema, options) {
        const includeRaw = !!(options && options.includeRaw === true)
        return {
          async invoke() {
            if (!includeRaw) return { loaf: 'rye' }
            return {
              parsed: { loaf: 'rye' },
              raw: new AIMessageChunk({
                content: '',
                usage_metadata: { input_tokens: 8, output_tokens: 4, total_tokens: 12 }
              })
            }
          }
        }
      }
    }
  }
}
module.exports = { nodeClass: Node }
`
)

describe('Agent structured output through invoke', () => {
    it('stores the generation and conversion calls and keeps the parsed chat text', async () => {
        const agent = new AgentNode()
        const result = await agent.run(
            {
                id: 'agent_0',
                inputs: {
                    agentModel: 'stubModel',
                    agentModelConfig: {},
                    agentTools: [],
                    agentStructuredOutput: [{ key: 'loaf', type: 'string', description: 'the loaf' }]
                }
            },
            'bake',
            {
                chatId: 'c1',
                chatflowid: 'f1',
                prependedChatHistory: [],
                abortController: new AbortController(),
                componentNodes: { stubModel: { filePath: structuredModelFile, label: 'Stub' } }
            }
        )
        const chatText = '```json\n{\n  "loaf": "rye"\n}\n```'
        expect(result.output.content).toBe(chatText)
        expect(result.output.loaf).toBe('rye')
        expect(result.chatHistory[result.chatHistory.length - 1].content).toBe(chatText)
        expect(result.output.usageMetadata.input_tokens).toBe(48)
        expect(result.output.usageMetadata.output_tokens).toBe(24)
        expect(result.output.usageMetadata.input_tokens + result.output.usageMetadata.output_tokens).toBe(72)
        expect(result.output.usageMetadata.tool_call_tokens).toBe(72)
        expect(result.output.usageMetadata.total_tokens).toBe(72)
    })
})

const costFs = require('fs')
const costOs = require('os')
const costPath = require('path')
const costRequireFrom = JSON.stringify(costPath.join(__dirname, 'Agent.tokens.test.ts'))
const GPT41_MINI_INPUT = 0.0000004
const GPT41_MINI_OUTPUT = 0.0000016

function writeCostFile(name: string, body: string) {
    const file = costPath.join(costOs.tmpdir(), `agent-cost-${name}-${process.pid}.js`)
    costFs.writeFileSync(file, body)
    return file
}

function costModelSource(turns: string) {
    return `
const { createRequire } = require('module')
const req = createRequire(${costRequireFrom})
const { AIMessageChunk } = req('@langchain/core/messages')
function message(total, toolCalls) {
  const input = Math.floor(total / 2)
  const output = total - input
  return new AIMessageChunk({
    content: toolCalls && toolCalls.length ? '' : 'done',
    tool_calls: toolCalls,
    usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: total }
  })
}
class Node {
  async init() {
    const turns = ${turns}
    let index = 0
    const model = {
      bindTools() { return model },
      async invoke() {
        const next = turns[index]
        index += 1
        if (!next) throw new Error('the test model ran out of responses')
        return next
      }
    }
    return model
  }
}
module.exports = { nodeClass: Node }
`
}

function costToolSource(returnDirect: boolean) {
    return `
class Node {
  async init() {
    return {
      name: 'lookup',
      description: 'look up a loaf',
      schema: null,
      returnDirect: ${returnDirect},
      async call() { return ${returnDirect ? "'the loaf'" : "'found'"} }
    }
  }
}
module.exports = { nodeClass: Node }
`
}

const lookupCall = "[{ id: 'call-1', name: 'lookup', args: { q: 'loaf' }, type: 'tool_call' }]"
const costModel100Then40 = writeCostFile('100-40', costModelSource(`[message(100, ${lookupCall}), message(40)]`))
const costModel1004020 = writeCostFile(
    '100-40-20',
    costModelSource(`[message(100, ${lookupCall}), message(40, ${lookupCall}), message(20)]`)
)
const costModelReturnDirect = writeCostFile('return-direct', costModelSource(`[message(40, ${lookupCall})]`))
const costTool = writeCostFile('tool', costToolSource(false))
const costToolDirect = writeCostFile('tool-direct', costToolSource(true))

function expectPricedSplit(
    usage: {
        input_tokens: number
        output_tokens: number
        total_tokens: number
        tool_call_tokens: number
        input_cost: number
        output_cost: number
        total_cost: number
    },
    input: number,
    output: number
) {
    expect(usage.input_tokens).toBe(input)
    expect(usage.output_tokens).toBe(output)
    expect(usage.total_tokens).toBe(input + output)
    expect(usage.tool_call_tokens).toBe(input + output)
    expect(usage.input_cost).toBeCloseTo(input * GPT41_MINI_INPUT, 12)
    expect(usage.output_cost).toBeCloseTo(output * GPT41_MINI_OUTPUT, 12)
    expect(usage.total_cost).toBeCloseTo(input * GPT41_MINI_INPUT + output * GPT41_MINI_OUTPUT, 12)
}

async function runPriced(modelFile: string, toolFile: string) {
    const agent = new AgentNode()
    return agent.run(
        {
            id: 'agent_0',
            inputs: {
                agentModel: 'chatOpenAI',
                agentModelConfig: { modelName: 'gpt-4.1-mini', streaming: false },
                agentTools: [{ agentSelectedTool: 'stubLookup', agentSelectedToolConfig: {} }],
                agentMessages: []
            }
        },
        'loaf',
        {
            chatId: 'c1',
            chatflowid: 'f1',
            sessionId: 's1',
            prependedChatHistory: [],
            abortController: new AbortController(),
            componentNodes: {
                chatOpenAI: { filePath: modelFile, label: 'OpenAI' },
                stubLookup: { filePath: toolFile, name: 'stubLookup', label: 'Lookup' }
            }
        }
    )
}

describe('Agent step cost matches the stored split', () => {
    it('prices a 100-then-40 run from the stored 70/70 split', async () => {
        const result = await runPriced(costModel100Then40, costTool)
        expectPricedSplit(result.output.usageMetadata, 70, 70)
        expect(result.output.usageMetadata.total_cost).toBeCloseTo(0.00014, 10)
        expect(result.output.usageMetadata.total_tokens).toBe(140)
    })

    it('prices a 100-40-20 run from the stored 80/80 split', async () => {
        const result = await runPriced(costModel1004020, costTool)
        expectPricedSplit(result.output.usageMetadata, 80, 80)
        expect(result.output.usageMetadata.total_tokens).toBe(160)
    })

    it('prices a return-direct answer from the stored 20/20 split', async () => {
        const result = await runPriced(costModelReturnDirect, costToolDirect)
        expect(result.output.content).toBe('the loaf')
        expectPricedSplit(result.output.usageMetadata, 20, 20)
        expect(result.output.usageMetadata.total_tokens).toBe(40)
    })
})
