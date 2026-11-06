const claim = { token: 'lease', revision: 1, definition: { harness: 'synthetic-contract' } }
const store = {
    claim: jest.fn(() => claim),
    settle: jest.fn((..._args: unknown[]) => ({ snapshot: { id: 'new' } })),
    due: jest.fn(() => [])
}
const execute = jest.fn(async () => 'typed-source-result')
const materialize = jest.fn(async (_definition, _record, invoke) => {
    await invoke({ specialist: 'analyst', name: 'pq_test', bindingIndex: 2 }, { month: '2026-10-01' })
    return { id: 'new' }
})
const access = jest.fn(async (..._args: unknown[]) => ({ owner: false, permissions: ['chatflows:update'] }))
const draining = jest.fn(() => false)
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
    trackBackgroundRun: (run: Promise<unknown>) => run,
    onDrainStart: jest.fn()
}))
import { refreshDashboard, tickDashflows } from '.'

beforeEach(() => {
    jest.clearAllMocks()
    store.due.mockReturnValue([])
    draining.mockReturnValue(false)
    access.mockResolvedValue({ owner: false, permissions: ['chatflows:update'] })
})
it('routes a refresh through the exact harness specialist binding and preserves the workspace context', async () => {
    await refreshDashboard('dashboard', 'team-a')
    expect(execute).toHaveBeenCalledWith(
        'synthetic-contract',
        'analyst',
        'pq_test',
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
