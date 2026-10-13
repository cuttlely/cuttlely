import fs from 'fs'
import path from 'path'
import { checkMetrics, gradingModel, llmGradeResult, questionsFromDataset } from './score'

test('dataset rows stay in sequence order, within the question cap', () => {
    const rows = [
        { input: '  Second ', output: 'two', sequenceNo: 2 },
        { input: 'First', output: 'one', sequenceNo: 1 },
        { input: 'First', output: 'again', sequenceNo: 3 },
        { input: '   ', output: 'blank', sequenceNo: 0 },
        { input: 'x'.repeat(2001), output: 'long', sequenceNo: 4 }
    ]
    expect(questionsFromDataset(rows)).toEqual([
        { question: 'First', expected: 'one' },
        { question: 'Second', expected: 'two' },
        { question: 'First', expected: 'again' }
    ])
    const many = Array.from({ length: 101 }, (_, index) => ({ input: `q${index}`, output: `a${index}`, sequenceNo: index }))
    expect(questionsFromDataset(many)).toHaveLength(100)
    expect(questionsFromDataset(many)[0].question).toBe('q0')
})

test('numeric evaluators see the check token total and the run time', () => {
    expect(checkMetrics(50, 657)).toEqual({ totalTokens: 50, apiLatency: 657, llm: 657, chain: 657 })
    expect(checkMetrics(null, 10)).toEqual({ apiLatency: 10, llm: 10, chain: 10 })
})

test('an llm grade is Pass, Fail or Error, and a bare number is not a cutoff', () => {
    expect(llmGradeResult({ pass: true })).toBe('Pass')
    expect(llmGradeResult({ passed: false })).toBe('Fail')
    expect(llmGradeResult({ result: 'Pass' })).toBe('Pass')
    expect(llmGradeResult({ error: 'Not Graded!' })).toBe('Error')
    expect(llmGradeResult({ score: 10 })).toBe('Error')
    expect(llmGradeResult(null)).toBe('Error')
})

test('the grader uses the model and credential saved on the canvas', () => {
    const chat = JSON.stringify({
        nodes: [
            {
                data: {
                    name: 'chatOpenAI',
                    category: 'Chat Models',
                    credential: 'cred-1',
                    inputs: { modelName: 'gpt-test' }
                }
            }
        ]
    })
    expect(gradingModel(chat)).toEqual({ llm: 'chatOpenAI', model: 'gpt-test', credentialId: 'cred-1' })
    const agent = JSON.stringify({
        nodes: [
            {
                data: {
                    name: 'llmAgentflow',
                    inputs: { llmModel: 'chatOpenAI', llmModelConfig: { modelName: 'gpt-test', FLOWISE_CREDENTIAL_ID: 'cred-2' } }
                }
            }
        ]
    })
    expect(gradingModel(agent)).toEqual({ llm: 'chatOpenAI', model: 'gpt-test', credentialId: 'cred-2' })
    expect(gradingModel('not json')).toBeNull()
    expect(gradingModel(JSON.stringify({ nodes: [{ data: { name: 'chatOpenAI', category: 'Chat Models' } }] }))).toBeNull()
})

test('an Agent, a Condition Agent, and the Simple RAG example each use that step model fields', () => {
    const step = (name: string, modelKey: string, configKey: string, config: Record<string, unknown>) =>
        JSON.stringify({ nodes: [{ data: { name, inputs: { [modelKey]: 'chatOpenAI', [configKey]: config } } }] })
    // `model` wins over `modelName`, the same order the step uses.
    expect(
        gradingModel(
            step('agentAgentflow', 'agentModel', 'agentModelConfig', {
                model: 'from-model',
                modelName: 'from-name',
                FLOWISE_CREDENTIAL_ID: 'cred-agent'
            })
        )
    ).toEqual({ llm: 'chatOpenAI', model: 'from-model', credentialId: 'cred-agent' })
    expect(
        gradingModel(
            step('conditionAgentAgentflow', 'conditionAgentModel', 'conditionAgentModelConfig', {
                modelName: 'gpt-condition',
                FLOWISE_CREDENTIAL_ID: 'cred-condition'
            })
        )
    ).toEqual({ llm: 'chatOpenAI', model: 'gpt-condition', credentialId: 'cred-condition' })
    const rag = fs.readFileSync(path.join(__dirname, '../../../marketplaces/agentflowsv2/Simple RAG.json'), 'utf8')
    expect(gradingModel(rag)).toEqual({ llm: 'chatOpenAI', model: 'gpt-4o-mini', credentialId: '' })
})
