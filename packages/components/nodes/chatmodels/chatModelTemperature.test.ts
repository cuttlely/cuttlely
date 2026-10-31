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
    ChatOpenAIResponses: MockResponse,
    ChatOpenAICompletions: MockProvider
}))
jest.mock('@langchain/deepseek', () => ({ ChatDeepSeek: MockProvider }))
jest.mock('@langchain/ollama', () => ({ ChatOllama: MockProvider }))
jest.mock('@langchain/community/chat_models/togetherai', () => ({ ChatTogetherAI: MockProvider }))
jest.mock('@langchain/community/chat_models/alibaba_tongyi', () => ({ ChatAlibabaTongyi: MockProvider }))
jest.mock('@langchain/community/chat_models/ibm', () => ({ ChatWatsonx: MockProvider }))
jest.mock('@langchain/community/chat_models/perplexity', () => ({ ChatPerplexity: MockProvider }))
jest.mock('@langchain/groq', () => ({ ChatGroq: MockProvider }))
jest.mock('@langchain/anthropic', () => ({ ChatAnthropic: MockProvider }))
jest.mock('@langchain/aws', () => ({ ChatBedrockConverse: MockProvider }))
jest.mock('@langchain/baidu-qianfan', () => ({ ChatBaiduQianfan: MockProvider }))
jest.mock('@langchain/cohere', () => ({ ChatCohere: MockProvider }))
jest.mock('@langchain/google-genai', () => ({ ChatGoogleGenerativeAI: MockProvider }))
jest.mock('@langchain/google-vertexai', () => ({ ChatVertexAI: MockProvider }))
jest.mock('@langchain/mistralai', () => ({ ChatMistralAI: MockProvider }))
jest.mock('@langchain/xai', () => ({ ChatXAI: MockProvider }))
jest.mock('./ChatHuggingFace/core', () => ({ HuggingFaceInference: MockProvider }))
jest.mock('../../src/google-utils', () => ({
    buildGoogleCredentials: jest.fn().mockResolvedValue({})
}))
jest.mock('../../src/awsToolsUtils', () => ({
    getAWSCredentialConfig: jest.fn().mockResolvedValue({
        credentials: { accessKeyId: 'made-up-access-key', secretAccessKey: 'made-up-secret-key' }
    })
}))
jest.mock('../../src/anthropicUtils', () => ({
    supportsSamplingParams: jest.fn().mockReturnValue(true)
}))
jest.mock('../../src/modelLoader', () => ({
    MODEL_TYPE: { CHAT: 'chat' },
    getModels: jest.fn().mockResolvedValue([]),
    getRegions: jest.fn().mockResolvedValue([])
}))
jest.mock('./AWSBedrock/utils', () => ({
    validateEndpointHost: jest.fn().mockReturnValue({}),
    discoverInferenceProfiles: jest.fn().mockResolvedValue(new Set()),
    resolveBedrockModel: jest.fn().mockResolvedValue({ modelId: 'made-up-model' }),
    getStopSeqUnsupportedModels: jest.fn().mockResolvedValue(new Set()),
    normalizeBedrockError: jest.fn((error) => error)
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
            cerebrasApiKey: 'made-up-key',
            anthropicApiKey: 'made-up-key',
            alibabaApiKey: 'made-up-key',
            qianfanAccessKey: 'made-up-key',
            qianfanSecretKey: 'made-up-key',
            cohereApiKey: 'made-up-key',
            fireworksApiKey: 'made-up-key',
            googleGenerativeAPIKey: 'made-up-key',
            huggingFaceApiKey: 'hf_made-up-key',
            version: 'made-up-version',
            serviceUrl: 'https://made-up.example',
            projectId: 'made-up-project',
            watsonxAIAuthType: 'iam',
            watsonxAIApikey: 'made-up-key',
            watsonxAIBearerToken: 'made-up-token',
            mistralAIAPIKey: 'made-up-key',
            perplexityApiKey: 'made-up-key',
            sambanovaApiKey: 'made-up-key',
            xaiApiKey: 'made-up-key'
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
    require('./ChatCerebras/ChatCerebras').nodeClass,
    require('./ChatAnthropic/ChatAnthropic').nodeClass,
    require('./ChatGoogleVertexAI/ChatGoogleVertexAI').nodeClass,
    require('./ChatAlibabaTongyi/ChatAlibabaTongyi').nodeClass,
    require('./ChatBaiduWenxin/ChatBaiduWenxin').nodeClass,
    require('./ChatCohere/ChatCohere').nodeClass,
    require('./ChatFireworks/ChatFireworks').nodeClass,
    require('./ChatGoogleGenerativeAI/ChatGoogleGenerativeAI').nodeClass,
    require('./ChatHuggingFace/ChatHuggingFace').nodeClass,
    require('./ChatIBMWatsonx/ChatIBMWatsonx').nodeClass,
    require('./ChatMistral/ChatMistral').nodeClass,
    require('./ChatPerplexity/ChatPerplexity').nodeClass,
    require('./ChatSambanova/ChatSambanova').nodeClass,
    require('./ChatXAI/ChatXAI').nodeClass,
    require('./AWSBedrock/AWSChatBedrock').nodeClass
]

const temperatureCases: [unknown, number | undefined][] = [
    ['', undefined],
    [undefined, undefined],
    ['abc', undefined],
    ['0.7oops', undefined],
    ['0', 0],
    [0, 0],
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
