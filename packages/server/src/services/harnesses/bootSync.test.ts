// A latched boot compile failure is cleared by a successful canvas sync, not by a write that rejects.
import { StatusCodes } from 'http-status-codes'
import {
    assertHarnessAvailable,
    recompileOutdatedHarnessProfiles,
    resetHarnessRuntimeForTests,
    setHarnessModuleLoader,
    syncUnderNameLock
} from './index'

const TEAM = 'team-boot'

describe('boot failure cleared by canvas sync', () => {
    const row = { name: 'helper', workspaceId: TEAM, version: 1, specialists: [{ name: 'scout' }] }
    const roster = { specialists: [{ name: 'scout' }] }

    beforeEach(() => {
        resetHarnessRuntimeForTests()
        // Warm-up would recompile in the background and could latch the failure again after the sync clears it.
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

    const unavailable = {
        statusCode: StatusCodes.SERVICE_UNAVAILABLE,
        message: 'harness unavailable: boom'
    }

    test('a harness marked boot-failed returns 503 until a successful canvas sync', async () => {
        await recompileOutdatedHarnessProfiles()
        expect(() => assertHarnessAvailable('helper')).toThrow(expect.objectContaining(unavailable))

        await expect(
            syncUnderNameLock('helper', TEAM, roster, async () => {
                throw new Error('write failed')
            })
        ).rejects.toThrow('write failed')
        expect(() => assertHarnessAvailable('helper')).toThrow(expect.objectContaining(unavailable))

        await syncUnderNameLock('helper', TEAM, roster, async () => undefined)
        expect(() => assertHarnessAvailable('helper')).not.toThrow()
    })
})
