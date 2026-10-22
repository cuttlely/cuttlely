import { ChatOpenAI as LangchainChatOpenAI, ChatOpenAIFields, ChatOpenAIResponses } from '@langchain/openai'
import { IMultiModalOption, IVisionChatModal } from '../../../src'

const STRING_TOOL_CHOICES: Record<string, string> = { required: 'required', any: 'required', auto: 'auto', none: 'none' }

/**
 * Responses API client that keeps a string tool choice. The bundled LangChain Responses adapter only carries
 * object tool choices (a named function), so `required`, `auto` and `none` never reached `/responses` and a
 * forced tool call became optional. The value is per call, so it is set here on the request params rather than
 * through modelKwargs.
 */
export class ToolChoiceResponses extends ChatOpenAIResponses {
    invocationParams(options?: this['ParsedCallOptions']): any {
        const params: any = super.invocationParams(options)
        const choice = (options as any)?.tool_choice
        if (typeof choice === 'string' && STRING_TOOL_CHOICES[choice] && params.tools?.length) {
            params.tool_choice = STRING_TOOL_CHOICES[choice]
        }
        return params
    }
}

export class ChatOpenAI extends LangchainChatOpenAI implements IVisionChatModal {
    configuredModel: string
    configuredMaxToken?: number
    multiModalOption: IMultiModalOption
    builtInTools: Record<string, any>[] = []
    id: string

    constructor(id: string, fields?: ChatOpenAIFields) {
        super({ ...fields, responses: (fields as any)?.responses ?? new ToolChoiceResponses(fields) } as ChatOpenAIFields)
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
