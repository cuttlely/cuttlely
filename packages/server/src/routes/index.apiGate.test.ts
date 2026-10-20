/**
 * The real /api/v1 gate, with the URL decoding in front of it, before the real API router: an API key is
 * refused on every path the router serves for a refused prefix, and the public list matches only the
 * paths and methods the router serves for each public entry.
 */
import express, { Request, Response } from 'express'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { apiV1Auth } from '../identity/apiGate'
import { API_KEY_BLACKLIST_URLS, READ_ONLY_WHITELIST_URLS, WHITELIST_URLS } from '../utils/constants'

const reached = (name: string) => jest.fn((req: Request, res: Response) => res.status(200).json({ reached: name, user: req.user ?? null }))

const mockNim = { preload: reached('nim.preload'), listRunningContainers: reached('nim.list'), stopContainer: reached('nim.stop') }
const mockChatflows = {
    getSinglePublicChatbotConfig: reached('public-chatbotConfig'),
    getChatflowByApiKey: reached('chatflows.apikey'),
    getChatflowById: reached('chatflows.byId'),
    saveChatflow: reached('chatflows.save'),
    updateChatflow: reached('chatflows.update')
}
const mockGetAllNodes = reached('nodes.list')

jest.mock('../controllers/nvidia-nim', () => {
    const actual = jest.requireActual('../controllers/nvidia-nim').default
    return { __esModule: true, default: { ...actual, ...mockNim } }
})
jest.mock('../controllers/chatflows', () => {
    const actual = jest.requireActual('../controllers/chatflows').default
    return { __esModule: true, default: { ...actual, ...mockChatflows } }
})
jest.mock('../controllers/nodes', () => {
    const actual = jest.requireActual('../controllers/nodes').default
    return { __esModule: true, default: { ...actual, getAllNodes: mockGetAllNodes } }
})

import apiRouter from './index'
import { sanitizeMiddleware } from '../utils/XSS'

jest.setTimeout(60_000)

function dataSource() {
    return {
        getRepository(entity: { name?: string }) {
            return {
                findOne: async () => {
                    if (entity?.name === 'Workspace') return { id: 'ws-1', name: 'Team', organizationId: 'org-1' }
                    if (entity?.name === 'Organization') return { id: 'org-1', subscriptionId: 'sub-1', customerId: 'cus-1' }
                    return null
                }
            }
        }
    } as unknown as DataSource
}

const sessionUser = { permissions: ['chatflows:view'], activeOrganizationId: 'org-1', activeWorkspaceId: 'ws-1' }

function app() {
    const server = express()
    server.use(sanitizeMiddleware)
    server.use(
        apiV1Auth({
            whitelistURLs: WHITELIST_URLS,
            readOnlyWhitelistURLs: READ_ONLY_WHITELIST_URLS,
            apiKeyBlacklistURLs: API_KEY_BLACKLIST_URLS,
            licenseRequired: () => false,
            dataSource: dataSource(),
            validateAPIKey: async (req) =>
                req.headers.authorization === 'Bearer no-permission-key'
                    ? { isValid: true, apiKey: { id: 'key-0', workspaceId: 'ws-1', permissions: [] } }
                    : req.headers.authorization === 'Bearer viewer-key'
                    ? { isValid: true, apiKey: { id: 'key-1', workspaceId: 'ws-1', permissions: ['chatflows:view'] } }
                    : { isValid: false },
            attachIdentitySession: async (req) => (req.headers.cookie?.includes('cuttlely-local-session=ok') ? sessionUser : null)
        })
    )
    server.use('/api/v1', apiRouter)
    server.use((_req, res) => res.status(404).json({ reached: 'none' }))
    return request(server)
}

const allControllers = () => [...Object.values(mockNim), ...Object.values(mockChatflows), mockGetAllNodes]

const nimSpellings: Array<['get' | 'post', string, string]> = [
    ['get', '/api/v1//nvidia-nim/preload', 'nim.preload'],
    ['get', '/api/v1//nvidia-nim/list-running-containers', 'nim.list'],
    ['get', '/api/v1/NVIDIA-NIM/preload', 'nim.preload'],
    ['get', '/api/v1/%6Evidia-nim/preload', 'nim.preload'],
    ['post', '/api/v1//nvidia-nim//stop-container', 'nim.stop']
]

describe('API key gate on the real API router', () => {
    beforeEach(() => allControllers().forEach((handler) => handler.mockClear()))

    it.each(nimSpellings)('refuses a no-permission API key on %s %s before the router', async (method, path) => {
        const res = await app()[method](path).set('Authorization', 'Bearer no-permission-key')
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'Unauthorized Access' })
        for (const handler of allControllers()) expect(handler).not.toHaveBeenCalled()
    })

    it('reaches the nvidia-nim router on each of those spellings without the gate', async () => {
        const server = express()
        server.use(sanitizeMiddleware)
        server.use('/api/v1', apiRouter)
        for (const [method, path, name] of nimSpellings) {
            expect({ path, reached: (await request(server)[method](path)).body.reached }).toEqual({ path, reached: name })
        }
    })

    it('does not treat a non-ASCII letter that lowercases to an ASCII one as part of a public entry', async () => {
        const res = await app().get('/api/v1/chatflows/api%E2%84%AAey/')
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'Unauthorized Access' })
        for (const handler of allControllers()) expect(handler).not.toHaveBeenCalled()
    })

    it('keeps the chatflow API-key lookup public for GET only', async () => {
        const read = await app().get('/api/v1/chatflows/apikey/').set('Authorization', 'Bearer some-key')
        expect(read.status).toBe(200)
        expect(read.body.reached).toBe('chatflows.apikey')
        for (const method of ['post', 'put', 'delete'] as const) {
            for (const path of ['/api/v1/chatflows/apikey', '/api/v1/chatflows/apikey/']) {
                const res = await app()[method](path)
                // The gate's body, not the route permission check's ({ message: 'Unauthorized' }).
                expect({ method, path, status: res.status, body: res.body }).toEqual({
                    method,
                    path,
                    status: 401,
                    body: { error: 'Unauthorized Access' }
                })
            }
        }
        for (const handler of [mockChatflows.saveChatflow, mockChatflows.updateChatflow]) expect(handler).not.toHaveBeenCalled()
    })

    it('still serves a permitted API key route', async () => {
        const res = await app().get('/api/v1/nodes').set('Authorization', 'Bearer viewer-key')
        expect(res.status).toBe(200)
        expect(res.body.reached).toBe('nodes.list')
        expect(res.body.user.apiKeyId).toBe('key-1')
    })

    it('still refuses an unknown API key', async () => {
        const res = await app().get('/api/v1/nodes').set('Authorization', 'Bearer wrong-key')
        expect(res.status).toBe(401)
        expect(mockGetAllNodes).not.toHaveBeenCalled()
    })

    it('still serves a public path written with capitals, with no credentials', async () => {
        const res = await app().get('/api/v1/public-chatbotConfig/flow-1')
        expect(res.status).toBe(200)
        expect(res.body.reached).toBe('public-chatbotConfig')
    })

    it('still lets a session reach a refused prefix, in any spelling', async () => {
        for (const path of ['/api/v1/nvidia-nim/preload', '/api/v1//NVIDIA-NIM/preload']) {
            const res = await app().get(path).set('Cookie', 'cuttlely-local-session=ok')
            expect(res.status).toBe(200)
            expect(res.body.reached).toBe('nim.preload')
        }
    })

    it('still answers 401 for a mixed-case /API/V1/ path', async () => {
        const res = await app().get('/API/V1/nvidia-nim/preload').set('Authorization', 'Bearer viewer-key')
        expect(res.status).toBe(401)
        expect(mockNim.preload).not.toHaveBeenCalled()
    })

    it('keeps the Orchestrate prefix public so the route answers, not the session gate', async () => {
        const res = await app()
            .post('/api/v1/orchestrate/11111111-1111-4111-8111-111111111111')
            .set('Content-Type', 'application/json')
            .send({ messages: [{ role: 'user', content: 'Hi' }] })
        expect(res.body).not.toEqual({ error: 'Unauthorized Access' })
        expect(res.body.error).toEqual(expect.objectContaining({ code: expect.any(String) }))
    })

    it('keeps the A2A prefix public so the route answers, not the session gate', async () => {
        const res = await app()
            .post('/api/v1/a2a/11111111-1111-4111-8111-111111111111')
            .set('Content-Type', 'application/json')
            .send({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message' } } })
        expect(res.body).not.toEqual({ error: 'Unauthorized Access' })
    })
})
