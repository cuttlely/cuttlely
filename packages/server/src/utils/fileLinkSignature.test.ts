/**
 * Signed file links: a file an Agent writes into its answer on a key-protected flow opens from the link alone, for
 * 15 minutes, for that one file in that chat of that flow, in that flow's organization. Expired, changed, wrong-flow
 * or wrong-organization links fall back to the flow's key or a session, so nothing that was refused before is opened.
 *
 * The real router, auth middleware, session ownership and controller run behind supertest; the data source and the
 * API key service are in-memory stand-ins and storage reads are counted.
 */
import express from 'express'
import request from 'supertest'
import { generateSecretHash } from './apiKey'

const mockState = { storageReads: [] as string[] }
const mockFlows = new Map<string, any>()
// Workspace id -> organization id.
const mockWorkspaceOrgs = new Map<string, string>([
    ['ws-1', 'org-1'],
    ['ws-2', 'org-2']
])
const mockApiKeys = new Map<string, { id: string; workspaceId: string; apiSecret: string }>()

jest.mock('./logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

jest.mock('@cuttlely/components', () => {
    const actual = jest.requireActual('@cuttlely/components')
    return {
        ...actual,
        streamStorageFile: async (chatflowId: string, chatId: string, fileName: string) => {
            mockState.storageReads.push(`${chatflowId}/${chatId}/${fileName}`)
            return Buffer.from('weekly croissant orders')
        }
    }
})

jest.mock('../services/apikey', () => ({
    __esModule: true,
    default: { getApiKeyById: jest.fn(async (id: string) => mockApiKeys.get(id) ?? null) }
}))

jest.mock('./getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: (entity: { name: string }) => ({
                findOneBy: async ({ id }: { id: string }) => {
                    if (entity.name === 'Workspace')
                        return mockWorkspaceOrgs.has(id) ? { id, organizationId: mockWorkspaceOrgs.get(id) } : null
                    return mockFlows.get(id) ?? null
                }
            })
        }
    })
}))

// Imported after the mocks.
import getUploadFileRouter from '../routes/get-upload-file'
import errorHandlerMiddleware from '../middlewares/errors'
import getUploadFileController from '../controllers/get-upload-file'
import { configureSessionOwnershipForTests, createMemoryGrantStore, resetSessionOwnershipForTests } from './sessionOwnership'
import { FILE_LINK_TTL_SECONDS, fileDownloadUrl, setFileLinkSecretForTests, signFileLink, verifyFileLink } from './fileLinkSignature'

const FLOW = '11111111-1111-4111-8111-111111111111' // key-protected
const OTHER_FLOW = '22222222-2222-4222-8222-222222222222' // key-protected, same workspace
const OTHER_ORG_FLOW = '33333333-3333-4333-8333-333333333333' // key-protected, a workspace in another organization
const CHAT = '44444444-4444-4444-8444-444444444444'
const OTHER_CHAT = '55555555-5555-4555-8555-555555555555'
const FILE = 'croissant-orders.csv'
const KEY = 'bakery-flow-key-0123456789abcdef'
const BASE = 'https://cuttlely.example'
const target = { orgId: 'org-1', chatflowId: FLOW, chatId: CHAT, fileName: FILE }
// What the address carries (the organization is signed, not sent).
const query = { chatflowId: FLOW, chatId: CHAT, fileName: FILE }

const app = express()
app.use('/api/v1/get-upload-file', getUploadFileRouter)
app.use(errorHandlerMiddleware)

const pathOf = (url: string) => url.slice(BASE.length)
const withQuery = (base: Record<string, string>, extra: Record<string, string> = {}) =>
    `/api/v1/get-upload-file?${new URLSearchParams({ ...base, ...extra }).toString()}`

beforeEach(() => {
    setFileLinkSecretForTests('file-link-test-secret')
    configureSessionOwnershipForTests({ grants: createMemoryGrantStore(), secret: 'ownership-test-secret' })
    mockState.storageReads = []
    mockFlows.clear()
    mockApiKeys.clear()
    mockApiKeys.set('apikey-1', { id: 'apikey-1', workspaceId: 'ws-1', apiSecret: generateSecretHash(KEY) })
    mockFlows.set(FLOW, { id: FLOW, workspaceId: 'ws-1', apikeyid: 'apikey-1', chatbotConfig: '{}' })
    mockFlows.set(OTHER_FLOW, { id: OTHER_FLOW, workspaceId: 'ws-1', apikeyid: 'apikey-1', chatbotConfig: '{}' })
    mockFlows.set(OTHER_ORG_FLOW, { id: OTHER_ORG_FLOW, workspaceId: 'ws-2', apikeyid: 'apikey-1', chatbotConfig: '{}' })
})

afterAll(() => {
    setFileLinkSecretForTests(undefined)
    resetSessionOwnershipForTests()
})

describe('signing and checking a file link', () => {
    const now = Date.UTC(2026, 9, 10, 15, 0, 0)

    it('a fresh link is valid for exactly that organization, flow, chat and file', () => {
        const signed = signFileLink(target, now)!
        expect(signed.expires).toBe(Math.floor(now / 1000) + FILE_LINK_TTL_SECONDS)
        expect(verifyFileLink(target, String(signed.expires), signed.signature, now)).toBe('valid')
    })

    it('expires after 15 minutes', () => {
        const signed = signFileLink(target, now)!
        expect(verifyFileLink(target, String(signed.expires), signed.signature, now + FILE_LINK_TTL_SECONDS * 1000 - 1)).toBe('valid')
        expect(verifyFileLink(target, String(signed.expires), signed.signature, now + FILE_LINK_TTL_SECONDS * 1000)).toBe('expired')
    })

    it('any changed field or a changed expiry fails', () => {
        const signed = signFileLink(target, now)!
        const e = String(signed.expires)
        expect(verifyFileLink({ ...target, orgId: 'org-2' }, e, signed.signature, now)).toBe('invalid')
        expect(verifyFileLink({ ...target, chatflowId: OTHER_FLOW }, e, signed.signature, now)).toBe('invalid')
        expect(verifyFileLink({ ...target, chatId: OTHER_CHAT }, e, signed.signature, now)).toBe('invalid')
        expect(verifyFileLink({ ...target, fileName: 'other.csv' }, e, signed.signature, now)).toBe('invalid')
        expect(verifyFileLink(target, String(signed.expires + 3600), signed.signature, now)).toBe('invalid')
        const flipped = (signed.signature[0] === 'A' ? 'B' : 'A') + signed.signature.slice(1)
        expect(verifyFileLink(target, e, flipped, now)).toBe('invalid')
        expect(verifyFileLink(target, e, signed.signature + 'A', now)).toBe('invalid')
    })

    it('a link signed with another server secret fails', () => {
        const signed = signFileLink(target, now)!
        setFileLinkSecretForTests('another-server-secret')
        expect(verifyFileLink(target, String(signed.expires), signed.signature, now)).toBe('invalid')
    })

    it('missing or malformed parameters are not a signature', () => {
        expect(verifyFileLink(target, undefined, undefined, now)).toBe('missing')
        expect(verifyFileLink(target, ['1', '2'], 'abc', now)).toBe('missing')
        expect(verifyFileLink(target, '12x', 'abc', now)).toBe('invalid')
        expect(verifyFileLink({ orgId: 'org-1', chatflowId: FLOW, chatId: CHAT }, '1', 'abc', now)).toBe('invalid')
        expect(verifyFileLink(query, '1', 'abc', now)).toBe('invalid')
    })

    it('the download address carries the expiry and signature, URL-encoded', () => {
        const url = new URL(fileDownloadUrl(BASE, { ...target, fileName: 'orders & notes.csv' }, now))
        expect(url.pathname).toBe('/api/v1/get-upload-file')
        expect(url.searchParams.get('fileName')).toBe('orders & notes.csv')
        expect(url.searchParams.get('download')).toBe('true')
        expect(url.searchParams.has('orgId')).toBe(false)
        expect(
            verifyFileLink(
                { ...target, fileName: 'orders & notes.csv' },
                url.searchParams.get('expires') ?? undefined,
                url.searchParams.get('signature') ?? undefined,
                now
            )
        ).toBe('valid')
    })
})

describe('GET /api/v1/get-upload-file with a signed link on a key-protected flow', () => {
    it('a valid signed link opens the file without the key or a session', async () => {
        const res = await request(app).get(pathOf(fileDownloadUrl(BASE, target)))
        expect(res.status).toBe(200)
        expect(res.headers['content-disposition']).toContain('attachment')
        expect(mockState.storageReads).toEqual([`${FLOW}/${CHAT}/${FILE}`])
    })

    it('without a signature it is still 401, as before', async () => {
        const res = await request(app).get(withQuery(query))
        expect(res.status).toBe(401)
        expect(mockState.storageReads).toEqual([])
    })

    it('an expired link is 401', async () => {
        const signed = signFileLink(target, Date.now() - (FILE_LINK_TTL_SECONDS + 60) * 1000)!
        const res = await request(app).get(withQuery(query, { expires: String(signed.expires), signature: signed.signature }))
        expect(res.status).toBe(401)
        expect(mockState.storageReads).toEqual([])
    })

    it('a tampered link is 401: another file, another chat, or a longer expiry', async () => {
        const signed = signFileLink(target)!
        const params = { expires: String(signed.expires), signature: signed.signature }
        for (const path of [
            withQuery({ ...query, fileName: 'payroll.csv' }, params),
            withQuery({ ...query, chatId: OTHER_CHAT }, params),
            withQuery(query, { ...params, expires: String(signed.expires + 86400) }),
            withQuery(query, { ...params, signature: signed.signature.slice(0, -2) + 'xx' })
        ]) {
            const res = await request(app).get(path)
            expect(res.status).toBe(401)
        }
        expect(mockState.storageReads).toEqual([])
    })

    it("a link for one flow does not open another flow's file", async () => {
        const signed = signFileLink(target)!
        const res = await request(app).get(
            withQuery({ ...query, chatflowId: OTHER_FLOW }, { expires: String(signed.expires), signature: signed.signature })
        )
        expect(res.status).toBe(401)
        expect(mockState.storageReads).toEqual([])
    })

    it("a link signed for another organization does not open the flow's file", async () => {
        // Signed as if the flow were in org-1; the flow's workspace is in org-2.
        const signed = signFileLink({ ...target, chatflowId: OTHER_ORG_FLOW })!
        const res = await request(app).get(
            withQuery({ ...query, chatflowId: OTHER_ORG_FLOW }, { expires: String(signed.expires), signature: signed.signature })
        )
        expect(res.status).toBe(401)
        expect(mockState.storageReads).toEqual([])
        // The same link signed for the right organization opens it.
        const right = signFileLink({ ...target, orgId: 'org-2', chatflowId: OTHER_ORG_FLOW })!
        const ok = await request(app).get(
            withQuery({ ...query, chatflowId: OTHER_ORG_FLOW }, { expires: String(right.expires), signature: right.signature })
        )
        expect(ok.status).toBe(200)
    })

    it('a flow whose workspace is gone accepts no signature', async () => {
        mockFlows.set(FLOW, { ...mockFlows.get(FLOW), workspaceId: 'ws-missing' })
        const res = await request(app).get(pathOf(fileDownloadUrl(BASE, target)))
        expect(res.status).toBe(401)
        expect(mockState.storageReads).toEqual([])
    })

    it('the flow key still works with a bad signature (falls back to the usual check)', async () => {
        const res = await request(app)
            .get(withQuery(query, { expires: '1', signature: 'not-a-signature' }))
            .set('Authorization', `Bearer ${KEY}`)
        // The key passes flow access; the chat id is then checked against the caller's session, as before.
        expect(res.status).toBe(403)
        expect(mockState.storageReads).toEqual([])
    })

    it('a repeated chatflowId, chatId or fileName is refused, signed or not, and nothing is read', async () => {
        const signed = signFileLink(target)!
        const sig = `&expires=${signed.expires}&signature=${encodeURIComponent(signed.signature)}`
        for (const name of ['chatflowId', 'chatId', 'fileName']) {
            const repeated = `${withQuery(query)}&${name}=${encodeURIComponent((query as Record<string, string>)[name])}`
            for (const url of [repeated, repeated + sig]) {
                const res = await request(app).get(url).set('Authorization', `Bearer ${KEY}`)
                expect([400, 401, 403]).toContain(res.status)
            }
        }
        expect(mockState.storageReads).toEqual([])
    })

    it('the file handler itself refuses a repeated parameter with 400 and reads nothing', async () => {
        for (const name of ['chatflowId', 'chatId', 'fileName']) {
            const req = { query: { ...query, [name]: [(query as Record<string, string>)[name], 'x'] } }
            const res = { statusCode: 200, body: '', status: jest.fn(), send: jest.fn(), setHeader: jest.fn() }
            res.status.mockImplementation((code: number) => ((res.statusCode = code), res))
            res.send.mockImplementation((body: string) => ((res.body = body), res))
            const next = jest.fn()
            await getUploadFileController.streamUploadedFile(req as any, res as any, next)
            expect(res.statusCode).toBe(400)
            expect(next).not.toHaveBeenCalled()
        }
        expect(mockState.storageReads).toEqual([])
    })

    it('path characters are refused before the signature is consulted', async () => {
        const evil = { ...target, chatId: '../x' }
        const signed = signFileLink(evil)!
        const res = await request(app).get(
            withQuery({ ...query, chatId: '../x' }, { expires: String(signed.expires), signature: signed.signature })
        )
        expect(res.status).toBe(400)
        expect(mockState.storageReads).toEqual([])
    })

    it('with no server secret, links are plain and nothing is accepted as signed', async () => {
        setFileLinkSecretForTests(undefined)
        const prior = process.env.TOKEN_HASH_SECRET
        const priorPath = process.env.SECRETKEY_PATH
        delete process.env.TOKEN_HASH_SECRET
        process.env.SECRETKEY_PATH = '/nonexistent-cuttlely-secret-dir'
        try {
            expect(signFileLink(target)).toBeUndefined()
            expect(fileDownloadUrl(BASE, target)).not.toContain('signature=')
            expect(verifyFileLink(target, '9999999999', 'abc')).toBe('invalid')
        } finally {
            if (prior === undefined) delete process.env.TOKEN_HASH_SECRET
            else process.env.TOKEN_HASH_SECRET = prior
            if (priorPath === undefined) delete process.env.SECRETKEY_PATH
            else process.env.SECRETKEY_PATH = priorPath
        }
    })
})
