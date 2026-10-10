// The OpenAI, Azure OpenAI and Cohere LLM (text completion) cards are hidden from the Add Nodes palette because their
// providers no longer offer a completion model. A flow saved with one must still load and run as before: the node
// classes stay, keep their names and versions, and init still builds the model with the saved settings.

jest.mock('@langchain/openai', () => ({
    OpenAI: jest.fn().mockImplementation((fields) => ({ kind: 'OpenAI', fields })),
    AzureOpenAI: jest.fn().mockImplementation((fields) => ({ kind: 'AzureOpenAI', fields }))
}))

jest.mock('@langchain/cohere', () => ({
    Cohere: jest.fn().mockImplementation((fields) => ({ kind: 'Cohere', fields }))
}))

jest.mock('../../src/utils', () => ({
    getBaseClasses: jest.fn().mockReturnValue(['BaseLLM']),
    getCredentialData: jest.fn(),
    getCredentialParam: jest.fn()
}))

jest.mock('../../src/modelLoader', () => ({
    MODEL_TYPE: { LLM: 'llm' },
    getModels: jest.fn().mockResolvedValue([])
}))

import { getCredentialData, getCredentialParam } from '../../src/utils'

const { nodeClass: OpenAILLM } = require('./OpenAI/OpenAI')
const { nodeClass: AzureOpenAILLM } = require('./Azure OpenAI/AzureOpenAI')
const { nodeClass: CohereLLM } = require('./Cohere/Cohere')

describe('retired completion cards still load and run saved flows', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        ;(getCredentialParam as jest.Mock).mockImplementation((key, credentialData) => credentialData[key])
    })

    it('keeps the node names a saved flow refers to', () => {
        expect(new OpenAILLM().name).toBe('openAI')
        expect(new AzureOpenAILLM().name).toBe('azureOpenAI')
        expect(new CohereLLM().name).toBe('cohere')
        for (const Node of [OpenAILLM, AzureOpenAILLM, CohereLLM]) {
            const node = new Node()
            expect(node.badge).toBe('DEPRECATING')
            expect(node.category).toBe('LLMs')
        }
    })

    it('OpenAI LLM builds the model with the saved model name', async () => {
        ;(getCredentialData as jest.Mock).mockResolvedValue({ openAIApiKey: 'test-key' })
        const model = await new OpenAILLM().init(
            { credential: 'cred-1', inputs: { modelName: 'gpt-3.5-turbo-instruct', temperature: '0.3', maxTokens: '200' } },
            '',
            {}
        )
        expect(model.kind).toBe('OpenAI')
        expect(model.fields).toMatchObject({
            modelName: 'gpt-3.5-turbo-instruct',
            temperature: 0.3,
            maxTokens: 200,
            openAIApiKey: 'test-key'
        })
    })

    it('Azure OpenAI LLM builds the model with the saved deployment', async () => {
        ;(getCredentialData as jest.Mock).mockResolvedValue({
            azureOpenAIApiKey: 'test-key',
            azureOpenAIApiInstanceName: 'crumb-and-co',
            azureOpenAIApiDeploymentName: 'instruct',
            azureOpenAIApiVersion: '2024-10-21'
        })
        const model = await new AzureOpenAILLM().init(
            { credential: 'cred-1', inputs: { modelName: 'gpt-35-turbo-instruct', temperature: '0.9' } },
            '',
            {}
        )
        expect(model.kind).toBe('AzureOpenAI')
        expect(model.fields).toMatchObject({
            modelName: 'gpt-35-turbo-instruct',
            temperature: 0.9,
            azureOpenAIApiInstanceName: 'crumb-and-co',
            azureOpenAIApiDeploymentName: 'instruct'
        })
    })

    it('Cohere LLM builds the model with the saved model name', async () => {
        ;(getCredentialData as jest.Mock).mockResolvedValue({ cohereApiKey: 'test-key' })
        const model = await new CohereLLM().init({ credential: 'cred-1', inputs: { modelName: 'command', temperature: '0.7' } }, '', {})
        expect(model.kind).toBe('Cohere')
        expect(model.fields).toMatchObject({ model: 'command', temperature: 0.7, apiKey: 'test-key' })
    })
})
