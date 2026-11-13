import { payloadHasUnresolvedCredentialMark } from './index'

describe('import of a credential name mark', () => {
    it('rejects a flow that still names a credential and accepts one that already has an id', () => {
        const named = {
            ChatFlow: [
                {
                    flowData: JSON.stringify({
                        nodes: [{ data: { credential: { $credential: { name: 'Bakery model', credentialName: 'openAIApi' } } } }]
                    })
                }
            ]
        }
        const matched = {
            ChatFlow: [
                { flowData: JSON.stringify({ nodes: [{ data: { credential: 'cred-dest', inputs: { modelName: 'gpt-5.6-luna' } } }] }) }
            ]
        }
        expect(payloadHasUnresolvedCredentialMark(named)).toBe(true)
        expect(payloadHasUnresolvedCredentialMark(matched)).toBe(false)
        expect(payloadHasUnresolvedCredentialMark({ ChatMessage: [{ content: '{"$credential":true}' }] })).toBe(false)
    })
})
