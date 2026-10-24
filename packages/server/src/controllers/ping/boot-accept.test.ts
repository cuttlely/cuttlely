// Architect acceptance checks for the boot profile compile: ping, the cap, one bad profile, and the 1.4.3 notes.
import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { StatusCodes } from 'http-status-codes'
import pingController from './index'
import { AppError } from '../../errors/appError'
import { BOOT_PASS_CAP_SECONDS, bootPassBlocksPing, resetBootPass } from '../../services/harnesses/bootGate'
import harnessesService, {
    invokeHarnessForBoot,
    logger,
    recompileBeforeHermes,
    resetHarnessRuntimeForTests,
    setHarnessModuleLoader
} from '../../services/harnesses'

const ROOT = path.resolve(__dirname, '../../../../..')

function pingApp() {
    const app = express()
    app.get('/api/v1/ping', pingController.getPing)
    return app
}

describe('boot acceptance', () => {
    let releaseCompile: () => void = () => undefined
    let releaseBlocked: () => void = () => undefined
    let block = false
    let failName = ''
    const saved = new Map<string, { name: string; workspaceId: string }>()

    beforeEach(() => {
        resetBootPass()
        resetHarnessRuntimeForTests()
        releaseCompile = () => undefined
        releaseBlocked = () => undefined
        block = false
        failName = ''
        saved.clear()
        delete process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS
        setHarnessModuleLoader(async (file: string) => {
            if (file === 'run.mjs') return { configureHarnessRuntime: () => undefined, warmHarnessProfiles: async () => [] }
            if (file === 'gateway.mjs') {
                return {
                    holdGatewayHealth: () => () => undefined,
                    startGateway: async () => undefined,
                    finishGatewayBoot: () => undefined
                }
            }
            if (file === 'cleanup.mjs') return { sweepOrphanHarnessProfiles: async () => undefined }
            if (file === 'store.mjs') {
                return {
                    listHarnessNames: () => [...saved.keys()],
                    listHarnesses: () => [...saved.values()],
                    getHarness: (name: string) => saved.get(name) || null,
                    claimWorkspace: (name: string, workspaceId: string) => {
                        const row = saved.get(name)
                        if (!row) return null
                        const next = { ...row, workspaceId }
                        saved.set(name, next)
                        return next
                    }
                }
            }
            if (file === 'profile.mjs') {
                return {
                    setAsideOutdatedConfigs: () => [],
                    recompileOutdatedProfiles: (list: Array<{ name: string }>) => {
                        if (block) {
                            return new Promise((resolve) => {
                                releaseBlocked = () => resolve([])
                            })
                        }
                        if (failName) {
                            return list.map((record) =>
                                record.name === failName
                                    ? { name: record.name, status: 'failed', error: 'invalid YAML' }
                                    : { name: record.name, status: 'recompiled' }
                            )
                        }
                        return new Promise((resolve) => {
                            releaseCompile = () => resolve(list.map((record) => ({ name: record.name, status: 'recompiled' })))
                        })
                    }
                }
            }
            throw new Error(`unexpected ${file}`)
        })
    })

    afterEach(async () => {
        releaseBlocked()
        releaseCompile()
        await new Promise((resolve) => setTimeout(resolve, 40))
    })

    afterAll(() => setHarnessModuleLoader(null))

    test('A1 ping is 503 while the boot compile is held and 200 after it finishes', async () => {
        saved.set('alpha', { name: 'alpha', workspaceId: 'team-1' })
        const pass = recompileBeforeHermes({
            holdGatewayHealth: () => () => undefined,
            startGateway: async () => undefined,
            finishGatewayBoot: () => undefined
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        try {
            const held = await request(pingApp()).get('/api/v1/ping')
            expect(held.status).toBe(503)
            expect(held.text).toMatch(/boot/i)
            expect(held.text).toMatch(/recompile/i)
            const yaml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8')
            expect(yaml).toMatch(/healthCheckPath:\s*\/api\/v1\/ping/)
        } finally {
            releaseCompile()
        }
        await pass
        const open = await request(pingApp()).get('/api/v1/ping')
        expect(open.status).toBe(200)
        expect(open.text).toBe('pong')
    })

    test('A2 a compile that never finishes is failed at the cap and ping turns 200', async () => {
        expect(BOOT_PASS_CAP_SECONDS).toBeLessThanOrEqual(10 * 60)
        const script = fs.readFileSync(path.join(ROOT, 'scripts', 'start-cuttlely.sh'), 'utf8')
        const wait = script.match(/wait_for_gateway\(\) \{[\s\S]*?\n\}/)?.[0] || ''
        expect(wait).toContain(`-gt ${BOOT_PASS_CAP_SECONDS}`)
        expect(wait).toMatch(/while \[\[ "\$i" -lt "\$starting_limit" &&/)
        expect(wait).not.toMatch(/while true/)
        process.env.CUTTLELY_GATEWAY_STARTING_WAIT_SECONDS = '2'
        block = true
        saved.set('stuck', { name: 'stuck', workspaceId: 'team-1' })
        const started = Date.now()
        await recompileBeforeHermes({
            holdGatewayHealth: () => () => undefined,
            startGateway: async () => undefined,
            finishGatewayBoot: () => undefined
        })
        expect(Date.now() - started).toBeGreaterThanOrEqual(1500)
        expect(Date.now() - started).toBeLessThan(8000)
        expect(bootPassBlocksPing()).toBe(false)
        const rows = await harnessesService.listHarnesses('team-1')
        expect(rows.find((row: { name: string }) => row.name === 'stuck')).toMatchObject({
            status: 'failed',
            error: 'boot recompile stopped at the cap'
        })
        const open = await request(pingApp()).get('/api/v1/ping')
        expect(open.status).toBe(200)
    })

    test('A3 one throwing compile fails that harness only', async () => {
        failName = 'beta'
        for (const name of ['alpha', 'beta', 'gamma']) saved.set(name, { name, workspaceId: 'team-1' })
        const errors: string[] = []
        const spy = jest.spyOn(logger, 'error').mockImplementation((message) => {
            errors.push(String(message))
            return logger
        })
        try {
            const results = await harnessesService.recompileOutdatedHarnessProfiles()
            expect(results.map((row: { name: string; status: string }) => `${row.name}:${row.status}`)).toEqual([
                'alpha:recompiled',
                'beta:failed',
                'gamma:recompiled'
            ])
            expect(bootPassBlocksPing()).toBe(false)
            const rows = await harnessesService.listHarnesses('team-1')
            expect(rows.find((row: { name: string }) => row.name === 'beta')).toMatchObject({
                status: 'failed',
                error: 'invalid YAML'
            })
            expect(rows.find((row: { name: string }) => row.name === 'alpha').status).toBeUndefined()
            const ran: string[] = []
            for (const name of ['alpha', 'gamma']) {
                const result = await invokeHarnessForBoot(name, async () => {
                    ran.push(name)
                    return { text: 'ok' }
                })
                expect(result.text).toBe('ok')
            }
            expect(ran).toEqual(['alpha', 'gamma'])
            let caught: AppError | null = null
            try {
                await invokeHarnessForBoot('beta', async () => ({ text: 'no' }))
            } catch (error) {
                caught = error as AppError
            }
            expect(caught).toBeInstanceOf(AppError)
            expect(caught?.statusCode).toBe(StatusCodes.SERVICE_UNAVAILABLE)
            expect(caught?.statusCode).not.toBe(500)
            expect(caught?.message).toMatch(/harness unavailable/)
            expect(errors.filter((line) => line.includes('beta'))).toEqual(['[harness] beta harness unavailable: invalid YAML'])
        } finally {
            spy.mockRestore()
        }
    })

    test('A6 there is a changelog line under 1.4.3 for the boot compile', () => {
        const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
        const start = changelog.indexOf('## [1.4.3]')
        const end = changelog.indexOf('## [1.4.2]')
        expect(start).toBeGreaterThanOrEqual(0)
        expect(end).toBeGreaterThan(start)
        const section = changelog.slice(start, end)
        expect(section).toMatch(/compiles harness profiles from an older compiler/)
        expect(section).toMatch(/boot recompile/)
    })
})
