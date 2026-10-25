// Server start: profiles from an older compiler are compiled again, under each name lock and the profile lock,
// while the gateway's /health is held. The start script launches Hermes only once /health answers, and Hermes
// reads config.yaml from disk.
import fs from 'fs'
import os from 'os'
import path from 'path'
import harnessesService, {
    acquireNameLock,
    BootPassIncomplete,
    logger,
    recompileBeforeHermes,
    recompileOutdatedHarnessProfiles,
    resetHarnessRuntimeForTests,
    setHarnessModuleLoader,
    withProfileLock
} from './index'
import { bootPassBlocksPing, bootPassBlocksRuns, bootPassPhase, resetBootPass } from './bootGate'

describe('harness runtime start', () => {
    const order: string[] = []
    let saved: Map<string, { name: string; version: number }>
    let failFor = ''
    let sweep = ''
    let sweepPaths: string[] = []
    let holds = 0
    let unreadable = ''
    let busyMs = 0
    let deferCompile: Promise<void> | null = null

    beforeEach(() => {
        order.length = 0
        saved = new Map([
            ['navi', { name: 'navi', version: 1 }],
            ['ops', { name: 'ops', version: 1 }]
        ])
        unreadable = ''
        busyMs = 0
        deferCompile = null
        failFor = ''
        delete process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS
        resetBootPass()
        sweep = ''
        sweepPaths = []
        holds = 0
        setHarnessModuleLoader(async (file: string) => {
            if (file === 'run.mjs') {
                return {
                    configureHarnessRuntime: () => order.push('configure'),
                    warmHarnessProfiles: async ({ lock }: { lock?: (fn: () => Promise<unknown>) => Promise<unknown> } = {}) => {
                        order.push('warm-start')
                        const compile = lock || (async (fn: () => Promise<unknown>) => fn())
                        await compile(async () => {
                            order.push('warm-locked')
                        })
                        // The health wait is this pause. The profile lock has to be free while it runs.
                        order.push('hermes-healthy-wait')
                        await new Promise((resolve) => setTimeout(resolve, 40))
                        let acquired = false
                        await Promise.race([
                            withProfileLock(async () => {
                                acquired = true
                            }),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('health wait still holds the profile lock')), 500))
                        ])
                        order.push(acquired ? 'health-lock-free' : 'health-lock-held')
                        order.push('warm')
                    }
                }
            }
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
                    setAsideOutdatedConfigs: () => {
                        order.push(`set aside holds ${holds}`)
                        if (sweep === 'throw') throw new Error('EACCES')
                        if (sweep === 'ancestor') {
                            const error = new Error('profile path is a link: /hermes')
                            ;(error as { code?: string }).code = 'profile_link'
                            throw error
                        }
                        if (sweep === 'link') return sweepPaths
                        return sweep === 'stuck' ? ['/p/ops'] : []
                    },
                    recompileOutdatedProfiles: async (list: Array<{ name: string; version: number }>) => {
                        if (deferCompile) await deferCompile
                        return list.map((record) => {
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
            }
            throw new Error(`unexpected ${file}`)
        })
    })

    afterEach(() => {
        deferCompile = null
        delete process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS
        resetBootPass()
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
            'set aside holds 1',
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
        resetHarnessRuntimeForTests()
        unreadable = 'navi'
        const lines: string[] = []
        const errorSpy = jest.spyOn(logger, 'error').mockImplementation((message) => {
            lines.push(`error ${String(message)}`)
            return logger
        })
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation((message) => {
            lines.push(`warn ${String(message)}`)
            return logger
        })
        try {
            expect(await recompileOutdatedHarnessProfiles()).toEqual([
                { name: 'navi', status: 'failed', error: 'Unexpected end of JSON input' },
                { name: 'ops', status: 'recompiled' }
            ])
            expect(lines.filter((line) => line.includes('navi'))).toEqual([
                'error [harness] navi harness unavailable: Unexpected end of JSON input'
            ])
        } finally {
            errorSpy.mockRestore()
            warnSpy.mockRestore()
        }
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
            'set aside holds 1',
            'release health'
        ])
    })

    test('a gateway that does not start keeps health held and fails the start', async () => {
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
        expect(released).toBe(false)
        expect(order).toEqual([])
    })

    test('one profile that cannot be set aside is logged and skipped, and boot finishes', async () => {
        sweep = 'stuck'
        const errors: string[] = []
        const spy = jest.spyOn(logger, 'error').mockImplementation((message) => {
            errors.push(String(message))
            return logger
        })
        let released = false
        let booted = false
        try {
            await recompileBeforeHermes({
                holdGatewayHealth: () => () => (released = true),
                finishGatewayBoot: () => (booted = true),
                startGateway: async () => undefined
            })
            expect(released).toBe(true)
            expect(booted).toBe(true)
            expect(bootPassPhase()).toBe('done')
            expect(bootPassBlocksPing()).toBe(false)
            expect(errors.some((line) => line.includes('skipped profile /p/ops'))).toBe(true)
            expect(order[order.length - 1]).toBe('set aside holds 0')
        } finally {
            spy.mockRestore()
        }
    })

    test('a profile link that cannot be moved aside keeps the runtime from starting', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-link-'))
        const target = path.join(dir, 'target')
        const link = path.join(dir, 'profile')
        fs.mkdirSync(target)
        fs.writeFileSync(path.join(target, 'marker'), 'boot-link-sentinel\n')
        fs.symlinkSync(target, link)
        sweep = 'link'
        sweepPaths = [link]
        process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS = '1'
        let released = false
        let booted = false
        try {
            await expect(
                recompileBeforeHermes({
                    holdGatewayHealth: () => () => (released = true),
                    finishGatewayBoot: () => (booted = true),
                    startGateway: async () => undefined
                })
            ).rejects.toBeInstanceOf(BootPassIncomplete)
            expect(released).toBe(false)
            expect(booted).toBe(false)
            expect(bootPassPhase()).toBe('incomplete')
            expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
            expect(fs.readFileSync(path.join(target, 'marker'), 'utf8')).toBe('boot-link-sentinel\n')
            for (let i = 0; i < 40 && bootPassBlocksPing(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
            expect(released).toBe(false)
            expect(booted).toBe(false)
            expect(bootPassBlocksPing()).toBe(false)
            expect(bootPassPhase()).toBe('background')
            expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
            expect(fs.readFileSync(path.join(target, 'marker'), 'utf8')).toBe('boot-link-sentinel\n')
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('an ancestor link keeps the runtime from starting', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-ancestor-'))
        const target = path.join(dir, 'target')
        const link = path.join(dir, 'home')
        fs.mkdirSync(target)
        fs.writeFileSync(path.join(target, 'marker'), 'ancestor-boot-sentinel\n')
        fs.symlinkSync(target, link)
        sweep = 'ancestor'
        process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS = '1'
        let released = false
        let booted = false
        try {
            await expect(
                recompileBeforeHermes({
                    holdGatewayHealth: () => () => (released = true),
                    finishGatewayBoot: () => (booted = true),
                    startGateway: async () => undefined
                })
            ).rejects.toBeInstanceOf(BootPassIncomplete)
            expect(released).toBe(false)
            expect(booted).toBe(false)
            expect(bootPassPhase()).toBe('incomplete')
            expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
            expect(fs.readFileSync(path.join(target, 'marker'), 'utf8')).toBe('ancestor-boot-sentinel\n')
            for (let i = 0; i < 40 && bootPassBlocksPing(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
            expect(released).toBe(false)
            expect(booted).toBe(false)
            expect(bootPassBlocksPing()).toBe(false)
            expect(bootPassPhase()).toBe('background')
            expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
            expect(fs.readFileSync(path.join(target, 'marker'), 'utf8')).toBe('ancestor-boot-sentinel\n')
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('a failure of the sweep itself is unfinished, and ping opens at the cap', async () => {
        sweep = 'throw'
        process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS = '1'
        let released = false
        let booted = false
        await expect(
            recompileBeforeHermes({
                holdGatewayHealth: () => () => (released = true),
                finishGatewayBoot: () => (booted = true),
                startGateway: async () => undefined
            })
        ).rejects.toBeInstanceOf(BootPassIncomplete)
        expect(released).toBe(false)
        expect(booted).toBe(false)
        expect(bootPassPhase()).toBe('incomplete')
        expect(bootPassBlocksPing()).toBe(true)
        for (let i = 0; i < 40 && !released; i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
        expect(released).toBe(true)
        expect(booted).toBe(true)
        expect(bootPassBlocksPing()).toBe(false)
    })

    test('warm-up holds the profile lock only during compile, not while Hermes health waits', async () => {
        resetHarnessRuntimeForTests()
        process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS = '0'
        harnessesService.startHarnessRuntime()
        for (let i = 0; i < 50 && !order.includes('sweep'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
        expect(order).toContain('sweep')
        let releaseLock: () => void = () => undefined
        const held = withProfileLock(
            () =>
                new Promise<void>((resolve) => {
                    releaseLock = resolve
                })
        )
        await new Promise((resolve) => setTimeout(resolve, 10))
        harnessesService.warmHarnesses()
        for (let i = 0; i < 50 && !order.includes('warm-start'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
        expect(order).toContain('warm-start')
        expect(order).not.toContain('warm-locked')
        expect(order).not.toContain('hermes-healthy-wait')
        releaseLock()
        await held
        for (let i = 0; i < 50 && !order.includes('health-lock-free'); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
        expect(order).toContain('warm-locked')
        expect(order).toContain('hermes-healthy-wait')
        expect(order).toContain('health-lock-free')
        expect(order).toContain('warm')
    })

    test('ping opens at the cap when harness modules fail to load', async () => {
        resetHarnessRuntimeForTests()
        process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS = '0'
        setHarnessModuleLoader(async () => {
            throw new Error('harness module missing')
        })
        harnessesService.startHarnessRuntime()
        await new Promise((resolve) => setTimeout(resolve, 30))
        expect(bootPassBlocksPing()).toBe(false)
        expect(bootPassPhase()).toBe('background')
    })

    test('a compile that outlasts the cap continues in the background and stops blocking startup', async () => {
        process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS = '0'
        let releaseCompile: () => void = () => undefined
        deferCompile = new Promise((resolve) => {
            releaseCompile = resolve
        })
        let released = false
        let booted = false
        try {
            await recompileBeforeHermes({
                holdGatewayHealth: () => () => {
                    released = true
                },
                finishGatewayBoot: () => {
                    booted = true
                },
                startGateway: async () => undefined
            })
            expect(released).toBe(false)
            expect(booted).toBe(false)
            expect(bootPassPhase()).toBe('background')
            expect(bootPassBlocksPing()).toBe(false)
            expect(bootPassBlocksRuns()).toBe(true)
            releaseCompile()
            for (let i = 0; i < 50 && !released; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
            expect(released).toBe(true)
            expect(booted).toBe(true)
            expect(bootPassBlocksRuns()).toBe(false)
            expect(bootPassPhase()).toBe('done')
        } finally {
            releaseCompile()
        }
    })

    test('a failed compile still releases health once the sweep finds nothing loadable', async () => {
        failFor = 'ops'
        let released = false
        await recompileBeforeHermes({
            holdGatewayHealth: () => () => (released = true),
            finishGatewayBoot: () => undefined,
            startGateway: async () => undefined
        })
        expect(released).toBe(true)
        expect(order).toContain('set aside holds 0')
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
