/**
 * Signed file links (issue #2): a file an Agent writes into its answer on a key-protected flow opens from the link
 * alone, for 15 minutes, for that one file in that chat of that flow. Expired, changed or wrong-flow links fall back
 * to the flow's key or a session, so nothing that was refused before is opened now.
 *
 * The real router, auth middleware, session ownership and controller run behind supertest; the data source and the
 * API key service are in-memory stand-ins and storage reads are counted.
 */
import express from 'express'
import request from 'supertest'
import { generateSecretHash } from './apiKey'

const mockState = { storageReads: [] as string[] }
const mockFlows = new Map<string, any>()
const mockApiKeys = new Map<string, { id: string; workspaceId: string; apiSecret: string }>()

jest.mock('./logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

jest.mock('flowise-components', () => {
    const actual = jest.requireActual('flowise-components')
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
                    if (entity.name === 'Workspace') return { id, organizationId: 'org-1' }
                    return mockFlows.get(id) ?? null
                }
            })
        }
    })
}))

// Imported after the mocks.
import getUploadFileRouter from '../routes/get-upload-file'
import errorHandlerMiddleware from '../middlewares/errors'
import { configureSessionOwnershipForTests, createMemoryGrantStore, resetSessionOwnershipForTests } from './sessionOwnership'
import { FILE_LINK_TTL_SECONDS, fileDownloadUrl, setFileLinkSecretForTests, signFileLink, verifyFileLink } from './fileLinkSignature'

const FLOW = '11111111-1111-4111-8111-111111111111' // key-protected
const OTHER_FLOW = '22222222-2222-4222-8222-222222222222' // key-protected, same workspace
const CHAT = '44444444-4444-4444-8444-444444444444'
const OTHER_CHAT = '55555555-5555-4555-8555-555555555555'
const FILE = 'croissant-orders.csv'
const KEY = 'bakery-flow-key-0123456789abcdef'
const BASE = 'https://cuttlely.example'
const target = { chatflowId: FLOW, chatId: CHAT, fileName: FILE }

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
})

afterAll(() => {
    setFileLinkSecretForTests(undefined)
    resetSessionOwnershipForTests()
})

describe('signing and checking a file link', () => {
    const now = Date.UTC(2026, 9, 10, 15, 0, 0)

    it('a fresh link is valid for exactly that flow, chat and file', () => {
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
        expect(verifyFileLink({ chatflowId: FLOW, chatId: CHAT }, '1', 'abc', now)).toBe('invalid')
    })

    it('the download address carries the expiry and signature, URL-encoded', () => {
        const url = new URL(fileDownloadUrl(BASE, { ...target, fileName: 'orders & notes.csv' }, now))
        expect(url.pathname).toBe('/api/v1/get-upload-file')
        expect(url.searchParams.get('fileName')).toBe('orders & notes.csv')
        expect(url.searchParams.get('download')).toBe('true')
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
        const res = await request(app).get(withQuery(target))
        expect(res.status).toBe(401)
        expect(mockState.storageReads).toEqual([])
    })

    it('an expired link is 401', async () => {
        const signed = signFileLink(target, Date.now() - (FILE_LINK_TTL_SECONDS + 60) * 1000)!
        const res = await request(app).get(withQuery(target, { expires: String(signed.expires), signature: signed.signature }))
        expect(res.status).toBe(401)
        expect(mockState.storageReads).toEqual([])
    })

    it('a tampered link is 401: another file, another chat, or a longer expiry', async () => {
        const signed = signFileLink(target)!
        const params = { expires: String(signed.expires), signature: signed.signature }
        for (const path of [
            withQuery({ ...target, fileName: 'payroll.csv' }, params),
            withQuery({ ...target, chatId: OTHER_CHAT }, params),
            withQuery(target, { ...params, expires: String(signed.expires + 86400) }),
            withQuery(target, { ...params, signature: signed.signature.slice(0, -2) + 'xx' })
        ]) {
            const res = await request(app).get(path)
            expect(res.status).toBe(401)
        }
        expect(mockState.storageReads).toEqual([])
    })

    it("a link for one flow does not open another flow's file", async () => {
        const signed = signFileLink(target)!
        const res = await request(app).get(
            withQuery({ ...target, chatflowId: OTHER_FLOW }, { expires: String(signed.expires), signature: signed.signature })
        )
        expect(res.status).toBe(401)
        expect(mockState.storageReads).toEqual([])
    })

    it('the flow key still works with a bad signature (falls back to the usual check)', async () => {
        const res = await request(app)
            .get(withQuery(target, { expires: '1', signature: 'not-a-signature' }))
            .set('Authorization', `Bearer ${KEY}`)
        // The key passes flow access; the chat id is then checked against the caller's session, as before.
        expect(res.status).toBe(403)
        expect(mockState.storageReads).toEqual([])
    })

    it('path characters are refused before the signature is consulted', async () => {
        const evil = { ...target, chatId: '../x' }
        const signed = signFileLink(evil)!
        const res = await request(app).get(withQuery(evil, { expires: String(signed.expires), signature: signed.signature }))
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
