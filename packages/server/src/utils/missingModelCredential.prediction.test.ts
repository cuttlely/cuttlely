/**
 * A prediction whose chat model has no credential selected answers 422 naming the card.
 * OPENAI_API_KEY and XAI_API_KEY stay unset so a missed check cannot fall through to a provider env error.
 */
const savedOpenAi = process.env.OPENAI_API_KEY
const savedXai = process.env.XAI_API_KEY
delete process.env.OPENAI_API_KEY
delete process.env.XAI_API_KEY

import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { AppError } from '../errors/appError'
import errorHandlerMiddleware from '../middlewares/errors'
import { toPredictionError } from './predictionErrors'

jest.setTimeout(30_000)

jest.mock('./logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))

afterAll(() => {
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
