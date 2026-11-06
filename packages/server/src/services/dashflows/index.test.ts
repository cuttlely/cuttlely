const claim = { token: 'lease', revision: 1, definition: { harness: 'synthetic-contract' } }
const store = {
    claim: jest.fn(() => claim),
    settle: jest.fn((..._args: unknown[]) => ({ snapshot: { id: 'new' } })),
    due: jest.fn(() => [])
}
const execute = jest.fn(async () => 'typed-source-result')
const queryName = (slug: string) => ['pq', slug].join('_')
const materialize = jest.fn(async (_definition, _record, invoke) => {
    await invoke({ specialist: 'analyst', name: queryName('test'), bindingIndex: 2 }, { month: '2026-10-01' })
    return { id: 'new' }
})
const access = jest.fn(async (..._args: unknown[]) => ({ owner: false, permissions: ['chatflows:update'] }))
const draining = jest.fn(() => false)
const track = jest.fn((run: Promise<unknown>) => run)
const drainStart = jest.fn()
class DashFlowError extends Error {
    status = 422
}
jest.mock('../harnesses', () => ({
    __esModule: true,
    default: { getHarness: jest.fn(async () => ({ name: 'synthetic-contract', workspaceId: 'team-a' })) },
    contextFor: jest.fn(async () => ({ flowOptions: { workspaceId: 'team-a' } })),
    loadHarness: async (name: string) =>
        name === 'dashflows.mjs' ? { dashStore: () => store, materialize, DashFlowError } : { executeSpecialistTool: execute }
}))
jest.mock('../../identity/rbac', () => ({ resolveTeamAccess: (...args: unknown[]) => access(...args) }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }))
jest.mock('../../settings/runs', () => ({
    isDraining: () => draining(),
    isShuttingDown: () => false,
    trackBackgroundRun: (run: Promise<unknown>) => track(run),
    onDrainStart: (...args: unknown[]) => drainStart(...args)
}))
import { refreshDashboard, startDashboardRefresh, startDashflowScheduler, tickDashflows } from '.'

const previousDashFlows = process.env.CUTTLELY_DASH_FLOWS
beforeEach(() => {
    jest.clearAllMocks()
    process.env.CUTTLELY_DASH_FLOWS = 'true'
    store.due.mockReturnValue([])
    draining.mockReturnValue(false)
    access.mockResolvedValue({ owner: false, permissions: ['chatflows:update'] })
})
afterAll(() => {
    if (previousDashFlows === undefined) delete process.env.CUTTLELY_DASH_FLOWS
    else process.env.CUTTLELY_DASH_FLOWS = previousDashFlows
})
it('routes a refresh through the exact harness specialist binding and preserves the workspace context', async () => {
    await refreshDashboard('dashboard', 'team-a')
    expect(execute).toHaveBeenCalledWith(
        'synthetic-contract',
        'analyst',
        queryName('test'),
        { month: '2026-10-01' },
        {
            harness: { name: 'synthetic-contract', workspaceId: 'team-a' },
            bindingIndex: 2,
            flowOptions: { workspaceId: 'team-a' }
        }
    )
    expect(store.settle).toHaveBeenCalledWith('dashboard', 'team-a', claim, { id: 'new' }, null)
})
it('keeps last-good data on failure without exposing raw source errors', async () => {
    materialize.mockRejectedValueOnce(new Error('private source detail'))
    await expect(refreshDashboard('dashboard', 'team-a')).rejects.toThrow('Check source availability')
    expect(store.settle.mock.calls[0][3]).toBeNull()
    expect(store.settle.mock.calls[0][4]).not.toContain('private source detail')
})
it('rechecks the owner before a scheduled refresh and skips revoked update access', async () => {
    store.due.mockReturnValueOnce([{ id: 'dashboard', workspace: 'team-a', owner: 'owner' }] as never[])
    access.mockResolvedValueOnce({ owner: false, permissions: ['chatflows:view'] })
    await tickDashflows()
    expect(access).toHaveBeenCalledWith('owner', 'team-a')
    expect(execute).not.toHaveBeenCalled()
    expect(store.settle.mock.calls[0][4]).toContain('current team access')
})
it('does not start scheduled work while draining', async () => {
    draining.mockReturnValue(true)
    await tickDashflows()
    expect(store.due).not.toHaveBeenCalled()
})
it('does no scheduled work while Dashflows is off', async () => {
    process.env.CUTTLELY_DASH_FLOWS = '0'
    await tickDashflows()
    expect(store.due).not.toHaveBeenCalled()
    startDashflowScheduler(null)
    expect(drainStart).not.toHaveBeenCalled()
})
it('refuses a manual refresh while draining without claiming or starting work', async () => {
    draining.mockReturnValue(true)
    await expect(startDashboardRefresh('dashboard', 'team-a')).rejects.toMatchObject({
        statusCode: 503,
        message: 'Cuttlely is restarting. Try again in a minute.'
    })
    expect(store.claim).not.toHaveBeenCalled()
    expect(track).not.toHaveBeenCalled()
    expect(materialize).not.toHaveBeenCalled()
})
it('claims a manual refresh and returns before materialization settles', async () => {
    let finish!: (value: { id: string }) => void
    materialize.mockImplementationOnce(() => new Promise<{ id: string }>((resolve) => (finish = resolve)))
    await expect(startDashboardRefresh('dashboard', 'team-a')).resolves.toEqual({ id: 'dashboard', refreshing: true })
    expect(store.claim).toHaveBeenCalledWith('dashboard', 'team-a')
    expect(track).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(store.settle).not.toHaveBeenCalled()
    finish({ id: 'later' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(store.settle).toHaveBeenCalledWith('dashboard', 'team-a', claim, { id: 'later' }, null)
})
