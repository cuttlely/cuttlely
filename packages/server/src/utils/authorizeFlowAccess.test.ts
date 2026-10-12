/**
 * POST /api/v1/attachments/:chatflowId/:chatId checks the flow's API key (or a session in the
 * flow's workspace) before multer runs. Test numbers follow cuttlely-api4-attachments-auth-spec.md v1.0 section 4.
 *
 * The real attachments route, controller, service and createFileAttachment run behind supertest.
 * Storage spy: getMulterStorage() returns real multer over a counting StorageEngine that writes into a temp dir,
 * and addArrayFilesToStorage is counted too. Parser spy: the fileLoader node's init is counted.
 */
import express, { NextFunction, Request, Response } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { generateSecretHash } from './apiKey'

const mockState = {
    multerWrites: [] as string[],
    storageWrites: [] as string[],
    parserCalls: 0,
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
    return { getMulterStorage: () => multer({ storage }) }
})

jest.mock('@cuttlely/components', () => {
    const actual = jest.requireActual('@cuttlely/components')
    const nodeFs = require('fs')
    return {
        ...actual,
        getFileFromUpload: async (filePath: string) => nodeFs.readFileSync(filePath),
        removeSpecificFileFromUpload: async (filePath: string) => nodeFs.rmSync(filePath, { force: true }),
        removeSpecificFileFromStorage: async () => ({ totalSize: 0 }),
        addArrayFilesToStorage: async (_mime: string, buffer: Buffer, fileName: string, fileNames: string[]) => {
            mockState.storageWrites.push(fileName)
            fileNames.push(fileName)
            return { path: `FILE-STORAGE::${JSON.stringify(fileNames)}`, totalSize: buffer.length }
        }
    }
})

jest.mock('./quotaUsage', () => ({ checkStorage: jest.fn(async () => undefined), updateStorageUsage: jest.fn(async () => undefined) }))

const mockApiKeys = new Map<string, { id: string; workspaceId: string; apiSecret: string }>()
jest.mock('../services/apikey', () => ({
    __esModule: true,
    default: { getApiKeyById: jest.fn(async (id: string) => mockApiKeys.get(id) ?? null) }
}))

const mockDb = { chatflows: new Map<string, any>(), fileLoaderPath: '' }
jest.mock('./getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: (entity: { name: string }) => ({
                findOneBy: async ({ id }: { id: string }) => {
                    if (entity.name === 'ChatFlow') return mockDb.chatflows.get(id) ?? null
                    if (entity.name === 'Workspace') return { id, organizationId: 'org-1' }
                    if (entity.name === 'Organization') return { id, subscriptionId: 'sub-1' }
                    return null
                }
            })
        },
        nodesPool: { componentNodes: { fileLoader: { filePath: mockDb.fileLoaderPath } } },
        usageCacheManager: {}
    })
}))

// Imported after the mocks.
import attachmentsRouter from '../routes/attachments'
import errorHandlerMiddleware from '../middlewares/errors'
import { createFileAttachment } from './createAttachment'
import { authorizeFlowAccess, hasFlowAccess } from './authorizeFlowAccess'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'
const K = '11111111-1111-4111-8111-111111111111'
const K2 = '22222222-2222-4222-8222-222222222222'
const F = '33333333-3333-4333-8333-333333333333'
const MISSING = '44444444-4444-4444-8444-444444444444'
const CHAT = '55555555-5555-4555-8555-555555555555'
const KEY_K = 'key-for-flow-k-0123456789abcdef'
const KEY_K2 = 'key-for-flow-k2-0123456789abcdef'
const KEY_OTHER_WS = 'key-from-other-workspace-0123456789'

const uploadsOn = JSON.stringify({ fullFileUpload: { status: true, allowedUploadFileTypes: 'text/plain' } })

let tmpRoot = ''

// Stands in for the session-cookie middleware: the test header becomes req.user (A0 confirmed live that the
// logged-in UI's cookie fills req.user on this whitelisted route).
const app = express()
app.use((req: Request, _res: Response, next: NextFunction) => {
    const ws = req.headers['x-test-session-workspace']
    if (typeof ws === 'string') {
        ;(req as any).user = { activeWorkspaceId: ws, activeOrganizationId: 'org-1', activeOrganizationSubscriptionId: 'sub-1' }
    }
    next()
})
app.use('/api/v1/attachments', attachmentsRouter)
app.use(errorHandlerMiddleware)

const upload = (flowId: string, headers: Record<string, string> = {}, chatId = CHAT) => {
    const req = request(app).post(`/api/v1/attachments/${flowId}/${chatId}`)
    for (const [name, value] of Object.entries(headers)) req.set(name, value)
    return req.attach('files', Buffer.from('hello attachment'), { filename: 'note.txt', contentType: 'text/plain' })
}

const uploadDirEntries = () => fs.readdirSync(mockState.uploadDir)

const expectNothingWrittenOrParsed = () => {
    expect(mockState.multerWrites).toEqual([])
    expect(mockState.storageWrites).toEqual([])
    expect(mockState.parserCalls).toBe(0)
    expect(uploadDirEntries()).toEqual([])
}

beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'api4-'))
    mockState.uploadDir = path.join(tmpRoot, 'uploads')
    fs.mkdirSync(mockState.uploadDir)
    mockDb.fileLoaderPath = path.join(tmpRoot, 'FileLoader.js')
    fs.writeFileSync(
        mockDb.fileLoaderPath,
        `module.exports.nodeClass = class { async init(nodeData) { global.__api4Parser(nodeData); return [{ pageContent: 'parsed: hello attachment' }] } }\n`
    )
    ;(global as any).__api4Parser = () => (mockState.parserCalls += 1)

    mockApiKeys.set('apikey-k', { id: 'apikey-k', workspaceId: WS, apiSecret: generateSecretHash(KEY_K) })
    mockApiKeys.set('apikey-k2', { id: 'apikey-k2', workspaceId: WS, apiSecret: generateSecretHash(KEY_K2) })
    mockApiKeys.set('apikey-x', { id: 'apikey-x', workspaceId: OTHER_WS, apiSecret: generateSecretHash(KEY_OTHER_WS) })

    mockDb.chatflows.set(K, { id: K, workspaceId: WS, apikeyid: 'apikey-k', chatbotConfig: uploadsOn })
    mockDb.chatflows.set(K2, { id: K2, workspaceId: WS, apikeyid: 'apikey-k2', chatbotConfig: uploadsOn })
    mockDb.chatflows.set(F, { id: F, workspaceId: WS, apikeyid: '', chatbotConfig: uploadsOn })
})

afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    delete (global as any).__api4Parser
})

beforeEach(() => {
    mockState.multerWrites = []
    mockState.storageWrites = []
    mockState.parserCalls = 0
    for (const entry of uploadDirEntries()) fs.rmSync(path.join(mockState.uploadDir, entry), { force: true })
})

describe('Attachment access: attachments route checks the flow key before multer', () => {
    it('1: no key on key-protected flow K -> 401, zero storage writes, zero parser calls', async () => {
        const res = await upload(K)
        expect(res.status).toBe(401)
        expect(res.body.message).toBe('Unauthorized')
        expectNothingWrittenOrParsed()
    })

    it('2: wrong key on K -> 401, zero writes, zero parser calls', async () => {
        const res = await upload(K, { Authorization: 'Bearer not-the-key' })
        expect(res.status).toBe(401)
        expectNothingWrittenOrParsed()
    })

    it("3: another flow's key (K2 on K) and a key from another workspace -> 401, zero writes, zero parser calls", async () => {
        expect((await upload(K, { Authorization: `Bearer ${KEY_K2}` })).status).toBe(401)
        expectNothingWrittenOrParsed()
        expect((await upload(K, { Authorization: `Bearer ${KEY_OTHER_WS}` })).status).toBe(401)
        expectNothingWrittenOrParsed()
        // And a key whose stored record is in another workspace than the flow: refused even when it matches
        mockDb.chatflows.set(K2, { ...mockDb.chatflows.get(K2), apikeyid: 'apikey-x' })
        try {
            expect((await upload(K2, { Authorization: `Bearer ${KEY_OTHER_WS}` })).status).toBe(401)
            expectNothingWrittenOrParsed()
        } finally {
            mockDb.chatflows.set(K2, { ...mockDb.chatflows.get(K2), apikeyid: 'apikey-k2' })
        }
    })

    it('4: malformed Authorization headers on K -> 401', async () => {
        for (const value of [`Basic ${Buffer.from(`user:${KEY_K}`).toString('base64')}`, 'Bearer ', 'Bearer', KEY_K.slice(0, 5)]) {
            const res = await upload(K, { Authorization: value })
            expect(res.status).toBe(401)
        }
        expectNothingWrittenOrParsed()
    })

    it('5: valid key on K -> 200 with the parsed content, exactly one write per file', async () => {
        const res = await upload(K, { Authorization: `Bearer ${KEY_K}` })
        expect(res.status).toBe(200)
        expect(res.body).toEqual([{ name: 'note.txt', mimeType: 'text/plain', size: 16, content: 'parsed: hello attachment' }])
        expect(mockState.multerWrites).toEqual(['note.txt'])
        expect(mockState.storageWrites).toEqual(['note.txt'])
        expect(mockState.parserCalls).toBe(1)

        const two = await request(app)
            .post(`/api/v1/attachments/${K}/${CHAT}`)
            .set('Authorization', `Bearer ${KEY_K}`)
            .attach('files', Buffer.from('one'), { filename: 'a.txt', contentType: 'text/plain' })
            .attach('files', Buffer.from('two'), { filename: 'b.txt', contentType: 'text/plain' })
        expect(two.status).toBe(200)
        expect(mockState.multerWrites).toEqual(['note.txt', 'a.txt', 'b.txt'])
        expect(mockState.storageWrites).toEqual(['note.txt', 'a.txt', 'b.txt'])
    })

    it('6: UI session path - session in K workspace plus x-request-from: internal, no key -> 200', async () => {
        const res = await upload(K, { 'x-test-session-workspace': WS, 'x-request-from': 'internal' })
        expect(res.status).toBe(200)
        expect(res.body[0].content).toBe('parsed: hello attachment')
        expect(mockState.multerWrites).toEqual(['note.txt'])
        expect(mockState.parserCalls).toBe(1)
    })

    it('7: spoofed x-request-from: internal with no session and no key on K -> 401, zero writes', async () => {
        const res = await upload(K, { 'x-request-from': 'internal' })
        expect(res.status).toBe(401)
        expectNothingWrittenOrParsed()
    })

    it('8: session in another workspace with no key on K -> 401', async () => {
        const res = await upload(K, { 'x-test-session-workspace': OTHER_WS, 'x-request-from': 'internal' })
        expect(res.status).toBe(401)
        expectNothingWrittenOrParsed()
    })

    it('9: keyless flow F with no key -> 200, unchanged', async () => {
        const res = await upload(F)
        expect(res.status).toBe(200)
        expect(res.body[0].content).toBe('parsed: hello attachment')
        expect(mockState.multerWrites).toEqual(['note.txt'])
    })

    it('10: invalid UUID or path traversal in the params -> 400 before any write; unknown flow -> 404 before any write', async () => {
        expect((await upload('not-a-uuid')).status).toBe(400)
        expect((await upload(K, { Authorization: `Bearer ${KEY_K}` }, '..%2F..%2Fetc')).status).toBe(400)
        expect((await upload(K, { Authorization: `Bearer ${KEY_K}` }, 'chat..id')).status).toBe(400)
        expect((await upload(MISSING)).status).toBe(404)
        expectNothingWrittenOrParsed()
    })

    it('refuses a document over 25 MB before parsing or storing it', async () => {
        const { MAX_DOCUMENT_UPLOAD_BYTES } = jest.requireActual('@cuttlely/components') as { MAX_DOCUMENT_UPLOAD_BYTES: number }
        const res = await request(app)
            .post(`/api/v1/attachments/${K}/${CHAT}`)
            .set('Authorization', `Bearer ${KEY_K}`)
            .attach('files', Buffer.alloc(MAX_DOCUMENT_UPLOAD_BYTES + 1), { filename: 'big.txt', contentType: 'text/plain' })
        expect(res.status).toBe(400)
        expect(res.body.message).toMatch(/too large/i)
        expect(mockState.storageWrites).toEqual([])
        expect(mockState.parserCalls).toBe(0)
        expect(uploadDirEntries()).toEqual([])
    }, 30000)

    it('11: BLOCKER 3 replay - no key, then wrong key -> 401 both times, the upload directory is unchanged', async () => {
        const before = uploadDirEntries()
        expect((await upload(K)).status).toBe(401)
        expect((await upload(K, { Authorization: 'Bearer wrong-key' })).status).toBe(401)
        expect(uploadDirEntries()).toEqual(before)
        expectNothingWrittenOrParsed()
    })
})

describe('Attachment access: defensive check in createFileAttachment and the reusable helper', () => {
    const directReq = (headers: Record<string, string> = {}, user?: object) =>
        ({ params: { chatflowId: K, chatId: CHAT }, headers, user, body: {}, files: [] } as unknown as Request)

    it('createFileAttachment called without the route middleware still refuses a keyless caller on K with 401', async () => {
        await expect(createFileAttachment(directReq())).rejects.toMatchObject({ statusCode: 401, message: 'Unauthorized' })
        await expect(createFileAttachment(directReq({ authorization: `Bearer ${KEY_K}` }))).resolves.toEqual([])
    })

    it('hasFlowAccess ignores x-request-from: internal and needs a matching workspace or the key', async () => {
        const flow = mockDb.chatflows.get(K)
        expect(await hasFlowAccess(directReq({ 'x-request-from': 'internal' }), flow)).toBe(false)
        expect(await hasFlowAccess(directReq({}, { activeWorkspaceId: WS }), flow)).toBe(true)
        expect(await hasFlowAccess(directReq({}, { activeWorkspaceId: OTHER_WS }), flow)).toBe(false)
        expect(await hasFlowAccess(directReq({ authorization: `Bearer ${KEY_K}` }), flow)).toBe(true)
        // A flow without a workspace never matches a session by accident
        expect(await hasFlowAccess(directReq({}, { activeWorkspaceId: undefined }), { ...flow, workspaceId: undefined })).toBe(false)
    })

    it('authorizeFlowAccess is reusable on other routes (chatflow id from any request field)', async () => {
        const other = express()
        other.get(
            '/feedback/:chatflowId',
            authorizeFlowAccess({ getChatflowId: (req) => req.params.chatflowId }),
            (_req: Request, res: Response) => res.json({ id: res.locals.chatflow.id })
        )
        other.use(errorHandlerMiddleware)
        expect((await request(other).get(`/feedback/${K}`)).status).toBe(401)
        expect((await request(other).get(`/feedback/${K}`).set('Authorization', `Bearer ${KEY_K}`)).body).toEqual({ id: K })
        expect((await request(other).get(`/feedback/${F}`)).body).toEqual({ id: F })
    })
})
