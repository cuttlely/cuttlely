const { resolveConversationSystemPrompt } = require('./ConversationChain')
const { transformBracesWithColon } = require('../../../src/utils')

describe('conversation system prompt', () => {
    it('uses the current prompt when it is set', () => {
        expect(resolveConversationSystemPrompt({ systemMessagePrompt: 'Stay brief.', systemMessage: 'Older greeting.' })).toBe(
            'Stay brief.'
        )
    })

    it('falls back to the older system message, then the default', () => {
        expect(resolveConversationSystemPrompt({ systemMessage: 'Older greeting.' })).toBe('Older greeting.')
        expect(resolveConversationSystemPrompt({ systemMessagePrompt: '', systemMessage: '' })).toContain('friendly conversation')
        expect(resolveConversationSystemPrompt({})).toContain('friendly conversation')
    })

    it('does not call the brace helper with an undefined prompt', () => {
        expect(() => transformBracesWithColon(resolveConversationSystemPrompt({}))).not.toThrow()
        expect(transformBracesWithColon(resolveConversationSystemPrompt({ systemMessage: 'Hello {name: Ada}' }))).toContain('{{name: Ada}}')
    })
})
