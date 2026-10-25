// A latched boot compile failure refuses engine.runHarness and engine.runQueuedHarness, the methods a chatflow calls.
import { StatusCodes } from 'http-status-codes'
import { bindHarnessAvailability, recompileOutdatedHarnessProfiles, resetHarnessRuntimeForTests, setHarnessModuleLoader } from './index'

// The real shared guard that packages/harness/run.mjs wraps both run methods with.
const availability = require('../../../../harness/availability.cjs')

describe('boot failure refuses shared harness runs', () => {
    const runBody = jest.fn(async () => ({ text: 'ran' }))
    const engine = {
        setHarnessAvailabilityCheck: availability.setHarnessAvailabilityCheck,
        runHarness: (args: { name: string }) => availability.guardHarnessRun(args.name, runBody),
        runQueuedHarness: (args: { name: string }) => availability.guardHarnessRun(args.name, runBody)
    }

    beforeEach(() => {
        resetHarnessRuntimeForTests()
        runBody.mockClear()
        setHarnessModuleLoader(async (file: string) => {
            if (file === 'store.mjs')
                return { listHarnessNames: () => ['helper'], getHarness: () => ({ name: 'helper', workspaceId: 'team-1' }) }
            if (file === 'profile.mjs') {
                return { recompileOutdatedProfiles: () => [{ name: 'helper', status: 'failed', error: 'boom' }] }
            }
            throw new Error(`unexpected ${file}`)
        })
    })

    afterEach(() => {
        availability.setHarnessAvailabilityCheck(null)
        setHarnessModuleLoader(null)
        resetHarnessRuntimeForTests()
    })

    test('runHarness and runQueuedHarness reject a boot-failed harness with 503 before the run', async () => {
        bindHarnessAvailability(engine)
        await recompileOutdatedHarnessProfiles()
        const unavailable = { statusCode: StatusCodes.SERVICE_UNAVAILABLE, message: 'harness unavailable: boom' }
        await expect(engine.runHarness({ name: 'helper' })).rejects.toMatchObject(unavailable)
        await expect(engine.runQueuedHarness({ name: 'helper' })).rejects.toMatchObject(unavailable)
        expect(runBody).not.toHaveBeenCalled()
        await expect(engine.runHarness({ name: 'other' })).resolves.toEqual({ text: 'ran' })
    })
})
