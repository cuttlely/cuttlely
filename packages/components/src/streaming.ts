import type { IServerSideEventStreamer } from './Interface'

export type ToolEventOptions = { showToolEvents?: boolean; chatflowType?: string }

/** Missing settings follow the canvas default without changing saved data. */
export function resolveShowToolEvents(chatbotConfig: unknown, chatflowType?: string): boolean {
    let config = chatbotConfig
    if (typeof config === 'string') {
        try {
            config = JSON.parse(config)
        } catch {
            config = undefined
        }
    }
    const status = (config as { showToolEvents?: { status?: unknown } } | undefined)?.showToolEvents?.status
    if (typeof status === 'boolean') return status
    return ['AGENTFLOW', 'MULTIAGENT', 'HARNESS'].includes(chatflowType || '')
}

export function allowsAgentStyleStream(options: ToolEventOptions): boolean {
    return options.showToolEvents === true
}

const agentStyleMethods = new Set([
    'streamUsedToolsEvent',
    'streamCalledToolsEvent',
    'streamAgentReasoningEvent',
    'streamAgentFlowEvent',
    'streamAgentFlowExecutedDataEvent',
    'streamNextAgentEvent',
    'streamNextAgentFlowEvent',
    'streamToolEvent'
])

export function isAgentStyleEvent(event: string): boolean {
    return (
        ['usedTools', 'calledTools', 'agentReasoning', 'agent_trace', 'tool'].includes(event) ||
        event.startsWith('agentFlow') ||
        event.startsWith('nextAgent')
    )
}

// Scope the policy to this execution, never to the shared streamer or a chat id.
// Bind forwarded methods to their original instance (including the Redis publisher).
// Harness events and normal answer/attachment events pass through unchanged.
export function streamChatflowSafe<T extends IServerSideEventStreamer | undefined>(streamer: T, options: ToolEventOptions): T {
    if (!streamer || allowsAgentStyleStream(options)) return streamer
    return new Proxy(streamer, {
        get(target, property) {
            if (agentStyleMethods.has(String(property))) return () => undefined
            if (property === 'streamCustomEvent') {
                return (chatId: string, event: string, data: unknown) => {
                    if (!isAgentStyleEvent(event)) target.streamCustomEvent(chatId, event, data)
                }
            }
            const value = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
        }
    }) as T
}
