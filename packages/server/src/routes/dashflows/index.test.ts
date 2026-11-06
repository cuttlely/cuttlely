import express, { Request } from 'express'
import request from 'supertest'
import { setTeamPermissionLookup } from '../../identity/rbac'
import { AppError } from '../../errors/appError'

jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }))

const published = jest.fn((_id: string, workspace: string) => {
    if (workspace !== 'team-a') throw new AppError(404, 'Dashboard not found.')
    return { definition: { harness: 'synthetic-contract' }, snapshot: { id: 'stored-data' } }
})
const startRefresh = jest.fn(async (id: string, _workspace: string, _preferCache = false) => ({ id, refreshing: true }))
const store = {
    status: jest.fn(() => ({ refreshing: true, refreshProgress: { phase: 'views', completed: 12, total: 20 } })),
    published,
    get: jest.fn(),
    list: jest.fn(() => []),
    publish: jest.fn(),
    unpublish: jest.fn()
}
jest.mock('../../services/dashflows', () => ({
    runtime: async () => ({ dashStore: () => store, DashFlowError: class extends Error {} }),
    startDashboardRefresh: (id: string, workspace: string, preferCache: boolean) => startRefresh(id, workspace, preferCache),
    saveDashboard: jest.fn(),
    sources: jest.fn()
}))
jest.mock('../../services/harnesses', () => ({ __esModule: true, default: { getHarness: jest.fn(async () => ({})) } }))
import router from '.'

function app(user?: object) {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        req.user = user as Express.User
        next()
    })
    server.use('/dashflows', router)
    server.use((error: any, _req: Request, res: express.Response, _next: express.NextFunction) =>
        res.status(error.statusCode || 500).json({ message: error.message })
    )
    return server
}
const viewer = { id: 'viewer', activeWorkspaceId: 'team-a', activeOrganizationId: 'org' }
const editor = { ...viewer, id: 'editor' }
const previousDashFlows = process.env.CUTTLELY_DASH_FLOWS
beforeEach(() => {
    jest.clearAllMocks()
    process.env.CUTTLELY_DASH_FLOWS = 'true'
    setTeamPermissionLookup({
        accessFor: async (id) => ({
            owner: false,
            permissions: id === 'editor' ? ['chatflows:view', 'chatflows:update'] : ['chatflows:view']
        })
    })
})
afterEach(() => setTeamPermissionLookup(null))
afterAll(() => {
    if (previousDashFlows === undefined) delete process.env.CUTTLELY_DASH_FLOWS
    else process.env.CUTTLELY_DASH_FLOWS = previousDashFlows
})
it('refuses every Dashflows route while the Experimental setting is off', async () => {
    process.env.CUTTLELY_DASH_FLOWS = 'false'
    for (const response of [
        await request(app(editor)).get('/dashflows'),
        await request(app(viewer)).get('/dashflows/demo/published'),
        await request(app(editor)).post('/dashflows/demo/refresh')
    ]) {
        expect(response.status).toBe(403)
        expect(response.body.message).toContain('Experimental')
    }
    expect(store.list).not.toHaveBeenCalled()
    expect(startRefresh).not.toHaveBeenCalled()
})
it('requires a signed-in session even for published snapshots', async () => {
    expect((await request(app()).get('/dashflows/demo/published')).status).toBe(403)
    expect(
        (
            await request(app({ apiKeyId: 'key', activeWorkspaceId: 'team-a', permissions: ['chatflows:view'] })).get(
                '/dashflows/demo/published'
            )
        ).status
    ).toBe(403)
    expect(published).not.toHaveBeenCalled()
})
it('serves only stored published data to viewers without executing the source', async () => {
    const res = await request(app(viewer)).get('/dashflows/demo/published')
    expect(res.status).toBe(200)
    expect(res.body.snapshot.id).toBe('stored-data')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(startRefresh).not.toHaveBeenCalled()
})
it('keeps drafts, source catalog and writes unavailable to viewers', async () => {
    for (const endpoint of ['/dashflows', '/dashflows/demo', '/dashflows/demo/refresh-status', '/dashflows/sources/synthetic-contract'])
        expect((await request(app(viewer)).get(endpoint)).status).toBe(403)
    for (const endpoint of ['/dashflows/demo/refresh', '/dashflows/demo/publish'])
        expect((await request(app(viewer)).post(endpoint).send({})).status).toBe(403)
    expect((await request(app(viewer)).delete('/dashflows/demo/publish')).status).toBe(403)
    expect(startRefresh).not.toHaveBeenCalled()
    expect(store.get).not.toHaveBeenCalled()
})
it('scopes published access to the current team', async () => {
    expect((await request(app({ ...viewer, activeWorkspaceId: 'team-b' })).get('/dashflows/demo/published')).status).toBe(404)
    expect(published).toHaveBeenCalledWith('demo', 'team-b')
})
it('allows a builder to revoke publication with the workspace scope', async () => {
    expect((await request(app(editor)).delete('/dashflows/demo/publish')).status).toBe(204)
    expect(store.unpublish).toHaveBeenCalledWith('demo', 'team-a')
})
it('accepts a refresh without waiting for its background materialization', async () => {
    const res = await request(app(editor)).post('/dashflows/demo/refresh')
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ id: 'demo', refreshing: true })
    expect(startRefresh).toHaveBeenCalledWith('demo', 'team-a', false)
})

it('only an explicit cache preference reuses source results for an authorized range change', async () => {
    await request(app(editor)).post('/dashflows/demo/refresh').send({ preferCache: true }).expect(202)
    expect(startRefresh).toHaveBeenLastCalledWith('demo', 'team-a', true)
    await request(app(editor)).post('/dashflows/demo/refresh').send({ preferCache: 'true' }).expect(202)
    expect(startRefresh).toHaveBeenLastCalledWith('demo', 'team-a', false)
})

it('returns scoped refresh progress without retransmitting dashboard snapshots', async () => {
    const response = await request(app(editor)).get('/dashflows/demo/refresh-status').expect(200)
    expect(store.status).toHaveBeenCalledWith('demo', 'team-a')
    expect(response.body.refreshProgress.completed).toBe(12)
    expect(response.body.snapshot).toBeUndefined()
    expect(startRefresh).not.toHaveBeenCalled()
})
