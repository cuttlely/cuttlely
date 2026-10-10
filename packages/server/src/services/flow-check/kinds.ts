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

function startInputType(flowData: string): string | null {
    try {
        const nodes = JSON.parse(flowData)?.nodes
        if (!Array.isArray(nodes)) return null
        const start = nodes.find((node: any) => node?.data?.name === 'startAgentflow')
        return start ? String(start.data?.inputs?.startInputType || '') : null
    } catch {
        return null
    }
}

// The check asks each question as a chat message, so an agentflow must start with one on both sides.
// A form, a webhook or a schedule start has nothing to replay.
export function startUnavailable(type: string | null | undefined, canvases: Array<string | null | undefined>): Unavailable | null {
    if (type !== 'AGENTFLOW') return null
    const starts = canvases.filter((canvas): canvas is string => Boolean(canvas)).map(startInputType)
    if (starts.every((start) => start === 'chatInput')) return null
    return { code: 'start', message: 'The check asks questions, so it works on agentflows that start with a chat message.' }
}
