import { AIMessageChunk } from '@langchain/core/messages'

const { nodeClass: AgentNode } = require('./Agent')

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
        expect(output.usageMetadata.tool_call_tokens).toBe(40)
        expect(output.usageMetadata.input_tokens + output.usageMetadata.output_tokens).toBe(output.usageMetadata.tool_call_tokens)
    })
})
