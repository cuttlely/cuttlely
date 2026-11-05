import { HARNESS_PLACEHOLDER_FLOW, harnessNameError, harnessSaveNameNote, planNewHarnessSave } from './harnessSave'

const openAI = { name: 'chatOpenAI', category: 'Chat Models', credential: { optional: false } }
const ollama = { name: 'chatOllama', category: 'Chat Models', credential: { optional: true } }

const flow = ({
    credential = '',
    credentialInput,
    specialistName = 'researcher',
    modelName = 'chatOpenAI',
    category = 'Chat Models',
    withModel = true
} = {}) => {
    const inputs = { modelName: 'gpt-test' }
    if (credentialInput !== undefined) inputs.FLOWISE_CREDENTIAL_ID = credentialInput
    const nodes = [
        { id: 'chief', data: { name: 'harnessChief', inputs: { instructions: 'Answer from the specialist.' } } },
        {
            id: 'spec',
            data: { name: 'harnessSpecialist', inputs: { specialistName, instructions: 'Help.' } }
        }
    ]
    const edges = []
    if (withModel) {
        nodes.push({ id: 'model', data: { name: modelName, category, credential, inputs } })
        edges.push({ source: 'model', target: 'chief', targetHandle: 'chief-input-chatModel-ChatModel' })
    }
    return JSON.stringify({ nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } })
}

const modelCredential = (plan) => {
    const saved = JSON.parse(plan.draftFlowData || plan.liveFlowData)
    return saved.nodes.find((node) => node.id === 'model').data.credential
}

describe('planNewHarnessSave', () => {
    test('an imported name with spaces and punctuation is stored as a safe id, and a selected credential stays on the live canvas', () => {
        const flowData = flow({ credential: 'cred-openai-1', credentialInput: '' })
        const plan = planNewHarnessSave({
            name: 'Sales Desk (v2)!',
            flowData,
            nodeDefinitions: [openAI]
        })
        expect(plan.error).toBeUndefined()
        expect(plan.name).toBe('Sales-Desk-v2')
        expect(plan.name).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
        expect(plan.draftFlowData).toBeNull()
        expect(modelCredential(plan)).toBe('cred-openai-1')
        expect(plan.notice).toContain('Saved as "Sales-Desk-v2"')
    })

    test('a required credential that is still missing does not block the save; the canvas is the draft and live stays empty', () => {
        const flowData = flow({ credential: '', specialistName: 'researcher' })
        const plan = planNewHarnessSave({ name: 'sales-desk', flowData, nodeDefinitions: [openAI] })
        expect(plan.error).toBeUndefined()
        expect(plan.name).toBe('sales-desk')
        expect(plan.liveFlowData).toBe(HARNESS_PLACEHOLDER_FLOW)
        expect(JSON.parse(plan.liveFlowData).nodes).toEqual([])
        expect(plan.draftFlowData).toBe(flowData)
        expect(plan.notice).toContain('Saved as a draft')
        expect(plan.notice).toContain('credential')
    })

    test('a specialist name with spaces is kept on the draft with the credential, and is not written live', () => {
        const flowData = flow({ credential: 'cred-openai-1', specialistName: 'SQL Analyst' })
        const plan = planNewHarnessSave({ name: 'Imported Flowise chatflow', flowData, nodeDefinitions: [openAI] })
        expect(plan.name).toBe('Imported-Flowise-chatflow')
        expect(plan.liveFlowData).toBe(HARNESS_PLACEHOLDER_FLOW)
        expect(modelCredential(plan)).toBe('cred-openai-1')
        expect(JSON.parse(plan.draftFlowData).nodes.find((node) => node.id === 'spec').data.inputs.specialistName).toBe('SQL Analyst')
        expect(plan.notice).toContain('Specialist names')
    })

    test('a complete harness still goes live on the first save', () => {
        const flowData = flow({ credential: 'cred-openai-1' })
        const plan = planNewHarnessSave({ name: 'sales-desk', flowData, nodeDefinitions: [openAI] })
        expect(plan.draftFlowData).toBeNull()
        expect(plan.liveFlowData).toBe(flowData)
        expect(plan.notice).toBe('')
    })

    test('an optional credential can be empty and the harness still goes live', () => {
        const flowData = flow({ modelName: 'chatOllama', credential: '' })
        const plan = planNewHarnessSave({ name: 'local-desk', flowData, nodeDefinitions: [ollama] })
        expect(plan.draftFlowData).toBeNull()
        expect(plan.liveFlowData).toBe(flowData)
    })

    test('a reserved try name is still refused', () => {
        const name = `try${'ab'.repeat(8)}`
        const plan = planNewHarnessSave({
            name,
            flowData: flow({ credential: 'cred-openai-1' }),
            nodeDefinitions: [openAI]
        })
        expect(plan.error).toContain('reserved for a draft try')
        expect(plan.liveFlowData).toBeUndefined()
        expect(harnessNameError(name)).toContain('reserved')
        expect(harnessSaveNameNote(name)).toBe('')
    })

    test('the save dialog tells you the id a name with spaces will use', () => {
        expect(harnessSaveNameNote('Chief of Staff')).toContain('Chief-of-Staff')
        expect(harnessNameError('sales-desk')).toBe('')
        expect(harnessSaveNameNote('sales-desk')).toBe('')
    })
})
