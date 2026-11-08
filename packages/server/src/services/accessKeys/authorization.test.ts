import express, { Request } from 'express'
import request from 'supertest'
import { ApiKey } from '../../database/entities/ApiKey'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { parsePolicy } from './policy'
import { AccessKeyLimitError } from './errors'

const mockKeys = new Map<string, ApiKey>()
let mockKeyError: Error | undefined
let mockIdentityError: string | undefined
let mockHarnessError: Error | undefined
const mockFlows = new Map<string, any>()
const mockGrants = new Set<string>()
const mockStartReport = jest.fn(async () => ({ runId: 'report-run' }))
let mockPublishedAccount = true
class MockDashFlowError extends Error {
    constructor(readonly status: number, message: string) {
        super(message)
    }
}
const mockDashStore = {
    status: jest.fn(() => ({ refreshing: false })),
    get: jest.fn(() => ({ revision: 1, definition: { harness: 'draft' } })),
    published: jest.fn(() => ({ definition: { harness: 'published' }, snapshot: { accounts: ['account'] } }))
}
jest.mock('../dashflows', () => ({ runtime: async () => ({ dashStore: () => mockDashStore, DashFlowError: MockDashFlowError }) }))
jest.mock('../../routes/dashflows/public', () => ({
    __esModule: true,
    default: require('express').Router(),
    hasPublishedAccount: () => mockPublishedAccount
}))
const mockConsume = jest.fn(async () => undefined)
const mockMetadataUpdate = jest.fn(async (where: any, patch: any) => {
    const row = mockFlows.get(where.id)
    if (row?.workspaceId === where.workspaceId) Object.assign(row, patch)
    return { affected: row ? 1 : 0 }
})
let mockOwnerPermissions: string[] | null = ['chatflows:view', 'chatflows:update']
let mockOwnerStatus = 'active'
jest.mock('../harnesses', () => ({
    __esModule: true,
    default: {
        startBackgroundRun: (...args: unknown[]) => (mockStartReport as any)(...args),
        getHarness: async (name: string) => {
            if (mockHarnessError) throw mockHarnessError
            const row = [...mockFlows.values()].find((flow) => flow.type === 'HARNESS' && flow.name === name)
            return row ? { chatflowId: row.id } : undefined
        }
    }
}))
jest.mock('../apikey', () => ({
    __esModule: true,
    default: {
        getApiKey: async (token: string) => {
            if (mockKeyError) throw mockKeyError
            return mockKeys.get(token)
        }
    }
}))
jest.mock('./limiter', () => ({
    consume: (...args: unknown[]) => (mockConsume as any)(...args),
    assertCapacity: jest.fn(async () => undefined)
}))
jest.mock('./audit', () => ({ recordKeyUse: jest.fn(async () => undefined) }))
jest.mock('./data', () => ({
    accessData: async () => ({
        getRepository: (entity: { name: string }) => ({
            update: mockMetadataUpdate,
            create: (row: any) => row,
            save: async (row: any) => row,
            createQueryBuilder: () => {
                const query: any = { delete: () => query, where: () => query, execute: async () => undefined }
                return query
            },
            findBy: async (where: any) => {
                if (entity.name === 'ChatFlow')
                    return [...mockFlows.values()].filter((row) => Object.entries(where).every(([k, v]) => row[k] === v))
                if (entity.name === 'ApiKeyResource')
                    return [...mockGrants]
                        .map((value) => {
                            const [principalId, resourceType, resourceId] = value.split(':')
                            return { principalId, resourceType, resourceId }
                        })
                        .filter((row: any) => Object.entries(where).every(([k, v]) => row[k] === v))
                return []
            },
            findOneBy: async (where: any) => {
                if (entity.name === mockIdentityError) throw new Error('driver-private-detail')
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

import { accessContext, admitAccessKey, authorizeFlowKey, authorizeKey, flowOperation, setAccessContext } from './authorization'
import { accessKeyRouteGuard } from './routes'
import { accessKeyPreflight } from './preflight'
import { scopedFlowMetadataUpdate } from './managementBoundary'
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
    mockKeyError = undefined
    mockIdentityError = undefined
    mockHarnessError = undefined
    mockFlows.clear()
    mockGrants.clear()
    mockConsume.mockClear()
    mockPublishedAccount = true
    mockMetadataUpdate.mockClear()
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
it('never lets a stale migration grant override a replacement legacy binding', async () => {
    mockKeys.set('fixture-token', {
        ...key({ scopes: ['predict'] }),
        accessPolicy: { ...parsePolicy({ scopes: ['predict'] }), legacy: true }
    })
    grant()
    await expect(authorizeFlowKey(req(), { ...flow, apikeyid: 'replacement-key' })).rejects.toMatchObject({ statusCode: 401 })
    expect(mockConsume).not.toHaveBeenCalled()
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
it('checks multipart stream scope before charging even when the principal retains its legacy bearer value', async () => {
    grant()
    mockKeys.set('fixture-token', key({ scopes: ['predict', 'upload'] }))
    const multipart = req()
    multipart.headers['content-type'] = 'multipart/form-data; boundary=fixture'
    await expect(authorizeFlowKey(multipart, flow)).rejects.toMatchObject({ statusCode: 403 })
    expect(mockConsume).not.toHaveBeenCalled()
})
it.each(['principal permission', 'owner permission', 'legacy owner permission', 'run scope'])(
    'Harness prediction checks target %s before admission or SSE headers',
    async (missing) => {
        const harness: ChatFlow = { ...flow, id: HARNESS, type: 'HARNESS', name: 'baker' }
        mockFlows.set(HARNESS, harness)
        grant(HARNESS, 'HARNESS')
        const principal = key({ scopes: missing === 'run scope' ? ['predict', 'stream'] : ['predict', 'stream', 'harness:run'] })
        principal.permissions = ['chatflows:view']
        if (missing !== 'principal permission') principal.permissions.push('chatflows:create')
        if (missing.includes('owner')) {
            principal.ownerUserId = 'creator'
            mockOwnerPermissions = ['chatflows:view']
        }
        if (missing.startsWith('legacy')) principal.accessPolicy!.legacy = true
        mockKeys.set('fixture-token', principal)
        const execute = jest.fn((_req: Request, res: express.Response) => {
            res.setHeader('Content-Type', 'text/event-stream')
            res.send('data: started\n\n')
        })
        const app = express()
        app.use(express.json())
        app.post(
            '/api/v1/prediction/:id',
            (req, _res, next) => {
                void authorizeFlowKey(req, harness).then(() => next(), next)
            },
            execute
        )
        app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) =>
            res.status(error.statusCode || 500).json({})
        )
        const denied = await request(app)
            .post('/api/v1/prediction/' + HARNESS)
            .set('Authorization', 'Bearer fixture-token')
            .send({ streaming: true })
        expect(denied.status).toBe(403)
        expect(denied.headers['content-type']).not.toContain('text/event-stream')
        expect(execute).not.toHaveBeenCalled()
        expect(mockConsume).not.toHaveBeenCalled()

        principal.permissions = ['chatflows:view', 'chatflows:update']
        principal.accessPolicy!.scopes.push('harness:run')
        mockOwnerPermissions = ['chatflows:view', 'chatflows:update']
        const accepted = await request(app)
            .post('/api/v1/prediction/' + HARNESS)
            .set('Authorization', 'Bearer fixture-token')
            .send({ streaming: true })
        expect(accepted.status).toBe(200)
        expect(accepted.headers['content-type']).toContain('text/event-stream')
        expect(execute).toHaveBeenCalledTimes(1)
        expect(mockConsume).toHaveBeenCalledTimes(1)
    }
)
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
    const token = 'ctu_live_0123456789abcdef_' + 'a'.repeat(43)
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
    mockKeys.set('fixture-token', key({ scopes: ['predict'] }))
    setAccessContext(r, mockKeys.get('fixture-token')!)
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

it('redacts execution transports and keeps canvas, publication and schedule mutations session-only', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/v1', accessKeyRouteGuard, (_req, res) =>
        res.json({
            id: FLOW,
            mcpServerConfig: { token: 'fixture-transport' },
            webhookSecret: 'fixture-signature',
            nested: { mcpServerConfig: 'fixture' }
        })
    )
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) =>
        res.status(error.statusCode || 500).json({ message: error.message })
    )
    mockKeys.set('fixture-token', key({ scopes: ['api:read', 'api:write'] }))
    grant()
    const read = await request(app)
        .get('/api/v1/chatflows/' + FLOW)
        .set('Authorization', 'Bearer fixture-token')
    expect(read.status).toBe(200)
    expect(read.body.mcpServerConfig).toBeUndefined()
    expect(read.body.webhookSecret).toBeUndefined()
    expect(read.body.nested).toEqual({})
    for (const body of [{ mcpServerConfig: '{}' }, { flowData: '{"schedule":true}' }, { apiConfig: '{}' }])
        expect(
            (
                await request(app)
                    .put('/api/v1/chatflows/' + FLOW)
                    .set('Authorization', 'Bearer fixture-token')
                    .send(body)
            ).status
        ).toBe(403)
    for (const path of [`flow-drafts/${FLOW}/publish`, `flow-drafts/${FLOW}/rollback`, `flow-versions/${FLOW}/fixture/restore`])
        expect(
            (
                await request(app)
                    .post('/api/v1/' + path)
                    .set('Authorization', 'Bearer fixture-token')
                    .send({})
            ).status
        ).toBe(403)
    expect(
        (
            await request(app)
                .put('/api/v1/chatflows/' + FLOW)
                .set('Authorization', 'Bearer fixture-token')
                .send({ category: 'Fixture' })
        ).status
    ).toBe(200)
})
it('edits metadata without entering the canvas save path or changing an existing schedule', async () => {
    const canvasSave = jest.fn((_req: Request, res: express.Response) => res.json({ canvas: true }))
    const app = express()
    app.use(express.json())
    app.use('/api/v1', accessKeyRouteGuard)
    app.put('/api/v1/chatflows/:id', scopedFlowMetadataUpdate, canvasSave)
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    mockKeys.set('fixture-token', key({ scopes: ['api:write'] }))
    grant()
    const scheduled = { ...flow, flowData: '{"existingSchedule":true}', mcpServerConfig: '{"enabled":true}' }
    mockFlows.set(FLOW, scheduled)
    const response = await request(app)
        .put('/api/v1/chatflows/' + FLOW)
        .set('Authorization', 'Bearer fixture-token')
        .send({ name: 'Updated name', category: 'Fixture' })
    expect(response.status).toBe(200)
    expect(canvasSave).not.toHaveBeenCalled()
    expect(mockMetadataUpdate).toHaveBeenCalledWith(
        { id: FLOW, workspaceId: 'one', type: 'CHATFLOW' },
        { name: 'Updated name', category: 'Fixture' }
    )
    expect(scheduled.flowData).toBe('{"existingSchedule":true}')
    expect(response.body.mcpServerConfig).toBeUndefined()
})
it('attaches a downstream key identity for whitelisted lead and abort routes', async () => {
    const app = express()
    app.use('/api/v1', accessKeyRouteGuard, (req, res) => res.json({ workspace: req.user?.activeWorkspaceId, key: req.user?.apiKeyId }))
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    mockKeys.set('fixture-token', key({ scopes: ['feedback:read', 'feedback:write'] }))
    grant()
    for (const response of [
        await request(app)
            .get('/api/v1/leads/' + FLOW)
            .set('Authorization', 'Bearer fixture-token'),
        await request(app)
            .put('/api/v1/chatmessage/abort/' + FLOW + '/fixture-chat')
            .set('Authorization', 'Bearer fixture-token')
    ]) {
        expect(response.status).toBe(200)
        expect(response.body).toEqual({ workspace: 'one', key: 'key' })
    }
})
it('keeps legacy non-flow management bound to its own endpoint RBAC rather than unrelated flow permissions', async () => {
    const legacy = {
        ...key({ scopes: ['api:read'] }),
        ownerUserId: 'creator',
        permissions: ['credentials:view'],
        accessPolicy: { ...parsePolicy({ scopes: ['api:read'] }), legacy: true }
    }
    mockOwnerPermissions = ['credentials:view']
    mockKeys.set('fixture-token', legacy)
    await expect(authorizeKey(req(), 'api:read', 'one')).resolves.toMatchObject({ id: 'key', permissions: ['credentials:view'] })
})
it('checks external streaming before admission, even after the adapter clears req.body', async () => {
    mockKeys.set('fixture-token', key({ scopes: ['predict'] }))
    grant()
    for (const external of [{ stream: true }, { method: 'message/stream' }]) {
        const r = req() as Request & { orchestrate?: unknown }
        r.orchestrate = external
        await expect(authorizeFlowKey(r, flow)).rejects.toMatchObject({ statusCode: 403 })
    }
    expect(mockConsume).not.toHaveBeenCalled()
})

it.each([
    { method: 'get', path: '/feedback', scope: 'feedback:read' },
    { method: 'post', path: '/feedback', scope: 'feedback:write' },
    { method: 'post', path: '/attachments/' + FLOW, scope: 'upload' },
    { method: 'get', path: '/get-upload-file', scope: 'upload' },
    { method: 'post', path: '/vector/upsert/' + FLOW, scope: 'upload' }
])('$method $path requires only $scope and its parent grant when the flow references a Harness', async ({ method, path, scope }) => {
    const parent = { ...flow, flowData: JSON.stringify({ nodes: [{ inputs: { harnessName: 'unavailable' } }] }) }
    mockKeys.set('fixture-token', key({ scopes: [scope] }))
    grant()
    const handle = jest.fn((_req: Request, res: express.Response) => res.json({ ok: true }))
    const app = express()
    app.use((req, _res, next) => {
        void authorizeFlowKey(req, parent).then(() => next(), next)
    })
    app.use(handle)
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    const send = () =>
        request(app)
            [method as 'get' | 'post']('/api/v1' + path)
            .set('Authorization', 'Bearer fixture-token')
    expect((await send()).status).toBe(200)
    expect(handle).toHaveBeenCalledTimes(1)
    expect(mockConsume).toHaveBeenCalledTimes(1)
    mockGrants.clear()
    expect((await send()).status).toBe(403)
    grant()
    mockKeys.set('fixture-token', key())
    expect((await send()).status).toBe(403)
    expect(handle).toHaveBeenCalledTimes(1)
    expect(mockConsume).toHaveBeenCalledTimes(1)
})

it('allows Harness status/result access with read scope alone and never turns it into run authority', async () => {
    const { keyHarnessNames } = await import('./resources')
    const reader = key({ scopes: ['harness:read'] })
    mockFlows.set(HARNESS, { id: HARNESS, name: 'baker', type: 'HARNESS', workspaceId: 'one' })
    grant(HARNESS, 'HARNESS')
    expect(await keyHarnessNames(reader, false)).toEqual(['baker'])
    expect(await keyHarnessNames(reader, true)).toEqual([])
})

it.each([null, [], ['other'], ['baker']].map((harnesses) => ({ harnesses })))(
    'preserves the migrated legacy Harness allowlist $harnesses in off/shadow',
    async ({ harnesses }) => {
        const { harnessCallerFor, harnessRefusedFor, setHarnessKeyLookup } = await import('../harnesses/apiAccess')
        const legacy = {
            ...key({ scopes: ['harness:run', 'harness:read'] }),
            accessPolicy: { ...parsePolicy({ scopes: ['harness:run', 'harness:read'] }), legacy: true },
            harnesses
        }
        // Migration derives a grant from apikeyid independently of the original Harness list.
        mockFlows.set(HARNESS, { id: HARNESS, name: 'baker', type: 'HARNESS', workspaceId: 'one', apikeyid: legacy.id })
        grant(HARNESS, 'HARNESS')
        setHarnessKeyLookup(async () => legacy)
        const previous = process.env.INBOUND_ACCESS_V2
        try {
            for (const mode of ['off', 'shadow', 'on']) {
                process.env.INBOUND_ACCESS_V2 = mode
                for (const method of ['POST', 'GET']) {
                    const r = req()
                    r.method = method
                    r.user = { apiKeyId: legacy.id, activeWorkspaceId: 'one' } as Request['user']
                    const caller = await harnessCallerFor(r)
                    expect(caller).toEqual({ via: 'api_key', apiKeyId: legacy.id, harnesses: mode === 'on' ? ['baker'] : harnesses || [] })
                    expect(harnessRefusedFor(caller, ['baker'])).toBe(mode === 'on' || harnesses?.includes('baker') ? null : 'baker')
                }
            }
        } finally {
            setHarnessKeyLookup(null)
            if (previous === undefined) delete process.env.INBOUND_ACCESS_V2
            else process.env.INBOUND_ACCESS_V2 = previous
        }
    }
)

it.each(['credential retired', 'principal revoked', 'principal expired', 'owner disabled', 'owner removed', 'owner permission removed'])(
    'revalidates %s after preflight and before charged execution',
    async (change) => {
        const token = 'ctu_live_0123456789abcdef_' + 'a'.repeat(43)
        mockKeys.set(token, { ...key({ scopes: ['predict'] }), ownerUserId: 'creator' })
        grant()
        const execute = jest.fn((_req: Request, res: express.Response) => res.json({ ok: true }))
        const app = express()
        app.use(accessKeyPreflight)
        // Model a lifecycle change while the body is arriving, after preflight cached authentication.
        app.use((_req, _res, next) => {
            if (change === 'credential retired') mockKeys.delete(token)
            if (change === 'principal revoked') mockKeys.set(token, { ...mockKeys.get(token)!, disabledAt: new Date() })
            if (change === 'principal expired') mockKeys.set(token, { ...mockKeys.get(token)!, expiresAt: new Date(0) })
            if (change === 'owner disabled') mockOwnerStatus = 'disabled'
            if (change === 'owner removed') mockOwnerPermissions = null
            if (change === 'owner permission removed') mockOwnerPermissions = []
            next()
        })
        app.use(express.json())
        app.post(
            '/api/v1/prediction/:id',
            (req, _res, next) => {
                void authorizeFlowKey(req, flow).then(() => next(), next)
            },
            execute
        )
        app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) =>
            res.status(error.statusCode || 500).json({ message: error.message })
        )
        const response = await request(app)
            .post('/api/v1/prediction/' + FLOW)
            .set('Authorization', 'Bearer ' + token)
            .send({ question: 'Hi' })
        expect(response.status).toBe(change === 'owner permission removed' ? 403 : 401)
        expect(execute).not.toHaveBeenCalled()
        expect(mockConsume).not.toHaveBeenCalled()
    }
)

it('keeps admitted operations cached and charges once after a credential is retired', async () => {
    grant()
    mockKeys.set('fixture-token', key({ scopes: ['predict'] }))
    const r = req()
    expect(await authorizeFlowKey(r, flow)).toBe(true)
    mockKeys.delete('fixture-token')
    expect(await authorizeFlowKey(r, flow)).toBe(true)
    expect(mockConsume).toHaveBeenCalledTimes(1)
})

it('authorizes the published Harness for account reports and the editable Harness for refresh', async () => {
    const { bearerDashboardReport } = await import('./dashflowReports')
    const { setHarnessKeyLookup } = await import('../harnesses/apiAccess')
    const published = { id: HARNESS, name: 'published', type: 'HARNESS', workspaceId: 'one' }
    const draft = { ...published, id: '33333333-3333-4333-8333-333333333333', name: 'draft' }
    mockFlows.set(published.id, published)
    mockFlows.set(draft.id, draft)
    const principal = key({ scopes: ['dashflow:report', 'harness:run'] })
    mockKeys.set('fixture-token', principal)
    grant('dashboard', 'DASHFLOW')
    grant(published.id, 'HARNESS')
    mockStartReport.mockClear()
    setHarnessKeyLookup(async () => principal)
    const refresh = jest.fn((_req: Request, res: express.Response) =>
        res.status(202).json({ refreshed: true, revision: res.locals.accessKeyDashboardRevision })
    )
    const app = express()
    app.use('/api/v1', accessKeyRouteGuard)
    app.post('/api/v1/dashflows/:id/accounts/:accountId/report', bearerDashboardReport)
    app.post('/api/v1/dashflows/:id/refresh', refresh)
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) =>
        res.status(error.statusCode || 500).json({ message: error.message })
    )
    const report = () =>
        request(app).post('/api/v1/dashflows/dashboard/accounts/account/report').set('Authorization', 'Bearer fixture-token')
    const refreshRequest = () => request(app).post('/api/v1/dashflows/dashboard/refresh').set('Authorization', 'Bearer fixture-token')
    try {
        expect((await report()).status).toBe(202)
        expect(mockStartReport).toHaveBeenCalledWith(
            'published',
            expect.any(Object),
            expect.objectContaining({ workspaceId: 'one', expectedChatflowId: published.id })
        )
        expect((await refreshRequest()).status).toBe(403)
        expect(refresh).not.toHaveBeenCalled()
        mockGrants.delete(`key:HARNESS:${published.id}`)
        grant(draft.id, 'HARNESS')
        expect((await report()).status).toBe(403)
        expect(mockStartReport).toHaveBeenCalledTimes(1)
        const accepted = await refreshRequest()
        expect(accepted.status).toBe(202)
        expect(accepted.body.revision).toBe(1)
        expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
        setHarnessKeyLookup(null)
    }
})

it.each(['run scope', 'owner run permission'])(
    'rechecks uncharged Harness prerequisites when %s changes before admission',
    async (removed) => {
        const harness: ChatFlow = { ...flow, id: HARNESS, type: 'HARNESS' }
        grant(HARNESS, 'HARNESS')
        const principal = { ...key({ scopes: ['predict', 'harness:run'] }), ownerUserId: 'creator' }
        mockKeys.set('fixture-token', principal)
        const r = req()
        expect(await authorizeFlowKey(r, harness, false)).toBe(true)
        if (removed === 'run scope') mockKeys.set('fixture-token', { ...principal, accessPolicy: parsePolicy({ scopes: ['predict'] }) })
        else mockOwnerPermissions = ['chatflows:view']
        await expect(authorizeFlowKey(r, harness)).rejects.toMatchObject({ statusCode: 403 })
        expect(mockConsume).not.toHaveBeenCalled()
    }
)

it.each(['off', 'shadow'])('keeps every Dashflows operation session-only in %s', async (mode) => {
    const previous = process.env.INBOUND_ACCESS_V2
    const legacy = { ...key(), accessPolicy: { ...parsePolicy({ scopes: ['api:read', 'api:write'] }), legacy: true }, harnesses: [] }
    mockKeys.set('fixture-token', legacy)
    const app = express()
    app.use('/api/v1', accessKeyRouteGuard, (_req, res) => res.json({ reached: true }))
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    try {
        process.env.INBOUND_ACCESS_V2 = mode
        for (const [method, path] of [
            ['get', ''],
            ['post', '/dashboard/publish'],
            ['post', '/dashboard/refresh'],
            ['post', '/dashboard/accounts/account/report']
        ]) {
            const response = await request(app)
                [method as 'get' | 'post']('/api/v1/dashflows' + path)
                .set('Authorization', 'Bearer fixture-token')
            expect(response.status).toBe(403)
        }
        expect(mockConsume).not.toHaveBeenCalled()
    } finally {
        process.env.INBOUND_ACCESS_V2 = previous
    }
})

it.each(['key', 'owner'])('rechecks route RBAC after %s permission removal during body parsing, before charging', async (removed) => {
    const token = 'ctu_live_0123456789abcdef_' + 'a'.repeat(43)
    const principal = {
        ...key({ scopes: ['feedback:write'] }),
        ownerUserId: 'creator',
        permissions: ['chatflows:view', 'chatflows:delete']
    }
    mockKeys.set(token, principal)
    mockOwnerPermissions = principal.permissions.slice()
    grant()
    const execute = jest.fn((_req: Request, res: express.Response) => res.json({ permissions: _req.user?.permissions }))
    const app = express()
    app.use(accessKeyPreflight)
    app.use((req, _res, next) => {
        req.user = { apiKeyId: principal.id, activeWorkspaceId: 'one', permissions: principal.permissions.slice() } as Request['user']
        if (removed === 'owner') mockOwnerPermissions = ['chatflows:view']
        else mockKeys.set(token, { ...principal, permissions: ['chatflows:view'] })
        next()
    })
    app.use(express.json())
    app.use('/api/v1', accessKeyRouteGuard)
    app.delete('/api/v1/chatmessage/:id', admitAccessKey, execute)
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    const response = await request(app)
        .delete('/api/v1/chatmessage/' + FLOW)
        .set('Authorization', 'Bearer ' + token)
        .send({})
    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
    expect(mockConsume).not.toHaveBeenCalled()
})

it('synchronizes downstream API identity after admission refresh', async () => {
    grant()
    mockKeys.set('fixture-token', key({ scopes: ['predict'] }))
    const r = req()
    r.user = { apiKeyId: 'key', activeWorkspaceId: 'one', permissions: ['chatflows:view', 'chatflows:delete'] } as Request['user']
    await authorizeFlowKey(r, flow, false)
    await authorizeFlowKey(r, flow)
    expect(r.user?.permissions).toEqual(['chatflows:view', 'chatflows:update'])
    expect(accessContext(r)?.key.permissions).toEqual(r.user?.permissions)
    expect(mockConsume).toHaveBeenCalledTimes(1)
})

it('does not make a still-bound public flow anonymous when enforcement is enabled', async () => {
    const r = req()
    delete r.headers.authorization
    expect(await authorizeFlowKey(r, { ...flow, apiAccessMode: 'public', apikeyid: 'legacy' })).toBe(false)
    expect(await authorizeFlowKey(r, { ...flow, apiAccessMode: 'public', apikeyid: '' })).toBe(true)
    expect(mockConsume).not.toHaveBeenCalled()
})

it('preserves an authentication-store outage as unavailable rather than an invalid bearer', async () => {
    mockKeyError = new Error('fixture-store-failure')
    await expect(authorizeFlowKey(req(), flow)).rejects.toMatchObject({ statusCode: 503 })
    expect(mockConsume).not.toHaveBeenCalled()
})

it('answers a malformed encoded Harness name as a client error before admission', async () => {
    mockKeys.set('fixture-token', key({ scopes: ['harness:read'] }))
    const app = express()
    app.use('/api/v1', accessKeyRouteGuard, (_req, res) => res.json({}))
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    expect((await request(app).get('/api/v1/harnesses/%ZZ/runs').set('Authorization', 'Bearer fixture-token')).status).toBe(400)
    expect(mockConsume).not.toHaveBeenCalled()
})

it.each(['Workspace', 'Organization', 'User'])('sanitizes %s authentication-store outages before parsing', async (entity) => {
    mockIdentityError = entity
    const token = 'ctu_live_0123456789abcdef_' + 'a'.repeat(43)
    mockKeys.set(token, { ...key({ scopes: ['predict'] }), ownerUserId: 'creator' })
    const app = express()
    const parsed = jest.fn((_req: Request, res: express.Response) => res.json({}))
    app.use(accessKeyPreflight, parsed)
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) =>
        res.status(error.statusCode || 500).json({ message: error.message })
    )
    const response = await request(app)
        .post('/api/v1/prediction/' + FLOW)
        .set('Authorization', 'Bearer ' + token)
    expect(response.status).toBe(503)
    expect(response.body.message).toBe('Access key verification is unavailable.')
    expect(parsed).not.toHaveBeenCalled()
})
it.each(['policy', 'scope', 'capacity'])('checks retained bearer %s before multipart storage', async (refusal) => {
    const { assertCapacity } = await import('./limiter')
    const principal = key({
        scopes: ['predict', 'upload', ...(refusal === 'scope' ? [] : ['stream'])],
        ...(refusal === 'policy' ? { origins: ['https://allowed.example'] } : {})
    })
    mockKeys.set('fixture-token', principal)
    grant()
    if (refusal === 'capacity') (assertCapacity as jest.Mock).mockRejectedValueOnce(new AccessKeyLimitError())
    const stored = jest.fn((_req: Request, res: express.Response) => res.json({}))
    const app = express()
    app.use(accessKeyPreflight, stored)
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    const response = await request(app)
        .post('/api/v1/prediction/' + FLOW)
        .set('Authorization', 'Bearer fixture-token')
        .set('Content-Type', 'multipart/form-data; boundary=fixture')
        .send('file bytes')
    expect(response.status).toBe(refusal === 'capacity' ? 429 : 403)
    expect(stored).not.toHaveBeenCalled()
    expect(mockConsume).not.toHaveBeenCalled()
    ;(assertCapacity as jest.Mock).mockReset().mockResolvedValue(undefined)
})
it.each(['orchestrate', 'a2a'])('checks X-API-Key caller policy and capacity before %s JSON parsing', async (adapter) => {
    const { assertCapacity } = await import('./limiter')
    const token = 'ctu_live_0123456789abcdef_' + 'a'.repeat(43)
    mockKeys.set(token, key({ scopes: ['predict'], origins: ['https://allowed.example'] }))
    const parsed = jest.fn((_req: Request, res: express.Response) => res.json({}))
    const app = express()
    app.use(accessKeyPreflight, parsed)
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    const call = () =>
        request(app)
            .post('/api/v1/' + adapter + '/' + FLOW)
            .set('X-API-Key', token)
            .set('Content-Type', 'application/json')
            .send('{bad json')
    expect((await call()).status).toBe(403)
    mockKeys.set(token, key({ scopes: ['predict'] }))
    ;(assertCapacity as jest.Mock).mockRejectedValueOnce(new AccessKeyLimitError())
    expect((await call()).status).toBe(429)
    expect(parsed).not.toHaveBeenCalled()
    ;(assertCapacity as jest.Mock).mockReset().mockResolvedValue(undefined)
})
it('does not log enforced denial events while serving a shadow-mode legacy call', async () => {
    const { recordKeyUse } = await import('./audit')
    ;(recordKeyUse as jest.Mock).mockClear()
    const previous = process.env.INBOUND_ACCESS_V2
    const legacy = { ...key(), accessPolicy: { ...parsePolicy({ scopes: [] }), legacy: true } }
    grant()
    mockKeys.set('fixture-token', legacy)
    try {
        process.env.INBOUND_ACCESS_V2 = 'shadow'
        expect(await authorizeFlowKey(req(), { ...flow, apikeyid: legacy.id })).toBe(true)
        await new Promise((resolve) => setImmediate(resolve))
        expect((recordKeyUse as jest.Mock).mock.calls.every((call) => call[4]?.shadowMismatch === true)).toBe(true)
    } finally {
        process.env.INBOUND_ACCESS_V2 = previous
    }
})
it('returns an unavailable error for a Harness lookup outage instead of a grant refusal', async () => {
    mockHarnessError = new Error('private-driver-detail')
    mockKeys.set('fixture-token', key({ scopes: ['harness:read'] }))
    const app = express()
    app.use('/api/v1', accessKeyRouteGuard, (_req, res) => res.json({}))
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) =>
        res.status(error.statusCode || 500).json({ message: error.message })
    )
    const response = await request(app).get('/api/v1/harnesses/baker/runs').set('Authorization', 'Bearer fixture-token')
    expect(response.status).toBe(503)
    expect(response.body.message).not.toContain('private-driver-detail')
    expect(mockConsume).not.toHaveBeenCalled()
})

it('refuses key diagnostics before quota admission', async () => {
    const harness = { id: HARNESS, name: 'baker', type: 'HARNESS', workspaceId: 'one' }
    mockFlows.set(HARNESS, harness)
    mockKeys.set('fixture-token', key({ scopes: ['harness:read'] }))
    grant(HARNESS, 'HARNESS')
    const app = express()
    app.use('/api/v1', accessKeyRouteGuard, (_req, res) => res.json({}))
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    expect(
        (await request(app).get('/api/v1/harnesses/baker/runs/run/diagnostics').set('Authorization', 'Bearer fixture-token')).status
    ).toBe(403)
    expect(mockConsume).not.toHaveBeenCalled()
})
it('rejects an unpublished dashboard account before charging report admission', async () => {
    mockPublishedAccount = false
    mockFlows.set(HARNESS, { id: HARNESS, name: 'published', type: 'HARNESS', workspaceId: 'one' })
    mockKeys.set('fixture-token', key({ scopes: ['dashflow:report', 'harness:run'] }))
    grant('dashboard', 'DASHFLOW')
    grant(HARNESS, 'HARNESS')
    const app = express()
    app.use('/api/v1', accessKeyRouteGuard, (_req, res) => res.json({}))
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    expect(
        (await request(app).post('/api/v1/dashflows/dashboard/accounts/missing/report').set('Authorization', 'Bearer fixture-token')).status
    ).toBe(404)
    expect(mockConsume).not.toHaveBeenCalled()
})
it('maps a missing published dashboard without loading its draft or charging', async () => {
    mockKeys.set('fixture-token', key({ scopes: ['dashflow:read'] }))
    grant('dashboard', 'DASHFLOW')
    mockDashStore.get.mockClear()
    mockDashStore.published.mockImplementationOnce(() => {
        throw new MockDashFlowError(404, 'Dashboard not found.')
    })
    const app = express()
    app.use('/api/v1', accessKeyRouteGuard, (_req, res) => res.json({}))
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    expect((await request(app).get('/api/v1/dashflows/dashboard/published').set('Authorization', 'Bearer fixture-token')).status).toBe(404)
    expect(mockDashStore.get).not.toHaveBeenCalled()
    expect(mockConsume).not.toHaveBeenCalled()
})
it('accepts uppercase flow UUIDs from a lead body', async () => {
    const id = 'abcdef11-1111-4111-8111-111111111111'
    mockFlows.set(id, { ...flow, id })
    mockKeys.set('fixture-token', key({ scopes: ['feedback:write'] }))
    grant(id)
    const seen: string[] = []
    const app = express()
    app.use(express.json())
    app.use('/api/v1', accessKeyRouteGuard, admitAccessKey, (req, res) => {
        seen.push(String(req.body?.chatflowid))
        res.json({})
    })
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    expect(
        (await request(app).post('/api/v1/leads').set('Authorization', 'Bearer fixture-token').send({ chatflowid: id.toUpperCase() }))
            .status
    ).toBe(200)
    expect(seen).toEqual([id])
    expect(mockConsume).toHaveBeenCalledTimes(1)
})

it('lets an authorized key read refresh status with view permission alone', async () => {
    const previous = process.env.CUTTLELY_DASH_FLOWS
    process.env.CUTTLELY_DASH_FLOWS = 'true'
    mockKeys.set('fixture-token', { ...key({ scopes: ['dashflow:read'] }), permissions: ['chatflows:view'] })
    grant('dashboard', 'DASHFLOW')
    const router = (await import('../../routes/dashflows')).default
    const app = express()
    app.use('/api/v1', accessKeyRouteGuard)
    app.use('/api/v1/dashflows', router)
    app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) => res.status(error.statusCode || 500).json({}))
    try {
        expect(
            (await request(app).get('/api/v1/dashflows/dashboard/refresh-status').set('Authorization', 'Bearer fixture-token')).status
        ).toBe(200)
        expect(mockConsume).toHaveBeenCalledTimes(1)
    } finally {
        if (previous === undefined) delete process.env.CUTTLELY_DASH_FLOWS
        else process.env.CUTTLELY_DASH_FLOWS = previous
    }
})

it('classifies harness and dashflow routes before substring path tokens', () => {
    const op = (method: string, url: string) => flowOperation({ method, originalUrl: url } as Request)
    expect(op('POST', '/api/v1/harnesses/feedback-bot/runs')).toBe('harness:run')
    expect(op('POST', '/api/v1/harnesses/my-upload/runs')).toBe('harness:run')
    expect(op('GET', '/api/v1/harnesses/vector-db/runs/run-1')).toBe('harness:read')
    expect(op('POST', '/api/v1/dashflows/d1/accounts/upload/report')).toBe('dashflow:report')
    expect(op('POST', '/api/v1/dashflows/d1/refresh')).toBe('dashflow:report')
    expect(op('GET', '/api/v1/dashflows/d1/refresh-status')).toBe('dashflow:read')
    expect(op('POST', '/api/v1/prediction/' + FLOW + '/feedback')).toBe('feedback:write')
})

it('sanitizes a legacy grant-store outage at the flow authorization boundary', async () => {
    const previous = mockIdentityError
    mockIdentityError = 'ApiKeyResource'
    try {
        const legacy = {
            ...key({ scopes: ['predict'] }),
            accessPolicy: { ...parsePolicy({ scopes: ['predict'] }), legacy: true }
        }
        mockKeys.set('fixture-token', legacy)
        await expect(authorizeFlowKey(req(), { ...flow, apikeyid: legacy.id })).rejects.toMatchObject({
            statusCode: 503,
            message: 'Access key verification is unavailable.'
        })
        expect(mockConsume).not.toHaveBeenCalled()
    } finally {
        mockIdentityError = previous
    }
})
