import fs from 'fs'
import path from 'path'

import { keysFor, modelForKeys, modelsForKeys, onlyFit, templateKeyNote, templateWithYourKey } from './yourKey'

const spec = (name, label, credentialName, modelDefault) => ({
    name,
    label,
    type: label.replace(/\s/g, ''),
    category: 'Chat Models',
    credential: { label: 'Connect Credential', name: 'credential', type: 'credential', credentialNames: [credentialName] },
    inputs: [{ name: 'modelName', default: modelDefault }]
})
const specs = [
    spec('chatXAI', 'xAI Grok', 'xaiApi'),
    spec('chatAnthropic', 'ChatAnthropic', 'anthropicApi', 'claude-haiku-4-5'),
    spec('chatOpenAI', 'ChatOpenAI', 'openAIApi', 'gpt-4o-mini'),
    spec('chatCohere', 'ChatCohere', 'cohereApi', 'command-r'),
    { ...spec('chatOld', 'Old model', 'openAIApi'), badge: 'DEPRECATING' },
    { name: 'calculator', label: 'Calculator', category: 'Tools' }
]
const openAI = { id: 'key-openai', name: 'My OpenAI key', credentialName: 'openAIApi' }
const openAI2 = { id: 'key-openai-2', name: 'Team OpenAI key', credentialName: 'openAIApi' }
const xai = { id: 'key-xai', name: 'My xAI key', credentialName: 'xaiApi' }
const github = { id: 'key-gh', name: 'GitHub', credentialName: 'githubApi' }

const template = () => {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../samples/harnesses/calculator.canvas.json'), 'utf8'))
    return typeof file.flowData === 'string' ? JSON.parse(file.flowData) : file.flowData
}

describe('use your own key', () => {
    test('picks a key only when exactly one fits the card', () => {
        expect(onlyFit(keysFor(specs[2], [openAI, github]))).toBe('key-openai')
        expect(onlyFit(keysFor(specs[2], [openAI, openAI2]))).toBe('')
        expect(onlyFit(keysFor(specs[2], [github]))).toBe('')
    })

    test('lists the chat models you have a key for, preferred first, without deprecated cards', () => {
        expect(modelsForKeys(specs, [xai, openAI, github]).map((item) => item.name)).toEqual(['chatOpenAI', 'chatXAI'])
        expect(modelsForKeys(specs, [github])).toEqual([])
    })

    test('starts Build with AI on your model and key', () => {
        expect(modelForKeys(specs, [openAI])).toEqual({ component: specs[2], credential: 'key-openai', modelName: 'gpt-4.1-mini' })
        expect(modelForKeys(specs, [openAI, openAI2]).credential).toBe('')
        expect(modelForKeys(specs, [{ id: 'c', credentialName: 'cohereApi' }]).modelName).toBe('command-r')
        expect(modelForKeys(specs, [])).toBeNull()
    })

    test('swaps a template xAI card for a full OpenAI card, in the same place and with the same links', () => {
        const { flow, changed } = templateWithYourKey(template(), specs, [openAI])
        const card = flow.nodes.find((node) => node.data.category === 'Chat Models')
        expect(card.id).toBe('chatOpenAI_0')
        expect(card.position).toEqual({ x: 40, y: 40 })
        expect(card.data).toMatchObject({
            name: 'chatOpenAI',
            credential: 'key-openai',
            inputs: { modelName: 'gpt-4.1-mini', FLOWISE_CREDENTIAL_ID: 'key-openai' }
        })
        const edge = flow.edges.find((item) => item.target === 'chief_0' && item.targetHandle === 'chief_0-input-chatModel')
        expect(edge).toMatchObject({
            id: 'chatOpenAI_0-chief_0-chatModel',
            source: 'chatOpenAI_0',
            sourceHandle: 'chatOpenAI_0-output-chatOpenAI-ChatOpenAI'
        })
        expect(flow.edges.some((item) => item.source === 'chatXAI_0' || item.target === 'chatXAI_0')).toBe(false)
        expect(templateKeyNote(changed)).toBe(
            'This template now uses ChatOpenAI (gpt-4.1-mini) instead of xAI Grok, with your key. Save to keep it.'
        )
    })

    test('keeps the template card and fills in the key when you have a key for it', () => {
        const { flow, changed } = templateWithYourKey(template(), specs, [xai, openAI])
        const card = flow.nodes.find((node) => node.data.category === 'Chat Models')
        expect(card.id).toBe('chatXAI_0')
        expect(card.data.credential).toBe('key-xai')
        expect(card.data.inputs.modelName).toBe('grok-4.7')
        expect(templateKeyNote(changed)).toBe('Your key is filled in on the chat model card. Save to keep it.')
    })

    test('leaves the template alone without a chat model key, and asks you to pick when several fit', () => {
        expect(templateWithYourKey(template(), specs, [github]).changed).toEqual([])
        expect(templateWithYourKey(template(), specs, []).changed).toEqual([])
        const { flow, changed } = templateWithYourKey(template(), specs, [openAI, openAI2])
        expect(flow.nodes.find((node) => node.data.category === 'Chat Models').data.credential).toBeUndefined()
        expect(templateKeyNote(changed)).toContain('pick your key on the card')
    })
})
