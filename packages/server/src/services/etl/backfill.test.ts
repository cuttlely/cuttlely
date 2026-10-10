// Workspace scope: the boot backfill gives every ETL pipeline without a workspace its chat flow's workspace, else the
// instance's default workspace, and logs the counts. The engine side (strict filters, 404s, triggers) is in etl:check.
const mockLog = { info: [] as string[], warn: [] as string[] }
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        info: (msg: string) => mockLog.info.push(msg),
        warn: (msg: string) => mockLog.warn.push(msg),
        error: jest.fn(),
        debug: jest.fn()
    }
}))

const mockDb = { flows: [] as { id: string; workspaceId?: string }[], workspaces: [] as { id: string }[], flowQueries: [] as any[] }
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: (entity: { name: string }) => ({
                find: async (options: any) => {
                    if (entity.name === 'ChatFlow') {
                        mockDb.flowQueries.push(options)
                        const ids: string[] = options.where.id.value
                        return mockDb.flows.filter((flow) => ids.includes(flow.id))
                    }
                    if (entity.name === 'Workspace') return mockDb.workspaces.slice(0, options.take)
                    return []
                },
                findOneBy: async ({ id }: { id: string }) =>
                    entity.name === 'Workspace' ? mockDb.workspaces.find((ws) => ws.id === id) ?? null : null
            })
        }
    })
}))

import { backfillPipelineWorkspaces } from '.'

function fakeApi(unassigned: string[]) {
    const calls: any[] = []
    return {
        calls,
        unassignedPipelineCount: () => unassigned.length,
        unassignedPipelineIds: () => [...unassigned],
        backfillWorkspaces: (args: { flowWorkspaces: Record<string, string>; defaultWorkspaceId: string | null }) => {
            calls.push(args)
            const fromFlow = unassigned.filter((id) => args.flowWorkspaces[id]).length
            const fromDefault = args.defaultWorkspaceId ? unassigned.length - fromFlow : 0
            return {
                pipelines: unassigned.length,
                fromFlow,
                fromDefault,
                unassigned: unassigned.length - fromFlow - fromDefault,
                childRows: 0
            }
        }
    }
}

beforeEach(() => {
    mockLog.info = []
    mockLog.warn = []
    mockDb.flows = []
    mockDb.workspaces = []
    mockDb.flowQueries = []
    delete process.env.CUTTLELY_ETL_DEFAULT_WORKSPACE_ID
})

describe('ETL workspace backfill', () => {
    it('does nothing when every pipeline has a workspace', async () => {
        const api = fakeApi([])
        expect(await backfillPipelineWorkspaces(api)).toBeNull()
        expect(api.calls).toHaveLength(0)
        expect(mockDb.flowQueries).toHaveLength(0)
    })

    it("uses each pipeline's chat flow workspace, and the only workspace as the default, then logs the counts", async () => {
        const P1 = '11111111-1111-4111-8111-111111111111'
        const P2 = '22222222-2222-4222-8222-222222222222'
        mockDb.flows = [{ id: P1, workspaceId: 'ws-a' }, { id: P2 }]
        mockDb.workspaces = [{ id: 'ws-only' }]
        const api = fakeApi([P1, P2, 'not-a-uuid'])
        const counts = await backfillPipelineWorkspaces(api)
        // Only UUIDs reach the chat flow query (Postgres rejects other values in a uuid IN list).
        expect(mockDb.flowQueries[0].where.id.value).toEqual([P1, P2])
        expect(api.calls[0]).toEqual({ flowWorkspaces: { [P1]: 'ws-a' }, defaultWorkspaceId: 'ws-only' })
        expect(counts).toMatchObject({ pipelines: 3, fromFlow: 1, fromDefault: 2, unassigned: 0 })
        expect(mockLog.info.join('\n')).toMatch(
            /3 pipeline\(s\) had no workspace; 1 took their chat flow's, 2 the default workspace, 0 left unassigned/
        )
        expect(mockLog.warn).toHaveLength(0)
    })

    it('has no default with several workspaces and no setting, so unmatched pipelines stay unassigned and a warning is logged', async () => {
        mockDb.workspaces = [{ id: 'ws-a' }, { id: 'ws-b' }]
        const api = fakeApi(['p-9'])
        const counts = await backfillPipelineWorkspaces(api)
        expect(api.calls[0].defaultWorkspaceId).toBeNull()
        expect(counts).toMatchObject({ unassigned: 1 })
        expect(mockLog.warn.join('\n')).toMatch(/1 pipeline\(s\) have no workspace and stay hidden .*CUTTLELY_ETL_DEFAULT_WORKSPACE_ID/)
    })

    it('takes CUTTLELY_ETL_DEFAULT_WORKSPACE_ID when it names a workspace, and ignores it when it does not', async () => {
        mockDb.workspaces = [{ id: 'ws-a' }, { id: 'ws-b' }]
        process.env.CUTTLELY_ETL_DEFAULT_WORKSPACE_ID = 'ws-b'
        const api = fakeApi(['p-9'])
        await backfillPipelineWorkspaces(api)
        expect(api.calls[0].defaultWorkspaceId).toBe('ws-b')

        process.env.CUTTLELY_ETL_DEFAULT_WORKSPACE_ID = 'ws-missing'
        const again = fakeApi(['p-9'])
        await backfillPipelineWorkspaces(again)
        expect(again.calls[0].defaultWorkspaceId).toBeNull()
        expect(mockLog.warn.join('\n')).toMatch(/does not name a workspace/)
    })
})
