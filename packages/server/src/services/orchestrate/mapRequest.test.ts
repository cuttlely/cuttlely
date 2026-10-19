import { validateHistorySchema } from '../../utils'
import { ExternalAgentError } from '../../utils/externalAgentAuth'
import { flowHasMemory, mapOrchestrateRequest } from './mapRequest'

const FLOW = '11111111-1111-4111-8111-111111111111'
const memoryFlow = {
    id: FLOW,
    apikeyid: 'key-1',
    flowData: JSON.stringify({ nodes: [{ data: { category: 'Memory', name: 'bufferMemory' } }] })
}
const noMemoryFlow = { id: FLOW, apikeyid: 'key-1', flowData: JSON.stringify({ nodes: [{ data: { category: 'Chains' } }] }) }

describe('flowHasMemory', () => {
    it('is true only when a node category is Memory', () => {
        expect(flowHasMemory(memoryFlow)).toBe(true)
        expect(flowHasMemory(noMemoryFlow)).toBe(false)
        expect(flowHasMemory({ flowData: 'not-json' })).toBe(false)
        expect(flowHasMemory({ flowData: '{}' })).toBe(false)
        expect(flowHasMemory({})).toBe(false)
    })
})

describe('mapOrchestrateRequest', () => {
    it('maps earlier turns to history that passes validateHistorySchema', () => {
        const mapped = mapOrchestrateRequest(
            {
                model: 'any',
                messages: [
                    { role: 'system', content: 'ignore' },
                    { role: 'user', content: 'My name is Ada' },
                    { role: 'assistant', content: 'Hello Ada' },
                    { role: 'tool', content: 'skip' },
                    { role: 'user', content: 'What is my name?' }
                ]
            },
            noMemoryFlow
        )
        expect(mapped.body.question).toBe('What is my name?')
        expect(mapped.body.history).toEqual([
            { role: 'userMessage', content: 'My name is Ada' },
            { role: 'apiMessage', content: 'Hello Ada' }
        ])
        expect(validateHistorySchema(mapped.body.history as any[])).toBe(true)
        expect(mapped.model).toBe('any')
        expect(mapped.stream).toBe(false)
        expect(mapped.body.streaming).toBe(false)
        expect(mapped.body).not.toHaveProperty('overrideConfig')
        expect(mapped.body).not.toHaveProperty('sessionToken')
    })

    it('joins text parts and drops overrideConfig, uploads, and session fields', () => {
        const mapped = mapOrchestrateRequest(
            {
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Hello' },
                            { type: 'text', text: 'Ada' }
                        ]
                    }
                ],
                overrideConfig: { sessionId: 'steal' },
                uploads: [1],
                sessionId: 's',
                chatId: 'c',
                sessionToken: 't',
                context: { ibm: true }
            },
            noMemoryFlow
        )
        expect(mapped.body.question).toBe('Hello\nAda')
        expect(mapped.model).toBe(`cuttlely-${FLOW}`)
        expect(mapped.body).toEqual({ question: 'Hello\nAda', streaming: false })
    })

    it('sends only the question when a thread id is present and the flow has memory', () => {
        const mapped = mapOrchestrateRequest(
            {
                messages: [
                    { role: 'user', content: 'My name is Ada' },
                    { role: 'assistant', content: 'Hello Ada' },
                    { role: 'user', content: 'What is my name?' }
                ]
            },
            memoryFlow,
            'Ada-01'
        )
        expect(mapped.body.question).toBe('What is my name?')
        expect(mapped.body.history).toBeUndefined()
        expect(mapped.body.chatId).toMatch(/^[0-9a-f-]{36}$/)
        expect(typeof mapped.body.sessionToken).toBe('string')
    })

    it('still sends history for a memory flow when no thread id is present', () => {
        const mapped = mapOrchestrateRequest(
            {
                messages: [
                    { role: 'user', content: 'My name is Ada' },
                    { role: 'assistant', content: 'Hello Ada' },
                    { role: 'user', content: 'What is my name?' }
                ]
            },
            memoryFlow
        )
        expect(mapped.body.history?.[0]).toEqual({ role: 'userMessage', content: 'My name is Ada' })
        const stored: Array<{ role: string; content: string }> = []
        if (mapped.body.history?.length) stored.unshift(...mapped.body.history)
        expect(stored[0].content).toBe('My name is Ada')
        expect(validateHistorySchema(stored as any[])).toBe(true)
    })

    it('refuses a missing user turn, a bad role, a non-text part, and an empty list', () => {
        const bad = (body: unknown) => {
            try {
                mapOrchestrateRequest(body, noMemoryFlow)
                throw new Error('expected throw')
            } catch (err) {
                expect(err).toBeInstanceOf(ExternalAgentError)
                expect((err as ExternalAgentError).code).toBe('messages_invalid')
            }
        }
        bad({ messages: [{ role: 'assistant', content: 'hi' }] })
        bad({ messages: [{ role: 'user', content: '   ' }] })
        bad({ messages: [{ role: 'other', content: 'hi' }] })
        bad({ messages: [{ role: 'user', content: [{ type: 'image', text: 'x' }] }] })
        bad({ messages: [] })
        bad(null)
        bad({ messages: new Array(201).fill({ role: 'user', content: 'x' }) })
    })

    it('streams only when stream is boolean true', () => {
        expect(mapOrchestrateRequest({ messages: [{ role: 'user', content: 'Hi' }], stream: true }, noMemoryFlow).stream).toBe(true)
        expect(mapOrchestrateRequest({ messages: [{ role: 'user', content: 'Hi' }], stream: 'true' }, noMemoryFlow).stream).toBe(false)
        expect(mapOrchestrateRequest({ messages: [{ role: 'user', content: 'Hi' }] }, noMemoryFlow).stream).toBe(false)
    })

    it('reaches a real Buffer Memory node so the second turn sees the first', async () => {
        const { nodeClass: BufferMemoryNode } = require('../../../../components/nodes/memory/BufferMemory/BufferMemory') as {
            nodeClass: new () => { init: (nodeData: unknown, input: string, options: unknown) => Promise<any> }
        }
        const memory = await new BufferMemoryNode().init({ inputs: { memoryKey: 'chat_history', sessionId: 'sess-1' } }, '', {
            appDataSource: { getRepository: () => ({ find: async () => [] }) },
            databaseEntities: { ChatMessage: class ChatMessage {} },
            chatflowid: FLOW,
            orgId: 'org-1'
        })
        const mapped = mapOrchestrateRequest(
            {
                messages: [
                    { role: 'user', content: 'My name is Ada' },
                    { role: 'assistant', content: 'Hello Ada' },
                    { role: 'user', content: 'What is my name?' }
                ]
            },
            memoryFlow
        )
        const seen = await memory.getChatMessages('sess-1', false, mapped.body.history)
        expect(seen[0]).toEqual({ message: 'My name is Ada', type: 'userMessage' })
        expect(seen[1]).toEqual({ message: 'Hello Ada', type: 'apiMessage' })
    })
})
