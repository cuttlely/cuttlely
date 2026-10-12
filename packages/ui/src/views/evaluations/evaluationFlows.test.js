import { evaluationFlows, requestsForRole } from './evaluationFlows'

const allow = (granted) => (permission) => granted.includes(permission)

describe('evaluation flow picker', () => {
    test('a role with chatflows but not assistants requests only chatflows', () => {
        const role = allow(['evaluations:create', 'chatflows:view'])
        expect(requestsForRole(role)).toEqual({ chatflows: true, agentflows: false, assistants: false })
        const merged = evaluationFlows(role, {
            chatflows: [{ id: 'c1', name: 'Support' }],
            agentflows: [{ id: 'a1', name: 'Hidden agent' }],
            assistants: [{ id: 'as1', details: '{"name":"Helper"}' }]
        })
        expect(merged.ready).toBe(true)
        expect(merged.flowTypes).toEqual(['Chatflow'])
        expect(merged.flows).toEqual([{ label: 'Support', name: 'c1', type: 'Chatflow', description: 'Chatflow' }])
        expect(merged.flows.some((flow) => flow.type === 'Custom Assistant')).toBe(false)
    })

    test('keeps chatflows when the agentflow request has not succeeded', () => {
        const role = allow(['chatflows:view', 'agentflows:view'])
        const merged = evaluationFlows(role, {
            chatflows: [{ id: 'c1', name: 'Support' }],
            agentflows: null
        })
        expect(merged.flows.map((flow) => flow.name)).toEqual(['c1'])
        expect(merged.flowTypes).toEqual(['Chatflow'])
    })

    test('merges chatflows and agentflows when both requests succeed', () => {
        const role = allow(['chatflows:view', 'agentflows:view', 'assistants:view'])
        const merged = evaluationFlows(role, {
            chatflows: [{ id: 'c1', name: 'Support' }],
            agentflows: [{ id: 'a1', name: 'Orders' }],
            assistants: [{ id: 'as1', details: '{"name":"Helper"}' }]
        })
        expect(merged.flowTypes).toEqual(['Chatflow', 'Agentflow v2'])
        expect(merged.flows.map((flow) => flow.label)).toEqual(['Support', 'Orders'])
        expect(requestsForRole(role).assistants).toBe(false)
    })
})
