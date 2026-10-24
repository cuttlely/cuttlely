// Server start: profiles from an older compiler are compiled again, under each name lock and the profile lock,
// while the gateway's /health is held. The start script launches Hermes only once /health answers, and Hermes
// reads config.yaml from disk.
import harnessesService, { acquireNameLock, recompileOutdatedHarnessProfiles, setHarnessModuleLoader, withProfileLock } from './index'

describe('harness runtime start', () => {
    const order: string[] = []
    let saved: Map<string, { name: string; version: number }>
    let listed: Array<{ name: string }>
    let failFor = ''
    let holds = 0

    beforeEach(() => {
        order.length = 0
        saved = new Map([
            ['navi', { name: 'navi', version: 1 }],
            ['ops', { name: 'ops', version: 1 }]
        ])
        listed = [...saved.values()].map((record) => ({ ...record }))
        failFor = ''
        holds = 0
        setHarnessModuleLoader(async (file: string) => {
            if (file === 'run.mjs') return { configureHarnessRuntime: () => order.push('configure') }
            if (file === 'gateway.mjs') {
                return {
                    holdGatewayHealth: () => {
                        holds += 1
                        order.push('hold health')
                        return () => {
                            holds -= 1
                            order.push('release health')
                        }
                    },
                    startGateway: async () => order.push('gateway')
                }
            }
            if (file === 'cleanup.mjs') return { sweepOrphanHarnessProfiles: async () => order.push('sweep') }
            if (file === 'store.mjs') return { listHarnesses: () => listed, getHarness: (name: string) => saved.get(name) || null }
            if (file === 'profile.mjs') {
                return {
                    recompileOutdatedProfiles: (list: Array<{ name: string; version: number }>) =>
                        list.map((record) => {
                            order.push(`recompile ${record.name} v${record.version} holds ${holds}`)
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

    test('recompiles under the profile lock, with health held, before the gateway starts', async () => {
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
        expect(order).toEqual(['configure', 'hold health'])
        release()
        await held
        for (let i = 0; i < 50 && !order.includes('sweep'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
        expect(order).toEqual([
            'configure',
            'hold health',
            'lock released',
            'recompile navi v1 holds 1',
            'recompile ops v1 holds 1',
            'release health',
            'gateway',
            'sweep'
        ])
    })

    test('a record saved or deleted while the pass waits is read again under its name lock', async () => {
        const releaseNavi = await acquireNameLock('navi')
        const releaseOps = await acquireNameLock('ops')
        const pass = recompileOutdatedHarnessProfiles()
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(order).toEqual([])
        saved.set('navi', { name: 'navi', version: 2 })
        releaseNavi()
        saved.delete('ops')
        releaseOps()
        expect(await pass).toEqual([{ name: 'navi', status: 'recompiled' }])
        expect(order).toEqual(['recompile navi v2 holds 0'])
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
