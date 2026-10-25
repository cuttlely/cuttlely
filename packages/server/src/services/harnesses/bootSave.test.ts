// A latched boot compile failure refuses runs with 503 until a later save compiles that harness again.
import { StatusCodes } from 'http-status-codes'
import harnessesService, {
    assertHarnessAvailable,
    recompileOutdatedHarnessProfiles,
    resetHarnessRuntimeForTests,
    setHarnessModuleLoader
} from './index'

const TEAM = 'team-boot'

describe('boot failure cleared by save', () => {
    const row = { name: 'helper', workspaceId: TEAM, version: 1, specialists: [{ name: 'scout' }] }

    beforeEach(() => {
        resetHarnessRuntimeForTests()
        // Warm-up would recompile in the background and could latch the failure again after the save clears it.
        process.env.CUTTLELY_WARM_HERMES = 'false'
        setHarnessModuleLoader(async (file: string) => {
            if (file === 'store.mjs') {
                return {
                    listHarnessNames: () => ['helper'],
                    getHarness: (name: string) => (name === row.name ? row : null),
                    saveHarness: (saved: typeof row) => saved
                }
            }
            if (file === 'profile.mjs') {
                return {
                    profileDestinationConflicts: () => [],
                    compileProfileCached: () => undefined,
                    recompileOutdatedProfiles: (list: Array<{ name: string }>) =>
                        list.map((record) => ({ name: record.name, status: 'failed', error: 'boom' }))
                }
            }
            throw new Error(`unexpected ${file}`)
        })
    })

    afterEach(() => {
        delete process.env.CUTTLELY_WARM_HERMES
        resetHarnessRuntimeForTests()
        setHarnessModuleLoader(null)
    })

    test('a harness marked boot-failed returns 503 until a successful save', async () => {
        await recompileOutdatedHarnessProfiles()
        expect(() => assertHarnessAvailable('helper')).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.SERVICE_UNAVAILABLE, message: 'harness unavailable: boom' })
        )
        await harnessesService.saveHarness({ name: 'helper', version: 1, specialists: [{ name: 'scout' }] }, TEAM)
        expect(() => assertHarnessAvailable('helper')).not.toThrow()
    })
})
