import {
    HARNESS_PLACEHOLDER_FLOW,
    harnessNameError,
    harnessSaveNameNote,
    planHarnessDraftFallback,
    planNewHarnessSave,
    draftSaveWasTurnedOff
} from './harnessSave'

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

const withSecondSpecialist = (flowData, specialistName) => {
    const saved = JSON.parse(flowData)
    saved.nodes.push({
        id: 'spec-2',
        data: { name: 'harnessSpecialist', inputs: { specialistName, instructions: 'Help too.' } }
    })
    return JSON.stringify(saved)
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
        expect(plan.retainIncompleteHarness).toBeUndefined()
        expect(plan.notice).toContain('Saved as a draft')
        expect(plan.notice).toContain('credential')
    })

    test('a specialist name with spaces is kept on the draft with the credential, and is not written live', () => {
        const flowData = flow({ credential: 'cred-openai-1', specialistName: 'SQL Analyst' })
        const plan = planNewHarnessSave({ name: 'Imported sales desk', flowData, nodeDefinitions: [openAI] })
        expect(plan.name).toBe('Imported-sales-desk')
        expect(plan.liveFlowData).toBe(HARNESS_PLACEHOLDER_FLOW)
        expect(modelCredential(plan)).toBe('cred-openai-1')
        expect(JSON.parse(plan.draftFlowData).nodes.find((node) => node.id === 'spec').data.inputs.specialistName).toBe('SQL Analyst')
        expect(plan.notice).toContain('Specialist names')
    })

    test('duplicate specialist names keep the canvas off the harness file until they are unique', () => {
        const flowData = withSecondSpecialist(flow({ credential: 'cred-openai-1', specialistName: 'researcher' }), 'researcher')
        const plan = planNewHarnessSave({ name: 'sales-desk', flowData, nodeDefinitions: [openAI] })
        expect(plan.liveFlowData).toBe(HARNESS_PLACEHOLDER_FLOW)
        expect(plan.draftFlowData).toBe(flowData)
        expect(plan.notice).toContain('unique')
    })

    test('duplicate specialist names and a missing credential report both readiness steps', () => {
        const flowData = withSecondSpecialist(flow({ credential: '', specialistName: 'researcher' }), 'researcher')
        const plan = planNewHarnessSave({ name: 'sales-desk', flowData, nodeDefinitions: [openAI] })
        expect(plan.notice).toContain('credential')
        expect(plan.notice).toContain('unique')
    })

    test('drafts off refuses an incomplete canvas with a clear message so cards are not silently lost', () => {
        const flowData = flow({ credential: '' })
        const plan = planHarnessDraftFallback({ flowData, nodeDefinitions: [openAI], draftsOff: true })
        expect(plan.error).toContain('drafts are off')
        expect(plan.error).toContain('not ready to go Live')
        expect(plan.body).toBeUndefined()
        const createPlan = planNewHarnessSave({ name: 'sales-desk', flowData, nodeDefinitions: [openAI], draftsOff: true })
        expect(createPlan.error).toContain('drafts are off')
        expect(createPlan.liveFlowData).toBeUndefined()
        expect(createPlan.draftFlowData).toBeUndefined()
    })

    test('the drafts-off refuse message is recognized the same way as the drafts-off server reply', () => {
        expect(draftSaveWasTurnedOff({ response: { status: 409, data: { message: 'Drafts are off on this server.' } } })).toBe(true)
        expect(
            draftSaveWasTurnedOff({
                response: {
                    status: 409,
                    data: {
                        message:
                            'This harness is not ready to go Live, and drafts are off on this server. Finish the roster (credentials and unique specialist ids), then save again.'
                    }
                }
            })
        ).toBe(true)
        expect(draftSaveWasTurnedOff({ response: { status: 409, data: { message: 'Someone else saved this draft.' } } })).toBe(false)
    })

    test('a complete harness still goes live on the first save', () => {
        const flowData = flow({ credential: 'cred-openai-1' })
        const plan = planNewHarnessSave({ name: 'sales-desk', flowData, nodeDefinitions: [openAI] })
        expect(plan.draftFlowData).toBeNull()
        expect(plan.retainIncompleteHarness).toBeUndefined()
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
