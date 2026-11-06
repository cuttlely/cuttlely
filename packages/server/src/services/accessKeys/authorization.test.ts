import express, { Request } from 'express'
import request from 'supertest'
import { ApiKey } from '../../database/entities/ApiKey'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { parsePolicy } from './policy'

const mockKeys = new Map<string, ApiKey>()
const mockFlows = new Map<string, any>()
const mockGrants = new Set<string>()
const mockConsume = jest.fn(async () => undefined)
let mockOwnerPermissions: string[] | null = ['chatflows:view', 'chatflows:update']
let mockOwnerStatus = 'active'
jest.mock('../apikey', () => ({ __esModule: true, default: { getApiKey: async (token: string) => mockKeys.get(token) } }))
jest.mock('./limiter', () => ({ consume: (...args: unknown[]) => (mockConsume as any)(...args) }))
jest.mock('./audit', () => ({ recordKeyUse: jest.fn(async () => undefined) }))
jest.mock('./data', () => ({
    accessData: async () => ({
        getRepository: (entity: { name: string }) => ({
            findOneBy: async (where: any) => {
                if (entity.name === 'Workspace') return { id: where.id, organizationId: 'org' }
                if (entity.name === 'Organization') return { id: where.id }
                if (entity.name === 'User') return { id: where.id, status: mockOwnerStatus }
                if (entity.name === 'ApiKeyResource')
                    return mockGrants.has(`${where.principalId}:${where.resourceType}:${where.resourceId}`) ? where : null
                if (entity.name === 'ChatFlow')
                    return [...mockFlows.values()].find((f) => Object.entries(where).every(([k, v]) => f[k] === v)) || null
                return null
            }
        })
    })
}))

import { authorizeFlowKey, authorizeKey, setAccessContext } from './authorization'
import { accessKeyRouteGuard } from './routes'
import { accessKeyPreflight } from './preflight'
import { setTeamPermissionLookup } from '../../identity/rbac'

const FLOW = '11111111-1111-4111-8111-111111111111'
const HARNESS = '22222222-2222-4222-8222-222222222222'
const flow = { id: FLOW, type: 'CHATFLOW', workspaceId: 'one', apiAccessMode: 'private', flowData: '{}' } as ChatFlow
function key(policy: object = {}): ApiKey {
    return {
        id: 'key',
        workspaceId: 'one',
        permissions: ['chatflows:view', 'chatflows:update'],
        accessPolicy: parsePolicy(policy)
    } as ApiKey
}
function req(token = 'fixture-token', body = {}): Request {
    return {
        headers: { authorization: `Bearer ${token}` },
        body,
        originalUrl: '/api/v1/prediction/' + FLOW,
        method: 'POST',
        ip: '192.0.2.4'
    } as Request
}
function grant(id = FLOW, type = 'CHATFLOW', principal = 'key') {
    mockGrants.add(`${principal}:${type}:${id}`)
}
beforeEach(() => {
    mockKeys.clear()
    mockFlows.clear()
    mockGrants.clear()
    mockConsume.mockClear()
    mockOwnerPermissions = ['chatflows:view', 'chatflows:update']
    mockOwnerStatus = 'active'
    mockFlows.set(FLOW, flow)
    setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: mockOwnerPermissions }) })
})
afterEach(() => setTeamPermissionLookup(null))

it('requires both an operation and an exact resource grant; workspace boundaries also constrain grant-all', async () => {
    mockKeys.set('fixture-token', key())
    await expect(authorizeFlowKey(req(), flow)).rejects.toMatchObject({ statusCode: 403 })
    mockKeys.set('fixture-token', key({ scopes: ['predict'] }))
    await expect(authorizeFlowKey(req(), flow)).rejects.toMatchObject({ statusCode: 403 })
    grant()
    expect(await authorizeFlowKey(req(), flow)).toBe(true)
    mockKeys.set('fixture-token', key({ scopes: ['predict'], allResources: true }))
    await expect(authorizeFlowKey(req(), { ...flow, workspaceId: 'other' })).rejects.toMatchObject({ statusCode: 401 })
    expect(mockConsume).toHaveBeenCalledTimes(1)
})
it('accepts many keys for the same resource and refuses a different resource or type', async () => {
    for (const id of ['first', 'second']) {
        mockKeys.set(id, { ...key({ scopes: ['predict'] }), id })
        grant(FLOW, 'CHATFLOW', id)
        expect(await authorizeFlowKey(req(id), flow)).toBe(true)
        await expect(authorizeFlowKey(req(id), { ...flow, type: 'AGENTFLOW' })).rejects.toMatchObject({ statusCode: 403 })
    }
})
it('checks expiry, revoke and the owner’s current workspace membership and permissions', async () => {
    grant()
    const valid = key({ scopes: ['predict'] })
    for (const patch of [{ expiresAt: new Date(Date.now() - 1) }, { disabledAt: new Date() }]) {
        mockKeys.set('fixture-token', { ...valid, ...patch })
        await expect(authorizeFlowKey(req(), flow)).rejects.toMatchObject({ statusCode: 401 })
    }
    mockKeys.set('fixture-token', { ...valid, ownerUserId: 'creator' })
    mockOwnerPermissions = null
    await expect(authorizeFlowKey(req(), flow)).rejects.toMatchObject({ statusCode: 401 })
    mockOwnerPermissions = []
    await expect(authorizeFlowKey(req(), flow)).rejects.toMatchObject({ statusCode: 403 })
    mockOwnerStatus = 'disabled'
    await expect(authorizeFlowKey(req(), flow)).rejects.toMatchObject({ statusCode: 401 })
    expect(mockConsume).not.toHaveBeenCalled()
})
it('requires stream and upload independently, charges an admitted HTTP request once, and shares nested Harness grants', async () => {
    const nested = { ...flow, flowData: JSON.stringify({ nodes: [{ inputs: { harnessName: 'baker' } }] }) }
    mockFlows.set(HARNESS, { id: HARNESS, name: 'baker', type: 'HARNESS', workspaceId: 'one' })
    grant()
    mockKeys.set('fixture-token', key({ scopes: ['predict', 'stream', 'upload', 'harness:run'] }))
    await expect(authorizeFlowKey(req(), nested)).rejects.toMatchObject({ statusCode: 403 })
    grant(HARNESS, 'HARNESS')
    const streaming = req('fixture-token', { streaming: true })
    expect(await authorizeFlowKey(streaming, nested)).toBe(true)
    expect(await authorizeFlowKey(streaming, nested)).toBe(true)
    expect(mockConsume).toHaveBeenCalledTimes(1)
    mockKeys.set('fixture-token', key({ scopes: ['predict'] }))
    await expect(authorizeFlowKey(req('fixture-token', { streaming: true }), flow)).rejects.toMatchObject({ statusCode: 403 })
    const multipart = req()
    multipart.headers['content-type'] = 'multipart/form-data; boundary=fixture'
    await expect(authorizeFlowKey(multipart, flow)).rejects.toMatchObject({ statusCode: 403 })
})
it('refuses caller policies and never trusts forwarded headers directly', async () => {
    grant()
    mockKeys.set(
        'fixture-token',
        key({ scopes: ['predict'], origins: ['https://app.example'], allowNoOrigin: false, ips: ['198.51.100.0/24'] })
    )
    const r = req()
    r.headers.origin = 'https://app.example'
    r.headers['x-forwarded-for'] = '198.51.100.1'
    await expect(authorizeFlowKey(r, flow)).rejects.toMatchObject({ statusCode: 403 })
    expect(mockConsume).not.toHaveBeenCalled()
})
it('rejects unclassified APIs, workspace lists and scoped-key management; registered routes require their own scope', async () => {
    const app = express()
    app.use('/api/v1', accessKeyRouteGuard, (_req, res) => res.json({ ok: true }))
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) =>
        res.status(error.statusCode || 500).json({ message: error.message })
    )
    mockKeys.set('fixture-token', key({ scopes: ['predict'] }))
    grant()
    for (const path of ['nodes', 'apikey', 'chatflows', `chatflows/${FLOW}`])
        expect(
            (
                await request(app)
                    .get('/api/v1/' + path)
                    .set('Authorization', 'Bearer fixture-token')
            ).status
        ).toBe(403)
    mockKeys.set('fixture-token', key({ scopes: ['api:read'] }))
    expect(
        (
            await request(app)
                .get('/api/v1/chatflows/' + FLOW)
                .set('Authorization', 'Bearer fixture-token')
        ).status
    ).toBe(200)
    expect(
        (
            await request(app)
                .put('/api/v1/chatflows/' + FLOW)
                .set('Authorization', 'Bearer fixture-token')
        ).status
    ).toBe(403)
})
it('preflight refuses before JSON parsing and file storage; inactive and malformed credentials cannot create context', async () => {
    const app = express()
    let parsed = 0
    app.use(accessKeyPreflight)
    app.use((_req, _res, next) => {
        parsed++
        next()
    })
    app.use(express.json())
    app.post('/api/v1/prediction/:id', (_req, res) => res.json({ ok: true }))
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    const token = 'ctu_live_fixture-token'
    mockKeys.set(token, key({ scopes: ['predict'] }))
    const response = await request(app)
        .post('/api/v1/prediction/' + FLOW)
        .set('Authorization', 'Bearer ' + token)
        .set('Content-Type', 'application/json')
        .send('{invalid')
    expect(response.status).toBe(403)
    expect(parsed).toBe(0)
    mockKeys.delete(token)
    expect(
        (
            await request(app)
                .post('/api/v1/prediction/' + FLOW)
                .set('Authorization', 'Bearer ' + token)
                .send({})
        ).status
    ).toBe(401)
})
it('does not confuse a signed-in session with an API principal', async () => {
    const r = req()
    setAccessContext(r, key({ scopes: ['predict'] }))
    grant()
    await expect(authorizeKey(r, 'api:read', 'one', { resourceType: 'CHATFLOW', resourceId: FLOW })).rejects.toMatchObject({
        statusCode: 403
    })
})

it('off and shadow preserve legacy integration decisions but never admit new principals', async () => {
    const legacy = { ...key({ scopes: [] }), accessPolicy: { ...parsePolicy({ scopes: [], rpm: 0 }), legacy: true } }
    mockKeys.set('fixture-token', legacy)
    const bound = { ...flow, apikeyid: legacy.id }
    try {
        process.env.INBOUND_ACCESS_V2 = 'off'
        expect(await authorizeFlowKey(req(), bound)).toBe(true)
        mockKeys.set('new', key({ scopes: ['predict'], allResources: true }))
        await expect(authorizeFlowKey(req('new'), bound)).rejects.toMatchObject({ statusCode: 503 })
        process.env.INBOUND_ACCESS_V2 = 'shadow'
        expect(await authorizeFlowKey(req(), bound)).toBe(true)
        expect(mockConsume).not.toHaveBeenCalled()
        process.env.INBOUND_ACCESS_V2 = 'on'
        await expect(authorizeFlowKey(req(), bound)).rejects.toMatchObject({ statusCode: 401 })
    } finally {
        process.env.INBOUND_ACCESS_V2 = 'on'
    }
})
