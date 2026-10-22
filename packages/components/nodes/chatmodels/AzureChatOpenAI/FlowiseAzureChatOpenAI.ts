import { AzureChatOpenAI as LangchainAzureChatOpenAI } from '@langchain/openai'
import { ToolChoiceResponses } from '../ChatOpenAI/FlowiseChatOpenAI'
import { IMultiModalOption, IVisionChatModal } from '../../../src'

export type AzureChatOpenAIConstructorFields = ConstructorParameters<typeof LangchainAzureChatOpenAI>[0]

/**
 * Base URL for the Azure OpenAI Responses API: the resource-level v1 path (`https://<resource>.openai.azure.com/openai/v1`).
 * LangChain's Azure client scopes every request to `/openai/deployments/<deployment>`, which serves chat completions
 * but not `/responses`. A custom base path such as `https://<resource>.openai.azure.com/openai/deployments` is cut
 * back to its resource.
 */
export function azureResponsesBaseURL(fields: { azureOpenAIBasePath?: string; azureOpenAIApiInstanceName?: string }): string | undefined {
    const basePath = fields.azureOpenAIBasePath?.trim()
    if (basePath) {
        const resource = basePath.replace(/\/+$/, '').replace(/\/openai(?:\/.*)?$/, '')
        return `${resource}/openai/v1`
    }
    if (fields.azureOpenAIApiInstanceName) return `https://${fields.azureOpenAIApiInstanceName}.openai.azure.com/openai/v1`
    return undefined
}

/**
 * Responses API client for Azure: resource-level v1 endpoint, the deployment name as `model` (Azure routes by
 * deployment), and the reasoning settings sent in the body through modelKwargs, because LangChain only sends
 * `reasoning` for model names it recognises and a deployment name can be anything.
 */
function azureResponsesClient(fields: AzureChatOpenAIConstructorFields): ToolChoiceResponses | undefined {
    const f = (fields ?? {}) as any
    const baseURL = azureResponsesBaseURL(f)
    const deployment = f.azureOpenAIApiDeploymentName ?? f.deploymentName
    const apiKey = f.azureOpenAIApiKey ?? f.apiKey ?? f.openAIApiKey
    if (!baseURL || !deployment || !apiKey) return undefined
    const reasoning = f.modelKwargs?.reasoning ?? f.reasoning
    const rest = { ...f }
    for (const key of [
        'reasoning',
        'azureOpenAIApiKey',
        'azureOpenAIApiInstanceName',
        'azureOpenAIApiDeploymentName',
        'azureOpenAIApiVersion',
        'azureOpenAIBasePath'
    ]) {
        delete rest[key]
    }
    return new ToolChoiceResponses({
        ...rest,
        model: deployment,
        modelName: deployment,
        apiKey,
        modelKwargs: { ...f.modelKwargs, ...(reasoning ? { reasoning } : {}) },
        configuration: {
            ...f.configuration,
            baseURL,
            defaultHeaders: { ...f.configuration?.defaultHeaders, 'api-key': apiKey }
        }
    })
}

export class AzureChatOpenAI extends LangchainAzureChatOpenAI implements IVisionChatModal {
    configuredModel: string
    configuredMaxToken?: number
    multiModalOption: IMultiModalOption
    builtInTools: Record<string, any>[] = []
    id: string

    constructor(id: string, fields?: AzureChatOpenAIConstructorFields) {
        super(fields)
        // Any call LangChain routes to the Responses API (useResponsesApi, a reasoning summary, built-in tools)
        // uses this client. withConfig and bindTools rebuild the model from this.fields, so it goes there too.
        const responses = azureResponsesClient(fields)
        if (responses) {
            ;(this as any).responses = responses
            ;(this as any).fields = { ...(this as any).fields, responses }
        }
        this.id = id
        this.configuredModel = fields?.modelName ?? ''
        this.configuredMaxToken = fields?.maxTokens
    }

    setMultiModalOption(multiModalOption: IMultiModalOption): void {
        this.multiModalOption = multiModalOption
    }

    addBuiltInTools(builtInTool: Record<string, any>): void {
        this.builtInTools.push(builtInTool)
    }
}
