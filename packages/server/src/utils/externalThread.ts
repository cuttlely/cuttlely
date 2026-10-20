import { createHash, createHmac } from 'crypto'
import { StatusCodes } from 'http-status-codes'
import { issueSessionToken, ownershipSecret } from './sessionOwnership'
import { ExternalAgentError } from './externalAgentAuth'

export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export function parseThreadId(raw: string | string[] | undefined): string | undefined {
    if (raw === undefined) return undefined
    if (Array.isArray(raw)) {
        throw new ExternalAgentError(StatusCodes.BAD_REQUEST, 'thread_id_invalid', 'invalid_request_error', 'Invalid thread id')
    }
    if (!THREAD_ID_PATTERN.test(raw)) {
        throw new ExternalAgentError(StatusCodes.BAD_REQUEST, 'thread_id_invalid', 'invalid_request_error', 'Invalid thread id')
    }
    return raw
}

const toUuidV8 = (bytes: Buffer): string => {
    const b = Buffer.from(bytes.subarray(0, 16))
    b[6] = (b[6] & 0x0f) | 0x80
    b[8] = (b[8] & 0x3f) | 0x80
    const hex = b.toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const callerKeyFor = (flow: { id: string; apikeyid?: string | null }): string =>
    typeof flow.apikeyid === 'string' && flow.apikeyid ? `key:${flow.apikeyid}` : `public:${flow.id}`

export function threadChatId(flow: { id: string; apikeyid?: string | null }, threadId: string): { chatId: string; sessionToken: string } {
    const callerKey = callerKeyFor(flow)
    const secret = ownershipSecret()
    const digest = createHmac('sha256', secret)
        .update('orchestrate-thread-v1')
        .update('\0')
        .update(callerKey)
        .update('\0')
        .update(flow.id)
        .update('\0')
        .update(threadId)
        .digest()
    const chatId = toUuidV8(digest)
    return { chatId, sessionToken: issueSessionToken(secret, callerKey, flow.id, chatId) }
}

export function threadLogHash(threadId?: string): string {
    if (!threadId) return 'none'
    return createHash('sha256').update(threadId).digest('hex').slice(0, 8)
}
