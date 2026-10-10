import { credentialLabel, missing, pickCredential } from './credentials'

const credentials = [
    { id: '1', name: 'OpenAI demo', credentialName: 'openAIApi' },
    { id: '2', name: 'OpenAI work', credentialName: 'openAIApi' },
    { id: '3', name: 'Search', credentialName: 'serpApi' }
]

describe('builder credentials', () => {
    it('matches by name, then by the only one of the type', () => {
        expect(pickCredential(['openAIApi'], 'openai DEMO', credentials).id).toBe('1')
        expect(pickCredential(['serpApi'], undefined, credentials).id).toBe('3')
        expect(pickCredential(['serpApi'], 'Other name', credentials).id).toBe('3')
    })

    it('leaves the card empty when it cannot tell which, or has none', () => {
        expect(pickCredential(['openAIApi'], undefined, credentials).id).toBeUndefined()
        expect(pickCredential(['openAIApi'], 'Nope', credentials).candidates).toHaveLength(2)
        expect(pickCredential(['braveSearchApi'], undefined, credentials)).toEqual({ candidates: [] })
    })

    it('lists a missing credential by a readable name', () => {
        expect(credentialLabel('serpApi')).toBe('Serp API')
        expect(missing('Writer', ['openAIApi'], undefined, { openAIApi: 'OpenAI API' })).toEqual({
            part: 'Writer',
            credential: 'OpenAI API'
        })
        expect(missing('Researcher: Serp API', ['serpApi'])).toEqual({ part: 'Researcher: Serp API', credential: 'Serp API' })
        expect(missing('Writer', ['openAIApi'], 'Team key', { openAIApi: 'OpenAI API' })).toEqual({
            part: 'Writer',
            credential: 'Team key (OpenAI API)'
        })
    })
})
