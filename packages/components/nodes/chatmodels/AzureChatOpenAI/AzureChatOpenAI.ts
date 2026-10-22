import { AzureOpenAIInput, AzureChatOpenAI as LangchainAzureChatOpenAI, ChatOpenAIFields } from '@langchain/openai'
import { BaseCache } from '@langchain/core/caches'
import { ICommonObject, IMultiModalOption, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { getBaseClasses, getCredentialData, getCredentialParam, isReasoningModelOpenAI, openAIReasoningFields } from '../../../src/utils'
import { getModels, MODEL_TYPE } from '../../../src/modelLoader'
import { AzureChatOpenAI } from './FlowiseAzureChatOpenAI'
import { OpenAI as OpenAIClient } from 'openai'

const serverCredentialsExists =
    !!process.env.AZURE_OPENAI_API_KEY &&
    !!process.env.AZURE_OPENAI_API_INSTANCE_NAME &&
    !!process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME &&
    !!process.env.AZURE_OPENAI_API_VERSION

class AzureChatOpenAI_ChatModels implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Azure OpenAI'
        this.name = 'azureChatOpenAI'
        this.version = 7.1
        this.type = 'AzureChatOpenAI'
        this.icon = 'Azure.svg'
        this.category = 'Chat Models'
        this.description = 'Wrapper around Azure OpenAI large language models that use the Chat endpoint'
        this.baseClasses = [this.type, ...getBaseClasses(LangchainAzureChatOpenAI)]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['azureOpenAIApi'],
            optional: serverCredentialsExists
        }
        this.inputs = [
            {
                label: 'Cache',
                name: 'cache',
                type: 'BaseCache',
                optional: true
            },
            {
                label: 'Model Name',
                name: 'modelName',
                type: 'asyncOptions',
                loadMethod: 'listModels',
                freeSolo: true
            },
            {
                label: 'Temperature',
                name: 'temperature',
                type: 'number',
                step: 0.1,
                default: 0.9,
                optional: true
            },
            {
                label: 'Max Tokens',
                name: 'maxTokens',
                type: 'number',
                step: 1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Streaming',
                name: 'streaming',
                type: 'boolean',
                default: true,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Allow Image Uploads',
                name: 'allowImageUploads',
                type: 'boolean',
                description:
                    'Allow image input. Refer to the <a href="https://github.com/cuttlely/cuttlely/blob/main/README.md#prediction-uploads" target="_blank">docs</a> for more details.',
                default: false,
                optional: true
            },
            {
                label: 'Reasoning',
                description:
                    'Whether the model reasons. Only applicable for reasoning models (gpt-5 and o-series models only). Off sends reasoning effort none on gpt-5.1 to gpt-5.x, and no reasoning effort on other models, which then use their default (GPT-6 has no none)',
                name: 'reasoning',
                type: 'boolean',
                default: false,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Reasoning Effort',
                description:
                    'Constrains effort on reasoning. Only applicable for reasoning models (gpt-5 and o-series models only). gpt-5.6 with an effort other than None, and every GPT-6 model, use the Responses API, because chat completions does not accept their function tools',
                name: 'reasoningEffort',
                type: 'options',
                options: [
                    {
                        label: 'None',
                        name: 'none',
                        description: 'No reasoning. gpt-5.1 to gpt-5.x only; other models send no effort'
                    },
                    {
                        label: 'Low',
                        name: 'low'
                    },
                    {
                        label: 'Medium',
                        name: 'medium'
                    },
                    {
                        label: 'High',
                        name: 'high'
                    }
                ],
                additionalParams: true,
                show: {
                    reasoning: true
                }
            },
            {
                label: 'Reasoning Summary',
                description: `A summary of the reasoning performed by the model. This can be useful for debugging and understanding the model's reasoning process`,
                name: 'reasoningSummary',
                type: 'options',
                options: [
                    {
                        label: 'Auto',
                        name: 'auto'
                    },
                    {
                        label: 'Concise',
                        name: 'concise'
                    },
                    {
                        label: 'Detailed',
                        name: 'detailed'
                    }
                ],
                additionalParams: true,
                show: {
                    reasoning: true
                }
            },
            {
                label: 'Top Probability',
                name: 'topP',
                type: 'number',
                step: 0.1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Frequency Penalty',
                name: 'frequencyPenalty',
                type: 'number',
                step: 0.1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Presence Penalty',
                name: 'presencePenalty',
                type: 'number',
                step: 0.1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Timeout',
                name: 'timeout',
                type: 'number',
                step: 1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Base Path',
                name: 'basepath',
                type: 'string',
                optional: true,
                description: 'Override the default base URL for the API, e.g., "https://api.example.com/v2/',
                additionalParams: true
            },
            {
                label: 'Base Options',
                name: 'baseOptions',
                type: 'json',
                optional: true,
                description: 'Default headers to include with every request to the API.',
                additionalParams: true
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listModels(): Promise<INodeOptionsValue[]> {
            return await getModels(MODEL_TYPE.CHAT, 'azureChatOpenAI')
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const modelName = nodeData.inputs?.modelName as string
        const temperature = nodeData.inputs?.temperature as string
        const maxTokens = nodeData.inputs?.maxTokens as string
        const frequencyPenalty = nodeData.inputs?.frequencyPenalty as string
        const presencePenalty = nodeData.inputs?.presencePenalty as string
        const timeout = nodeData.inputs?.timeout as string
        const streaming = nodeData.inputs?.streaming as boolean
        const cache = nodeData.inputs?.cache as BaseCache
        const topP = nodeData.inputs?.topP as string
        const basePath = nodeData.inputs?.basepath as string
        const baseOptions = nodeData.inputs?.baseOptions
        const reasoningEffort = nodeData.inputs?.reasoningEffort as OpenAIClient.Chat.ChatCompletionReasoningEffort | 'none' | null
        const reasoningSummary = nodeData.inputs?.reasoningSummary as 'auto' | 'concise' | 'detailed' | null

        const credentialData = await getCredentialData(nodeData.credential ?? '', options, { instance: this, nodeData })
        const azureOpenAIApiKey = getCredentialParam('azureOpenAIApiKey', credentialData, nodeData)
        const azureOpenAIApiInstanceName = getCredentialParam('azureOpenAIApiInstanceName', credentialData, nodeData)
        const azureOpenAIApiDeploymentName = getCredentialParam('azureOpenAIApiDeploymentName', credentialData, nodeData)
        const azureOpenAIApiVersion = getCredentialParam('azureOpenAIApiVersion', credentialData, nodeData)

        const allowImageUploads = nodeData.inputs?.allowImageUploads as boolean

        const obj: ChatOpenAIFields & Partial<AzureOpenAIInput> = {
            temperature: parseFloat(temperature),
            modelName,
            azureOpenAIApiKey,
            azureOpenAIApiInstanceName,
            azureOpenAIApiDeploymentName,
            azureOpenAIApiVersion,
            streaming: streaming ?? true
        }

        if (maxTokens) obj.maxCompletionTokens = parseInt(maxTokens, 10)
        if (frequencyPenalty) obj.frequencyPenalty = parseFloat(frequencyPenalty)
        if (presencePenalty) obj.presencePenalty = parseFloat(presencePenalty)
        if (timeout) obj.timeout = parseInt(timeout, 10)
        if (cache) obj.cache = cache
        if (topP) obj.topP = parseFloat(topP)
        if (basePath) obj.azureOpenAIBasePath = basePath
        if (baseOptions) {
            try {
                const parsedBaseOptions = typeof baseOptions === 'object' ? baseOptions : JSON.parse(baseOptions)
                obj.configuration = {
                    defaultHeaders: parsedBaseOptions
                }
            } catch (exception) {
                console.error('Error parsing base options', exception)
            }
        }
        if (isReasoningModelOpenAI(modelName)) {
            delete obj.temperature
            delete obj.stop
            const fields = openAIReasoningFields(modelName, {
                enabled: nodeData.inputs?.reasoning as boolean | string | undefined,
                effort: reasoningEffort,
                summary: reasoningSummary
            })
            if (fields.reasoning) obj.reasoning = fields.reasoning
            if (fields.useResponsesApi) obj.useResponsesApi = true
        }

        const multiModalOption: IMultiModalOption = {
            image: {
                allowImageUploads: allowImageUploads ?? false
            }
        }

        const model = new AzureChatOpenAI(nodeData.id, obj)
        model.setMultiModalOption(multiModalOption)
        return model
    }
}

module.exports = { nodeClass: AzureChatOpenAI_ChatModels }
