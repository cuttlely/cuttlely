// Which flows the publish check can replay. Shared by the check and Dev-to-Prod promote.

export interface Unavailable {
    code: 'off' | 'type' | 'start' | 'no-draft' | 'new-flow' | 'credentials'
    message: string
}

const CHECKABLE_TYPES = new Set(['CHATFLOW', 'AGENTFLOW'])

// Chatflows and agentflows. Legacy multi-agent canvases and assistants are not replayed. When Live and the
// version to check are given, they must be the same kind, because both run as the Live flow's kind.
export function typeUnavailable(...types: Array<string | null | undefined>): Unavailable | null {
    const kinds = types.map((type) => type || 'CHATFLOW')
    if (!kinds.every((kind) => CHECKABLE_TYPES.has(kind))) return { code: 'type', message: 'The check works on chatflows and agentflows.' }
    if (new Set(kinds).size > 1) return { code: 'type', message: 'The check compares two versions of the same kind of flow.' }
    return null
}

const CHAT_START_MESSAGE = 'The check asks questions, so it works on agentflows that start with a chat message.'

const TRIGGER_STARTS = new Set(['formInput', 'webhookTrigger', 'scheduleInput'])

export type TriggerStart = 'formInput' | 'webhookTrigger' | 'scheduleInput'

// What the dialog calls the start. One flow uses one of these for every recorded input.
export type ReplaySource = 'form' | 'webhook' | 'schedule'

export function sourceOf(kind: TriggerStart): ReplaySource {
    if (kind === 'formInput') return 'form'
    if (kind === 'webhookTrigger') return 'webhook'
    return 'schedule'
}

// The Start node's input type, or null when this canvas has no Start node (or is not JSON).
// An empty string means the Start node is there but its input type is blank.
export function canvasStart(flowData: string | null | undefined): string | null {
    if (!flowData) return null
    try {
        const nodes = JSON.parse(flowData)?.nodes
        if (!Array.isArray(nodes)) return null
        const start = nodes.find((node: any) => node?.data?.name === 'startAgentflow')
        if (!start) return null
        return String(start.data?.inputs?.startInputType || '')
    } catch {
        return null
    }
}

function presentStarts(canvases: Array<string | null | undefined>): string[] {
    return canvases
        .filter((canvas): canvas is string => Boolean(canvas))
        .map(canvasStart)
        .filter((start): start is string => start != null)
}

// The start both versions share, when it is a form, a webhook or a schedule.
// A canvas with no Start node is ignored, so a flow that was never published can still be checked.
// Two different starts, or a Start node with no input type, are not a trigger replay.
export function triggerStart(type: string | null | undefined, canvases: Array<string | null | undefined>): TriggerStart | null {
    if (type !== 'AGENTFLOW') return null
    const present = presentStarts(canvases)
    if (!present.length) return null
    const first = present[0]
    if (!TRIGGER_STARTS.has(first) || !present.every((start) => start === first)) return null
    return first as TriggerStart
}

// Chat-started agentflows are checked by replaying questions. Form, webhook and schedule starts are checked
// by replaying recorded inputs, and both versions must use that same start. Anything else keeps the chat message.
export function startUnavailable(type: string | null | undefined, canvases: Array<string | null | undefined>): Unavailable | null {
    if (type !== 'AGENTFLOW') return null
    const present = presentStarts(canvases)
    if (present.length > 0 && present.every((start) => start === 'chatInput')) return null
    if (triggerStart(type, canvases)) return null
    return { code: 'start', message: CHAT_START_MESSAGE }
}

const START_NAMES: Record<string, string> = {
    formInput: 'a form',
    webhookTrigger: 'a webhook',
    scheduleInput: 'a schedule'
}

// A dataset check is refused on its own, with a 400, because the rows are chat questions.
// A recent-question check on the same flow stays the 409 from startUnavailable.
export function datasetStartRefusal(type: string | null | undefined, canvases: Array<string | null | undefined>): string | null {
    const trigger = triggerStart(type, canvases)
    if (trigger) {
        return `A dataset check asks each row as a chat message. This flow starts with ${START_NAMES[trigger]}, so it cannot use a dataset.`
    }
    if (type !== 'AGENTFLOW') return null
    const starts = canvases
        .filter((canvas): canvas is string => Boolean(canvas))
        .map(canvasStart)
        .filter((start): start is string => start != null)
    if (!starts.length || starts.every((start) => start === 'chatInput')) return null
    const named = starts.map((start) => START_NAMES[start] || '').find(Boolean)
    const which = named || 'something other than a chat message'
    return `A dataset check asks each row as a chat message. This flow starts with ${which}, so it cannot use a dataset.`
}
