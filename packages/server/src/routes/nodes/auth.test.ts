import express, { Request, Response } from 'express'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { attachIdentitySession } from '../../identity'
import { apiV1Auth } from '../../identity/apiGate'
import { API_KEY_BLACKLIST_URLS, WHITELIST_URLS } from '../../utils/constants'
import { validateAPIKey } from '../../utils/validateKey'
import nodesRouter from './index'

jest.mock('../../services/nodes', () => ({
    __esModule: true,
    default: {
        getAllNodes: jest.fn(async () => [{ name: 'chatOpenAI', label: 'ChatOpenAI' }])
    }
}))

const sessionUser = {
    id: 'user-1',
    email: 'proof@example.com',
    name: 'Proof',
    status: 'active',
    role: 'owner',
    isSSO: false as const,
    activeOrganizationId: 'org-1',
    activeOrganizationSubscriptionId: null,
    activeOrganizationCustomerId: null,
    activeOrganizationProductId: null,
    activeWorkspaceId: 'ws-1',
    activeWorkspace: 'Team',
    lastLogin: null,
    isOrganizationAdmin: true,
    assignedWorkspaces: [{ id: 'ws-1', name: 'Team' }],
    permissions: ['chatflows:view'],
    features: {}
}

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

function app(overrides?: {
    attachIdentitySession?: (req: Request, res: Response) => Promise<object | null>
    validateAPIKey?: (req: Request) => Promise<{ isValid: boolean; apiKey?: { workspaceId?: string; permissions: string[] } }>
}) {
    const server = express()
    server.use(
        apiV1Auth({
            whitelistURLs: WHITELIST_URLS,
            apiKeyBlacklistURLs: API_KEY_BLACKLIST_URLS,
            licenseRequired: () => false,
            dataSource: dataSource(),
            validateAPIKey: overrides?.validateAPIKey ?? validateAPIKey,
            attachIdentitySession: overrides?.attachIdentitySession ?? attachIdentitySession
        })
    )
    server.use('/api/v1/nodes', nodesRouter)
    return request(server)
}

describe('node list and pack index sign-in', () => {
    it('returns 401 for both routes when the request has no session and no API key', async () => {
        const client = app()
        const nodes = await client.get('/api/v1/nodes')
        const index = await client.get('/api/v1/nodes/pack-index')
        expect(nodes.status).toBe(401)
        expect(index.status).toBe(401)
        expect(nodes.body).toEqual({ error: 'Unauthorized Access' })
        expect(index.body).toEqual({ error: 'Unauthorized Access' })
    })

    it('returns 200 for both routes with a valid session', async () => {
        const client = app({
            attachIdentitySession: async (req) => {
                if (req.headers.cookie?.includes('cuttlely-local-session=ok')) return sessionUser
                return null
            }
        })
        const nodes = await client.get('/api/v1/nodes').set('Cookie', 'cuttlely-local-session=ok')
        const index = await client.get('/api/v1/nodes/pack-index').set('Cookie', 'cuttlely-local-session=ok')
        expect(nodes.status).toBe(200)
        expect(nodes.body).toEqual([{ name: 'chatOpenAI', label: 'ChatOpenAI' }])
        expect(index.status).toBe(200)
        expect(Array.isArray(index.body.nodes)).toBe(true)
        expect(index.body.nodes.length).toBeGreaterThan(0)
    })

    it('returns 200 for both routes with a valid API key', async () => {
        const client = app({
            validateAPIKey: async (req) => {
                if (req.headers.authorization === 'Bearer good-key') {
                    return {
                        isValid: true,
                        apiKey: { workspaceId: 'ws-1', permissions: ['chatflows:view'] }
                    }
                }
                return { isValid: false }
            }
        })
        const nodes = await client.get('/api/v1/nodes').set('Authorization', 'Bearer good-key')
        const index = await client.get('/api/v1/nodes/pack-index').set('Authorization', 'Bearer good-key')
        expect(nodes.status).toBe(200)
        expect(nodes.body).toEqual([{ name: 'chatOpenAI', label: 'ChatOpenAI' }])
        expect(index.status).toBe(200)
        expect(Array.isArray(index.body.nodes)).toBe(true)
    })
})
