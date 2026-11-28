import * as running from '../../utils/getRunningExpressApp'
import { recompileOutdatedHarnessProfiles, setHarnessModuleLoader } from './index'

describe('bundled external queue after loss of a published profile', () => {
    const name = 'finance'
    const workspaceId = 'b0a22b20-0272-4785-9dfd-e41dbe0cefb4'
    const chatflowId = '5895486e-550b-48e7-98b9-8263815470dd'
    const createdAt = '2024-01-01T00:00:00.000Z'
    const chief = { model: { nodeName: 'chatXAI', credential: 'fixture' } }
    const specialists = [{ name: 'assistant', modules: [] }]
    const saved = { name, workspaceId, chatflowId, createdAt, updatedAt: createdAt, chief, specialists }
    const findOne = jest.fn()
    const getHarness = jest.fn()
    const compile = jest.fn()
    const rosterFromFlow = jest.fn()
    let priorEngine: string | undefined

    beforeEach(() => {
        priorEngine = process.env.CUTTLELY_NATIVE_PRIME_TEAMS
        delete process.env.CUTTLELY_NATIVE_PRIME_TEAMS
        findOne.mockReset().mockResolvedValue({ flowData: 'published' })
        getHarness.mockReset().mockReturnValue(saved)
        compile.mockReset().mockReturnValue([])
        rosterFromFlow.mockReset().mockReturnValue({ chief, specialists })
        jest.spyOn(running, 'getRunningExpressApp').mockReturnValue({
            AppDataSource: { getRepository: () => ({ findOne }) },
            nodesPool: {}
        } as unknown as ReturnType<typeof running.getRunningExpressApp>)
        setHarnessModuleLoader(async (file: string) => {
            if (file === 'store.mjs') return { getHarness, listHarnessNames: () => [name] }
            if (file === 'profile.mjs') return { needsPublishedProfileRecovery: () => true, recompileOutdatedProfiles: compile }
            if (file === 'sync-from-flow.mjs')
                return { harnessCanvasIsPlaceholder: (graph: string) => graph === 'placeholder', rosterFromFlow }
            throw new Error(file)
        })
    })

    afterEach(() => {
        if (priorEngine === undefined) delete process.env.CUTTLELY_NATIVE_PRIME_TEAMS
        else process.env.CUTTLELY_NATIVE_PRIME_TEAMS = priorEngine
        setHarnessModuleLoader(null)
        jest.restoreAllMocks()
    })

    test('validates the exact saved published workspace, canvas, chief and specialists', async () => {
        await recompileOutdatedHarnessProfiles()
        expect(findOne.mock.calls[0][0].where).toEqual({ id: chatflowId, workspaceId, name, type: 'HARNESS' })
        expect(compile).toHaveBeenCalledWith([saved], expect.objectContaining({ recoverMissing: true }))
    })

    test.each(['missing', 'draft only', 'changed specialist grant', 'changed chief credential'])(
        'holds missing materialization for %s',
        async (state) => {
            if (state === 'missing') findOne.mockResolvedValue(null)
            if (state === 'draft only') findOne.mockResolvedValue({ flowData: 'placeholder' })
            if (state === 'changed specialist grant')
                rosterFromFlow.mockReturnValue({ chief, specialists: [{ ...specialists[0], fileAccess: true }] })
            if (state === 'changed chief credential')
                rosterFromFlow.mockReturnValue({ chief: { model: { ...chief.model, credential: 'other' } }, specialists })
            await recompileOutdatedHarnessProfiles()
            expect(compile).toHaveBeenCalledWith([saved], expect.objectContaining({ recoverMissing: false }))
        }
    )

    test('does not use an earlier match after the owner generation changes', async () => {
        getHarness.mockReturnValueOnce(saved).mockReturnValue({ ...saved, createdAt: '2024-01-02T00:00:00.000Z' })
        await recompileOutdatedHarnessProfiles()
        expect(compile).not.toHaveBeenCalled()
    })

    test('native teams use the existing boot sweep', async () => {
        process.env.CUTTLELY_NATIVE_PRIME_TEAMS = name
        await recompileOutdatedHarnessProfiles()
        expect(findOne).not.toHaveBeenCalled()
        expect(compile).toHaveBeenCalledWith([saved], { log: expect.anything() })
    })
})
