/**
 * The real /api/v1 gate in front of the real API router: an API key is refused on every path the
 * router serves for a refused prefix, whatever the letter case or repeated slashes.
 */
import express, { Request, Response } from 'express'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { apiV1Auth } from '../identity/apiGate'
import { API_KEY_BLACKLIST_URLS, WHITELIST_URLS } from '../utils/constants'

const reached = (name: string) => jest.fn((req: Request, res: Response) => res.status(200).json({ reached: name, user: req.user ?? null }))

const mockFiles = { getAllFiles: reached('files.list'), deleteFile: reached('files.delete') }
const mockNim = { preload: reached('nim.preload'), listRunningContainers: reached('nim.list'), stopContainer: reached('nim.stop') }
const mockPublicChatbotConfig = reached('public-chatbotConfig')
const mockGetAllNodes = reached('nodes.list')

jest.mock('../controllers/files', () => ({ __esModule: true, default: mockFiles }))
jest.mock('../controllers/nvidia-nim', () => {
    const actual = jest.requireActual('../controllers/nvidia-nim').default
    return { __esModule: true, default: { ...actual, ...mockNim } }
})
jest.mock('../controllers/chatflows', () => {
    const actual = jest.requireActual('../controllers/chatflows').default
    return { __esModule: true, default: { ...actual, getSinglePublicChatbotConfig: mockPublicChatbotConfig } }
})
jest.mock('../controllers/nodes', () => {
    const actual = jest.requireActual('../controllers/nodes').default
    return { __esModule: true, default: { ...actual, getAllNodes: mockGetAllNodes } }
})

import apiRouter from './index'

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
    server.use(
        apiV1Auth({
            whitelistURLs: WHITELIST_URLS,
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

const allControllers = () => [...Object.values(mockFiles), ...Object.values(mockNim), mockPublicChatbotConfig, mockGetAllNodes]

describe('API key gate on the real API router', () => {
    beforeEach(() => allControllers().forEach((handler) => handler.mockClear()))

    const refused: Array<['get' | 'delete' | 'post', string]> = [
        ['get', '/api/v1/files'],
        ['get', '/api/v1/Files'],
        ['get', '/api/v1/FILES'],
        ['get', '/api/v1//files'],
        ['get', '/api/v1//FILES'],
        ['get', '/api/v1///files/'],
        ['delete', '/api/v1/Files?path=a.txt'],
        ['delete', '/api/v1//files?path=a.txt'],
        ['get', '//api/v1/files'],
        ['get', '/api//v1/files'],
        ['get', '/api/v1/nvidia-nim/preload'],
        ['get', '/api/v1//nvidia-nim/preload'],
        ['get', '/api/v1//nvidia-nim/list-running-containers'],
        ['get', '/api/v1/NVIDIA-NIM/preload'],
        ['post', '/api/v1//nvidia-nim//stop-container']
    ]

    it.each(refused)('refuses a no-permission API key on %s %s before the router', async (method, path) => {
        const res = await app()[method](path).set('Authorization', 'Bearer no-permission-key')
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'Unauthorized Access' })
        for (const handler of allControllers()) expect(handler).not.toHaveBeenCalled()
    })

    it('reaches the nvidia-nim router on those paths without the gate, so each path is one the router serves', async () => {
        const server = express()
        server.use('/api/v1', apiRouter)
        for (const path of ['/api/v1//nvidia-nim/preload', '/api/v1/NVIDIA-NIM/preload', '/api/v1//nvidia-nim//preload']) {
            expect((await request(server).get(path)).body.reached).toBe('nim.preload')
        }
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
})
