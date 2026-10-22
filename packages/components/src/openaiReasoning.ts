import { OpenAI as OpenAIClient } from 'openai'
import { isReasoningModelOpenAI } from './utils'

export type OpenAIReasoningEffortInput = OpenAIClient.ReasoningEffort | 'none' | null | undefined

export interface OpenAIReasoningInputs {
    /** The node's Reasoning toggle. Anything but true (or 'true') counts as off. */
    enabled?: boolean | string | null
    effort?: OpenAIReasoningEffortInput | string
    summary?: 'auto' | 'concise' | 'detailed' | null | string
}

export interface OpenAIReasoningFields {
    reasoning?: OpenAIClient.Reasoning
    useResponsesApi?: boolean
}

const GPT_LATER = /gpt-(?:[6-9]|[1-9]\d)(?![\d])/

function gpt5Minor(name: string): number | undefined {
    const match = /gpt-5\.(\d+)/.exec(name)
    return match ? parseInt(match[1], 10) : undefined
}

/**
 * Models that accept reasoning effort 'none': gpt-5.1 and later, and gpt-6 and later.
 * gpt-5, gpt-5-mini and gpt-5-nano, o-series and codex-mini do not (their lowest is 'minimal' or 'low').
 * Codex and -pro variants are left out: they do not document 'none'.
 */
export function supportsReasoningEffortNone(name: string): boolean {
    if (!name || !isReasoningModelOpenAI(name)) return false
    if (/codex/.test(name) || /-pro(?:$|-)/.test(name)) return false
    const minor = gpt5Minor(name)
    if (minor !== undefined) return minor >= 1
    return GPT_LATER.test(name)
}

/**
 * Models that refuse function tools together with a reasoning effort other than 'none' on
 * /v1/chat/completions ("Function tools with reasoning_effort are not supported ... use /v1/responses"):
 * gpt-5.6 and later, and gpt-6 and later. Those calls go to the Responses API instead.
 */
export function needsResponsesApiForToolsWithReasoning(name: string): boolean {
    if (!name || !isReasoningModelOpenAI(name)) return false
    const minor = gpt5Minor(name)
    if (minor !== undefined) return minor >= 6
    return GPT_LATER.test(name)
}

function toggleOn(value: OpenAIReasoningInputs['enabled']): boolean {
    return value === true || value === 'true'
}

/**
 * Reasoning fields for a ChatOpenAI or AzureChatOpenAI node.
 *
 * - Not a reasoning model: nothing.
 * - Toggle off: effort 'none' where the model accepts it, otherwise no reasoning field at all, so
 *   LangChain sends no reasoning_effort. A Reasoning Effort or Summary left in the saved inputs is ignored.
 * - Toggle on: the chosen effort and summary. 'None' on a model without it sends no effort. A real effort
 *   on gpt-5.6 and later also turns on the Responses API, because chat completions refuses function tools
 *   with a reasoning effort on those models.
 */
export function openAIReasoningFields(modelName: string, inputs: OpenAIReasoningInputs): OpenAIReasoningFields {
    if (!modelName || !isReasoningModelOpenAI(modelName)) return {}
    const noneOk = supportsReasoningEffortNone(modelName)

    if (!toggleOn(inputs.enabled)) {
        return noneOk ? { reasoning: { effort: 'none' as OpenAIClient.ReasoningEffort } } : {}
    }

    const reasoning: OpenAIClient.Reasoning = {}
    const effort = inputs.effort ? String(inputs.effort) : ''
    if (effort === 'none') {
        if (noneOk) reasoning.effort = 'none' as OpenAIClient.ReasoningEffort
    } else if (effort) {
        reasoning.effort = effort as OpenAIClient.ReasoningEffort
    }
    // A summary only makes sense when the model reasons.
    if (inputs.summary && effort !== 'none') {
        reasoning.summary = inputs.summary as OpenAIClient.Reasoning['summary']
    }

    const fields: OpenAIReasoningFields = {}
    if (Object.keys(reasoning).length) fields.reasoning = reasoning
    if (effort && effort !== 'none' && needsResponsesApiForToolsWithReasoning(modelName)) fields.useResponsesApi = true
    return fields
}
