import { answerText } from './completion'

describe('answerText', () => {
    it('prefers text, then json, then the rest of the result without session fields', () => {
        expect(answerText({ text: 'Hello', json: { a: 1 } })).toBe('Hello')
        expect(answerText({ json: { a: 1 }, chatId: 'c' })).toBe('{"a":1}')
        expect(
            answerText({
                chatId: 'c',
                chatMessageId: 'm',
                sessionId: 's',
                sessionToken: 'tok',
                memoryType: 'buffer',
                question: 'q',
                followUpPrompts: [],
                flowVariables: {},
                action: null,
                executionId: 'e',
                extra: 'keep'
            })
        ).toBe('{"extra":"keep"}')
    })
})
