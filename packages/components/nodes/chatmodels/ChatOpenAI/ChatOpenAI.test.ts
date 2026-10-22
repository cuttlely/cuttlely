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

import {
    chatCompletionsRefusesFunctionTools,
    openAIReasoningFields,
    supportsReasoningEffortNone,
    needsResponsesApiForToolsWithReasoning
} from '../../../src/utils'

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

type Sent = { api: 'chat' | 'responses'; url: string; headers: Record<string, string>; body: any }

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
        sent.push({
            api,
            url: href,
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: JSON.parse(String(init?.body ?? '{}'))
        })
        return new Response(JSON.stringify(api === 'responses' ? responsesReply : completionReply), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })
    }
    fetchSpy.mockImplementation(fakeFetch as any)
    await model.bindTools([lookupTool]).invoke('hello')
    return sent
}

// Every test in this file runs with no OpenAI or xAI key, restored afterwards.
const prevKeys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, XAI_API_KEY: process.env.XAI_API_KEY }
beforeAll(() => {
    delete process.env.OPENAI_API_KEY
    delete process.env.XAI_API_KEY
})
afterAll(() => {
    for (const [key, value] of Object.entries(prevKeys)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
})

describe('openAIReasoningFields', () => {
    it('gpt-6.1-sol gets low instead of minimal, which it refuses', () => {
        expect(openAIReasoningFields('gpt-6.1-sol', { enabled: true, effort: 'minimal' })).toEqual({
            modelKwargs: { reasoning: { effort: 'low' } },
            useResponsesApi: true
        })
        expect(openAIReasoningFields('gpt-5', { enabled: true, effort: 'minimal' })).toEqual({ reasoning: { effort: 'minimal' } })
    })

    it('knows which models take effort none', () => {
        expect(supportsReasoningEffortNone('gpt-5.6-luna')).toBe(true)
        expect(supportsReasoningEffortNone('gpt-5.1')).toBe(true)
        expect(supportsReasoningEffortNone('gpt-6-luna')).toBe(false)
        expect(supportsReasoningEffortNone('gpt-6-astra')).toBe(false)
        expect(supportsReasoningEffortNone('gpt-6.1-sol')).toBe(false)
        expect(supportsReasoningEffortNone('gpt-5.4-pro')).toBe(false)
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
        expect(chatCompletionsRefusesFunctionTools('gpt-6-astra')).toBe(true)
        expect(chatCompletionsRefusesFunctionTools('gpt-6.1-sol')).toBe(true)
        expect(chatCompletionsRefusesFunctionTools('gpt-5.6-luna')).toBe(false)
    })

    it('GPT-6 never gets effort none and always uses the Responses API', () => {
        expect(openAIReasoningFields('gpt-6-astra', { enabled: false, effort: 'high' })).toEqual({ useResponsesApi: true })
        expect(openAIReasoningFields('gpt-6.1-sol', { enabled: true, effort: 'none' })).toEqual({ useResponsesApi: true })
        expect(openAIReasoningFields('gpt-6-luna', { enabled: true, effort: 'low' })).toEqual({
            modelKwargs: { reasoning: { effort: 'low' } },
            useResponsesApi: true
        })
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
        // gpt-5.6 reasons at medium when no effort is sent, so tools need the Responses API
        expect(openAIReasoningFields('gpt-5.6-luna', { enabled: true })).toEqual({ useResponsesApi: true })
        expect(openAIReasoningFields('gpt-5.2', { enabled: true })).toEqual({})
    })
})

describe('ChatOpenAI request params', () => {
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

    it('gpt-6-astra with Reasoning off sends no effort none and uses the Responses API for tools', async () => {
        const sent = await sendWithTool(ChatOpenAINode, { modelName: 'gpt-6-astra', reasoning: false, reasoningEffort: 'high' })
        expect(sent).toHaveLength(1)
        expect(sent[0].api).toBe('responses')
        expect(sent[0].body.reasoning).toBeUndefined()
        expect(sent[0].body.tools[0].name).toBe('lookup')
    })

    it('gpt-6.1-sol with effort None sends no effort and uses the Responses API', async () => {
        const sent = await sendWithTool(ChatOpenAINode, { modelName: 'gpt-6.1-sol', reasoning: true, reasoningEffort: 'none' })
        expect(sent[0].api).toBe('responses')
        expect(sent[0].body.reasoning?.effort).toBeUndefined()
    })

    it('gpt-6.1-sol with effort minimal sends reasoning effort low in the /responses body', async () => {
        const sent = await sendWithTool(ChatOpenAINode, { modelName: 'gpt-6.1-sol', reasoning: true, reasoningEffort: 'minimal' })
        expect(sent).toHaveLength(1)
        expect(sent[0].api).toBe('responses')
        expect(sent[0].body.reasoning).toEqual({ effort: 'low' })
        expect(sent[0].body.reasoning_effort).toBeUndefined()
        expect(sent[0].body.temperature).toBeUndefined()
        expect(sent[0].body.tools[0].name).toBe('lookup')
    })

    it('gpt-6-astra with high and a summary sends both in the /responses body', async () => {
        const sent = await sendWithTool(ChatOpenAINode, {
            modelName: 'gpt-6-astra',
            reasoning: true,
            reasoningEffort: 'high',
            reasoningSummary: 'auto'
        })
        expect(sent[0].api).toBe('responses')
        expect(sent[0].body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    })

    it('gpt-6-luna with medium sends it in the /responses body', async () => {
        const sent = await sendWithTool(ChatOpenAINode, { modelName: 'gpt-6-luna', reasoning: true, reasoningEffort: 'medium' })
        expect(sent[0].api).toBe('responses')
        expect(sent[0].body.reasoning).toEqual({ effort: 'medium' })
    })

    it('gpt-5 and gpt-5-mini keep effort minimal on chat completions', async () => {
        for (const modelName of ['gpt-5', 'gpt-5-mini']) {
            const sent = await sendWithTool(ChatOpenAINode, { modelName, reasoning: true, reasoningEffort: 'minimal' })
            expect(sent[0].api).toBe('chat')
            expect(sent[0].body.reasoning_effort).toBe('minimal')
            expect(sent[0].body.reasoning).toBeUndefined()
        }
    })

    it('gpt-5.6-mini with Reasoning off or effort None sends reasoning_effort none on chat completions', async () => {
        for (const inputs of [
            { reasoning: false, reasoningEffort: 'high' },
            { reasoning: true, reasoningEffort: 'none' }
        ]) {
            const sent = await sendWithTool(ChatOpenAINode, { modelName: 'gpt-5.6-mini', ...inputs })
            expect(sent[0].api).toBe('chat')
            expect(sent[0].body.reasoning_effort).toBe('none')
            expect(sent[0].body.reasoning).toBeUndefined()
            expect(sent[0].body.temperature).toBeUndefined()
        }
    })

    it('gpt-5.6 and o3 send no unsupported fields', async () => {
        const gpt56 = await sendWithTool(ChatOpenAINode, {
            modelName: 'gpt-5.6',
            temperature: '0.5',
            reasoning: true,
            reasoningEffort: 'high'
        })
        expect(gpt56[0].api).toBe('responses')
        expect(gpt56[0].body.reasoning).toEqual({ effort: 'high' })
        expect(gpt56[0].body.reasoning_effort).toBeUndefined()
        expect(gpt56[0].body.temperature).toBeUndefined()
        const o3 = await sendWithTool(ChatOpenAINode, { modelName: 'o3', temperature: '0.5', reasoning: true, reasoningEffort: 'high' })
        expect(o3[0].api).toBe('chat')
        expect(o3[0].body.reasoning_effort).toBe('high')
        expect(o3[0].body.reasoning).toBeUndefined()
        expect(o3[0].body.temperature).toBeUndefined()
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

    it('gpt-6.1-sol with minimal sends reasoning effort low in the /responses body', async () => {
        const sent = await sendWithTool(AzureChatOpenAINode, { modelName: 'gpt-6.1-sol', reasoning: true, reasoningEffort: 'minimal' })
        expect(sent[0].api).toBe('responses')
        expect(sent[0].body.reasoning).toEqual({ effort: 'low' })
        expect(sent[0].body.tools[0].name).toBe('lookup')
    })

    it('gpt-6-astra with Reasoning off sends no reasoning field', async () => {
        const sent = await sendWithTool(AzureChatOpenAINode, { modelName: 'gpt-6-astra', reasoning: false, reasoningEffort: 'high' })
        expect(sent[0].api).toBe('responses')
        expect(sent[0].body.reasoning).toBeUndefined()
    })

    it('Responses calls go to the resource-level v1 endpoint with the deployment as model', async () => {
        const sent = await sendWithTool(AzureChatOpenAINode, { modelName: 'gpt-6.1-sol', reasoning: true, reasoningEffort: 'high' })
        expect(sent[0].url).toBe('https://inst.openai.azure.com/openai/v1/responses')
        expect(sent[0].body.model).toBe('dep')
        expect(sent[0].headers['api-key']).toBe('az-test')
        expect(sent[0].body.reasoning).toEqual({ effort: 'high' })
    })

    it('gpt-5.6 Responses calls keep the reasoning in the body although the deployment name is not a model name', async () => {
        const sent = await sendWithTool(AzureChatOpenAINode, {
            modelName: 'gpt-5.6-luna',
            reasoning: true,
            reasoningEffort: 'low',
            reasoningSummary: 'auto'
        })
        expect(sent[0].url).toBe('https://inst.openai.azure.com/openai/v1/responses')
        expect(sent[0].body.model).toBe('dep')
        expect(sent[0].body.reasoning).toEqual({ effort: 'low', summary: 'auto' })
        expect(sent[0].body.temperature).toBeUndefined()
    })

    it('a custom base path is cut back to its resource for Responses calls', async () => {
        const sent = await sendWithTool(AzureChatOpenAINode, {
            modelName: 'gpt-6-astra',
            basepath: 'https://custom.example.com/openai/deployments',
            reasoning: true,
            reasoningEffort: 'medium'
        })
        expect(sent[0].url).toBe('https://custom.example.com/openai/v1/responses')
    })

    it('chat completions calls stay on the deployment path', async () => {
        const sent = await sendWithTool(AzureChatOpenAINode, { modelName: 'gpt-5.6-luna', reasoning: false })
        expect(sent[0].url).toBe('https://inst.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2025-04-01-preview')
    })

    it('Reasoning off on o3 sends no reasoning_effort', async () => {
        const sent = await sendWithTool(AzureChatOpenAINode, { modelName: 'o3', reasoning: false, reasoningEffort: 'high' })
        expect(sent[0].api).toBe('chat')
        expect(sent[0].body.reasoning_effort).toBeUndefined()
    })
})
