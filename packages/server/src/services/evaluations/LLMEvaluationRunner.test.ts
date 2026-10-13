const nodes: Record<string, { filePath: string }> = {}
const mockDatabaseEntities = { Credential: class Credential {} }
const mockFindCredential = jest.fn()
const mockDecrypt = jest.fn()
const mockAppDataSource = {
    getRepository: () => ({ findOneBy: mockFindCredential }),
    entityMetadatas: []
}
jest.mock('../../utils', () => ({ databaseEntities: mockDatabaseEntities }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), info: jest.fn(), debug: jest.fn() } }))
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        nodesPool: { componentNodes: nodes },
        AppDataSource: mockAppDataSource
    })
}))
jest.mock('@cuttlely/components', () => {
    const actual = jest.requireActual('@cuttlely/components')
    return {
        ...actual,
        convertSchemaToZod: () => ({})
    }
})
jest.mock('crypto-js', () => {
    const actual = jest.requireActual('crypto-js')
    return {
        ...actual,
        AES: {
            ...actual.AES,
            decrypt: (...args: unknown[]) => mockDecrypt(...args)
        }
    }
})

import path from 'path'
import { RunnableLambda } from '@langchain/core/runnables'
import { scoreAnswer } from '../flow-check/score'
import { LLMEvaluationRunner, graderNodeInputs, graderTokenTotal, noteGraderTokens } from './LLMEvaluationRunner'

const fixture = path.join(__dirname, 'grader-node-fixture.js')
const node = require('./grader-node-fixture.js')

beforeEach(() => {
    node.nodeClass.last = null
    node.nodeClass.lastOptions = null
    node.nodeClass.initCalls = 0
    node.nodeClass.modelCalls = 0
    node.nodeClass.useCredentialGate = false
    mockFindCredential.mockReset()
    mockDecrypt.mockClear()
})

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
    expect(node.nodeClass.last.credential).toBe('cred-bedrock')
    expect(node.nodeClass.lastOptions.workspaceId).toBe('team-a')
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

function reportUsage(config: { callbacks?: any }, totalTokens: number) {
    const callbacks = config?.callbacks
    const handlers = Array.isArray(callbacks) ? callbacks : callbacks?.handlers || []
    for (const callback of handlers) {
        const handler = callback as { handleLLMEnd?: (output: unknown) => void }
        handler.handleLLMEnd?.({ llmOutput: { tokenUsage: { totalTokens } } })
    }
}

test('an aborted grade does not start another evaluator, and earlier usage is kept', async () => {
    const started: string[] = []
    let tokens = 0
    const controller = new AbortController()
    const runner = new LLMEvaluationRunner() as any
    runner.llm = {
        withStructuredOutput() {
            return RunnableLambda.from(async (_input: unknown, config: { callbacks?: unknown }) => {
                const id = ['first', 'second', 'third'][started.length]
                started.push(id)
                if (id === 'first') {
                    reportUsage(config, 400)
                    controller.abort()
                    return { pass: true }
                }
                throw new Error('aborted')
            })
        }
    }
    const evaluators = ['first', 'second', 'third'].map((id) => ({
        evaluatorId: id,
        evaluator: { prompt: 'Grade {actualOutput}', outputSchema: [] }
    }))
    const results = await runner.runLLMEvaluators({ input: 'q', expectedOutput: 'e' }, ['answer'], [''], evaluators, {
        signal: controller.signal,
        addTokens: (count: number) => {
            tokens += count
        }
    })
    expect(started).toEqual(['first'])
    expect(tokens).toBe(400)
    expect(results).toHaveLength(1)
})

test('a thrown abort does not start the evaluator after it', async () => {
    const started: number[] = []
    let tokens = 0
    const controller = new AbortController()
    const runner = new LLMEvaluationRunner() as any
    runner.llm = {
        withStructuredOutput() {
            return RunnableLambda.from(async (_input: unknown, config: { callbacks?: unknown }) => {
                started.push(started.length + 1)
                if (started.length === 1) {
                    reportUsage(config, 250)
                    return { pass: true }
                }
                controller.abort()
                throw new Error('aborted')
            })
        }
    }
    const evaluators = ['first', 'second', 'third'].map((id) => ({
        evaluatorId: id,
        evaluator: { prompt: 'Grade {actualOutput}', outputSchema: [] }
    }))
    await runner.runLLMEvaluators({ input: 'q', expectedOutput: 'e' }, ['answer'], [''], evaluators, {
        signal: controller.signal,
        addTokens: (count: number) => {
            tokens += count
        }
    })
    expect(started).toEqual([1, 2])
    expect(tokens).toBe(250)
})

test('a credential from another workspace is not decrypted and the grade is Error', async () => {
    nodes.awsChatBedrock = { filePath: fixture }
    node.nodeClass.useCredentialGate = true
    mockFindCredential.mockResolvedValue({
        id: 'cred-foreign',
        workspaceId: 'team-b',
        encryptedData: 'ciphertext-from-team-b'
    })
    // Without a key, decryption fails before AES.decrypt, so the test would stay green even if the workspace were not passed.
    mockDecrypt.mockReturnValue({ toString: () => '{}' })
    const savedKey = process.env.CUTTLELY_SECRETKEY_OVERWRITE
    const savedOtherKey = process.env.FLOWISE_SECRETKEY_OVERWRITE
    process.env.CUTTLELY_SECRETKEY_OVERWRITE = 'grader-test-key'
    if (savedOtherKey !== undefined && savedOtherKey !== 'grader-test-key') process.env.FLOWISE_SECRETKEY_OVERWRITE = 'grader-test-key'
    const flowData = JSON.stringify({
        nodes: [
            {
                data: {
                    name: 'awsChatBedrock',
                    category: 'Chat Models',
                    credential: 'cred-foreign',
                    inputs: { model: 'anthropic.claude-3-haiku-20240307-v1:0', region: 'us-east-1' }
                }
            }
        ]
    })
    try {
        const graded = await scoreAnswer({
            evaluators: [{ id: 'llm-1', name: 'Graded', type: 'llm', prompt: 'Grade {actualOutput}', outputSchema: [] } as any],
            question: 'Q',
            expected: null,
            text: 'ok',
            error: null,
            tokens: 4,
            ms: 5,
            workspaceId: 'team-a',
            flowData
        })
        expect(graded.scores).toEqual([
            { id: 'llm-1', name: 'Graded', result: 'Error', message: 'The grading model could not be started.' }
        ])
        expect(mockFindCredential).toHaveBeenCalledWith({ id: 'cred-foreign' })
        expect(node.nodeClass.lastOptions.workspaceId).toBe('team-a')
        expect(node.nodeClass.modelCalls).toBe(0)
        expect(mockDecrypt).not.toHaveBeenCalled()
        expect(JSON.stringify(graded)).not.toContain('ciphertext-from-team-b')
    } finally {
        if (savedKey === undefined) delete process.env.CUTTLELY_SECRETKEY_OVERWRITE
        else process.env.CUTTLELY_SECRETKEY_OVERWRITE = savedKey
        if (savedOtherKey === undefined) delete process.env.FLOWISE_SECRETKEY_OVERWRITE
        else process.env.FLOWISE_SECRETKEY_OVERWRITE = savedOtherKey
    }
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
