import fs from 'fs'
import path from 'path'
import { normalizeCanvasFlow } from './normalizeCanvasFlow'
import { harnessChatBlock, reservedHarnessNameMessage } from './harnessChatReady'

const chief = { id: 'chief_0', data: { id: 'chief_0', name: 'harnessChief' } }
const grok = { id: 'chatXAI_0', data: { id: 'chatXAI_0', name: 'chatXAI', credential: 'cred-xai' } }
const grokBare = { id: 'chatXAI_0', data: { name: 'chatXAI' } }
const ollama = { id: 'chatOllama_0', data: { name: 'chatOllama' } }
const modelEdge = { source: 'chatXAI_0', target: 'chief_0', targetHandle: 'chief_0-input-chatModel' }
const ollamaEdge = { source: 'chatOllama_0', target: 'chief_0', targetHandle: 'chief_0-input-chatModel' }
const xaiDef = { name: 'chatXAI', credential: { name: 'xaiApi' } }
const ollamaDef = { name: 'chatOllama', credential: { name: 'ollamaApi', optional: true } }

describe('harness canvas chat block', () => {
    it('tells an unsaved harness to save and to connect a chat model', () => {
        const message = harnessChatBlock({ saved: false, flowReady: true, nodes: [chief], edges: [], nodeDefinitions: [] })
        expect(message).toMatch(/Save this harness/)
        expect(message).toMatch(/chat model is required/)
    })

    it('still asks to save when the model and credential are already on the canvas', () => {
        const message = harnessChatBlock({
            saved: false,
            flowReady: true,
            nodes: [chief, grok],
            edges: [modelEdge],
            nodeDefinitions: [xaiDef]
        })
        expect(message).toBe('Save this harness before chatting.')
    })

    it('waits for a saved canvas to load before judging the graph', () => {
        expect(harnessChatBlock({ saved: true, flowReady: false, nodes: [], edges: [], nodeDefinitions: [] })).toBe('')
    })

    it('asks for a chat model when the chief has none', () => {
        const message = harnessChatBlock({
            saved: true,
            flowReady: true,
            nodes: [chief],
            edges: [],
            nodeDefinitions: [xaiDef]
        })
        expect(message).toMatch(/chat model is required/)
        expect(message).toMatch(/Credentials/)
    })

    it('asks for a credential when the connected model requires one', () => {
        const message = harnessChatBlock({
            saved: true,
            flowReady: true,
            nodes: [chief, grokBare],
            edges: [modelEdge],
            nodeDefinitions: [xaiDef]
        })
        expect(message).toMatch(/needs a credential/)
        expect(message).toMatch(/Credentials/)
    })

    it('lets a saved harness chat when the model edge still uses a legacy handle', () => {
        const legacy = {
            nodes: [chief, { ...grok, data: { ...grok.data, type: 'ChatXAI', baseClasses: ['ChatXAI', 'BaseChatModel'] } }],
            edges: [{ id: 'chatXAI_0-chief_0-chatModel', source: 'chatXAI_0', target: 'chief_0', targetHandle: 'chief_0-input-chatModel' }]
        }
        const repaired = normalizeCanvasFlow(legacy, [
            { name: 'chatXAI', type: 'ChatXAI', baseClasses: ['ChatXAI', 'BaseChatModel'], inputs: [] },
            {
                name: 'harnessChief',
                type: 'HarnessChief',
                baseClasses: ['HarnessChief'],
                inputs: [{ name: 'chatModel', type: 'BaseChatModel' }]
            }
        ])
        expect(repaired.edges[0].targetHandle).toBe('chief_0-input-chatModel-BaseChatModel')
        expect(
            harnessChatBlock({
                saved: true,
                flowReady: true,
                nodes: repaired.nodes,
                edges: repaired.edges,
                nodeDefinitions: [xaiDef]
            })
        ).toBe('')
        expect(
            harnessChatBlock({
                saved: true,
                flowReady: true,
                nodes: [chief, grok],
                edges: [legacy.edges[0]],
                nodeDefinitions: [xaiDef]
            })
        ).toBe('')
    })

    it('lets a saved harness chat when the model credential is set or optional', () => {
        expect(
            harnessChatBlock({
                saved: true,
                flowReady: true,
                nodes: [chief, grok],
                edges: [modelEdge],
                nodeDefinitions: [xaiDef]
            })
        ).toBe('')
        expect(
            harnessChatBlock({
                saved: true,
                flowReady: true,
                nodes: [chief, ollama],
                edges: [ollamaEdge],
                nodeDefinitions: [ollamaDef]
            })
        ).toBe('')
    })
})

describe('reserved harness names', () => {
    it('rejects a name that matches a draft try profile and leaves ordinary names alone', () => {
        const reserved = `try${'a'.repeat(16)}`
        expect(reservedHarnessNameMessage(reserved)).toBe(
            `Harness name "${reserved}" is reserved for a draft try. Choose a different name.`
        )
        expect(reservedHarnessNameMessage(`Try${'AB'.repeat(8)}`)).toContain('reserved for a draft try')
        expect(reservedHarnessNameMessage('tryabcdef')).toBe('')
        expect(reservedHarnessNameMessage(`tryx${'ab'.repeat(8)}`)).toBe(
            `Harness name "tryx${'ab'.repeat(8)}" is reserved for a draft try. Choose a different name.`
        )
        expect(reservedHarnessNameMessage('chief-of-staff')).toBe('')
    })

    it('shows that message in the save dialog and the canvas name field', () => {
        const dialog = fs.readFileSync(path.join(__dirname, '../ui-component/dialog/SaveChatflowDialog.jsx'), 'utf8')
        const header = fs.readFileSync(path.join(__dirname, '../views/canvas/CanvasHeader.jsx'), 'utf8')
        const canvas = fs.readFileSync(path.join(__dirname, '../views/canvas/index.jsx'), 'utf8')
        expect(dialog).toContain('nameError')
        expect(dialog).toContain('harness-name-error')
        expect(header).toContain('reservedHarnessNameMessage')
        expect(header).toContain('nameError: isHarnessCanvas ? reservedHarnessNameMessage : undefined')
        expect(canvas).toContain('reservedHarnessNameMessage(importedName)')
    })
})
