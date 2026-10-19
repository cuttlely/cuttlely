import { StatusCodes } from 'http-status-codes'
import { ExternalAgentError } from '../../utils/externalAgentAuth'
import { threadChatId } from '../../utils/externalThread'

export type OrchestrateHistoryTurn = { role: 'userMessage' | 'apiMessage'; content: string }

export type OrchestrateRunBody = {
    question: string
    history?: OrchestrateHistoryTurn[]
    streaming: boolean
    chatId?: string
    sessionToken?: string
}

export type MappedOrchestrateRequest = {
    body: OrchestrateRunBody
    model: string
    stream: boolean
}

const ROLES = new Set(['user', 'assistant', 'system', 'tool'])
const MAX_MESSAGES = 200

export function flowHasMemory(flow: { flowData?: string | null }): boolean {
    try {
        const parsed = JSON.parse(flow.flowData || '') as { nodes?: Array<{ data?: { category?: unknown } }> }
        const nodes = parsed?.nodes
        if (!Array.isArray(nodes)) return false
        return nodes.some((node) => node?.data?.category === 'Memory')
    } catch {
        return false
    }
}

const textContent = (content: unknown): string | undefined => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return undefined
    const parts: string[] = []
    for (const part of content) {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined
        const item = part as { type?: unknown; text?: unknown }
        if (item.type !== 'text' || typeof item.text !== 'string') return undefined
        parts.push(item.text)
    }
    return parts.join('\n')
}

export function mapOrchestrateRequest(
    raw: unknown,
    flow: { id: string; apikeyid?: string | null; flowData?: string | null },
    threadId?: string
): MappedOrchestrateRequest {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ExternalAgentError(StatusCodes.BAD_REQUEST, 'messages_invalid', 'invalid_request_error', 'messages is required')
    }
    const body = raw as Record<string, unknown>
    const messages = body.messages
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
        throw new ExternalAgentError(
            StatusCodes.BAD_REQUEST,
            'messages_invalid',
            'invalid_request_error',
            'messages must have between 1 and 200 items'
        )
    }

    const turns: Array<{ role: string; content: string }> = []
    for (const item of messages) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new ExternalAgentError(StatusCodes.BAD_REQUEST, 'messages_invalid', 'invalid_request_error', 'messages is invalid')
        }
        const role = (item as { role?: unknown }).role
        const content = textContent((item as { content?: unknown }).content)
        if (typeof role !== 'string' || !ROLES.has(role) || content === undefined) {
            throw new ExternalAgentError(StatusCodes.BAD_REQUEST, 'messages_invalid', 'invalid_request_error', 'messages is invalid')
        }
        turns.push({ role, content })
    }

    let lastUser = -1
    for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i].role === 'user') {
            lastUser = i
            break
        }
    }
    const question = lastUser >= 0 ? turns[lastUser].content.trim() : ''
    if (!question) {
        throw new ExternalAgentError(
            StatusCodes.BAD_REQUEST,
            'messages_invalid',
            'invalid_request_error',
            'messages must include a non-empty user turn'
        )
    }

    const skipHistory = Boolean(threadId) && flowHasMemory(flow)
    const history: OrchestrateHistoryTurn[] = []
    if (!skipHistory) {
        for (let i = 0; i < lastUser; i += 1) {
            const turn = turns[i]
            if (turn.role === 'user') history.push({ role: 'userMessage', content: turn.content })
            else if (turn.role === 'assistant') history.push({ role: 'apiMessage', content: turn.content })
        }
    }

    const model = typeof body.model === 'string' && body.model ? body.model : `cuttlely-${flow.id}`
    const stream = body.stream === true
    const runBody: OrchestrateRunBody = { question, streaming: stream }
    if (history.length) runBody.history = history
    if (threadId) {
        const bound = threadChatId(flow, threadId)
        runBody.chatId = bound.chatId
        runBody.sessionToken = bound.sessionToken
    }

    return { body: runBody, model, stream }
}
