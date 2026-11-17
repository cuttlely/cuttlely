jest.mock('./utils', () => {
    const actual = jest.requireActual('./utils')
    return {
        ...actual,
        getCredentialData: jest.fn().mockResolvedValue({
            anthropicApiKey: 'anthropic-test',
            azureOpenAIApiKey: 'azure-test',
            azureOpenAIApiInstanceName: 'instance',
            azureOpenAIApiDeploymentName: 'deployment',
            azureOpenAIApiVersion: '2025-04-01-preview',
            googleGenerativeAPIKey: 'google-test',
            mistralAIAPIKey: 'mistral-test',
            openAIApiKey: 'openai-test',
            groqApiKey: 'groq-test'
        })
    }
})

jest.mock('@langchain/openai', () => ({
    ChatOpenAI: jest.fn().mockImplementation(() => ({
        withStructuredOutput: jest.fn().mockReturnValue({
            invoke: jest.fn().mockResolvedValue({ questions: [] })
        })
    })),
    AzureChatOpenAI: jest.fn().mockImplementation(() => ({}))
}))

jest.mock('@langchain/anthropic', () => ({
    ChatAnthropic: jest.fn().mockImplementation(() => ({
        withStructuredOutput: jest.fn().mockReturnValue({
            invoke: jest.fn().mockResolvedValue({ questions: [] })
        })
    }))
}))

jest.mock('@langchain/google-genai', () => ({
    ChatGoogleGenerativeAI: jest.fn().mockImplementation(() => ({
        withStructuredOutput: jest.fn().mockReturnValue({
            invoke: jest.fn().mockResolvedValue({ questions: [] })
        })
    }))
}))

jest.mock('@langchain/mistralai', () => ({
    ChatMistralAI: jest.fn().mockImplementation(() => ({
        withStructuredOutput: jest.fn().mockReturnValue({
            invoke: jest.fn().mockResolvedValue({ questions: [] })
        })
    }))
}))

jest.mock('@langchain/groq', () => ({
    ChatGroq: jest.fn().mockImplementation(() => ({
        withStructuredOutput: jest.fn().mockReturnValue({
            invoke: jest.fn().mockResolvedValue({ questions: [] })
        })
    }))
}))

jest.mock('ollama', () => ({
    Ollama: jest.fn().mockImplementation(() => ({
        chat: jest.fn().mockResolvedValue({ message: { content: '{"questions":[]}' } })
    }))
}))

import { PromptTemplate } from '@langchain/core/prompts'
import { FollowUpPromptConfig, FollowUpPromptProvider } from './Interface'
import { generateFollowUpPrompts } from './followUpPrompts'

const providers = [
    ['Anthropic', FollowUpPromptProvider.ANTHROPIC, require('@langchain/anthropic').ChatAnthropic],
    ['Azure OpenAI', FollowUpPromptProvider.AZURE_OPENAI, require('@langchain/openai').AzureChatOpenAI],
    ['Google Generative AI', FollowUpPromptProvider.GOOGLE_GENAI, require('@langchain/google-genai').ChatGoogleGenerativeAI],
    ['Mistral AI', FollowUpPromptProvider.MISTRALAI, require('@langchain/mistralai').ChatMistralAI],
    ['OpenAI', FollowUpPromptProvider.OPENAI, require('@langchain/openai').ChatOpenAI],
    ['Groq', FollowUpPromptProvider.GROQ, require('@langchain/groq').ChatGroq],
    ['Ollama', FollowUpPromptProvider.OLLAMA, require('ollama').Ollama]
] as const

const configFor = (selectedProvider: FollowUpPromptProvider, temperature: string, modelName = 'normal-model'): FollowUpPromptConfig =>
    ({
        status: true,
        selectedProvider,
        [selectedProvider]: {
            credentialId: 'credential',
            modelName,
            baseUrl: '',
            prompt: 'History: {history}',
            temperature
        }
    } as FollowUpPromptConfig)

const temperatureOptions = (provider: FollowUpPromptProvider, constructor: jest.Mock): Record<string, unknown> => {
    const result = constructor.mock.results[constructor.mock.results.length - 1]?.value
    if (provider === FollowUpPromptProvider.OLLAMA) {
        const request = result.chat.mock.calls[result.chat.mock.calls.length - 1][0]
        return request.options
    }
    return constructor.mock.calls[constructor.mock.calls.length - 1][0]
}

beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(PromptTemplate, 'fromTemplate').mockReturnValue({
        pipe: jest.fn().mockReturnValue({
            pipe: jest.fn().mockReturnValue({
                invoke: jest.fn().mockResolvedValue({ questions: [] })
            })
        })
    } as any)
})

afterEach(() => jest.restoreAllMocks())

describe.each(providers)('generateFollowUpPrompts with %s', (_label, provider, constructor) => {
    it.each(['', 'not-a-number'])('omits a blank or non-numeric temperature (%p)', async (temperature) => {
        await generateFollowUpPrompts(configFor(provider, temperature), 'conversation', {})

        expect(temperatureOptions(provider, constructor)).not.toHaveProperty('temperature')
    })
})

describe('generateFollowUpPrompts OpenAI reasoning temperatures', () => {
    it.each([
        ['OpenAI gpt-5', FollowUpPromptProvider.OPENAI, require('@langchain/openai').ChatOpenAI, 'gpt-5'],
        ['OpenAI o3', FollowUpPromptProvider.OPENAI, require('@langchain/openai').ChatOpenAI, 'o3'],
        ['Azure OpenAI gpt-5', FollowUpPromptProvider.AZURE_OPENAI, require('@langchain/openai').AzureChatOpenAI, 'gpt-5'],
        ['Azure OpenAI o3', FollowUpPromptProvider.AZURE_OPENAI, require('@langchain/openai').AzureChatOpenAI, 'o3']
    ])('omits temperature for %s', async (_label, provider, constructor, modelName) => {
        await generateFollowUpPrompts(configFor(provider, '0.4', modelName), 'conversation', {})

        expect(temperatureOptions(provider, constructor)).not.toHaveProperty('temperature')
    })

    it('keeps a finite temperature for a normal OpenAI model', async () => {
        const constructor = require('@langchain/openai').ChatOpenAI
        await generateFollowUpPrompts(configFor(FollowUpPromptProvider.OPENAI, '0.25', 'gpt-4o-mini'), 'conversation', {})

        expect(temperatureOptions(FollowUpPromptProvider.OPENAI, constructor)).toHaveProperty('temperature', 0.25)
    })

    it('keeps a finite temperature for a non-OpenAI provider', async () => {
        const constructor = require('@langchain/anthropic').ChatAnthropic
        await generateFollowUpPrompts(configFor(FollowUpPromptProvider.ANTHROPIC, '0.6'), 'conversation', {})

        expect(temperatureOptions(FollowUpPromptProvider.ANTHROPIC, constructor)).toHaveProperty('temperature', 0.6)
    })
})
