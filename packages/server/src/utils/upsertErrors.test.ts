import fs from 'fs'
import os from 'os'
import path from 'path'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-credential-upsert-'))
const storageEnv = ['HOME', 'DATABASE_PATH', 'CUTTLELY_DATA_DIR', 'HERMES_HOME'] as const
const savedEnv = Object.fromEntries(storageEnv.map((name) => [name, process.env[name]]))
for (const name of storageEnv) process.env[name] = dataDir

import express from 'express'
import request from 'supertest'
import { MissingModelCredentialError, missingModelCredentialMessage } from '@cuttlely/components'
import { StatusCodes } from 'http-status-codes'
import { DocumentStore } from '../database/entities/DocumentStore'
import errorHandlerMiddleware from '../middlewares/errors'
import { AppError } from '../errors/appError'
import { clientErrorStatus, toUpsertAppError } from './upsertErrors'

jest.mock('./upsertVector', () => ({ upsertVector: jest.fn() }))
jest.mock('./getRunningExpressApp', () => ({ getRunningExpressApp: () => mockDocumentStoreApp }))
jest.mock('./logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))
jest.mock('./index', () => ({ databaseEntities: {}, saveUpsertFlowData: () => ({}) }))
jest.mock('../services/nodes', () => ({ __esModule: true, default: {} }))
jest.mock(
    'credential-test-loader',
    () => ({
        nodeClass: class {
            async init() {
                return [{ pageContent: 'The sample bakery opens at eight.', metadata: {} }]
            }
        }
    }),
    { virtual: true }
)
jest.mock(
    'credential-test-embedding',
    () => ({
        nodeClass: class {
            async init(nodeData: { label: string }) {
                return mockEmbeddingInit(nodeData)
            }
        }
    }),
    { virtual: true }
)

const mockEmbeddingInit = jest.fn()
const mockWaitUntilFinished = jest.fn()
const mockQueueEvents = {}
const mockDocumentStoreApp = {
    AppDataSource: { getRepository: jest.fn() },
    nodesPool: {
        componentNodes: {
            sampleLoader: { name: 'sampleLoader', label: 'Sample loader', filePath: 'credential-test-loader' },
            sampleEmbedding: {
                name: 'sampleEmbedding',
                label: 'Bakery embeddings',
                category: 'Embeddings',
                inputs: [],
                filePath: 'credential-test-embedding'
            }
        }
    },
    telemetry: {},
    usageCacheManager: {},
    queueManager: {
        getQueue: jest.fn(() => ({
            addJob: jest.fn(async () => ({ id: 'sample-job', waitUntilFinished: mockWaitUntilFinished })),
            getQueueEvents: () => mockQueueEvents
        }))
    }
}

afterAll(() => {
    for (const name of storageEnv) {
        if (savedEnv[name] === undefined) delete process.env[name]
        else process.env[name] = savedEnv[name]
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('vector upsert error status', () => {
    it('keeps a component 422 (missing model credential) as a 422 AppError', () => {
        const err = Object.assign(new Error('Pick a credential on the OpenAI Embedding node.'), { statusCode: 422 })
        const out = toUpsertAppError(err, 'Error: vectorsService.upsertVector - ')
        expect(out).toBeInstanceOf(AppError)
        expect(out.statusCode).toBe(422)
        expect(out.message).toBe('Pick a credential on the OpenAI Embedding node.')
    })

    it('passes a 4xx AppError through unchanged', () => {
        const err = new AppError(StatusCodes.UNAUTHORIZED, 'Unauthorized')
        expect(toUpsertAppError(err)).toBe(err)
    })

    it('turns other errors into a 500 with the prefix', () => {
        const out = toUpsertAppError(new Error('boom'), 'p - ')
        expect(out.statusCode).toBe(500)
        expect(out.message).toBe('p - boom')
        expect(clientErrorStatus(new AppError(500, 'x'))).toBeUndefined()
    })

    it('vectorsService keeps the 422 from upsertVector', async () => {
        const { upsertVector } = jest.requireMock('./upsertVector') as { upsertVector: jest.Mock }
        upsertVector.mockRejectedValueOnce(new AppError(422, 'Pick a credential on the OpenAI Embedding node.'))
        const vectorsService = (await import('../services/vectors')).default
        await expect(vectorsService.upsertVectorMiddleware({} as any)).rejects.toMatchObject({ statusCode: 422 })
    })
})

describe('document-store upsert HTTP errors', () => {
    const originalMode = process.env.MODE
    const cardMessage = missingModelCredentialMessage('Bakery embeddings')
    const upsertBody = {
        loader: { name: 'sampleLoader', config: {} },
        embedding: { name: 'sampleEmbedding', config: {} },
        vectorStore: { name: 'sampleVectorStore', config: {} }
    }
    let controller: typeof import('../controllers/documentstore').default
    let service: typeof import('../services/documentstore')

    beforeAll(async () => {
        controller = (await import('../controllers/documentstore')).default
        service = await import('../services/documentstore')
    })

    beforeEach(() => {
        jest.clearAllMocks()
        const store = {
            id: 'sample-store',
            name: 'Bakery notes',
            workspaceId: 'sample-workspace',
            loaders: '[]',
            status: 'SYNC',
            embeddingConfig: null,
            vectorStoreConfig: null,
            recordManagerConfig: null
        }
        const chunks: unknown[] = []
        const storeRepository = {
            findOneBy: jest.fn(async () => store),
            save: jest.fn(async (entity) => entity)
        }
        const chunkRepository = {
            delete: jest.fn(async () => {
                chunks.length = 0
            }),
            create: jest.fn((chunk) => chunk),
            save: jest.fn(async (chunk) => {
                chunks.push(chunk)
                return chunk
            }),
            count: jest.fn(async () => chunks.length),
            find: jest.fn(async () => chunks)
        }
        mockDocumentStoreApp.AppDataSource.getRepository.mockImplementation((entity) =>
            entity === DocumentStore ? storeRepository : chunkRepository
        )
        mockEmbeddingInit.mockImplementation(async (nodeData) => {
            throw new MissingModelCredentialError(nodeData.label)
        })
        // BullMQ reconstructs failedReason as a plain Error without the worker's statusCode or class.
        mockWaitUntilFinished.mockRejectedValue(new Error(cardMessage))
    })

    afterEach(() => {
        if (originalMode === undefined) delete process.env.MODE
        else process.env.MODE = originalMode
    })

    const app = () => {
        const server = express()
        server.use(express.json())
        server.use((req, _res, next) => {
            req.user = {
                id: 'sample-user',
                activeOrganizationId: 'sample-organization',
                activeWorkspaceId: 'sample-workspace'
            } as any
            next()
        })
        server.post('/api/v1/document-store/upsert/:id', controller.upsertDocStoreMiddleware)
        server.post('/api/v1/document-store/refresh/:id', controller.refreshDocStoreMiddleware)
        server.post('/api/v1/document-store/vectorstore/insert', controller.insertIntoVectorStore)
        server.use(errorHandlerMiddleware)
        return server
    }

    it.each(['main', 'queue'])('upsert answers 422 with the embeddings card message in %s mode', async (mode) => {
        process.env.MODE = mode
        const response = await request(app()).post('/api/v1/document-store/upsert/sample-store').send(upsertBody)
        expect(response.status).toBe(422)
        expect(response.body).toMatchObject({ statusCode: 422, success: false, message: cardMessage })
        if (mode === 'queue') expect(mockWaitUntilFinished).toHaveBeenCalledWith(mockQueueEvents)
        else expect(mockEmbeddingInit).toHaveBeenCalledWith(expect.objectContaining({ label: 'Bakery embeddings' }))
    })

    it.each(['main', 'queue'])('refresh answers 422 with the embeddings card message in %s mode', async (mode) => {
        process.env.MODE = mode
        const response = await request(app())
            .post('/api/v1/document-store/refresh/sample-store')
            .send({ items: [upsertBody] })
        expect(response.status).toBe(422)
        expect(response.body).toMatchObject({ statusCode: 422, success: false, message: cardMessage })
    })

    it.each(['main', 'queue'])('vector insert answers 422 with the embeddings card message in %s mode', async (mode) => {
        process.env.MODE = mode
        const response = await request(app()).post('/api/v1/document-store/vectorstore/insert').send({
            storeId: 'sample-store',
            embeddingName: 'sampleEmbedding',
            embeddingConfig: {},
            vectorStoreName: 'sampleVectorStore',
            vectorStoreConfig: {}
        })
        expect(response.status).toBe(422)
        expect(response.body).toMatchObject({ statusCode: 422, success: false, message: cardMessage })
    })

    it.each(['main', 'queue'])('a non-credential upsert failure stays 500 in %s mode', async (mode) => {
        process.env.MODE = mode
        mockEmbeddingInit.mockRejectedValue(new Error('Sample index is offline.'))
        mockWaitUntilFinished.mockRejectedValue(new Error('Sample index is offline.'))
        const response = await request(app()).post('/api/v1/document-store/upsert/sample-store').send(upsertBody)
        expect(response.status).toBe(500)
        expect(response.body.statusCode).toBe(500)
        expect(response.body.message).toContain('Sample index is offline.')
    })

    it('keeps the worker failure class and exact message before queue serialization', async () => {
        const failure = service.executeDocStoreUpsert({
            appDataSource: mockDocumentStoreApp.AppDataSource,
            componentNodes: mockDocumentStoreApp.nodesPool.componentNodes,
            telemetry: {},
            storeId: 'sample-store',
            totalItems: [upsertBody],
            files: [],
            isRefreshAPI: false,
            orgId: 'sample-organization',
            workspaceId: 'sample-workspace',
            subscriptionId: '',
            usageCacheManager: {}
        } as any)
        await expect(failure).rejects.toBeInstanceOf(MissingModelCredentialError)
        await expect(failure).rejects.toMatchObject({ statusCode: 422, message: cardMessage })
    })
})
