import {
    LEGACY_AGENTFLOW_LABEL,
    NEW_AGENTFLOW_PATH,
    canCopyToNewFlow,
    isLegacyAgentflow,
    isLegacyTemplate,
    legacySafeSettings
} from './legacyAgentflows'
import { BUILD_CHOICES, GLOSSARY } from '@/ui-component/flow/buildChoices'

const gear = ['viewMessages', 'chatflowConfiguration', 'saveAsTemplate', 'duplicateChatflow', 'exportChatflow', 'deleteChatflow'].map(
    (id) => ({ id })
)

describe('legacy agentflows (V1) stay hidden', () => {
    it('only treats the V1 types as legacy', () => {
        expect(isLegacyAgentflow('MULTIAGENT')).toBe(true)
        expect(isLegacyAgentflow('Agentflow')).toBe(true)
        expect(isLegacyAgentflow('AGENTFLOW')).toBe(false)
        expect(isLegacyAgentflow('AgentflowV2')).toBe(false)
        expect(isLegacyAgentflow('CHATFLOW')).toBe(false)
        expect(isLegacyAgentflow(undefined)).toBe(false)
    })

    it('new agentflows always open the V2 canvas', () => {
        expect(NEW_AGENTFLOW_PATH).toBe('/v2/agentcanvas')
        const createPaths = BUILD_CHOICES.map((choice) => choice.createPath)
        expect(createPaths).toContain('/v2/agentcanvas')
        expect(createPaths).not.toContain('/agentcanvas')
    })

    it('drops duplicate and save-as-template from a legacy flow gear menu, and keeps the rest', () => {
        expect(legacySafeSettings(gear, 'MULTIAGENT').map((m) => m.id)).toEqual([
            'viewMessages',
            'chatflowConfiguration',
            'exportChatflow',
            'deleteChatflow'
        ])
        expect(legacySafeSettings(gear, 'AGENTFLOW')).toEqual(gear)
        expect(legacySafeSettings(gear, 'CHATFLOW')).toEqual(gear)
    })

    it('hides Duplicate and Save As Template in the list menu only for legacy agentflows', () => {
        expect(canCopyToNewFlow({ isAgentCanvas: true, isAgentflowV2: false })).toBe(false)
        expect(canCopyToNewFlow({ isAgentCanvas: true, isAgentflowV2: true })).toBe(true)
        expect(canCopyToNewFlow({ isAgentCanvas: false })).toBe(true)
    })

    it('treats a template saved from a legacy flow, or one using legacy agent nodes, as preview only', () => {
        const legacyGraph = { nodes: [{ data: { category: 'Multi Agents' } }] }
        const sequentialGraph = { nodes: [{ data: { category: 'Sequential Agents' } }] }
        const v2Graph = { nodes: [{ data: { category: 'Agent Flows' } }] }
        const chatGraph = { nodes: [{ data: { category: 'Chat Models' } }] }
        expect(isLegacyTemplate({ type: 'Agentflow', flowData: v2Graph })).toBe(true)
        expect(isLegacyTemplate({ type: 'Chatflow', flowData: legacyGraph })).toBe(true)
        expect(isLegacyTemplate({ type: undefined, flowData: sequentialGraph })).toBe(true)
        expect(isLegacyTemplate({ type: 'AgentflowV2', flowData: v2Graph })).toBe(false)
        expect(isLegacyTemplate({ type: 'Chatflow', flowData: chatGraph })).toBe(false)
        expect(isLegacyTemplate({ type: 'Harness', flowData: { nodes: [] } })).toBe(false)
        expect(isLegacyTemplate()).toBe(false)
    })

    it('uses plain words: a simple Legacy label and no V1 or V2 in the glossary', () => {
        expect(LEGACY_AGENTFLOW_LABEL).toBe('Legacy agentflow')
        const agentflows = GLOSSARY.find(([name]) => name === 'Agentflows')[1]
        expect(agentflows).not.toMatch(/V1|V2/)
    })
})
