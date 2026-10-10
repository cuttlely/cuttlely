/**
 * Vector upsert and document-store upsert check the flow or the permission before multer.
 * A 401 or 403 writes nothing.
 */
import express, { NextFunction, Request, Response } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { generateSecretHash } from './apiKey'

const REQUEST_TIMEOUT_MS = 20_000
jest.setTimeout(30_000)

const hangGuard = (req: request.Test) => req.timeout({ response: REQUEST_TIMEOUT_MS, deadline: REQUEST_TIMEOUT_MS })

const mockState = {
    multerRuns: 0,
    multerWrites: [] as string[],
    uploadDir: ''
}

jest.mock('./logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

jest.mock('./index', () => {
    const multer = require('multer')
    const nodeFs = require('fs')
    const nodePath = require('path')
    const storage = {
        _handleFile(_req: unknown, file: any, cb: (error: Error | null, info?: object) => void) {
            mockState.multerWrites.push(file.originalname)
            const target = nodePath.join(mockState.uploadDir, `${Date.now()}-${mockState.multerWrites.length}`)
            const out = nodeFs.createWriteStream(target)
            file.stream.pipe(out)
            out.on('error', cb)
            out.on('finish', () => cb(null, { path: target, size: out.bytesWritten }))
        },
        _removeFile(_req: unknown, file: any, cb: (error: Error | null) => void) {
            nodeFs.rm(file.path, { force: true }, cb)
        }
    }
    const counted = (inner: any) =>
        Object.defineProperty(
            function multerMiddleware(req: unknown, res: unknown, next: unknown) {
                mockState.multerRuns += 1
                return inner(req, res, next)
            },
            'name',
            { value: 'multerMiddleware' }
        )
    return {
        getMulterStorage: () => {
            const instance = multer({ storage })
            return { array: (field: string, max?: number) => counted(instance.array(field, max)) }
        }
    }
})

const mockApiKeys = new Map<string, { id: string; workspaceId: string; apiSecret: string }>()
jest.mock('../services/apikey', () => ({
    __esModule: true,
    default: { getApiKeyById: jest.fn(async (id: string) => mockApiKeys.get(id) ?? null) }
}))

const vectorCalls: string[] = []
jest.mock('../services/vectors', () => ({
    __esModule: true,
    default: {
        upsertVectorMiddleware: jest.fn(async () => {
            vectorCalls.push('vector')
            return { ok: true }
        })
    }
}))

const docCalls: string[] = []
jest.mock('../services/documentstore', () => ({
    __esModule: true,
    default: {
        upsertDocStoreMiddleware: jest.fn(async () => {
            docCalls.push('doc')
            return { ok: true }
        })
    }
}))

const mockDb = {
    chatflows: new Map<string, any>(),
    workspaces: new Map<string, any>(),
    orgs: new Map<string, any>(),
    stores: new Map<string, any>()
}

jest.mock('./getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: (entity: { name: string }) => ({
                findOneBy: async ({ id }: { id: string }) => {
                    if (entity.name === 'ChatFlow') return mockDb.chatflows.get(id) ?? null
                    if (entity.name === 'Workspace') return mockDb.workspaces.get(id) ?? null
                    if (entity.name === 'Organization') return mockDb.orgs.get(id) ?? null
                    if (entity.name === 'DocumentStore') return mockDb.stores.get(id) ?? null
                    return null
                }
            })
        }
    })
}))

import vectorsRouter from '../routes/vectors'
import documentStoreRouter from '../routes/documentstore'
import errorHandlerMiddleware from '../middlewares/errors'

const WS = 'ws-1'
const OTHER = 'ws-2'
const FLOW = '11111111-1111-4111-8111-111111111111'
const STORE = '22222222-2222-4222-8222-222222222222'
const KEY = 'vector-flow-key-0123456789abcdef'

const app = express()
app.use(express.json())
app.use((req: Request, _res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-user']
    if (typeof raw === 'string') (req as Request & { user?: object }).user = JSON.parse(raw)
    next()
})
app.use('/api/v1/vector', vectorsRouter)
app.use('/api/v1/document-store', documentStoreRouter)
app.use(errorHandlerMiddleware)

const user = (workspaceId: string, permissions: string[]) =>
    JSON.stringify({
        permissions,
        activeOrganizationId: 'org-1',
        activeWorkspaceId: workspaceId
    })

const multipart = (url: string, headers: Record<string, string> = {}) => {
    const req = request(app).post(url).attach('files', Buffer.from('hello'), 'note.txt')
    for (const [name, value] of Object.entries(headers)) req.set(name, value)
    return hangGuard(req)
}

const expectNoWrites = () => {
    expect(mockState.multerRuns).toBe(0)
    expect(mockState.multerWrites).toEqual([])
    expect(fs.readdirSync(mockState.uploadDir)).toEqual([])
}

beforeEach(() => {
    mockState.multerRuns = 0
    mockState.multerWrites = []
    mockState.uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upsert-auth-'))
    vectorCalls.length = 0
    docCalls.length = 0
    mockApiKeys.clear()
    mockApiKeys.set('apikey-flow', { id: 'apikey-flow', workspaceId: WS, apiSecret: generateSecretHash(KEY) })
    mockDb.chatflows.clear()
    mockDb.workspaces.clear()
    mockDb.orgs.clear()
    mockDb.stores.clear()
    mockDb.chatflows.set(FLOW, { id: FLOW, workspaceId: WS, apikeyid: 'apikey-flow' })
    mockDb.workspaces.set(WS, { id: WS, organizationId: 'org-1' })
    mockDb.orgs.set('org-1', { id: 'org-1' })
    mockDb.stores.set(STORE, { id: STORE, workspaceId: WS })
})

afterEach(() => {
    fs.rmSync(mockState.uploadDir, { recursive: true, force: true })
})

describe('Vector upsert access', () => {
    const url = `/api/v1/vector/upsert/${FLOW}`

    it('no key or a wrong key is 401 and writes nothing', async () => {
        const missing = await multipart(url, { 'x-test-user': user(WS, []) })
        expect(missing.status).toBe(401)
        const wrong = await multipart(url, {
            'x-test-user': user(WS, []),
            Authorization: 'Bearer not-the-flow-key'
        })
        expect(wrong.status).toBe(401)
        expectNoWrites()
        expect(vectorCalls).toEqual([])
    })

    it('a valid flow key from another workspace is 401 and writes nothing', async () => {
        const res = await multipart(url, {
            'x-test-user': user(OTHER, []),
            Authorization: `Bearer ${KEY}`
        })
        expect(res.status).toBe(401)
        expect(res.body.message).toBe('Unauthorized')
        expectNoWrites()
        expect(vectorCalls).toEqual([])
    })

    it('internal upsert from another workspace is 401 and writes nothing', async () => {
        const res = await multipart(`/api/v1/vector/internal-upsert/${FLOW}`, { 'x-test-user': user(OTHER, []) })
        expect(res.status).toBe(401)
        expectNoWrites()
        expect(vectorCalls).toEqual([])
    })

    it('a matching workspace and flow key reaches the controller after multer', async () => {
        const res = await multipart(url, {
            'x-test-user': user(WS, []),
            Authorization: `Bearer ${KEY}`
        })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ ok: true })
        expect(mockState.multerWrites).toEqual(['note.txt'])
        expect(vectorCalls).toEqual(['vector'])
    })
})

describe('Document-store upsert access', () => {
    const url = `/api/v1/document-store/upsert/${STORE}`

    it('no user is 401 and writes nothing', async () => {
        const res = await multipart(url)
        expect(res.status).toBe(401)
        expect(res.body.message).toBe('Unauthorized')
        expectNoWrites()
        expect(docCalls).toEqual([])
    })

    it('a user without documentStores:upsert-config is 403 and writes nothing', async () => {
        const res = await multipart(url, { 'x-test-user': user(WS, ['documentStores:view']) })
        expect(res.status).toBe(403)
        expect(res.body.message).toBe('Forbidden')
        expectNoWrites()
        expect(docCalls).toEqual([])
    })

    it('a store in another workspace is 401 and writes nothing', async () => {
        mockDb.stores.set(STORE, { id: STORE, workspaceId: OTHER })
        const res = await multipart(url, { 'x-test-user': user(WS, ['documentStores:upsert-config']) })
        expect(res.status).toBe(401)
        expect(res.body.message).toBe('Unauthorized')
        expectNoWrites()
        expect(docCalls).toEqual([])
    })

    it('the workspace permission reaches the controller after multer', async () => {
        const res = await multipart(url, { 'x-test-user': user(WS, ['documentStores:upsert-config']) })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ ok: true })
        expect(mockState.multerWrites).toEqual(['note.txt'])
        expect(docCalls).toEqual(['doc'])
    })
})
