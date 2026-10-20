/**
 * A chat model or embeddings node with a required credential and none selected must fail
 * before the provider SDK asks for a process environment key.
 */
import {
    assertRequiredModelCredential,
    credentialIsOptional,
    getCredentialData,
    MISSING_MODEL_CREDENTIAL_STATUS,
    MissingModelCredentialError,
    missingModelCredentialMessage,
    selectedModelCredentialId
} from './utils'

const { nodeClass: ChatOpenAI } = require('../nodes/chatmodels/ChatOpenAI/ChatOpenAI')
const { nodeClass: ChatXAI } = require('../nodes/chatmodels/ChatXAI/ChatXAI')
const { nodeClass: ChatCerebras } = require('../nodes/chatmodels/ChatCerebras/ChatCerebras')
const { nodeClass: ChatOllama } = require('../nodes/chatmodels/ChatOllama/ChatOllama')
const { nodeClass: OpenAIEmbedding } = require('../nodes/embeddings/OpenAIEmbedding/OpenAIEmbedding')

const savedOpenAi = process.env.OPENAI_API_KEY
const savedXai = process.env.XAI_API_KEY

beforeAll(() => {
    delete process.env.OPENAI_API_KEY
    delete process.env.XAI_API_KEY
})

afterAll(() => {
    if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedOpenAi
    if (savedXai === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = savedXai
})

const requiredChat = {
    category: 'Chat Models',
    label: 'OpenAI',
    name: 'chatOpenAI',
    credential: { optional: false }
}

describe('missing required model credential', () => {
    it('names the card and uses 422', () => {
        expect(missingModelCredentialMessage('OpenAI')).toBe('Pick a credential on the OpenAI node.')
        expect(() => assertRequiredModelCredential(requiredChat, { label: 'Support desk model' })).toThrow(MissingModelCredentialError)
        try {
            assertRequiredModelCredential(requiredChat, { label: 'Support desk model' })
        } catch (error) {
            expect(error).toBeInstanceOf(MissingModelCredentialError)
            expect((error as MissingModelCredentialError).statusCode).toBe(MISSING_MODEL_CREDENTIAL_STATUS)
            expect((error as Error).message).toContain('Support desk model')
            expect((error as Error).message).toMatch(/Pick a credential on the .+ node/)
        }
    })

    it('accepts a selected credential id, including FLOWISE_CREDENTIAL_ID', () => {
        expect(selectedModelCredentialId({ credential: 'cred-1' })).toBe('cred-1')
        expect(selectedModelCredentialId({ inputs: { FLOWISE_CREDENTIAL_ID: 'cred-2' } })).toBe('cred-2')
        expect(() => assertRequiredModelCredential(requiredChat, { credential: 'cred-1', label: 'OpenAI' })).not.toThrow()
    })

    it('leaves optional credentials alone, including an Azure-style env-var fallback', () => {
        expect(credentialIsOptional({ optional: true })).toBe(true)
        expect(credentialIsOptional({ optional: false })).toBe(false)
        const ollama = { category: 'Chat Models', label: 'Ollama', credential: { optional: true } }
        const azureWithEnv = { category: 'Chat Models', label: 'Azure OpenAI', credential: { optional: true } }
        expect(() => assertRequiredModelCredential(ollama, { label: 'Ollama' })).not.toThrow()
        expect(() => assertRequiredModelCredential(azureWithEnv, { label: 'Azure OpenAI' })).not.toThrow()
    })
})

describe('getCredentialData', () => {
    it('throws 422 with the node label when a required chat model has no credential', async () => {
        const node = new ChatOpenAI()
        await expect(
            getCredentialData('', {}, { instance: node, nodeData: { label: 'OpenAI', name: 'chatOpenAI' } })
        ).rejects.toMatchObject({
            statusCode: 422,
            message: 'Pick a credential on the OpenAI node.'
        })
    })

    it('returns empty data for an optional credential with no selection (env-var fallback still available)', async () => {
        const cerebras = new ChatCerebras()
        await expect(getCredentialData('', {}, { instance: cerebras, nodeData: { label: 'Cerebras' } })).resolves.toEqual({})
        const ollama = new ChatOllama()
        await expect(getCredentialData('', {}, { instance: ollama, nodeData: { label: 'Ollama' } })).resolves.toEqual({})
    })

    it('does not 422 for a non-model caller with no credential id', async () => {
        await expect(getCredentialData('', {})).resolves.toEqual({})
    })
})

describe('node init', () => {
    it('OpenAI chat refuses a missing credential with 422 and the card name, not OPENAI_API_KEY', async () => {
        const node = new ChatOpenAI()
        try {
            await node.init({ label: 'OpenAI', name: 'chatOpenAI', inputs: {} }, '', {})
            throw new Error('expected a missing-credential refusal')
        } catch (error) {
            expect(error).toBeInstanceOf(MissingModelCredentialError)
            expect((error as MissingModelCredentialError).statusCode).toBe(422)
            expect((error as Error).message).toBe('Pick a credential on the OpenAI node.')
            expect((error as Error).message).not.toMatch(/OPENAI_API_KEY/)
        }
    })

    it('xAI chat and OpenAI embeddings name their own cards', async () => {
        const xai = new ChatXAI()
        await expect(xai.init({ label: 'xAI Grok', name: 'chatXAI', inputs: {} }, '', {})).rejects.toMatchObject({
            statusCode: 422,
            message: 'Pick a credential on the xAI Grok node.'
        })
        const embeddings = new OpenAIEmbedding()
        await expect(embeddings.init({ label: 'OpenAI Embedding', name: 'openAIEmbeddings', inputs: {} }, '', {})).rejects.toMatchObject({
            statusCode: 422,
            message: 'Pick a credential on the OpenAI Embedding node.'
        })
    })

    it('Cerebras still allows a process key when no credential is selected', async () => {
        const node = new ChatCerebras()
        expect(node.credential.optional).toBe(true)
        await expect(getCredentialData('', {}, { instance: node, nodeData: { label: node.label } })).resolves.toEqual({})
    })

    it('OpenAI still 422s when OPENAI_API_KEY is set: a required credential is not an env fallback', async () => {
        const previous = process.env.OPENAI_API_KEY
        process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key'
        try {
            const node = new ChatOpenAI()
            await expect(node.init({ label: 'OpenAI', name: 'chatOpenAI', inputs: {} }, '', {})).rejects.toMatchObject({
                statusCode: 422,
                message: 'Pick a credential on the OpenAI node.'
            })
        } finally {
            if (previous === undefined) delete process.env.OPENAI_API_KEY
            else process.env.OPENAI_API_KEY = previous
        }
    })
})
