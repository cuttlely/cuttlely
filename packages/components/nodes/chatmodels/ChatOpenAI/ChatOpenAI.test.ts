// Request params for ChatOpenAI and AzureChatOpenAI reasoning settings. The client is mocked: no network, no keys.
jest.mock('../../../src/modelLoader', () => ({
    MODEL_TYPE: { CHAT: 'chat' },
    getModels: jest.fn().mockResolvedValue([])
}))
jest.mock('../../../src/utils', () => {
    const actual = jest.requireActual('../../../src/utils')
    return {
        ...actual,
        getCredentialData: jest.fn().mockResolvedValue({
            openAIApiKey: 'sk-test',
            azureOpenAIApiKey: 'az-test',
            azureOpenAIApiInstanceName: 'inst',
            azureOpenAIApiDeploymentName: 'dep',
            azureOpenAIApiVersion: '2025-04-01-preview'
        })
    }
})

import { openAIReasoningFields, supportsReasoningEffortNone, needsResponsesApiForToolsWithReasoning } from '../../../src/utils'

const { nodeClass: ChatOpenAINode } = require('./ChatOpenAI')
const { nodeClass: AzureChatOpenAINode } = require('../AzureChatOpenAI/AzureChatOpenAI')

const lookupTool = {
    type: 'function',
    function: {
        name: 'lookup',
        description: 'Look something up',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
    }
}

const completionReply = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
}

const responsesReply = {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    model: 'm',
    status: 'completed',
    output: [
        {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'ok', annotations: [] }]
        }
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
}

type Sent = { api: 'chat' | 'responses'; body: any }

let fetchSpy: jest.SpyInstance
beforeEach(() => {
    fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation((() => Promise.reject(new Error('network is not allowed in this test'))) as any)
})
afterEach(() => fetchSpy.mockRestore())

async function sendWithTool(nodeClass: any, inputs: Record<string, any>): Promise<Sent[]> {
    const node = new nodeClass()
    const model = await node.init({ id: 'n1', inputs: { streaming: false, ...inputs }, credential: 'c1' }, '', {})
    const sent: Sent[] = []
    // The OpenAI client's fetch is replaced, so every request is recorded and nothing reaches the network.
    const fakeFetch = async (url: any, init?: any) => {
        const href = String(url?.url ?? url)
        const api: Sent['api'] = /\/responses(\?|$)/.test(href) ? 'responses' : 'chat'
        sent.push({ api, body: JSON.parse(String(init?.body ?? '{}')) })
        return new Response(JSON.stringify(api === 'responses' ? responsesReply : completionReply), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })
    }
    fetchSpy.mockImplementation(fakeFetch as any)
    await model.bindTools([lookupTool]).invoke('hello')
    return sent
}

describe('openAIReasoningFields', () => {
    it('knows which models take effort none', () => {
        expect(supportsReasoningEffortNone('gpt-5.6-luna')).toBe(true)
        expect(supportsReasoningEffortNone('gpt-5.1')).toBe(true)
        expect(supportsReasoningEffortNone('gpt-6-luna')).toBe(true)
        expect(supportsReasoningEffortNone('gpt-5')).toBe(false)
        expect(supportsReasoningEffortNone('gpt-5-mini')).toBe(false)
        expect(supportsReasoningEffortNone('o3')).toBe(false)
        expect(supportsReasoningEffortNone('gpt-5.1-codex')).toBe(false)
        expect(supportsReasoningEffortNone('gpt-4.1')).toBe(false)
    })

    it('knows which models need the Responses API for tools with reasoning', () => {
        expect(needsResponsesApiForToolsWithReasoning('gpt-5.6-luna')).toBe(true)
        expect(needsResponsesApiForToolsWithReasoning('gpt-6.1-sol')).toBe(true)
        expect(needsResponsesApiForToolsWithReasoning('gpt-5.2')).toBe(false)
        expect(needsResponsesApiForToolsWithReasoning('gpt-5')).toBe(false)
        expect(needsResponsesApiForToolsWithReasoning('o4-mini')).toBe(false)
    })

    it('toggle off ignores a saved effort and summary', () => {
        expect(openAIReasoningFields('gpt-5.6-luna', { enabled: false, effort: 'high', summary: 'auto' })).toEqual({
            reasoning: { effort: 'none' }
        })
        expect(openAIReasoningFields('gpt-5', { enabled: false, effort: 'high' })).toEqual({})
        expect(openAIReasoningFields('o3', { effort: 'medium' })).toEqual({})
        expect(openAIReasoningFields('gpt-4.1', { enabled: true, effort: 'high' })).toEqual({})
    })

    it('toggle on sends the chosen effort', () => {
        expect(openAIReasoningFields('gpt-5.6-luna', { enabled: true, effort: 'high', summary: 'auto' })).toEqual({
            reasoning: { effort: 'high', summary: 'auto' },
            useResponsesApi: true
        })
        expect(openAIReasoningFields('gpt-5.6-luna', { enabled: 'true', effort: 'none', summary: 'auto' })).toEqual({
            reasoning: { effort: 'none' }
        })
        expect(openAIReasoningFields('gpt-5', { enabled: true, effort: 'none' })).toEqual({})
        expect(openAIReasoningFields('o3', { enabled: true, effort: 'low' })).toEqual({ reasoning: { effort: 'low' } })
        expect(openAIReasoningFields('gpt-5.6-luna', { enabled: true })).toEqual({})
    })
})

describe('ChatOpenAI request params', () => {
    const prevOpenAI = process.env.OPENAI_API_KEY
    beforeAll(() => {
        delete process.env.OPENAI_API_KEY
        delete process.env.XAI_API_KEY
    })
    afterAll(() => {
        if (prevOpenAI !== undefined) process.env.OPENAI_API_KEY = prevOpenAI
    })

    it('gpt-5.6-luna with Reasoning off and a leftover effort sends reasoning_effort none on chat completions', async () => {
        const sent = await sendWithTool(ChatOpenAINode, { modelName: 'gpt-5.6-luna', reasoning: false, reasoningEffort: 'medium' })
        expect(sent).toHaveLength(1)
        expect(sent[0].api).toBe('chat')
        expect(sent[0].body.reasoning_effort).toBe('none')
        expect(sent[0].body.tools[0].function.name).toBe('lookup')
        expect(sent[0].body.temperature).toBeUndefined()
    })

    it('gpt-5.6-luna with Reasoning on goes to the Responses API with tools and the effort', async () => {
        const sent = await sendWithTool(ChatOpenAINode, {
            modelName: 'gpt-5.6-luna',
            reasoning: true,
            reasoningEffort: 'high',
            reasoningSummary: 'auto'
        })
        expect(sent).toHaveLength(1)
        expect(sent[0].api).toBe('responses')
        expect(sent[0].body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
        expect(sent[0].body.tools[0].name).toBe('lookup')
        expect(sent[0].body.reasoning_effort).toBeUndefined()
    })

    it('gpt-5.6-luna with Reasoning on and effort None stays on chat completions', async () => {
        const sent = await sendWithTool(ChatOpenAINode, { modelName: 'gpt-5.6-luna', reasoning: true, reasoningEffort: 'none' })
        expect(sent[0].api).toBe('chat')
        expect(sent[0].body.reasoning_effort).toBe('none')
        expect(sent[0].body.tools).toHaveLength(1)
    })

    it('gpt-5 with Reasoning off sends no reasoning_effort', async () => {
        const sent = await sendWithTool(ChatOpenAINode, { modelName: 'gpt-5', reasoning: false, reasoningEffort: 'high' })
        expect(sent[0].api).toBe('chat')
        expect('reasoning_effort' in sent[0].body ? sent[0].body.reasoning_effort : undefined).toBeUndefined()
    })

    it('gpt-5.2 with Reasoning on keeps chat completions and the effort', async () => {
        const sent = await sendWithTool(ChatOpenAINode, { modelName: 'gpt-5.2', reasoning: true, reasoningEffort: 'low' })
        expect(sent[0].api).toBe('chat')
        expect(sent[0].body.reasoning_effort).toBe('low')
    })

    it('a non-reasoning model is unchanged', async () => {
        const sent = await sendWithTool(ChatOpenAINode, {
            modelName: 'gpt-4.1',
            temperature: '0.2',
            reasoning: true,
            reasoningEffort: 'high'
        })
        expect(sent[0].api).toBe('chat')
        expect(sent[0].body.reasoning_effort).toBeUndefined()
        expect(sent[0].body.temperature).toBe(0.2)
    })
})

describe('AzureChatOpenAI request params', () => {
    it('Reasoning off with a leftover effort sends reasoning_effort none on gpt-5.6', async () => {
        const sent = await sendWithTool(AzureChatOpenAINode, { modelName: 'gpt-5.6-luna', reasoning: false, reasoningEffort: 'high' })
        expect(sent[0].api).toBe('chat')
        expect(sent[0].body.reasoning_effort).toBe('none')
    })

    it('Reasoning on with an effort on gpt-5.6 uses the Responses API', async () => {
        const sent = await sendWithTool(AzureChatOpenAINode, { modelName: 'gpt-5.6-luna', reasoning: true, reasoningEffort: 'medium' })
        expect(sent[0].api).toBe('responses')
        expect(sent[0].body.reasoning).toEqual({ effort: 'medium' })
        expect(sent[0].body.tools[0].name).toBe('lookup')
    })

    it('Reasoning off on o3 sends no reasoning_effort', async () => {
        const sent = await sendWithTool(AzureChatOpenAINode, { modelName: 'o3', reasoning: false, reasoningEffort: 'high' })
        expect(sent[0].api).toBe('chat')
        expect(sent[0].body.reasoning_effort).toBeUndefined()
    })
})
