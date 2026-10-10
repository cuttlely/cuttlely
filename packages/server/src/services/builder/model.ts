import { Ask, ChatMessage } from './core'
import { BuildingModel, PartDefinition } from './recipe'

const FLOWISE_CREDENTIAL_ID = 'FLOWISE_CREDENTIAL_ID'

export const modelCredential = (chatModel: BuildingModel): string | undefined =>
    chatModel.credential || chatModel.inputs?.[FLOWISE_CREDENTIAL_ID] || undefined

const replyText = (content: unknown): string => {
    if (typeof content === 'string') return content
    if (Array.isArray(content))
        return content.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('')
    return ''
}

// The chat model the person picked, loaded the way a canvas loads it, as one ask(messages) call.
export async function chatModelAsk(
    chatModel: BuildingModel,
    componentNodes: Record<string, PartDefinition>,
    options: Record<string, any>
): Promise<Ask> {
    const component = componentNodes[chatModel.name]
    if (!component || component.category !== 'Chat Models') throw new Error(`"${chatModel.name}" is not a chat model.`)
    const nodeData = { ...chatModel, credential: modelCredential(chatModel), inputs: { ...(chatModel.inputs || {}) } }
    const nodeModule = await import(component.filePath as string)
    const model = await new nodeModule.nodeClass().init(nodeData, '', options)
    return async (messages: ChatMessage[]) => replyText((await model.invoke(messages))?.content)
}
