import fs from 'fs'
import path from 'path'

import { TEMPLATE_SETTINGS_NOTE, templateSettingsMessage } from './templateSettingsNote'

describe('template settings note', () => {
    test('uses the fixed sentence and names each node that needs settings entered again', () => {
        expect(TEMPLATE_SETTINGS_NOTE).toBe('connection settings are not included in templates; re-enter them after import')
        const message = templateSettingsMessage({
            nodes: [],
            edges: [],
            droppedSettings: [
                { nodeId: 'chatOpenAI_0', label: 'OpenAI', inputs: ['secretField', 'credential'] },
                { nodeId: 'n0', label: '', inputs: ['headers'] }
            ]
        })
        expect(message.startsWith(TEMPLATE_SETTINGS_NOTE)).toBe(true)
        expect(message).toContain('OpenAI (secretField, credential)')
        expect(message).toContain('n0 (headers)')
    })

    test('says nothing when the template left every setting in place', () => {
        expect(templateSettingsMessage({ droppedSettings: [] })).toBe('')
        expect(templateSettingsMessage({ droppedSettings: [{ nodeId: 'n0', label: 'Fine', inputs: [] }] })).toBe('')
        expect(templateSettingsMessage('{"nodes":[],"edges":[]}')).toBe('')
        expect(templateSettingsMessage('not json')).toBe('')
        expect(templateSettingsMessage('')).toBe('')
    })

    test('reads the same note from template JSON used on import', () => {
        const text = JSON.stringify({
            nodes: [],
            edges: [],
            droppedSettings: [{ nodeId: 'tool_0', label: 'Hours', inputs: ['headers'] }]
        })
        const message = templateSettingsMessage(text)
        expect(message).toBe(`${TEMPLATE_SETTINGS_NOTE} Hours (headers)`)
    })

    test('the template preview and both canvases show that note on import', () => {
        const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8')
        const header = read('../views/marketplaces/MarketplaceCanvasHeader.jsx')
        const chatCanvas = read('../views/canvas/index.jsx')
        const agentCanvas = read('../views/agentflowsv2/Canvas.jsx')
        expect(header).toContain('templateSettingsMessage(flowData)')
        expect(chatCanvas).toContain('templateSettingsMessage(templateFlowData)')
        expect(agentCanvas).toContain('templateSettingsMessage(templateFlowData)')
    })
})
