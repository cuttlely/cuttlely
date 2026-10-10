import { DatabaseHealth, databaseWhere, plainReason, unreachableLine, setDatabaseHealth } from './databaseHealth'
import pingController from '../controllers/ping'

const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' })
const env = {
    DATABASE_TYPE: 'postgres',
    DATABASE_HOST: 'db.rosas-bakery.example',
    DATABASE_PORT: '6543',
    DATABASE_USER: 'rosa',
    DATABASE_PASSWORD: 'made-up-db-password-0000'
} as NodeJS.ProcessEnv

function logs() {
    const lines: string[] = []
    return { lines, log: { error: (line: string) => lines.push(`E ${line}`), info: (line: string) => lines.push(`I ${line}`) } }
}

describe('database health', () => {
    afterEach(() => setDatabaseHealth(null))

    it('names host and port, never the user or password', () => {
        const where = databaseWhere(env)
        expect(where).toBe('postgres at db.rosas-bakery.example:6543')
        const line = unreachableLine(where, plainReason(refused))
        expect(line).toContain('db.rosas-bakery.example:6543')
        expect(line).toContain('connection refused')
        expect(line).not.toContain('made-up-db-password-0000')
        expect(line).not.toContain('rosa ')
        expect(line).not.toMatch(/is ready/)
        expect(databaseWhere({ DATABASE_TYPE: 'sqlite' } as NodeJS.ProcessEnv, '/var/cuttlely/database.sqlite')).toBe(
            'the SQLite file /var/cuttlely/database.sqlite'
        )
    })

    it('gives a plain reason and never echoes an unknown message', () => {
        expect(plainReason(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('timed out')
        expect(plainReason(Object.assign(new Error('x'), { code: '28P01' }))).toBe('sign-in refused')
        expect(plainReason({ errors: [{ code: 'ECONNREFUSED' }] })).toBe('connection refused')
        expect(plainReason(new Error('password made-up-db-password-0000 rejected'))).toBe('no answer')
    })

    it('a start that never opened the database stays down, logged once', async () => {
        const { lines, log } = logs()
        const health = new DatabaseHealth(
            () => Promise.reject(refused),
            () => databaseWhere(env),
            log,
            { cacheMs: 0 }
        )
        health.markDown(refused)
        expect(health.current()).toEqual({ ok: false, reason: 'connection refused' })
        await health.check()
        await health.check()
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatch(/^E .*can't reach its database \(postgres at db\.rosas-bakery\.example:6543\): connection refused/)
    })

    it('a later outage goes down and comes back, one line each way', async () => {
        const { lines, log } = logs()
        let up = true
        const health = new DatabaseHealth(
            () => (up ? Promise.resolve() : Promise.reject(refused)),
            () => databaseWhere(env),
            log,
            { cacheMs: 0 }
        )
        expect(await health.check()).toEqual({ ok: true })
        up = false
        expect(await health.check()).toEqual({ ok: false, reason: 'connection refused' })
        expect(await health.check()).toEqual({ ok: false, reason: 'connection refused' })
        up = true
        expect(await health.check()).toEqual({ ok: true })
        expect(lines.map((line) => line.slice(0, 1))).toEqual(['E', 'I'])
    })

    it('a database that hangs counts as down after the timeout', async () => {
        const { log } = logs()
        const health = new DatabaseHealth(
            () => new Promise(() => {}),
            () => 'x',
            log,
            { cacheMs: 0, timeoutMs: 20 }
        )
        expect(await health.check()).toEqual({ ok: false, reason: 'timed out' })
    })

    it('caches the answer so frequent health checks do not hit the database each time', async () => {
        const { log } = logs()
        let calls = 0
        let t = 0
        const health = new DatabaseHealth(
            async () => {
                calls++
            },
            () => 'x',
            log,
            { cacheMs: 5000, now: () => t }
        )
        await health.check()
        t = 1000
        await health.check()
        expect(calls).toBe(1)
        t = 6000
        await health.check()
        expect(calls).toBe(2)
    })

    it('ping answers 503 with a plain reason while the database is down, 200 once it answers', async () => {
        let up = false
        const { log } = logs()
        setDatabaseHealth(
            new DatabaseHealth(
                () => (up ? Promise.resolve() : Promise.reject(refused)),
                () => 'x',
                log,
                { cacheMs: 0 }
            )
        )
        const call = async () => {
            const res: any = { headers: {} as Record<string, string> }
            res.setHeader = (k: string, v: string) => (res.headers[k] = v)
            res.status = (code: number) => ((res.code = code), res)
            res.send = (body: string) => ((res.body = body), res)
            await pingController.getPing({} as any, res, (e: unknown) => {
                throw e
            })
            return res
        }
        const down = await call()
        expect(down.code).toBe(503)
        expect(down.body).toBe('database unreachable: connection refused')
        expect(down.headers['X-Cuttlely-Database']).toBe('down')
        up = true
        const ok = await call()
        expect(ok.code).toBe(200)
        expect(ok.body).toBe('pong')
        expect(ok.headers['X-Cuttlely-Database']).toBe('up')
    })
})
