/**
 * A prediction whose chat model has no credential selected answers 422 naming the card.
 * OPENAI_API_KEY and XAI_API_KEY stay unset so a missed check cannot fall through to a provider env error.
 */
const savedOpenAi = process.env.OPENAI_API_KEY
const savedXai = process.env.XAI_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.XAI_API_KEY

import fs from 'fs'
import os from 'os'
import path from 'path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-credential-prediction-'))
const storageEnv = ['HOME', 'DATABASE_PATH', 'CUTTLELY_DATA_DIR', 'HERMES_HOME'] as const
const savedEnv = Object.fromEntries(storageEnv.map((name) => [name, process.env[name]]))
for (const name of storageEnv) process.env[name] = dataDir
const savedMode = process.env.MODE

import express from 'express'
import request from 'supertest'
import { AppError } from '../errors/appError'
import errorHandlerMiddleware from '../middlewares/errors'
import { toPredictionError } from './predictionErrors'
import { MissingModelCredentialError, missingModelCredentialMessage } from '@cuttlely/components'
import predictionsController from '../controllers/predictions'
import vectorsController from '../controllers/vectors'
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

describe('prediction HTTP for a missing model credential', () => {
    it('answers 422 with the node name and does not mention OPENAI_API_KEY', async () => {
        const app = express()
        app.post('/api/v1/prediction/flow-1', (_req, _res, next) => {
            next(toPredictionError(Object.assign(new Error('Pick a credential on the OpenAI node.'), { statusCode: 422 })))
        })
        app.use(errorHandlerMiddleware)

        const res = await request(app).post('/api/v1/prediction/flow-1').send({ question: 'hi' })
        expect(res.status).toBe(422)
        expect(res.body).toMatchObject({
            statusCode: 422,
            success: false,
            message: 'Pick a credential on the OpenAI node.'
        })
        expect(res.body.message).toContain('OpenAI')
        expect(res.body.message).not.toMatch(/OPENAI_API_KEY/)
    })
})

describe('buildFlow keeps the 422 from a chat model with no credential', () => {
    let fixturePath = ''
    let buildFlow: typeof import('./index').buildFlow

    beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-cred-'))
        fixturePath = path.join(dir, 'OpenAIStandIn.js')
        fs.writeFileSync(
            fixturePath,
            [
                'class OpenAIStandIn {',
                "  constructor() { this.label = 'OpenAI'; this.name = 'chatOpenAI'; this.category = 'Chat Models';",
                "    this.credential = { label: 'Connect Credential', name: 'credential', type: 'credential' } }",
                '  async init(nodeData) {',
                "    const err = new Error('Pick a credential on the ' + (nodeData.label || this.label) + ' node.')",
                '    err.statusCode = 422',
                '    throw err',
                '  }',
                '}',
                'module.exports = { nodeClass: OpenAIStandIn }',
                ''
            ].join('\n')
        )
        buildFlow = (await import('./index')).buildFlow
    })

    it('rethrows 422 with the card name instead of wrapping it as 500', async () => {
        const node = {
            id: 'chatOpenAI_0',
            type: 'customNode',
            position: { x: 0, y: 0 },
            data: {
                id: 'chatOpenAI_0',
                name: 'chatOpenAI',
                label: 'Support desk model',
                category: 'Chat Models',
                inputs: {},
                outputs: {},
                inputParams: [],
                inputAnchors: [],
                outputAnchors: []
            }
        }
        await expect(
            buildFlow({
                startingNodeIds: [node.id],
                reactFlowNodes: [node as any],
                reactFlowEdges: [],
                apiMessageId: 'm1',
                graph: { [node.id]: [] },
                depthQueue: { [node.id]: 0 },
                componentNodes: { chatOpenAI: { filePath: fixturePath } },
                question: 'q',
                uploadedFilesContent: '',
                chatHistory: [],
                chatId: 'c1',
                sessionId: 's1',
                chatflowid: 'f1',
                appDataSource: {},
                overrideConfig: {},
                apiOverrideStatus: false,
                nodeOverrides: {},
                availableVariables: [],
                variableOverrides: [],
                cachePool: {},
                usageCacheManager: {},
                isUpsert: false,
                orgId: 'o1',
                workspaceId: 'w1',
                subscriptionId: 'sub1',
                updateStorageUsage: jest.fn(),
                checkStorage: jest.fn()
            } as any)
        ).rejects.toMatchObject({
            statusCode: 422,
            message: 'Pick a credential on the Support desk model node.'
        })
        const mapped = toPredictionError(Object.assign(new Error('Pick a credential on the Support desk model node.'), { statusCode: 422 }))
        expect(mapped).toBeInstanceOf(AppError)
        expect(mapped.statusCode).toBe(422)
        expect(mapped.message).toContain('Support desk model')
    })
})

const node = (id: string, name: string, label: string, inputs: Record<string, unknown>) => ({
    id,
    type: 'agentFlow',
    position: { x: 0, y: 0 },
    data: { id, name, label, inputs, inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {} }
})
const flow = {
    id: 'flow-1',
    name: 'Bakery helper',
    type: 'AGENTFLOW',
    workspaceId: 'workspace-1',
    flowData: JSON.stringify({
        nodes: [
            node('start-1', 'startAgentflow', 'Start', { startInputType: 'chatInput' }),
            node('model-1', 'llmAgentflow', 'Bakery model', {})
        ],
        edges: [{ id: 'edge-1', source: 'start-1', target: 'model-1', sourceHandle: 'a', targetHandle: 'b' }]
    })
}

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
let modelStep: { failure: Error }

const predict = () => {
    const app = express()
    app.use(express.json())
    app.post('/api/v1/prediction/:id', predictionsController.createPrediction)
    app.use(errorHandlerMiddleware)
    return request(app).post('/api/v1/prediction/flow-1').send({ question: 'When is the bread ready?', streaming: false })
}

const upsert = () => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
        req.user = { activeWorkspaceId: 'workspace-1' } as any
        next()
    })
    app.post('/api/v1/vector/upsert/:id', vectorsController.upsertVectorMiddleware)
    app.use(errorHandlerMiddleware)
    return request(app).post('/api/v1/vector/upsert/flow-1').send({})
}

describe('prediction HTTP for agentflow and queue failures', () => {
    beforeAll(() => {
        const startPath = path.join(dataDir, 'start.js')
        const modelPath = path.join(dataDir, 'model.js')
        fs.writeFileSync(
            startPath,
            "exports.nodeClass = class { async run(nodeData, input) { return { id: nodeData.id, name: 'startAgentflow', input: {}, output: { question: input } } } }\n"
        )
        fs.writeFileSync(modelPath, 'exports.nodeClass = class { async run() { throw exports.failure } }\n')
        modelStep = require(modelPath)
        server.nodesPool.componentNodes = {
            startAgentflow: { filePath: startPath },
            llmAgentflow: { filePath: modelPath }
        }
    })

    beforeEach(() => {
        delete process.env.MODE
        execution = undefined
        modelStep.failure = new MissingModelCredentialError('Bakery model')
        waitUntilFinished.mockReset()
        addJob.mockClear()
    })

    it('answers 422 naming the agentflow model card with no selected credential', async () => {
        const res = await predict()
        expect(res.status).toBe(422)
        expect(res.body).toMatchObject({ statusCode: 422, success: false, message: missingModelCredentialMessage('Bakery model') })
        expect(execution?.state).toBe('ERROR')
        expect(addJob).not.toHaveBeenCalled()
    })

    it('keeps an unrelated agentflow failure at 500', async () => {
        modelStep.failure = new Error('Unexpected model failure')
        const res = await predict()
        expect(res.status).toBe(500)
        expect(res.body.message).toBe('Unexpected model failure')
    })

    it('answers 422 with the card message after BullMQ drops the error class and status', async () => {
        process.env.MODE = 'queue'
        waitUntilFinished.mockRejectedValue(new Error(missingModelCredentialMessage('Bakery model')))
        const res = await predict()
        expect(res.status).toBe(422)
        expect(res.body).toMatchObject({ statusCode: 422, success: false, message: missingModelCredentialMessage('Bakery model') })
        expect(waitUntilFinished).toHaveBeenCalledTimes(1)
    })

    it('keeps a non-credential BullMQ failure at 500', async () => {
        process.env.MODE = 'queue'
        waitUntilFinished.mockRejectedValue(new Error('Queue worker connection failed'))
        const res = await predict()
        expect(res.status).toBe(500)
        expect(res.body.message).toBe('Queue worker connection failed')
        expect(waitUntilFinished).toHaveBeenCalledTimes(1)
    })

    it('answers 422 naming the embeddings card after a vector-upsert queue failure', async () => {
        process.env.MODE = 'queue'
        waitUntilFinished.mockRejectedValue(new Error(missingModelCredentialMessage('Bakery embeddings')))
        const res = await upsert()
        expect(res.status).toBe(422)
        expect(res.body).toMatchObject({ statusCode: 422, success: false, message: missingModelCredentialMessage('Bakery embeddings') })
        expect(waitUntilFinished).toHaveBeenCalledTimes(1)
    })

    it('keeps a non-credential vector-upsert queue failure at 500', async () => {
        process.env.MODE = 'queue'
        waitUntilFinished.mockRejectedValue(new Error('Vector queue worker connection failed'))
        const res = await upsert()
        expect(res.status).toBe(500)
        expect(res.body.message).toContain('Vector queue worker connection failed')
        expect(waitUntilFinished).toHaveBeenCalledTimes(1)
    })

    it.each([new MissingModelCredentialError('Bakery model'), Object.assign(new Error('Check the model input'), { statusCode: 409 })])(
        'rethrows the same agentflow client error object: %s',
        async (failure) => {
            modelStep.failure = failure
            await expect(
                executeAgentFlow({
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
            ).rejects.toBe(failure)
        }
    )
})
