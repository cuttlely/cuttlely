import { createHmac } from 'crypto'
import { ExternalAgentError } from './externalAgentAuth'
import { parseThreadId, THREAD_ID_PATTERN, threadChatId, threadLogHash } from './externalThread'
import { configureSessionOwnershipForTests, issueSessionToken, resetSessionOwnershipForTests } from './sessionOwnership'

const FLOW_A = '11111111-1111-4111-8111-111111111111'
const FLOW_B = '22222222-2222-4222-8222-222222222222'
const SECRET = 'orchestrate-thread-test-secret'

describe('externalThread', () => {
    beforeEach(() => configureSessionOwnershipForTests({ secret: SECRET }))
    afterEach(() => resetSessionOwnershipForTests())

    it('accepts a matching thread id and rejects a bad or repeated header', () => {
        expect(parseThreadId(undefined)).toBeUndefined()
        expect(parseThreadId('Ada-01')).toBe('Ada-01')
        expect(THREAD_ID_PATTERN.test('A')).toBe(true)
        expect(() => parseThreadId('')).toThrow(ExternalAgentError)
        expect(() => parseThreadId('-bad')).toThrow(ExternalAgentError)
        expect(() => parseThreadId(['a', 'b'])).toThrow(ExternalAgentError)
        try {
            parseThreadId('has space')
        } catch (err) {
            expect(err).toMatchObject({ statusCode: 400, code: 'thread_id_invalid' })
        }
    })

    it('hashes a thread id to 8 hex characters and uses none when it is missing', () => {
        expect(threadLogHash()).toBe('none')
        expect(threadLogHash('Ada-01')).toMatch(/^[0-9a-f]{8}$/)
        expect(threadLogHash('Ada-01')).not.toBe('Ada-01')
        expect(threadLogHash('Ada-01')).not.toContain('Ada')
    })

    it('derives a stable uuid v8 chat id and a matching session token', () => {
        const first = threadChatId({ id: FLOW_A, apikeyid: 'key-1' }, 'Ada-01')
        const again = threadChatId({ id: FLOW_A, apikeyid: 'key-1' }, 'Ada-01')
        expect(first.chatId).toBe(again.chatId)
        expect(first.chatId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(first.sessionToken).toBe(issueSessionToken(SECRET, 'key:key-1', FLOW_A, first.chatId))

        const digest = createHmac('sha256', SECRET)
            .update('orchestrate-thread-v1')
            .update('\0')
            .update('key:key-1')
            .update('\0')
            .update(FLOW_A)
            .update('\0')
            .update('Ada-01')
            .digest()
        expect(first.chatId.replace(/-/g, '').slice(12, 13)).toBe('8')
        expect(digest.length).toBe(32)
    })

    it('gives a different chat id for another flow or another bound key', () => {
        const a = threadChatId({ id: FLOW_A, apikeyid: 'key-1' }, 'Ada-01')
        const b = threadChatId({ id: FLOW_B, apikeyid: 'key-1' }, 'Ada-01')
        const c = threadChatId({ id: FLOW_A, apikeyid: 'key-2' }, 'Ada-01')
        expect(new Set([a.chatId, b.chatId, c.chatId]).size).toBe(3)
    })
})
