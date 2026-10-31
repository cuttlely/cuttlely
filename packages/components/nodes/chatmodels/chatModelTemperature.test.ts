const mockProviderConfigs: Record<string, any>[] = []

class MockProvider {
    constructor(fields: Record<string, any>) {
        mockProviderConfigs.push(fields)
    }
}

class MockResponse {
    fields: Record<string, any> | undefined

    constructor(fields?: Record<string, any>) {
        this.fields = fields
    }

    invocationParams(): Record<string, any> {
        return {}
    }
}

jest.mock('@langchain/openai', () => ({
    ChatOpenAI: MockProvider,
    AzureChatOpenAI: MockProvider,
    ChatOpenAIResponses: MockResponse
}))
jest.mock('@langchain/deepseek', () => ({ ChatDeepSeek: MockProvider }))
jest.mock('@langchain/ollama', () => ({ ChatOllama: MockProvider }))
jest.mock('@langchain/community/chat_models/togetherai', () => ({ ChatTogetherAI: MockProvider }))
jest.mock('@langchain/groq', () => ({ ChatGroq: MockProvider }))
jest.mock('../../src/modelLoader', () => ({
    MODEL_TYPE: { CHAT: 'chat' },
    getModels: jest.fn().mockResolvedValue([])
}))
jest.mock('../../src/httpSecurity', () => ({
    checkDenyList: jest.fn().mockResolvedValue(undefined)
}))
jest.mock('../../src/utils', () => {
    const actual = jest.requireActual('../../src/utils')
    return {
        ...actual,
        getCredentialData: jest.fn().mockResolvedValue({
            openAIApiKey: 'made-up-key',
            azureOpenAIApiKey: 'made-up-key',
            azureOpenAIApiInstanceName: 'made-up-instance',
            azureOpenAIApiDeploymentName: 'made-up-deployment',
            azureOpenAIApiVersion: 'made-up-version',
            deepseekApiKey: 'made-up-key',
            togetherAIApiKey: 'made-up-key',
            nvidiaNIMApiKey: 'made-up-key',
            cometApiKey: 'made-up-key',
            groqApiKey: 'made-up-key',
            localAIApiKey: 'made-up-key',
            litellmApiKey: 'made-up-key',
            cerebrasApiKey: 'made-up-key'
        })
    }
})

const nodeClasses = [
    require('./ChatOpenAI/ChatOpenAI').nodeClass,
    require('./AzureChatOpenAI/AzureChatOpenAI').nodeClass,
    require('./ChatOpenAICustom/ChatOpenAICustom').nodeClass,
    require('./ChatOpenRouter/ChatOpenRouter').nodeClass,
    require('./Deepseek/Deepseek').nodeClass,
    require('./ChatOllama/ChatOllama').nodeClass,
    require('./ChatTogetherAI/ChatTogetherAI').nodeClass,
    require('./ChatNvdiaNIM/ChatNvdiaNIM').nodeClass,
    require('./ChatCometAPI/ChatCometAPI').nodeClass,
    require('./Groq/Groq').nodeClass,
    require('./ChatLocalAI/ChatLocalAI').nodeClass,
    require('./ChatLitellm/ChatLitellm').nodeClass,
    require('./ChatCerebras/ChatCerebras').nodeClass
]

const temperatureCases: [unknown, number | undefined][] = [
    ['', undefined],
    [undefined, undefined],
    ['abc', undefined],
    ['0', 0],
    ['0.7', 0.7]
]

const cases = nodeClasses.flatMap((NodeClass, nodeIndex) =>
    temperatureCases.map(([temperature, expected]) => ({ NodeClass, nodeIndex, temperature, expected }))
)

test.each(cases)('node $nodeIndex passes optional temperature $temperature', async ({ NodeClass, temperature, expected }) => {
    mockProviderConfigs.length = 0
    const node = new NodeClass()

    await node.init(
        {
            id: 'made-up-node',
            credential: 'made-up-credential',
            inputs: { modelName: 'made-up-model', streaming: false, temperature }
        },
        '',
        {}
    )

    expect(mockProviderConfigs).toHaveLength(1)
    const config = mockProviderConfigs[0]
    if (expected === undefined) expect(config).not.toHaveProperty('temperature')
    else expect(config.temperature).toBe(expected)
})
