// Server start: profiles from an older compiler are compiled again, under the profile lock, before the gateway
// answers. The start script launches Hermes only once the gateway answers, and Hermes reads config.yaml from disk.
import harnessesService, { recompileOutdatedHarnessProfiles, setHarnessModuleLoader, withProfileLock } from './index'

describe('harness runtime start', () => {
    const order: string[] = []
    let records: Array<{ name: string }>
    let failFor = ''

    beforeEach(() => {
        order.length = 0
        records = [{ name: 'navi' }, { name: 'ops' }]
        failFor = ''
        setHarnessModuleLoader(async (file: string) => {
            if (file === 'run.mjs') return { configureHarnessRuntime: () => order.push('configure') }
            if (file === 'gateway.mjs') return { startGateway: async () => order.push('gateway') }
            if (file === 'cleanup.mjs') return { sweepOrphanHarnessProfiles: async () => order.push('sweep') }
            if (file === 'store.mjs') return { listHarnesses: () => records }
            if (file === 'profile.mjs') {
                return {
                    recompileOutdatedProfiles: (list: Array<{ name: string }>) =>
                        list.map((record) => {
                            order.push(`recompile ${record.name}`)
                            return record.name === failFor
                                ? { name: record.name, status: 'failed', error: 'boom' }
                                : { name: record.name, status: 'recompiled' }
                        })
                }
            }
            throw new Error(`unexpected ${file}`)
        })
    })

    afterAll(() => setHarnessModuleLoader(null))

    test('recompiles every saved harness under the profile lock before the gateway starts', async () => {
        let release: () => void = () => undefined
        const held = withProfileLock(
            () =>
                new Promise<void>((resolve) => {
                    release = () => {
                        order.push('lock released')
                        resolve()
                    }
                })
        )
        harnessesService.startHarnessRuntime()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(order).toEqual(['configure'])
        release()
        await held
        for (let i = 0; i < 50 && !order.includes('sweep'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
        expect(order).toEqual(['configure', 'lock released', 'recompile navi', 'recompile ops', 'gateway', 'sweep'])
    })

    test('one failed recompile is reported and the rest still run', async () => {
        failFor = 'navi'
        const results = await recompileOutdatedHarnessProfiles()
        expect(results).toEqual([
            { name: 'navi', status: 'failed', error: 'boom' },
            { name: 'ops', status: 'recompiled' }
        ])
    })
})
