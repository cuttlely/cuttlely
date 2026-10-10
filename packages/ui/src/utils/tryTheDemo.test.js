import { defaultKey, keyTypesForDemo, usableKeys } from './tryTheDemo'

describe('Try the demo key picker', () => {
    const keys = [
        { id: 'a', name: 'Work OpenAI', credentialName: 'openAIApi' },
        { id: 'b', name: 'Mail', credentialName: 'smtpApi' }
    ]

    it('offers only keys a chat model can use', () => {
        expect(usableKeys(keys, ['openAIApi', 'anthropicApi']).map((key) => key.id)).toEqual(['a'])
        expect(usableKeys(keys, [])).toEqual([])
    })

    it('preselects the only key that fits, or the one just added', () => {
        expect(defaultKey([keys[0]])).toBe('a')
        expect(defaultKey(keys)).toBe('')
        expect(defaultKey(keys, 'b')).toBe('b')
        expect(defaultKey(keys, 'gone')).toBe('')
        expect(defaultKey([])).toBe('')
    })

    it('lists popular key types first and leaves out types no chat model takes', () => {
        const types = [
            { name: 'groqApi', label: 'Groq API' },
            { name: 'smtpApi', label: 'SMTP' },
            { name: 'anthropicApi', label: 'Anthropic API' },
            { name: 'openAIApi', label: 'OpenAI API' }
        ]
        expect(keyTypesForDemo(types, ['groqApi', 'anthropicApi', 'openAIApi']).map((type) => type.name)).toEqual([
            'openAIApi',
            'anthropicApi',
            'groqApi'
        ])
    })
})
