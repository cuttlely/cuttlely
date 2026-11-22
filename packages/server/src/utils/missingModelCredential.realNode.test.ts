/**
 * A real agentflow LLM/Agent/Condition Agent node (not a stubbed run()) must
 * rethrow a missing credential as 422, and a non-credential failure from the
 * same node as 500, both in-process and through MODE=queue.
 * OPENAI_API_KEY and XAI_API_KEY stay unset so a missed check cannot fall through.
 */
const savedOpenAi = process.env.OPENAI_API_KEY
const savedXai = process.env.XAI_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.XAI_API_KEY

import fs from 'fs'
import os from 'os'
import path from 'path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-credential-real-node-'))
const storageEnv = ['HOME', 'DATABASE_PATH', 'CUTTLELY_DATA_DIR', 'HERMES_HOME'] as const
const savedEnv = Object.fromEntries(storageEnv.map((name) => [name, process.env[name]]))
for (const name of storageEnv) process.env[name] = dataDir
const savedMode = process.env.MODE

import express from 'express'
import request from 'supertest'
import errorHandlerMiddleware from '../middlewares/errors'
import { MissingModelCredentialError, missingModelCredentialMessage } from '@cuttlely/components'
import predictionsController from '../controllers/predictions'
import { executeAgentFlow } from './buildAgentflow'

jest.setTimeout(30_000)

jest.mock('./logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

jest.mock('@cuttlely/components', () => ({ ...jest.requireActual('@cuttlely/components'), tracingEnvEnabled: () => false }))
jest.mock('./getRunningExpressApp', () => ({ getRunningExpressApp: () => server }))
jest.mock('./validateKey', () => ({ validateFlowAPIKey: async () => true }))
jest.mock('./sessionOwnership', () => ({
    ...jest.requireActual('./sessionOwnership'),
    bindRequestSession: () => ({ chatId: 'chat-1' })
}))
jest.mock('./quotaUsage', () => ({
    checkPredictions: async () => undefined,
    updatePredictionsUsage: async () => undefined,
    checkStorage: async () => undefined,
    updateStorageUsage: async () => undefined
}))
jest.mock('../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowById: async () => flow,
        checkIfChatflowIsValidForStreaming: async () => ({ isStreaming: false })
    }
}))

afterAll(() => {
    for (const name of storageEnv) {
        if (savedEnv[name] === undefined) delete process.env[name]
        else process.env[name] = savedEnv[name]
    }
    if (savedMode === undefined) delete process.env.MODE
    else process.env.MODE = savedMode
    fs.rmSync(dataDir, { recursive: true, force: true })
    if (savedOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = savedOpenAi
    if (savedXai === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = savedXai
})

const node = (id: string, name: string, label: string, inputs: Record<string, unknown>) => ({
    id,
    type: 'agentFlow',
    position: { x: 0, y: 0 },
    data: { id, name, label, inputs, inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {} }
})

let flow: {
    id: string
    name: string
    type: string
    workspaceId: string
    flowData: string
}

const bakersLlmFlow = () => ({
    id: 'flow-1',
    name: 'Bakery helper',
    type: 'AGENTFLOW',
    workspaceId: 'workspace-1',
    flowData: JSON.stringify({
        nodes: [
            node('start-1', 'startAgentflow', 'Start', { startInputType: 'chatInput' }),
            node('model-1', 'llmAgentflow', 'Bakery model', {
                llmModel: 'chatOpenAI',
                llmModelConfig: { modelName: 'gpt-4o-mini' }
            })
        ],
        edges: [{ id: 'edge-1', source: 'start-1', target: 'model-1', sourceHandle: 'a', targetHandle: 'b' }]
    })
})

let execution: Record<string, unknown> | undefined
const repository = {
    find: async () => [],
    findBy: async () => [],
    findOneBy: async () => execution,
    create: (value: unknown) => value,
    save: async (value: Record<string, unknown>) => (execution = { id: 'execution-1', ...value }),
    merge: (target: Record<string, unknown>, value: Record<string, unknown>) => Object.assign(target, value)
}

const waitUntilFinished = jest.fn()
const addJob = jest.fn(async () => ({ id: 'job-1', waitUntilFinished }))
const server = {
    AppDataSource: {
        getRepository: (entity: { name?: string }) => {
            if (entity.name === 'ChatFlow') return { findOneBy: async () => flow }
            if (entity.name === 'Workspace') return { findOneBy: async () => ({ id: 'workspace-1', organizationId: 'org-1' }) }
            if (entity.name === 'Organization') return { findOneBy: async () => ({ id: 'org-1', subscriptionId: 'subscription-1' }) }
            return repository
        }
    },
    queueManager: { getQueue: () => ({ addJob, getQueueEvents: () => ({}) }) },
    abortControllerPool: { add: jest.fn(), remove: jest.fn() },
    nodesPool: { componentNodes: {} as Record<string, { filePath: string }> },
    usageCacheManager: {},
    cachePool: {},
    telemetry: { sendTelemetry: jest.fn() }
}

const predict = () => {
    const app = express()
    app.use(express.json())
    app.post('/api/v1/prediction/:id', predictionsController.createPrediction)
    app.use(errorHandlerMiddleware)
    return request(app).post('/api/v1/prediction/flow-1').send({ question: 'When is the bread ready?', streaming: false })
}

const executeParams = () =>
    ({
        componentNodes: server.nodesPool.componentNodes,
        incomingInput: { question: 'When is the bread ready?' },
        chatflow: flow,
        chatId: 'chat-1',
        appDataSource: server.AppDataSource,
        telemetry: server.telemetry,
        usageCacheManager: {},
        cachePool: {},
        baseURL: 'http://127.0.0.1',
        isInternal: true,
        orgId: 'org-1',
        workspaceId: 'workspace-1',
        subscriptionId: 'subscription-1',
        productId: 'product-1'
    } as any)

const componentsRoot = path.join(__dirname, '../../../components/nodes')
const llmPath = path.join(componentsRoot, 'agentflow/LLM/LLM.ts')
const agentPath = path.join(componentsRoot, 'agentflow/Agent/Agent.ts')
const conditionPath = path.join(componentsRoot, 'agentflow/ConditionAgent/ConditionAgent.ts')

const writeStart = () => {
    const startPath = path.join(dataDir, 'start.js')
    fs.writeFileSync(
        startPath,
        "exports.nodeClass = class { async run(nodeData, input) { return { id: nodeData.id, name: 'startAgentflow', input: {}, output: { question: input } } } }\n"
    )
    return startPath
}

const writeCredentialModel = () => {
    const modelPath = path.join(dataDir, 'chatOpenAI-credential.js')
    const components = JSON.stringify(require.resolve('@cuttlely/components'))
    fs.writeFileSync(
        modelPath,
        [
            `const { getCredentialData } = require(${components})`,
            'class ChatOpenAICredentialCheck {',
            "  constructor() { this.label = 'OpenAI'; this.name = 'chatOpenAI'; this.category = 'Chat Models';",
            "    this.credential = { label: 'Connect Credential', name: 'credential', type: 'credential' } }",
            '  async init(nodeData, _input, options) {',
            "    await getCredentialData(nodeData.credential ?? '', options, { instance: this, nodeData })",
            "    throw new Error('init continued past the credential check')",
            '  }',
            '}',
            'module.exports = { nodeClass: ChatOpenAICredentialCheck }',
            ''
        ].join('\n')
    )
    return modelPath
}

const writeFailingModel = () => {
    const modelPath = path.join(dataDir, 'chatOpenAI-failure.js')
    fs.writeFileSync(modelPath, "exports.nodeClass = class { async init() { throw new Error('Unexpected model failure') } }\n")
    return modelPath
}

const emptyNodeData = (id: string, name: string, label: string, inputs: Record<string, unknown>) => ({
    id,
    name,
    label,
    inputs,
    inputParams: [],
    inputAnchors: [],
    outputAnchors: [],
    outputs: {}
})

describe('real agentflow LLM node prediction path', () => {
    let startPath = ''
    let credentialModelPath = ''
    let failingModelPath = ''

    beforeAll(() => {
        startPath = writeStart()
        credentialModelPath = writeCredentialModel()
        failingModelPath = writeFailingModel()
    })

    beforeEach(() => {
        delete process.env.MODE
        execution = undefined
        flow = bakersLlmFlow()
        waitUntilFinished.mockReset()
        addJob.mockClear()
        server.nodesPool.componentNodes = {
            startAgentflow: { filePath: startPath },
            llmAgentflow: { filePath: llmPath },
            chatOpenAI: { filePath: credentialModelPath }
        }
    })

    it('answers 422 naming the card when the real LLM node has no selected credential', async () => {
        const res = await predict()
        expect(res.status).toBe(422)
        expect(res.body).toMatchObject({
            statusCode: 422,
            success: false,
            message: missingModelCredentialMessage('Bakery model')
        })
        expect(res.body.message).not.toContain('Error in LLM node')
        expect(addJob).not.toHaveBeenCalled()
    })

    it('keeps a non-credential failure from the same LLM node at 500', async () => {
        server.nodesPool.componentNodes.chatOpenAI = { filePath: failingModelPath }
        const res = await predict()
        expect(res.status).toBe(500)
        expect(res.body.message).toContain('Unexpected model failure')
        expect(res.body.message).not.toBe(missingModelCredentialMessage('Bakery model'))
        expect(res.status).not.toBe(422)
    })

    it('answers 422 after a MODE=queue worker runs the real LLM node and BullMQ keeps only the message', async () => {
        process.env.MODE = 'queue'
        waitUntilFinished.mockImplementation(async () => {
            const prev = process.env.MODE
            delete process.env.MODE
            try {
                return await executeAgentFlow(executeParams())
            } catch (err) {
                throw new Error(err instanceof Error ? err.message : String(err))
            } finally {
                if (prev === undefined) delete process.env.MODE
                else process.env.MODE = prev
            }
        })
        const res = await predict()
        expect(res.status).toBe(422)
        expect(res.body).toMatchObject({
            statusCode: 422,
            success: false,
            message: missingModelCredentialMessage('Bakery model')
        })
        expect(res.body.message).not.toContain('Error in LLM node')
        expect(waitUntilFinished).toHaveBeenCalledTimes(1)
    })

    it('keeps a non-credential failure from the same LLM node at 500 through MODE=queue', async () => {
        server.nodesPool.componentNodes.chatOpenAI = { filePath: failingModelPath }
        process.env.MODE = 'queue'
        waitUntilFinished.mockImplementation(async () => {
            const prev = process.env.MODE
            delete process.env.MODE
            try {
                return await executeAgentFlow(executeParams())
            } catch (err) {
                throw new Error(err instanceof Error ? err.message : String(err))
            } finally {
                if (prev === undefined) delete process.env.MODE
                else process.env.MODE = prev
            }
        })
        const res = await predict()
        expect(res.status).toBe(500)
        expect(res.body.message).toContain('Unexpected model failure')
        expect(res.body.message).not.toBe(missingModelCredentialMessage('Bakery model'))
        expect(waitUntilFinished).toHaveBeenCalledTimes(1)
    })
})

describe('real Agent and Condition Agent nodes rethrow a missing credential', () => {
    let credentialModelPath = ''
    let failingModelPath = ''
    let agentClass: { new (): { run: Function } }
    let conditionClass: { new (): { run: Function } }

    beforeAll(() => {
        credentialModelPath = writeCredentialModel()
        failingModelPath = writeFailingModel()
        agentClass = require(agentPath).nodeClass
        conditionClass = require(conditionPath).nodeClass
    })

    const options = (modelPath: string) => ({
        componentNodes: { chatOpenAI: { filePath: modelPath } },
        agentflowRuntime: {},
        pastChatHistory: []
    })

    it('rethrows MissingModelCredentialError unchanged from the Agent node', async () => {
        const inst = new agentClass()
        await inst
            .run(
                emptyNodeData('agent-1', 'agentAgentflow', 'Bakery agent', {
                    agentModel: 'chatOpenAI',
                    agentModelConfig: { modelName: 'gpt-4o-mini' },
                    agentTools: []
                }),
                'When is the bread ready?',
                options(credentialModelPath)
            )
            .then(
                () => {
                    throw new Error('expected MissingModelCredentialError')
                },
                (err: unknown) => {
                    expect(err).toBeInstanceOf(MissingModelCredentialError)
                    expect(err).toMatchObject({
                        statusCode: 422,
                        message: missingModelCredentialMessage('Bakery agent')
                    })
                }
            )
    })

    it('wraps a non-credential Agent failure and does not report 422', async () => {
        const inst = new agentClass()
        await expect(
            inst.run(
                emptyNodeData('agent-1', 'agentAgentflow', 'Bakery agent', {
                    agentModel: 'chatOpenAI',
                    agentModelConfig: { modelName: 'gpt-4o-mini' },
                    agentTools: []
                }),
                'When is the bread ready?',
                options(failingModelPath)
            )
        ).rejects.toMatchObject({
            message: 'Error in Agent node: Unexpected model failure'
        })
    })

    it('rethrows MissingModelCredentialError unchanged from the Condition Agent node', async () => {
        const inst = new conditionClass()
        await inst
            .run(
                emptyNodeData('cond-1', 'conditionAgentAgentflow', 'Bakery condition', {
                    conditionAgentModel: 'chatOpenAI',
                    conditionAgentModelConfig: { modelName: 'gpt-4o-mini' },
                    conditionAgentScenarios: [{ scenario: 'bread is ready' }]
                }),
                'When is the bread ready?',
                options(credentialModelPath)
            )
            .then(
                () => {
                    throw new Error('expected MissingModelCredentialError')
                },
                (err: unknown) => {
                    expect(err).toBeInstanceOf(MissingModelCredentialError)
                    expect(err).toMatchObject({
                        statusCode: 422,
                        message: missingModelCredentialMessage('Bakery condition')
                    })
                }
            )
    })

    it('wraps a non-credential Condition Agent failure and does not report 422', async () => {
        const inst = new conditionClass()
        await expect(
            inst.run(
                emptyNodeData('cond-1', 'conditionAgentAgentflow', 'Bakery condition', {
                    conditionAgentModel: 'chatOpenAI',
                    conditionAgentModelConfig: { modelName: 'gpt-4o-mini' },
                    conditionAgentScenarios: [{ scenario: 'bread is ready' }]
                }),
                'When is the bread ready?',
                options(failingModelPath)
            )
        ).rejects.toMatchObject({
            message: 'Error in Condition Agent node: Unexpected model failure'
        })
    })
})
