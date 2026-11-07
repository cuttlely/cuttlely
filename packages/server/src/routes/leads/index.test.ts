import express from 'express'
import request from 'supertest'
import { AppError } from '../../errors/appError'
import { parsePolicy } from '../../services/accessKeys/policy'

const FLOW = '11111111-1111-4111-8111-111111111111'
const mockFlows = new Map<string, any>()
const mockKeys = new Map<string, any>()
const mockSave = jest.fn(async (lead: any) => ({ ...lead, id: 'lead' }))
const mockConsume = jest.fn(async () => undefined)
jest.mock('../../services/chatflows', () => ({ __esModule: true, default: {} }))
jest.mock('../../services/apikey', () => ({ __esModule: true, default: { getApiKey: async (token: string) => mockKeys.get(token) } }))
jest.mock('../../services/accessKeys/data', () => ({
    accessData: async () => require('../../utils/accessKeyTestFixtures').fixtureAccessData(mockFlows)
}))
jest.mock('../../services/accessKeys/limiter', () => ({ consume: (...args: unknown[]) => (mockConsume as any)(...args) }))
jest.mock('../../services/accessKeys/audit', () => ({ recordKeyUse: jest.fn(async () => undefined) }))
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: () => ({ findOneBy: async ({ id }: any) => mockFlows.get(id), create: (row: any) => row, save: mockSave })
        }
    })
}))

import leadsRouter from './index'
import { accessKeyRouteGuard } from '../../services/accessKeys/routes'

const app = express()
app.use(express.json())
app.use('/api/v1', accessKeyRouteGuard)
app.use('/api/v1/leads', leadsRouter)
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(error.statusCode || 500).json({ message: error.message })
)
const lead = () => request(app).post('/api/v1/leads').send({ chatflowid: FLOW, name: 'Fixture' })
beforeEach(() => {
    process.env.INBOUND_ACCESS_V2 = 'on'
    mockFlows.clear()
    mockKeys.clear()
    mockSave.mockClear()
    mockConsume.mockReset().mockResolvedValue(undefined)
    mockFlows.set(FLOW, { id: FLOW, workspaceId: 'one', type: 'CHATFLOW', apiAccessMode: 'private', fixtureGrantIds: ['key'] })
    mockKeys.set('fixture-token', {
        id: 'key',
        workspaceId: 'one',
        permissions: ['chatflows:view'],
        accessPolicy: parsePolicy({ scopes: ['feedback:write'] })
    })
})

afterEach(() => {
    process.env.INBOUND_ACCESS_V2 = 'on'
})

it.each(['private', undefined])('refuses anonymous lead writes unless the parent is explicitly public (%s)', async (apiAccessMode) => {
    mockFlows.get(FLOW).apiAccessMode = apiAccessMode
    expect((await lead()).status).toBe(401)
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockConsume).not.toHaveBeenCalled()
})
it('allows anonymous writes only to a known explicitly public parent', async () => {
    mockFlows.get(FLOW).apiAccessMode = 'public'
    expect((await lead()).status).toBe(200)
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave.mock.calls[0][0]).toMatchObject({ chatflowid: FLOW, name: 'Fixture' })
    mockFlows.clear()
    expect((await lead()).status).toBe(404)
    expect(mockSave).toHaveBeenCalledTimes(1)
})
it.each(['off', 'shadow'])('preserves legacy anonymous lead creation with enforcement %s', async (mode) => {
    process.env.INBOUND_ACCESS_V2 = mode
    expect((await lead()).status).toBe(200)
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockConsume).not.toHaveBeenCalled()
})
it.each(['invalid bearer', 'missing scope', 'missing grant', 'caller policy', 'quota'])(
    'blocks a lead write before persistence for %s, including a public flow',
    async (missing) => {
        mockFlows.get(FLOW).apiAccessMode = 'public'
        const key = mockKeys.get('fixture-token')
        if (missing === 'invalid bearer') mockKeys.clear()
        if (missing === 'missing scope') key.accessPolicy.scopes = []
        if (missing === 'missing grant') mockFlows.get(FLOW).fixtureGrantIds = []
        if (missing === 'caller policy')
            key.accessPolicy = parsePolicy({ scopes: ['feedback:write'], allowNoOrigin: false, origins: ['https://app.example'] })
        if (missing === 'quota') mockConsume.mockRejectedValueOnce(new AppError(429, 'Quota reached'))
        const response = await lead().set('Authorization', 'Bearer fixture-token')
        expect(response.status).toBe(missing === 'invalid bearer' ? 401 : missing === 'quota' ? 429 : 403)
        expect(mockSave).not.toHaveBeenCalled()
    }
)
it('admits a granted key to a private parent and charges once across route and flow checks', async () => {
    expect((await lead().set('Authorization', 'Bearer fixture-token')).status).toBe(200)
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockConsume).toHaveBeenCalledTimes(1)
})
