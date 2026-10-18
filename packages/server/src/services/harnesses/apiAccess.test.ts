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

const storedKeys: Array<{ id: string; workspaceId: string; harnesses: string[] | null }> = []
const savedKeys: string[] = []
const boundFlows: Array<{ id: string; apikeyid: string; workspaceId: string; flowData: string }> = []
jest.mock('../../DataSource', () => ({
    getDataSource: () => ({
        getRepository: (entity: { name?: string }) =>
            entity?.name === 'ChatFlow'
                ? { find: async () => boundFlows }
                : {
                      findBy: async ({ workspaceId }: { workspaceId: string }) =>
                          storedKeys.filter((key) => key.workspaceId === workspaceId),
                      findOneBy: async ({ id }: { id: string }) => storedKeys.find((key) => key.id === id) ?? null,
                      save: async (key: { id: string }) => {
                          savedKeys.push(key.id)
                          return key
                      }
                  }
    })
}))

jest.mock('../../identity/auditLog', () => ({
    safeRecordAudit: async (_sql: unknown, event: (typeof audits)[number]) => {
        audits.push(event)
    }
}))

import harnessesRouter from '../../routes/harnesses'
import {
    assertCallerMayGrant,
    harnessAllowlist,
    harnessRunRateLimit,
    parseHarnessAllowlist,
    referencedHarnessNames,
    requireHarnessCanvasAccess,
    removeHarnessFromKeyLists,
    safeHarnessName,
    setHarnessKeyLookup,
    warnKeysMissingBoundHarnesses
} from './apiAccess'

const RUN_PERMISSIONS = ['chatflows:view', 'chatflows:create']

// Tokens the stub gate knows. Anything else is an unknown key.
const TOKENS: Record<string, { id: string; workspaceId: string; permissions: string[] }> = {
    'bakery-key': { id: 'key-bakery', workspaceId: 'team-a', permissions: RUN_PERMISSIONS },
    'empty-key': { id: 'key-empty', workspaceId: 'team-a', permissions: RUN_PERMISSIONS },
    'view-only-key': { id: 'key-view', workspaceId: 'team-a', permissions: ['chatflows:view'] }
}

function gate(sessionUser?: object) {
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
    return server
}

function app(sessionUser?: object) {
    const server = gate(sessionUser)
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

    it('checks the list on reading, saving, and deleting a harness by name', async () => {
        const auth = { Authorization: 'Bearer bakery-key' }
        expect((await request(app()).get('/api/v1/harnesses/payroll').set(auth)).status).toBe(403)
        expect((await request(app()).delete('/api/v1/harnesses/payroll').set(auth)).status).toBe(403)
        expect((await request(app()).post('/api/v1/harnesses').set(auth).send({ name: 'payroll' })).status).toBe(403)
        expect((await request(app()).post('/api/v1/harnesses').set(auth).send({ name: '../etc' })).body).toEqual({
            message: 'This API key may not run harness "<invalid>".'
        })
        expect(handled).toEqual([])
        expect((await request(app()).get('/api/v1/harnesses/bakery').set(auth)).status).toBe(200)
        expect((await request(app()).post('/api/v1/harnesses').set(auth).send({ name: 'bakery' })).status).toBe(200)
        expect(handled).toEqual(['getHarness bakery', 'saveHarness '])
    })

    it('records an invalid name as <invalid> in the refusal audit row', async () => {
        const res = await start('bakery-key', 'not%20a%20name')
        expect(res.status).toBe(403)
        expect(audits[0]?.detail).toMatchObject({ harness: '<invalid>', outcome: 'refused' })
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

describe('a canvas save from an API key', () => {
    const flow = (name: string) => JSON.stringify({ nodes: [{ data: { name: 'harness', inputs: { harnessName: name } } }], edges: [] })

    function saveApp() {
        const server = gate()
        server.post('/api/v1/chatflows', requireHarnessCanvasAccess(), (_req, res) => res.json({ saved: true }))
        return server
    }

    beforeAll(() => setHarnessKeyLookup(async (id) => keys.get(id)))
    afterAll(() => setHarnessKeyLookup(null))
    beforeEach(() => {
        keys.clear()
        keys.set('key-bakery', { id: 'key-bakery', workspaceId: 'team-a', harnesses: ['bakery'] })
    })

    it('refuses a Harness card that names a harness off the key list, and saves one on it', async () => {
        const auth = { Authorization: 'Bearer bakery-key' }
        const refused = await request(saveApp())
            .post('/api/v1/chatflows')
            .set(auth)
            .send({ name: 'x', flowData: flow('payroll') })
        expect(refused.status).toBe(403)
        expect(refused.body).toEqual({ message: 'This API key may not use harness "payroll".' })
        const saved = await request(saveApp())
            .post('/api/v1/chatflows')
            .set(auth)
            .send({ name: 'x', flowData: flow('bakery') })
        expect(saved.status).toBe(200)
        const plain = await request(saveApp()).post('/api/v1/chatflows').set(auth).send({ name: 'x', flowData: '{"nodes":[]}' })
        expect(plain.status).toBe(200)
    })

    it('reads every harness name from a canvas, including an Agent harness tool', () => {
        expect(referencedHarnessNames(flow('bakery'))).toEqual(['bakery'])
        const agent = JSON.stringify({
            nodes: [
                {
                    data: {
                        name: 'agentAgentflow',
                        inputs: { agentTools: [{ agentSelectedTool: 'harness', agentSelectedToolConfig: { harnessName: 'payroll' } }] }
                    }
                }
            ]
        })
        expect(referencedHarnessNames(agent)).toEqual(['payroll'])
        expect(referencedHarnessNames('not json "harnessName"')).toEqual([])
        expect(referencedHarnessNames(undefined)).toEqual([])
    })
})

describe('granting harnesses to a key', () => {
    beforeAll(() => setHarnessKeyLookup(async (id) => keys.get(id)))
    afterAll(() => setHarnessKeyLookup(null))

    it('lets a key grant only harnesses it already holds, and leaves a person to the role check', async () => {
        keys.set('key-bakery', { id: 'key-bakery', workspaceId: 'team-a', harnesses: ['bakery'] })
        const viaKey = { user: { apiKeyId: 'key-bakery', activeWorkspaceId: 'team-a' } } as unknown as Request
        await expect(assertCallerMayGrant(viaKey, ['bakery'])).resolves.toBeUndefined()
        await expect(assertCallerMayGrant(viaKey, ['bakery', 'payroll'])).rejects.toMatchObject({ statusCode: 403 })
        const person = { user: { id: 'user-1', activeWorkspaceId: 'team-a' } } as unknown as Request
        await expect(assertCallerMayGrant(person, ['payroll'])).resolves.toBeUndefined()
    })

    it('records only a valid harness name', () => {
        expect(safeHarnessName('bakery')).toBe('bakery')
        expect(safeHarnessName('../etc\nforged')).toBe('<invalid>')
        expect(safeHarnessName(42)).toBe('<invalid>')
    })
})

describe('deleting a harness', () => {
    it('removes its name from every key list in that team and leaves other keys alone', async () => {
        storedKeys.splice(
            0,
            storedKeys.length,
            { id: 'k1', workspaceId: 'team-a', harnesses: ['bakery', 'payroll'] },
            { id: 'k2', workspaceId: 'team-a', harnesses: ['payroll'] },
            { id: 'k3', workspaceId: 'team-b', harnesses: ['bakery'] }
        )
        savedKeys.length = 0
        expect(await removeHarnessFromKeyLists('team-a', 'bakery')).toBe(1)
        expect(savedKeys).toEqual(['k1'])
        expect(storedKeys.map((key) => key.harnesses)).toEqual([['payroll'], ['payroll'], ['bakery']])
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
        try {
            parseHarnessAllowlist({ bakery: true })
        } catch (error) {
            expect((error as { statusCode?: number }).statusCode).toBe(400)
        }
        expect(() => parseHarnessAllowlist(['../etc'])).toThrow('"../etc" is not a harness name.')
        expect(() => parseHarnessAllowlist(Array.from({ length: 201 }, (_, i) => `h${i}`))).toThrow('at most 200 harnesses')
    })
})

describe('the startup check of bound keys', () => {
    it('names each flow whose Harness card or Agent harness tool is off the bound key list', async () => {
        storedKeys.splice(
            0,
            storedKeys.length,
            { id: 'k1', workspaceId: 'team-a', harnesses: ['bakery'] },
            { id: 'k2', workspaceId: 'team-b', harnesses: ['payroll'] }
        )
        const card = (name: string) => JSON.stringify({ nodes: [{ data: { name: 'harness', inputs: { harnessName: name } } }] })
        const tool = (name: string) =>
            JSON.stringify({ nodes: [{ data: { inputs: { agentTools: [{ agentSelectedToolConfig: { harnessName: name } }] } } }] })
        boundFlows.splice(
            0,
            boundFlows.length,
            { id: 'f1', apikeyid: 'k1', workspaceId: 'team-a', flowData: card('bakery') },
            { id: 'f2', apikeyid: 'k1', workspaceId: 'team-a', flowData: tool('payroll') },
            { id: 'f3', apikeyid: 'k2', workspaceId: 'team-a', flowData: card('payroll') },
            { id: 'f4', apikeyid: 'gone', workspaceId: 'team-a', flowData: card('bakery') },
            { id: 'f5', apikeyid: 'k1', workspaceId: 'team-a', flowData: '{"nodes":[]}' }
        )
        expect(await warnKeysMissingBoundHarnesses()).toEqual([
            { chatflowId: 'f2', apiKeyId: 'k1', harness: 'payroll' },
            { chatflowId: 'f3', apiKeyId: 'k2', harness: 'payroll' },
            { chatflowId: 'f4', apiKeyId: 'gone', harness: 'bakery' }
        ])
    })
})
