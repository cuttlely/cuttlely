import fs from 'fs'
import path from 'path'
import { canUseTemplate, templateUsePermission } from './templateUsePermission'

describe('template use permission', () => {
    test('an agentflows:create-only role sees Use Template on an agentflow template', () => {
        expect(templateUsePermission('AgentflowV2')).toBe('agentflows:create')
        expect(templateUsePermission('Agentflow')).toBe('agentflows:create')
        expect(canUseTemplate(['agentflows:create'], 'AgentflowV2')).toBe(true)
        expect(canUseTemplate(['agentflows:view'], 'AgentflowV2')).toBe(false)
        expect(canUseTemplate(['chatflows:create'], 'AgentflowV2')).toBe(false)
    })

    test('a chatflow, harness, or ETL template checks chatflows:create', () => {
        expect(templateUsePermission('Chatflow')).toBe('chatflows:create')
        expect(templateUsePermission('Harness')).toBe('chatflows:create')
        expect(templateUsePermission('ETL')).toBe('chatflows:create')
        expect(canUseTemplate(['chatflows:create'], 'Chatflow')).toBe(true)
        expect(canUseTemplate(['chatflows:view'], 'Harness')).toBe(false)
        expect(canUseTemplate(['agentflows:create'], 'ETL')).toBe(false)
    })

    test('the marketplace header uses that key and does not use a dotted permission', () => {
        const source = fs.readFileSync(path.join(__dirname, 'MarketplaceCanvasHeader.jsx'), 'utf8')
        expect(source).toContain('permission={templateUsePermission(templateType)}')
        expect(source).not.toContain('agentflows.create')
        expect(source).not.toContain('chatflows:create,agentflows:create')
    })
})
