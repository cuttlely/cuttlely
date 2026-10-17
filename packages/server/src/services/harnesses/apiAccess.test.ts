import express, { Request } from 'express'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { apiV1Auth } from '../../identity/apiGate'

const handled: string[] = []
const audits: Array<{ type: string; summary: string; detail: Record<string, unknown>; workspaceId: string | null }> = []
const keys = new Map<string, { id: string; workspaceId: string; harnesses: string[] | null }>()

jest.mock('../../controllers/harnesses', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: (_target, name: string) => (req: Request, res: express.Response) => {
                handled.push(`${name} ${req.params.name || ''}`)
                res.status(name === 'startBackgroundRun' ? 202 : 200).json({ ok: true })
            }
        }
    )
}))

jest.mock('../../identity/production', () => ({ applicationSql: () => ({}) }))

jest.mock('../../identity/auditLog', () => ({
    safeRecordAudit: async (_sql: unknown, event: (typeof audits)[number]) => {
        audits.push(event)
    }
}))

import harnessesRouter from '../../routes/harnesses'
import { harnessAllowlist, harnessRunRateLimit, parseHarnessAllowlist, setHarnessKeyLookup } from './apiAccess'

const RUN_PERMISSIONS = ['chatflows:view', 'chatflows:create']

// Tokens the stub gate knows. Anything else is an unknown key.
const TOKENS: Record<string, { id: string; workspaceId: string; permissions: string[] }> = {
    'bakery-key': { id: 'key-bakery', workspaceId: 'team-a', permissions: RUN_PERMISSIONS },
    'empty-key': { id: 'key-empty', workspaceId: 'team-a', permissions: RUN_PERMISSIONS },
    'view-only-key': { id: 'key-view', workspaceId: 'team-a', permissions: ['chatflows:view'] }
}

function app(sessionUser?: object) {
    const dataSource = {
        getRepository: (entity: { name: string }) => ({
            findOne: async ({ where }: { where: { id: string } }) =>
                entity.name === 'Workspace' ? { id: where.id, name: 'Team A', organizationId: 'org-1' } : { id: 'org-1' }
        })
    } as unknown as DataSource
    const server = express()
    server.use(express.json())
    server.use(
        apiV1Auth({
            whitelistURLs: [],
            apiKeyBlacklistURLs: [],
            licenseRequired: () => false,
            dataSource,
            validateAPIKey: async (req) => {
                const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
                const key = TOKENS[token]
                return key ? { isValid: true, apiKey: key } : { isValid: false }
            },
            attachIdentitySession: async () => (sessionUser ? { ...sessionUser } : null)
        })
    )
    server.use('/api/v1/harnesses', harnessesRouter)
    return server
}

function start(token: string, name = 'bakery') {
    return request(app())
        .post(`/api/v1/harnesses/${name}/runs/async`)
        .set('Authorization', `Bearer ${token}`)
        .send({ question: 'How many sourdough loaves sold on Saturday?' })
}

describe('harness API runs with an API key', () => {
    beforeAll(() => setHarnessKeyLookup(async (id) => keys.get(id)))
    afterAll(() => setHarnessKeyLookup(null))

    beforeEach(() => {
        handled.length = 0
        audits.length = 0
        keys.clear()
        keys.set('key-bakery', { id: 'key-bakery', workspaceId: 'team-a', harnesses: ['bakery'] })
        keys.set('key-empty', { id: 'key-empty', workspaceId: 'team-a', harnesses: null })
        keys.set('key-view', { id: 'key-view', workspaceId: 'team-a', harnesses: ['bakery'] })
    })

    it('refuses an unknown key before any harness route runs', async () => {
        const res = await start('not-a-real-key')
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'Unauthorized Access' })
        const read = await request(app()).get('/api/v1/harnesses/bakery/runs/run_00000000-0000-4000-8000-000000000000/result')
        expect(read.status).toBe(401)
        expect(handled).toEqual([])
        expect(audits).toEqual([])
    })

    it('refuses a key whose allowlist is empty, and records the refusal', async () => {
        const res = await start('empty-key')
        expect(res.status).toBe(403)
        expect(res.body).toEqual({ message: 'This API key may not run harness "bakery".' })
        expect(handled).toEqual([])
        expect(audits).toHaveLength(1)
        expect(audits[0]).toMatchObject({
            type: 'harness_run',
            workspaceId: 'team-a',
            detail: { harness: 'bakery', outcome: 'refused', reason: 'not_on_allowlist', via: 'api_key', keyId: 'key-empty' }
        })
    })

    it('refuses a harness that is not on the key list, the same way whether or not it exists', async () => {
        const res = await start('bakery-key', 'payroll')
        expect(res.status).toBe(403)
        expect(res.body).toEqual({ message: 'This API key may not run harness "payroll".' })
        const sync = await request(app())
            .post('/api/v1/harnesses/payroll/runs')
            .set('Authorization', 'Bearer bakery-key')
            .send({ question: 'Total payroll for October?' })
        expect(sync.status).toBe(403)
        const read = await request(app()).get('/api/v1/harnesses/payroll/runs').set('Authorization', 'Bearer bakery-key')
        expect(read.status).toBe(403)
        expect(handled).toEqual([])
    })

    it('lets a key run and read a harness on its list', async () => {
        const res = await start('bakery-key')
        expect(res.status).toBe(202)
        const read = await request(app())
            .get('/api/v1/harnesses/bakery/runs/run_00000000-0000-4000-8000-000000000000/result')
            .set('Authorization', 'Bearer bakery-key')
        expect(read.status).toBe(200)
        expect(handled).toEqual(['startBackgroundRun bakery', 'getRunResult bakery'])
    })

    it('still needs the role permission: a listed harness does not let a view-only key start a run', async () => {
        const res = await start('view-only-key')
        expect(res.status).toBe(403)
        expect(res.body).toEqual({ message: 'Forbidden' })
        expect(handled).toEqual([])
    })

    it('reads the list on each request, so removing a harness applies to the next call', async () => {
        expect((await start('bakery-key')).status).toBe(202)
        keys.set('key-bakery', { id: 'key-bakery', workspaceId: 'team-a', harnesses: [] })
        expect((await start('bakery-key')).status).toBe(403)
    })

    it('refuses a key whose stored row moved to another team', async () => {
        keys.set('key-bakery', { id: 'key-bakery', workspaceId: 'team-b', harnesses: ['bakery'] })
        expect((await start('bakery-key')).status).toBe(403)
    })

    it('does not apply the key list to a signed-in person', async () => {
        const person = { id: 'user-1', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-1', permissions: RUN_PERMISSIONS }
        const { setTeamPermissionLookup } = await import('../../identity/rbac')
        setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: RUN_PERMISSIONS }) })
        try {
            const res = await request(app(person))
                .post('/api/v1/harnesses/bakery/runs/async')
                .set('x-request-from', 'internal')
                .send({ question: 'How many loaves?' })
            expect(res.status).toBe(202)
        } finally {
            setTeamPermissionLookup(null)
        }
    })
})

describe('harness run rate limits', () => {
    it('answers 429 once a key passes the limit, and counts each key on its own', async () => {
        const server = express()
        server.use((req, _res, next) => {
            const key = String(req.headers['x-key'] || '')
            ;(req as Request).user = { apiKeyId: key } as unknown as Express.User
            next()
        })
        server.post('/:name/runs/async', harnessRunRateLimit('start', 2), (_req, res) => res.status(202).json({ ok: true }))
        const send = (key: string) => request(server).post('/bakery/runs/async').set('x-key', key)
        expect((await send('key-1')).status).toBe(202)
        expect((await send('key-1')).status).toBe(202)
        const limited = await send('key-1')
        expect(limited.status).toBe(429)
        expect(limited.body).toEqual({ message: 'Too many harness runs. The limit is 2 a minute.' })
        expect((await send('key-2')).status).toBe(202)
    })
})

describe('harness allowlist values', () => {
    it('keeps harness names only, once each', () => {
        expect(harnessAllowlist('["bakery","bakery","not a name",3,"field-team"]')).toEqual(['bakery', 'field-team'])
        expect(harnessAllowlist(null)).toEqual([])
        expect(harnessAllowlist('not json')).toEqual([])
    })

    it('refuses a body that is not a list of names', () => {
        expect(parseHarnessAllowlist(undefined)).toEqual([])
        expect(() => parseHarnessAllowlist('bakery')).toThrow('harnesses must be an array of harness names.')
        expect(() => parseHarnessAllowlist(['../etc'])).toThrow('"../etc" is not a harness name.')
        expect(() => parseHarnessAllowlist(Array.from({ length: 201 }, (_, i) => `h${i}`))).toThrow('at most 200 harnesses')
    })
})
