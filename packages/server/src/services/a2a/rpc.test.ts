import { A2A_RPC_CODES, a2aLogMethod, errorResponseId, methodError, parseEnvelope, parseMessageParams, parseTaskIdParams } from './rpc'

describe('A2A JSON-RPC envelope', () => {
    it('returns -32600 with a null id for a bad envelope', () => {
        for (const raw of [
            null,
            [],
            1,
            'x',
            { jsonrpc: '1.0', id: 1, method: 'message/send', params: {} },
            { jsonrpc: '2.0', id: 1.5, method: 'message/send', params: {} },
            { jsonrpc: '2.0', id: true, method: 'message/send', params: {} },
            { jsonrpc: '2.0', id: null, method: 'message/send', params: {} },
            { jsonrpc: '2.0', method: 'message/send', params: {} },
            { jsonrpc: '2.0', id: 1, method: 9, params: {} }
        ]) {
            const parsed = parseEnvelope(raw)
            expect(parsed.ok).toBe(false)
            if (!parsed.ok) {
                expect(parsed.error.code).toBe(A2A_RPC_CODES.invalidRequest)
                expect(errorResponseId(parsed.error.code, parsed.id)).toBeNull()
            }
        }
    })

    it('returns -32600 when params is missing, including message/send', () => {
        const parsed = parseEnvelope({ jsonrpc: '2.0', id: 1, method: 'message/send' })
        expect(parsed.ok).toBe(false)
        if (!parsed.ok) {
            expect(parsed.error.code).toBe(A2A_RPC_CODES.invalidRequest)
            expect(parsed.id).toBeNull()
        }
    })

    it('returns -32602 with the request id when params is present but not an object', () => {
        const parsed = parseEnvelope({ jsonrpc: '2.0', id: 7, method: 'tasks/get', params: [] })
        expect(parsed.ok).toBe(false)
        if (!parsed.ok) {
            expect(parsed.error.code).toBe(A2A_RPC_CODES.invalidParams)
            expect(errorResponseId(parsed.error.code, parsed.id)).toBe(7)
        }
    })
})

describe('A2A methods and params', () => {
    const message = { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }

    it('joins text parts and accepts a context id with spaces', () => {
        const parsed = parseMessageParams({
            message: {
                ...message,
                parts: [
                    { kind: 'text', text: 'a' },
                    { kind: 'text', text: 'b' }
                ],
                contextId: 'Ada thread'
            },
            configuration: { historyLength: 3 },
            metadata: { x: 1 }
        })
        expect(parsed.question).toBe('a\nb')
        expect(parsed.contextId).toBe('Ada thread')
    })

    it('refuses blank text, a missing message, a non-string text part, and a bad context id', () => {
        expect(() => parseMessageParams({})).toThrow(/Invalid params/)
        expect(() => parseMessageParams({ message: { ...message, parts: [{ kind: 'text', text: '   ' }] } })).toThrow(/Invalid params/)
        expect(() => parseMessageParams({ message: { ...message, parts: [{ kind: 'text', text: 1 }] } })).toThrow(/Invalid params/)
        expect(() => parseMessageParams({ message: { ...message, contextId: '' } })).toThrow(/Invalid params/)
        expect(() => parseMessageParams({ message: { ...message, contextId: 'x'.repeat(201) } })).toThrow(/Invalid params/)
        expect(() => parseMessageParams({ message: { ...message, contextId: 9 } })).toThrow(/Invalid params/)
    })

    it('refuses a non-text part and push notification config', () => {
        try {
            parseMessageParams({ message: { ...message, parts: [{ kind: 'file', file: {} }] } })
            throw new Error('expected throw')
        } catch (err: any) {
            expect(err.code).toBe(A2A_RPC_CODES.contentType)
        }
        try {
            parseMessageParams({ message, configuration: { pushNotificationConfig: {} } })
            throw new Error('expected throw')
        } catch (err: any) {
            expect(err.code).toBe(A2A_RPC_CODES.pushNotSupported)
        }
    })

    it('maps unsupported methods', () => {
        expect(methodError('tasks/pushNotificationConfig/set')?.code).toBe(A2A_RPC_CODES.pushNotSupported)
        expect(methodError('tasks/resubscribe')?.code).toBe(A2A_RPC_CODES.unsupported)
        expect(methodError('agent/getAuthenticatedExtendedCard')?.code).toBe(A2A_RPC_CODES.extendedCard)
        expect(methodError('foo')?.code).toBe(A2A_RPC_CODES.methodNotFound)
        expect(methodError('message/send')).toBeUndefined()
    })

    it('logs only known methods', () => {
        expect(a2aLogMethod(undefined)).toBe('-')
        expect(a2aLogMethod('message/send')).toBe('message/send')
        expect(a2aLogMethod('tasks/pushNotificationConfig/set')).toBe('tasks/pushNotificationConfig')
        expect(a2aLogMethod('nope\n[a2a] forged secret-raw-message-xyz')).toBe('unknown')
    })

    it('requires a string task id', () => {
        expect(() => parseTaskIdParams({})).toThrow(/Invalid params/)
        expect(parseTaskIdParams({ id: 't1' })).toBe('t1')
    })
})
