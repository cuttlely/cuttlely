/**
 * Charts in a cross-site embed: a chat file (GET /api/v1/get-upload-file) may be read cross-origin by a site that the
 * file's own chatflow lists in its allowed domains, and only for chats the caller owns. Everything else keeps the
 * server-wide CORS setting (CORS_ORIGINS), and a flow with no allowed domains grants nothing new.
 *
 * The real CORS options, router, auth middleware, session ownership and controller run behind supertest, with the app
 * level cors() middleware as in the server. The data source is an in-memory stand-in; storage reads are counted.
 */
import cors from 'cors'
import express from 'express'
import request from 'supertest'

const mockState = { storageReads: [] as string[] }
const mockFlows = new Map<string, any>()

jest.mock('./logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

jest.mock('@cuttlely/components', () => {
    const actual = jest.requireActual('@cuttlely/components')
    return {
        ...actual,
        streamStorageFile: async (chatflowId: string, chatId: string, fileName: string) => {
            mockState.storageReads.push(`${chatflowId}/${chatId}/${fileName}`)
            return Buffer.from(`chart of ${chatflowId}`)
        }
    }
})

jest.mock('../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowById: jest.fn(async (id: string) => {
            const flow = mockFlows.get(id)
            if (!flow) throw new Error(`Chatflow ${id} not found`)
            return flow
        })
    }
}))

jest.mock('./getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: (entity: { name: string }) => ({
                findOneBy: async ({ id }: { id: string }) => {
                    if (entity.name === 'Workspace') return { id, organizationId: 'org-1' }
                    return mockFlows.get(id) ?? null
                },
                findOne: async ({ where }: { where: { id: string } }) => mockFlows.get(where.id) ?? null
            })
        }
    })
}))

// Imported after the mocks.
import getUploadFileRouter from '../routes/get-upload-file'
import errorHandlerMiddleware from '../middlewares/errors'
import { getCorsOptions } from './XSS'
import { isUploadFileReadRequest, uploadFileChatflowId } from './domainValidation'
import {
    configureSessionOwnershipForTests,
    createMemoryGrantStore,
    issueSessionToken,
    resetSessionOwnershipForTests
} from './sessionOwnership'

const SECRET = 'upload-file-cors-secret'
const FLOW = '11111111-1111-4111-8111-111111111111' // lists https://shop.example
const OTHER_FLOW = '22222222-2222-4222-8222-222222222222' // lists https://other.example
const OPEN_FLOW = '33333333-3333-4333-8333-333333333333' // no allowed domains
const CHAT = '44444444-4444-4444-8444-444444444444'
const OTHER_CHAT = '55555555-5555-4555-8555-555555555555'
const OPEN_CHAT = '66666666-6666-4666-8666-666666666666'
const SHOP = 'https://shop.example'
const OTHER_SITE = 'https://other.example'
const EVIL = 'https://evil.example'
const TOKEN_HEADER = 'x-cuttlely-session-token'

const app = express()
app.use(express.json())
app.use(cors(getCorsOptions()))
app.use('/api/v1/get-upload-file', getUploadFileRouter)
app.use(errorHandlerMiddleware)

const flow = (id: string, allowedOrigins?: string[]) => ({
    id,
    workspaceId: 'ws-1',
    isPublic: true,
    chatbotConfig: JSON.stringify(allowedOrigins ? { allowedOrigins } : { title: 'Bakery' })
})
const query = (chatflowId: string, chatId: string) =>
    `/api/v1/get-upload-file?chatflowId=${chatflowId}&chatId=${chatId}&fileName=harness_chart.png`
const token = (chatflowId: string, chatId: string) => issueSessionToken(SECRET, `public:${chatflowId}`, chatflowId, chatId)

const readFile = (path: string, origin: string | undefined, sessionToken?: string) => {
    const req = request(app).get(path)
    if (origin) req.set('Origin', origin)
    if (sessionToken) req.set(TOKEN_HEADER, sessionToken)
    return req
}
const preflight = (path: string, origin: string) =>
    request(app)
        .options(path)
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', TOKEN_HEADER)

const ENV = { ...process.env }

beforeEach(() => {
    process.env = { ...ENV }
    delete process.env.CORS_ORIGINS
    delete process.env.CORS_ALLOW_CREDENTIALS
    configureSessionOwnershipForTests({ grants: createMemoryGrantStore(), secret: SECRET })
    mockState.storageReads = []
    mockFlows.clear()
    mockFlows.set(FLOW, flow(FLOW, [SHOP]))
    mockFlows.set(OTHER_FLOW, flow(OTHER_FLOW, [OTHER_SITE]))
    mockFlows.set(OPEN_FLOW, flow(OPEN_FLOW))
})

afterAll(() => {
    process.env = ENV
    resetSessionOwnershipForTests()
})

describe('chat files for cross-site embeds follow the chatflow allowed domains', () => {
    it("a site the file's chatflow lists passes the preflight and reads the chart of a chat it owns", async () => {
        const pre = await preflight(query(FLOW, CHAT), SHOP)
        expect(pre.status).toBe(204)
        expect(pre.headers['access-control-allow-origin']).toBe(SHOP)
        expect(String(pre.headers['access-control-allow-headers']).toLowerCase()).toContain(TOKEN_HEADER)

        const res = await readFile(query(FLOW, CHAT), SHOP, token(FLOW, CHAT))
        expect(res.status).toBe(200)
        expect(res.headers['access-control-allow-origin']).toBe(SHOP)
        expect(String(res.headers.vary)).toContain('Origin')
        expect(Buffer.from(res.body).toString()).toBe(`chart of ${FLOW}`)
        expect(mockState.storageReads).toEqual([`${FLOW}/${CHAT}/harness_chart.png`])
    })

    it('a site the chatflow does not list gets no CORS allowance (the browser blocks the read)', async () => {
        for (const origin of [EVIL, OTHER_SITE, 'http://shop.example.evil.test', 'null']) {
            const pre = await preflight(query(FLOW, CHAT), origin)
            expect(pre.headers['access-control-allow-origin']).toBeUndefined()
            const res = await readFile(query(FLOW, CHAT), origin, token(FLOW, CHAT))
            expect(res.headers['access-control-allow-origin']).toBeUndefined()
        }
    })

    it("another chatflow's files are not opened to a site only this chatflow lists", async () => {
        const pre = await preflight(query(OTHER_FLOW, OTHER_CHAT), SHOP)
        expect(pre.headers['access-control-allow-origin']).toBeUndefined()
        const res = await readFile(query(OTHER_FLOW, OTHER_CHAT), SHOP, token(OTHER_FLOW, OTHER_CHAT))
        expect(res.headers['access-control-allow-origin']).toBeUndefined()
    })

    it("a listed site still can't read a chat it does not own: 403 and storage is not read", async () => {
        // No token, or the token of another flow's chat, for this flow's chat id.
        for (const sessionToken of [undefined, token(OTHER_FLOW, OTHER_CHAT)]) {
            const res = await readFile(query(FLOW, CHAT), SHOP, sessionToken)
            expect(res.status).toBe(403)
        }
        // A token for one chat of this flow does not open another chat of it.
        const res = await readFile(query(FLOW, OTHER_CHAT), SHOP, token(FLOW, CHAT))
        expect(res.status).toBe(403)
        expect(mockState.storageReads).toEqual([])
    })

    it('a chatflow with no allowed domains opens nothing new: the server-wide setting decides, as before', async () => {
        const res = await readFile(query(OPEN_FLOW, OPEN_CHAT), SHOP, token(OPEN_FLOW, OPEN_CHAT))
        expect(res.status).toBe(200)
        expect(res.headers['access-control-allow-origin']).toBeUndefined()

        // An emptied list (first entry blank) is the same as none.
        mockFlows.set(OPEN_FLOW, flow(OPEN_FLOW, ['']))
        expect((await preflight(query(OPEN_FLOW, OPEN_CHAT), SHOP)).headers['access-control-allow-origin']).toBeUndefined()

        process.env.CORS_ORIGINS = SHOP
        const listed = await readFile(query(OPEN_FLOW, OPEN_CHAT), SHOP, token(OPEN_FLOW, OPEN_CHAT))
        expect(listed.headers['access-control-allow-origin']).toBe(SHOP)

        process.env.CORS_ORIGINS = '*'
        const wildcard = await readFile(query(OPEN_FLOW, OPEN_CHAT), EVIL, token(OPEN_FLOW, OPEN_CHAT))
        expect(wildcard.headers['access-control-allow-origin']).toBe(EVIL)
    })

    it("the query can't borrow another flow's allowance: two chatflowIds, or a prediction path in the query", async () => {
        const twoIds = `${query(OTHER_FLOW, OTHER_CHAT)}&chatflowId=${FLOW}`
        expect((await preflight(twoIds, SHOP)).headers['access-control-allow-origin']).toBeUndefined()
        // Before this change a `/prediction/<open flow>` anywhere in the URL put the request under the prediction rule.
        const borrowed = `${query(OTHER_FLOW, OTHER_CHAT)}&x=/prediction/${OPEN_FLOW}`
        expect((await preflight(borrowed, EVIL)).headers['access-control-allow-origin']).toBeUndefined()
        const unknown = query('77777777-7777-4777-8777-777777777777', CHAT)
        expect((await preflight(unknown, SHOP)).headers['access-control-allow-origin']).toBeUndefined()
    })

    it('a request with no Origin (same site, server to server) is unchanged', async () => {
        const res = await readFile(query(FLOW, CHAT), undefined, token(FLOW, CHAT))
        expect(res.status).toBe(200)
        expect(mockState.storageReads).toEqual([`${FLOW}/${CHAT}/harness_chart.png`])
    })
})

describe('chat file route helpers', () => {
    it('match the route by path only', () => {
        expect(isUploadFileReadRequest('/api/v1/get-upload-file?chatflowId=x')).toBe(true)
        expect(isUploadFileReadRequest('/api/v1/Get-Upload-File/')).toBe(true)
        expect(isUploadFileReadRequest('/api/v1/prediction/x?u=/api/v1/get-upload-file')).toBe(false)
        expect(isUploadFileReadRequest('/api/v1/get-upload-files')).toBe(false)
    })

    it('take exactly one UUID chatflowId from the query', () => {
        expect(uploadFileChatflowId(query(FLOW, CHAT))).toBe(FLOW)
        expect(uploadFileChatflowId(`${query(FLOW, CHAT)}&chatflowId=${OTHER_FLOW}`)).toBeNull()
        expect(uploadFileChatflowId('/api/v1/get-upload-file?chatflowId=../x')).toBeNull()
        expect(uploadFileChatflowId('/api/v1/get-upload-file')).toBeNull()
    })
})
