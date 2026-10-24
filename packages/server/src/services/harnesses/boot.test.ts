// Server start: profiles from an older compiler are compiled again, under each name lock and the profile lock,
// while the gateway's /health is held. The start script launches Hermes only once /health answers, and Hermes
// reads config.yaml from disk.
import harnessesService, {
    acquireNameLock,
    recompileBeforeHermes,
    recompileOutdatedHarnessProfiles,
    setHarnessModuleLoader,
    withProfileLock
} from './index'

describe('harness runtime start', () => {
    const order: string[] = []
    let saved: Map<string, { name: string; version: number }>
    let failFor = ''
    let holds = 0
    let unreadable = ''
    let busyMs = 0

    beforeEach(() => {
        order.length = 0
        saved = new Map([
            ['navi', { name: 'navi', version: 1 }],
            ['ops', { name: 'ops', version: 1 }]
        ])
        unreadable = ''
        busyMs = 0
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
                    startGateway: async () => order.push('gateway'),
                    finishGatewayBoot: () => order.push('boot done')
                }
            }
            if (file === 'cleanup.mjs') return { sweepOrphanHarnessProfiles: async () => order.push('sweep') }
            if (file === 'store.mjs') {
                return {
                    listHarnessNames: () => ['navi', 'ops'],
                    getHarness: (name: string) => {
                        if (name === unreadable) throw new Error('Unexpected end of JSON input')
                        return saved.get(name) || null
                    }
                }
            }
            if (file === 'profile.mjs') {
                return {
                    recompileOutdatedProfiles: (list: Array<{ name: string; version: number }>) =>
                        list.map((record) => {
                            order.push(`recompile ${record.name} v${record.version} holds ${holds}`)
                            // Synchronous work, as a real compile is.
                            const until = Date.now() + busyMs
                            while (Date.now() < until) {
                                // busy
                            }
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
        // The listener is up with health held while the pass waits for the lock.
        expect(order).toEqual(['configure', 'hold health', 'gateway'])
        release()
        await held
        for (let i = 0; i < 50 && !order.includes('sweep'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
        expect(order).toEqual([
            'configure',
            'hold health',
            'gateway',
            'lock released',
            'recompile navi v1 holds 1',
            'recompile ops v1 holds 1',
            'release health',
            'boot done',
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

    test('an unreadable record is reported and the other records still run', async () => {
        unreadable = 'navi'
        expect(await recompileOutdatedHarnessProfiles()).toEqual([
            { name: 'navi', status: 'failed', error: 'Unexpected end of JSON input' },
            { name: 'ops', status: 'recompiled' }
        ])
    })

    test('health stays held until the last record is compiled, and answers between records', async () => {
        busyMs = 40
        let release: () => void = () => undefined
        const held = withProfileLock(() => new Promise<void>((resolve) => (release = resolve)))
        const gateway = {
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
        const pass = recompileBeforeHermes(gateway)
        await new Promise((resolve) => setTimeout(resolve, 30))
        // Waiting on a lock does not release health.
        expect(order).toEqual(['hold health', 'gateway'])
        release()
        await held
        // A health request that arrives while the first record compiles is answered before the second one starts.
        const probe = new Promise<void>((resolve) =>
            setTimeout(() => {
                order.push(`health probe holds ${holds}`)
                resolve()
            }, 1)
        )
        await pass
        await probe
        expect(order).toEqual([
            'hold health',
            'gateway',
            'recompile navi v1 holds 1',
            'health probe holds 1',
            'recompile ops v1 holds 1',
            'release health'
        ])
    })

    test('a gateway that does not start releases the hold and fails the start', async () => {
        let released = false
        await expect(
            recompileBeforeHermes({
                holdGatewayHealth: () => () => (released = true),
                finishGatewayBoot: () => order.push('boot done'),
                startGateway: async () => {
                    throw new Error('port in use')
                }
            })
        ).rejects.toThrow('port in use')
        expect(released).toBe(true)
        expect(order).toEqual(['boot done'])
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
