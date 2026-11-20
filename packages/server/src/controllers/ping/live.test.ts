import fs from 'fs'
import os from 'os'
import path from 'path'
import controller from './index'
import { apiV1Auth } from '../../identity/apiGate'
import { WHITELIST_URLS } from '../../utils/constants'
import { beginBootPass, finishBootPass, resetBootPass } from '../../services/harnesses/bootGate'
import { DatabaseHealth, setDatabaseHealth } from '../../startup/databaseHealth'

describe('public application liveness', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-live-'))
    const previous = process.env.CUTTLELY_DATA_DIR
    const authorize = apiV1Auth({
        whitelistURLs: WHITELIST_URLS,
        apiKeyBlacklistURLs: [],
        licenseRequired: () => false,
        dataSource: {} as any,
        validateAPIKey: async () => ({ isValid: false }),
        attachIdentitySession: async () => null
    })

    // The same handler convention as startup/databaseHealth.test.ts, without a listening socket.
    const get = async (route: string) => {
        const res: any = { headers: {} as Record<string, string> }
        res.setHeader = (key: string, value: string) => (res.headers[key.toLowerCase()] = value)
        res.status = (code: number) => ((res.status = code), res)
        res.send = (body: string) => ((res.text = body), res)
        const handler = route.endsWith('/live') ? controller.getLive : controller.getPing
        await handler({} as any, res, (error: unknown) => {
            throw error
        })
        return res
    }

    beforeEach(() => {
        process.env.CUTTLELY_DATA_DIR = dir
        resetBootPass()
    })
    afterEach(() => {
        resetBootPass()
        setDatabaseHealth(null)
    })
    afterAll(() => {
        if (previous === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = previous
        fs.rmSync(dir, { recursive: true, force: true })
    })

    test('explicitly allows unauthenticated GET liveness through the API gate', async () => {
        expect(WHITELIST_URLS).toContain('/api/v1/ping/live')
        const next = jest.fn()
        await authorize({ path: '/api/v1/ping/live', method: 'GET', headers: {} } as any, {} as any, next)
        expect(next).toHaveBeenCalledWith()
    })

    test.each(['down', 'cooldown', 'exhausted'])('stays live while runtime is %s and strict ping refuses traffic', async (state) => {
        fs.writeFileSync(path.join(dir, 'hermes-supervisor.json'), JSON.stringify({ state }))
        const live = await get('/api/v1/ping/live')
        expect(live.status).toBe(200)
        expect(live.text).toBe('pong')
        expect(live.headers['x-cuttlely-hermes']).toBe(state)
        expect((await get('/api/v1/ping')).status).toBe(503)
    })

    test('refuses liveness during the first boot compile and opens after it', async () => {
        beginBootPass()
        const live = await get('/api/v1/ping/live')
        expect(live.status).toBe(503)
        expect(live.text).toBe('boot recompile')
        expect(live.headers['retry-after']).toBe('30')
        finishBootPass()
        expect((await get('/api/v1/ping/live')).status).toBe(200)
    })

    test('both probes refuse an unreachable database and recover when it answers', async () => {
        let up = false
        setDatabaseHealth(
            new DatabaseHealth(
                async () => {
                    if (!up) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
                },
                () => 'test database',
                { info: () => undefined, error: () => undefined } as any,
                { cacheMs: 0 }
            )
        )
        for (const route of ['/api/v1/ping', '/api/v1/ping/live']) {
            const response = await get(route)
            expect(response.status).toBe(503)
            expect(response.text).toMatch(/database unreachable/)
        }
        up = true
        expect((await get('/api/v1/ping/live')).status).toBe(200)
    })
})
