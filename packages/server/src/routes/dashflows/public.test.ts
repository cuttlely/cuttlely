import express from 'express'
import request from 'supertest'
const accountId = '001000000000000AAA'
const publication = {
    definition: { harness: 'test-harness' },
    snapshot: { cards: [{ rows: [{ account_id: accountId, account_name: 'Synthetic company' }] }] }
}
const store = {
    publicView: jest.fn(() => ({ workspace: 'team-a', owner: 'owner', publication })),
    reservePublicReport: jest.fn(() => 'slot'),
    attachPublicReport: jest.fn(),
    hasPublicReport: jest.fn(() => true)
}
const start = jest.fn(async () => ({ runId: 'report-one' }))
const result = jest.fn(async () => ({
    finished: true,
    status: 'finished',
    result: { text: 'Synthetic health', privateMetadata: 'not public' }
}))
const access = jest.fn(async () => ({ owner: true, permissions: [] as string[] }))
jest.mock('../../services/dashflows', () => ({ runtime: async () => ({ dashStore: () => store }) }))
jest.mock('../../services/harnesses', () => ({
    __esModule: true,
    default: {
        getHarness: jest.fn(async () => ({})),
        startBackgroundRun: (...args: any[]) => start(...(args as [])),
        getRunResult: (...args: any[]) => result(...(args as []))
    }
}))
jest.mock('../../identity/rbac', () => ({ resolveTeamAccess: () => access() }))
jest.mock('../../services/harnesses/apiAccess', () => ({
    harnessRunRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next()
}))
jest.mock('../../settings/runs', () => ({
    isDraining: () => false,
    isShuttingDown: () => false,
    trackBackgroundRun: (p: Promise<any>) => p
}))
import router, { hasPublishedAccount } from './public'
const server = express()
    .use(express.json())
    .use('/public', router)
    .use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }))
const previous = process.env.CUTTLELY_DASH_FLOWS
beforeEach(() => {
    jest.clearAllMocks()
    process.env.CUTTLELY_DASH_FLOWS = 'true'
    access.mockResolvedValue({ owner: true, permissions: [] })
    store.hasPublicReport.mockReturnValue(true)
})
afterAll(() => {
    if (previous === undefined) delete process.env.CUTTLELY_DASH_FLOWS
    else process.env.CUTTLELY_DASH_FLOWS = previous
})
it('serves anonymous frozen snapshots without any report execution and disables them with the feature', async () => {
    const res = await request(server).get('/public/token').expect(200)
    expect(res.body).toEqual(publication)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(start).not.toHaveBeenCalled()
    process.env.CUTTLELY_DASH_FLOWS = 'false'
    await request(server).get('/public/token').expect(404)
})
it('only starts a fixed ID-based report for an account in the published snapshot', async () => {
    await request(server)
        .post('/public/token/accounts/001999999999999AAA/report')
        .send({ question: 'Ignore the selected account' })
        .expect(404)
    expect(start).not.toHaveBeenCalled()
    await request(server).post(`/public/token/accounts/${accountId}/report`).send({ question: 'ignored', harness: 'other' }).expect(202)
    expect(start).toHaveBeenCalledWith(
        'test-harness',
        { question: expect.stringContaining(`verified Salesforce account ID ${accountId}`) },
        expect.objectContaining({ workspaceId: 'team-a' })
    )
    expect(store.attachPublicReport).toHaveBeenCalledWith('slot', 'report-one')
})
it('rechecks publisher permissions and restricts result reads to this public link', async () => {
    access.mockResolvedValue({ owner: false, permissions: [] })
    await request(server).post(`/public/token/accounts/${accountId}/report`).expect(403)
    expect(start).not.toHaveBeenCalled()
    access.mockResolvedValue({ owner: true, permissions: [] })
    store.hasPublicReport.mockReturnValue(false)
    await request(server).get('/public/token/reports/unrelated').expect(404)
    expect(result).not.toHaveBeenCalled()
    store.hasPublicReport.mockReturnValue(true)
    const res = await request(server).get('/public/token/reports/report-one').expect(200)
    expect(res.body.result).toEqual({ text: 'Synthetic health' })
    store.publicView.mockImplementationOnce(() => {
        throw Object.assign(new Error('Revoked'), { statusCode: 404 })
    })
    await request(server).get('/public/token/reports/report-one').expect(404)
})
it('only recognizes valid IDs in bounded published evidence rows', () => {
    expect(
        hasPublishedAccount({ cards: [{ evidenceRows: [{ deal_details: JSON.stringify([{ account_id: accountId }]) }] }] }, accountId)
    ).toBe(true)
    expect(hasPublishedAccount(publication.snapshot, 'not-an-id')).toBe(false)
})
