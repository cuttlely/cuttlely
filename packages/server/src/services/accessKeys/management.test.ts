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
