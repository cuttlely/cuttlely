import express, { Request } from 'express'
import request from 'supertest'
import { ApiKey } from '../../database/entities/ApiKey'
import { parsePolicy } from './policy'
const mockActorPermissions = new Set(['apikeys:update', 'chatflows:view', 'chatflows:update'])
let mockKey: ApiKey
let mockGrants: object[] = []
const mockTransaction = jest.fn(async () => ({ key: mockKey, secret: 'synthetic-once' }))
jest.mock('../../identity/rbac', () => ({
    hasAnyPermission: async (_req: Request, ...permissions: string[]) => permissions.some((p) => mockActorPermissions.has(p))
}))
jest.mock('./data', () => ({
    accessData: async () => ({
        transaction: mockTransaction,
        getRepository: (entity: { name: string }) => ({
            findOneBy: async () => (entity.name === 'ApiKey' ? mockKey : null),
            findBy: async () => mockGrants
        })
    })
}))
jest.mock('../apikey', () => ({ __esModule: true, default: { getAllApiKeys: async () => [mockKey] }, validatePermissions: jest.fn() }))
import { createAccessKey, target } from './management'
const app = express()
app.use(express.json())
app.use((req, _res, next) => {
    req.user = { id: 'actor', activeWorkspaceId: 'workspace' } as Request['user']
    next()
})
app.post('/keys/:id/rotate', (req, res, next) => {
    void target(req).then((key) => res.json({ id: key.id }), next)
})
app.post('/keys', createAccessKey)
app.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) =>
    res.status(error.statusCode || 500).json({ message: error.message })
)
beforeEach(() => {
    mockKey = {
        id: 'key',
        workspaceId: 'workspace',
        permissions: ['chatflows:view'],
        accessPolicy: parsePolicy({ scopes: ['predict'] })
    } as ApiKey
    mockTransaction.mockClear()
    mockGrants = [{ principalId: 'key', resourceType: 'AGENTFLOW', resourceId: 'agent' }]
    mockActorPermissions.delete('apikeys:grant-all')
})
it('reauthorizes each granted resource family before lifecycle access', async () => {
    expect((await request(app).post('/keys/key/rotate')).status).toBe(403)
    mockGrants = [{ principalId: 'key', resourceType: 'CHATFLOW', resourceId: 'chat' }]
    expect((await request(app).post('/keys/key/rotate')).status).toBe(200)
})
it('reauthorizes both flow families before lifecycle access to a workspace-wide grant', async () => {
    mockActorPermissions.add('apikeys:grant-all')
    mockKey.accessPolicy = parsePolicy({ scopes: ['predict'], allResources: true })
    mockGrants = []
    expect((await request(app).post('/keys/key/rotate')).status).toBe(403)
})

it('refuses a deleted workspace before committing a one-time secret', async () => {
    const response = await request(app).post('/keys').send({ keyName: 'Fixture', permissions: [], resources: [] })
    expect(response.status).toBe(401)
    expect(mockTransaction).not.toHaveBeenCalled()
})

it('refuses an AGENTFLOW write scope the issuer cannot authorize for that family', async () => {
    process.env.INBOUND_ACCESS_V2 = 'on'
    mockActorPermissions.add('apikeys:create')
    mockActorPermissions.add('agentflows:view')
    // choices lists the agentflow via view, and api:write via chatflows:update OR
    const dataMock = jest.requireMock('./data')
    const previous = dataMock.accessData
    dataMock.accessData = async () => ({
        transaction: mockTransaction,
        getRepository: (entity: { name: string }) => ({
            findOneBy: async () => (entity.name === 'ApiKey' ? mockKey : entity.name === 'Workspace' ? { id: 'workspace' } : null),
            findBy: async () =>
                entity.name === 'ChatFlow'
                    ? [{ id: 'agent', name: 'Agent', type: 'AGENTFLOW', workspaceId: 'workspace', flowData: '{}' }]
                    : mockGrants
        })
    })
    try {
        const response = await request(app)
            .post('/keys')
            .send({
                keyName: 'Overreach',
                permissions: ['chatflows:update', 'agentflows:view'],
                resources: [{ resourceType: 'AGENTFLOW', resourceId: 'agent' }],
                accessPolicy: { scopes: ['api:write'] }
            })
        expect(response.status).toBe(403)
        expect(mockTransaction).not.toHaveBeenCalled()
    } finally {
        dataMock.accessData = previous
        mockActorPermissions.delete('apikeys:create')
        mockActorPermissions.delete('agentflows:view')
    }
})

it('refuses prediction policies missing view permission before minting a secret', async () => {
    process.env.INBOUND_ACCESS_V2 = 'on'
    const response = await request(app)
        .post('/keys')
        .send({ keyName: 'Incomplete', permissions: [], accessPolicy: { scopes: ['predict'] }, resources: [] })
    expect(response.status).toBe(400)
    expect(response.body.message).toContain('predict needs chatflows:view or agentflows:view')
    expect(response.body.message).toContain('https://cuttlely.com/docs/how-to/access-keys/')
    expect(mockTransaction).not.toHaveBeenCalled()
})
