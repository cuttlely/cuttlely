import fs from 'fs'
import os from 'os'
import path from 'path'
import { Request } from 'express'
import { chatScopedUploadName } from '@cuttlely/components'
import { getMemorySessionId } from './index'
import {
    bindRequestSession,
    bindSuppliedChatId,
    configureSessionOwnershipForTests,
    createFileGrantStore,
    createMemoryGrantStore,
    OwnedSession,
    pinOwnedMemorySession,
    resetSessionOwnershipForTests
} from './sessionOwnership'

/**
 * Buffer memory reads rows with `{ sessionId, chatflowid }` and the prediction write
 * stores that same sessionId (BufferMemory.getChatMessages, utilAddChatMessage).
 * These tests use that key: a second caller must not read or append the first caller's rows.
 */
const FLOW = '11111111-1111-4111-8111-111111111111'
const SECRET = 'test-session-secret'

interface MemoryRow {
    sessionId: string
    chatId: string
    content: string
}

const memory = new Map<string, MemoryRow[]>()

const readMemory = (sessionId: string): MemoryRow[] => memory.get(`${FLOW}:${sessionId}`)?.slice() ?? []

const writeMemory = (sessionId: string, chatId: string, content: string): void => {
    const key = `${FLOW}:${sessionId}`
    const rows = memory.get(key) ?? []
    rows.push({ sessionId, chatId, content })
    memory.set(key, rows)
}

const fakeReq = (
    body: Record<string, unknown>,
    user?: Record<string, unknown>,
    headerToken?: string,
    cookies?: Record<string, string>
): Request =>
    ({
        body,
        user,
        cookies,
        headers: headerToken ? { 'x-cuttlely-session-token': headerToken } : {},
        get(name: string) {
            if (name.toLowerCase() === 'x-cuttlely-session-token') return headerToken
            return undefined
        }
    } as unknown as Request)

const turn = (
    body: Record<string, unknown>,
    options: {
        isInternal: boolean
        apiKeyId?: string
        user?: Record<string, unknown>
        headerToken?: string
        cookies?: Record<string, string>
    }
): { owned: OwnedSession; sessionId: string } => {
    const req = fakeReq(body, options.user, options.headerToken, options.cookies)
    const owned = bindRequestSession(req, {
        chatflow: { id: FLOW, apikeyid: options.apiKeyId },
        isInternal: options.isInternal
    })
    const sessionId = getMemorySessionId(undefined, req.body, owned.chatId, options.isInternal)
    return { owned, sessionId }
}

describe('session ownership', () => {
    beforeEach(() => {
        memory.clear()
        configureSessionOwnershipForTests({ grants: createMemoryGrantStore(), secret: SECRET })
    })

    afterAll(() => {
        resetSessionOwnershipForTests()
    })

    it('keeps an API-key caller on its own session and blocks a second caller at read and write', () => {
        const first = turn({ question: 'hi' }, { isInternal: false, apiKeyId: 'key-a' })
        writeMemory(first.sessionId, first.owned.chatId, 'secret plan')
        expect(readMemory(first.sessionId)).toEqual([{ sessionId: first.sessionId, chatId: first.owned.chatId, content: 'secret plan' }])

        const continued = turn(
            { chatId: first.owned.chatId, overrideConfig: { sessionId: first.owned.sessionId }, sessionToken: first.owned.sessionToken },
            { isInternal: false, apiKeyId: 'key-a' }
        )
        expect(continued.sessionId).toBe(first.sessionId)
        const continuedInput = {
            question: 'again',
            overrideConfig: { sessionId: continued.sessionId },
            chatId: continued.owned.chatId
        }
        expect(getMemorySessionId(undefined, continuedInput, continued.owned.chatId, false)).toBe(first.sessionId)
        expect(readMemory(continued.sessionId).map((row) => row.content)).toEqual(['secret plan'])
        writeMemory(continued.sessionId, continued.owned.chatId, 'second turn')
        expect(readMemory(first.sessionId).map((row) => row.content)).toEqual(['secret plan', 'second turn'])

        const sameKeyNoToken = turn(
            { chatId: first.owned.chatId, overrideConfig: { sessionId: first.owned.sessionId } },
            { isInternal: false, apiKeyId: 'key-a' }
        )
        expect(sameKeyNoToken.sessionId).not.toBe(first.sessionId)
        expect(readMemory(sameKeyNoToken.sessionId)).toEqual([])
        writeMemory(sameKeyNoToken.sessionId, sameKeyNoToken.owned.chatId, 'should not land on the first session')
        expect(readMemory(first.sessionId).map((row) => row.content)).toEqual(['secret plan', 'second turn'])

        const otherKey = turn(
            {
                chatId: first.owned.chatId,
                overrideConfig: { sessionId: first.owned.sessionId },
                sessionToken: first.owned.sessionToken
            },
            { isInternal: false, apiKeyId: 'key-b' }
        )
        expect(otherKey.sessionId).not.toBe(first.sessionId)
        expect(readMemory(otherKey.sessionId)).toEqual([])
        writeMemory(otherKey.sessionId, otherKey.owned.chatId, 'other key')
        expect(readMemory(first.sessionId).map((row) => row.content)).toEqual(['secret plan', 'second turn'])
        expect(otherKey.owned.sessionToken).not.toBe(first.owned.sessionToken)
        expect(otherKey.owned.sessionToken).not.toContain(first.sessionId)

        const second = turn({ question: 'other chat' }, { isInternal: false, apiKeyId: 'key-a' })
        const cookieContinue = turn(
            { chatId: first.owned.chatId },
            {
                isInternal: false,
                apiKeyId: 'key-a',
                cookies: {
                    cuttlely_session: `${second.owned.chatId}.${second.owned.sessionToken},${first.owned.chatId}.${first.owned.sessionToken}`
                }
            }
        )
        expect(cookieContinue.sessionId).toBe(first.sessionId)
        expect(readMemory(cookieContinue.sessionId).map((row) => row.content)).toEqual(['secret plan', 'second turn'])

        const cookieForAnotherId = turn(
            { chatId: first.owned.chatId },
            {
                isInternal: false,
                apiKeyId: 'key-a',
                cookies: { cuttlely_session: `${second.owned.chatId}.${second.owned.sessionToken}` }
            }
        )
        expect(cookieForAnotherId.sessionId).not.toBe(first.sessionId)
        expect(readMemory(first.sessionId).map((row) => row.content)).toEqual(['secret plan', 'second turn'])
    })

    it('lets a signed-in user continue and gives another user a new session', () => {
        const userA = { id: 'user-a', activeWorkspaceId: 'ws-1' }
        const userB = { id: 'user-b', activeWorkspaceId: 'ws-1' }
        const opened = turn(
            { chatId: 'client-picked-id', overrideConfig: { sessionId: 'client-picked-id' } },
            { isInternal: true, user: userA }
        )
        expect(opened.sessionId).not.toBe('client-picked-id')
        writeMemory(opened.sessionId, opened.owned.chatId, 'only A')

        const again = turn({ chatId: opened.owned.chatId }, { isInternal: true, user: userA })
        expect(again.sessionId).toBe(opened.sessionId)
        expect(readMemory(again.sessionId).map((row) => row.content)).toEqual(['only A'])
        writeMemory(again.sessionId, again.owned.chatId, 'still A')

        const intruder = turn(
            { chatId: opened.owned.chatId, overrideConfig: { sessionId: opened.owned.sessionId }, sessionToken: opened.owned.sessionToken },
            { isInternal: true, user: userB }
        )
        expect(intruder.sessionId).not.toBe(opened.sessionId)
        expect(readMemory(intruder.sessionId)).toEqual([])
        writeMemory(intruder.sessionId, intruder.owned.chatId, 'B')
        expect(readMemory(opened.sessionId).map((row) => row.content)).toEqual(['only A', 'still A'])

        const otherWorkspace = turn(
            { chatId: opened.owned.chatId },
            { isInternal: true, user: { id: 'user-a', activeWorkspaceId: 'ws-2' } }
        )
        expect(otherWorkspace.sessionId).not.toBe(opened.sessionId)
        expect(readMemory(otherWorkspace.sessionId)).toEqual([])
    })

    it('stores an upload under the bound chat id, not another caller prefix', () => {
        const owner = turn({ question: 'hi' }, { isInternal: false, apiKeyId: 'key-a' })
        const attacker = turn(
            { chatId: owner.owned.chatId, overrideConfig: { sessionId: owner.owned.sessionId } },
            { isInternal: false, apiKeyId: 'key-a' }
        )
        const stored = chatScopedUploadName(attacker.owned.chatId, 'rows.csv', { nonce: 'abcd1234' })
        expect(stored.startsWith(`${attacker.owned.chatId}--`)).toBe(true)
        expect(stored.startsWith(`${owner.owned.chatId}--`)).toBe(false)
        expect(attacker.owned.chatId).not.toBe(owner.owned.chatId)
    })

    it('does not let a hard-coded memory Session Id put two callers in one bucket', () => {
        const node = { data: { inputs: { sessionId: 'shared-bucket' } } } as any
        const userA = { id: 'user-a', activeWorkspaceId: 'ws-1' }
        const userB = { id: 'user-b', activeWorkspaceId: 'ws-1' }
        const a = turn({ question: 'hi' }, { isInternal: true, user: userA })
        const b = turn({ question: 'hi' }, { isInternal: true, user: userB })
        const sessionA = getMemorySessionId(node, { question: '', chatId: a.owned.chatId }, a.owned.chatId, true)
        const sessionB = getMemorySessionId(node, { question: '', chatId: b.owned.chatId }, b.owned.chatId, true)
        expect(sessionA).toBe(a.owned.chatId)
        expect(sessionB).toBe(b.owned.chatId)
        expect(sessionA).not.toBe('shared-bucket')
        expect(sessionA).not.toBe(sessionB)
        writeMemory(sessionA, a.owned.chatId, 'only A')
        writeMemory(sessionB, b.owned.chatId, 'only B')
        expect(readMemory(sessionA).map((row) => row.content)).toEqual(['only A'])
        expect(readMemory(sessionB).map((row) => row.content)).toEqual(['only B'])
    })

    it('refuses a resume of another caller session and keeps an owned one', () => {
        const owner = turn({ question: 'start' }, { isInternal: false, apiKeyId: 'key-a' })
        const intruder = fakeReq({ chatId: owner.owned.chatId, humanInput: { type: 'proceed' }, sessionToken: owner.owned.sessionToken })
        expect(() =>
            bindRequestSession(intruder, { chatflow: { id: FLOW, apikeyid: 'key-b' }, isInternal: false, failClosed: true })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))

        const again = fakeReq({
            chatId: owner.owned.chatId,
            humanInput: { type: 'proceed' },
            sessionToken: owner.owned.sessionToken
        })
        const resumed = bindRequestSession(again, { chatflow: { id: FLOW, apikeyid: 'key-a' }, isInternal: false, failClosed: true })
        expect(resumed.chatId).toBe(owner.owned.chatId)
    })

    it('does not keep another caller attachment or file prefix', () => {
        const owner = turn({ question: 'start' }, { isInternal: false, apiKeyId: 'key-a' })
        const write = fakeReq({})
        const stored = bindSuppliedChatId(write, {
            chatflow: { id: FLOW, apikeyid: 'key-a' },
            isInternal: false,
            suppliedChatId: owner.owned.chatId
        })
        expect(stored.chatId).not.toBe(owner.owned.chatId)
        expect(chatScopedUploadName(stored.chatId, 'rows.csv', { nonce: 'abcd1234' }).startsWith(`${owner.owned.chatId}--`)).toBe(false)

        const read = fakeReq({})
        expect(() =>
            bindSuppliedChatId(read, {
                chatflow: { id: FLOW, apikeyid: 'key-a' },
                isInternal: false,
                suppliedChatId: owner.owned.chatId,
                failClosed: true
            })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))

        const ownerRead = fakeReq({ sessionToken: owner.owned.sessionToken })
        const allowed = bindSuppliedChatId(ownerRead, {
            chatflow: { id: FLOW, apikeyid: 'key-a' },
            isInternal: false,
            suppliedChatId: owner.owned.chatId,
            failClosed: true
        })
        expect(allowed.chatId).toBe(owner.owned.chatId)
    })

    it('does not let overrideConfig.sessionId pick another caller memory without ownership', () => {
        const owner = turn({ question: 'hi' }, { isInternal: false, apiKeyId: 'key-a' })
        writeMemory(owner.sessionId, owner.owned.chatId, 'secret plan')
        const attacker = turn({ question: 'other' }, { isInternal: false, apiKeyId: 'key-b' })

        const copied = {
            question: 'read',
            chatId: owner.sessionId,
            overrideConfig: { sessionId: owner.sessionId, temperature: 0 }
        }
        const picked = getMemorySessionId(undefined, copied, attacker.owned.chatId, false)
        expect(picked).toBe(attacker.owned.chatId)
        expect(picked).not.toBe(owner.sessionId)
        expect(copied.overrideConfig.sessionId).toBe(attacker.owned.chatId)
        expect(copied.overrideConfig.temperature).toBe(0)
        expect(readMemory(picked)).toEqual([])
        expect(readMemory(owner.sessionId).map((row) => row.content)).toEqual(['secret plan'])

        const chatOnly = { question: 'read', chatId: owner.sessionId }
        expect(getMemorySessionId(undefined, chatOnly, attacker.owned.chatId, false)).toBe(attacker.owned.chatId)

        const internalBody = { question: 'read', overrideConfig: { sessionId: owner.sessionId } }
        expect(getMemorySessionId(undefined, internalBody, attacker.owned.chatId, true)).toBe(attacker.owned.chatId)
        expect(internalBody.overrideConfig.sessionId).toBe(attacker.owned.chatId)

        const kept = { sessionId: attacker.owned.chatId }
        expect(pinOwnedMemorySession(kept, attacker.owned.chatId)).toBe(attacker.owned.chatId)
        expect(kept.sessionId).toBe(attacker.owned.chatId)
        expect(() => pinOwnedMemorySession({ sessionId: { steal: true } }, attacker.owned.chatId)).toThrow(/must be a string/)
    })

    it('does not throw when the client session id is not a string', () => {
        const turned = turn({ overrideConfig: { sessionId: { steal: true } }, chatId: 12 }, { isInternal: false, apiKeyId: 'key-a' })
        expect(turned.sessionId).toMatch(/^[0-9a-f-]{36}$/)
        expect(readMemory(turned.sessionId)).toEqual([])
    })

    it('remembers a signed-in grant across a new store reading the same file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-grants-'))
        const file = path.join(dir, 'session-grants.json')
        configureSessionOwnershipForTests({ grants: createFileGrantStore(file), secret: SECRET })
        const user = { id: 'user-a', activeWorkspaceId: 'ws-1' }
        const opened = turn({ chatId: 'client-id' }, { isInternal: true, user })
        writeMemory(opened.sessionId, opened.owned.chatId, 'kept')
        configureSessionOwnershipForTests({ grants: createFileGrantStore(file), secret: SECRET })
        const again = turn({ chatId: opened.owned.chatId }, { isInternal: true, user })
        expect(again.sessionId).toBe(opened.sessionId)
        expect(readMemory(again.sessionId).map((row) => row.content)).toEqual(['kept'])
        fs.rmSync(dir, { recursive: true, force: true })
    })
})
