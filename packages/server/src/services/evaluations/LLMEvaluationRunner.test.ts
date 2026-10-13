const nodes: Record<string, { filePath: string }> = {}
jest.mock('../../utils', () => ({ databaseEntities: {} }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), info: jest.fn(), debug: jest.fn() } }))
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        nodesPool: { componentNodes: nodes },
        AppDataSource: {}
    })
}))
jest.mock('@cuttlely/components', () => ({ convertSchemaToZod: () => ({}) }))

import path from 'path'
import { LLMEvaluationRunner, graderNodeInputs, graderTokenTotal, noteGraderTokens } from './LLMEvaluationRunner'

const fixture = path.join(__dirname, 'grader-node-fixture.js')

test('a Bedrock-style step is built with inputs.model, modelName, and streaming off', () => {
    const inputs = graderNodeInputs({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        inputs: {
            model: 'anthropic.claude-3-haiku-20240307-v1:0',
            region: 'us-east-1',
            temperature: 0.2,
            streaming: true,
            FLOWISE_CREDENTIAL_ID: 'cred-bedrock'
        }
    })
    expect(inputs).toEqual({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        modelName: 'anthropic.claude-3-haiku-20240307-v1:0',
        region: 'us-east-1',
        temperature: 0.2,
        streaming: false,
        FLOWISE_CREDENTIAL_ID: 'cred-bedrock'
    })
})

test('createLLM spreads that config onto the node', async () => {
    nodes.awsChatBedrock = { filePath: fixture }
    const runner = new LLMEvaluationRunner()
    await runner.createLLM({
        workspaceId: 'team-a',
        llmConfig: {
            llm: 'awsChatBedrock',
            model: 'anthropic.claude-3-haiku-20240307-v1:0',
            credentialId: 'cred-bedrock',
            inputs: { model: 'anthropic.claude-3-haiku-20240307-v1:0', region: 'us-east-1', streaming: true }
        }
    })
    const node = require('./grader-node-fixture.js')
    expect(node.nodeClass.last.credential).toBe('cred-bedrock')
    expect(node.nodeClass.last.inputs).toEqual({
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        modelName: 'anthropic.claude-3-haiku-20240307-v1:0',
        region: 'us-east-1',
        streaming: false
    })
})

test('estimatedTokenUsage counts when tokenUsage is empty, then usage_metadata', () => {
    expect(graderTokenTotal({ llmOutput: { tokenUsage: {}, estimatedTokenUsage: { totalTokens: 500 } } })).toBe(500)
    expect(graderTokenTotal({ llmOutput: { tokenUsage: { totalTokens: 12 }, estimatedTokenUsage: { totalTokens: 500 } } })).toBe(12)
    expect(
        graderTokenTotal({
            llmOutput: {},
            generations: [[{ message: { usage_metadata: { input_tokens: 8, output_tokens: 5, total_tokens: 13 } } }]]
        })
    ).toBe(13)
    expect(graderTokenTotal({ llmOutput: {} })).toBe(0)
    let noted = 0
    noteGraderTokens({ llmOutput: { estimatedTokenUsage: { totalTokens: 500 } } }, (count) => {
        noted += count
    })
    expect(noted).toBe(500)
})

test('a node that fails to start says the grading model could not be started', async () => {
    nodes.awsChatBedrock = { filePath: fixture }
    const node = require('./grader-node-fixture.js')
    node.nodeClass.prototype.init = async () => {
        throw new Error('model is required')
    }
    const runner = new LLMEvaluationRunner()
    await expect(
        runner.createLLM({
            llmConfig: { llm: 'awsChatBedrock', model: 'anthropic.claude', credentialId: 'cred', inputs: { model: 'anthropic.claude' } }
        })
    ).rejects.toThrow('The grading model could not be started.')
    node.nodeClass.prototype.init = async function (nodeData: { inputs: unknown; credential: string }) {
        node.nodeClass.last = nodeData
        return { ready: true }
    }
})
