import { chatflowCanChat, isUnchatableChatflow } from './chatflowReady'

const card = (id, name, category) => ({ id, data: { id, name, label: name, category } })

describe('chatflowCanChat', () => {
    it('lets a Harness node with a loose removed card chat', () => {
        const flowData = JSON.stringify({
            nodes: [card('harness_0', 'harness', 'Harness'), card('langFuse_0', 'langFuse', 'Analytic')],
            edges: []
        })
        expect(chatflowCanChat(flowData)).toBe(true)
        expect(isUnchatableChatflow({ type: 'CHATFLOW', flowData })).toBe(false)
    })

    it('ignores an edge into a removed card', () => {
        const flow = {
            nodes: [card('harness_0', 'harness', 'Harness'), card('assemblyAI_0', 'assemblyAI', 'SpeechToText')],
            edges: [{ id: 'e1', source: 'harness_0', target: 'assemblyAI_0' }]
        }
        expect(chatflowCanChat(flow)).toBe(true)
    })

    it('still blocks a loose card that is not a removed node', () => {
        const flow = { nodes: [card('harness_0', 'harness', 'Harness'), card('tracer_0', 'someTracer', 'Analytic')], edges: [] }
        expect(chatflowCanChat(flow)).toBe(false)
    })

    it('blocks a flow that only holds removed cards', () => {
        expect(chatflowCanChat({ nodes: [card('opik_0', 'opik', 'Analytic')], edges: [] })).toBe(false)
    })
})
