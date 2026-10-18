/**
 * An API key's harness list on the routes that read or write a canvas, through the real API gate and the real routers.
 * Only the controllers are stand-ins: a request that reaches one was let through.
 */
import express, { Request, Response } from 'express'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { apiV1Auth } from '../identity/apiGate'
import { setTeamPermissionLookup } from '../identity/rbac'
import { API_KEY_BLACKLIST_URLS, WHITELIST_URLS } from '../utils/constants'

const handled: string[] = []

function standIn(prefix: string) {
    return {
        __esModule: true,
        default: new Proxy(
            {},
            {
                get: (_target, name: string) => (req: Request, res: Response) => {
                    handled.push(`${prefix}.${name}`)
                    res.json({ ok: true, scope: res.locals.harnessCanvasScope ?? null, id: req.params.id || req.params.chatflowId })
                }
            }
        )
    }
}

jest.mock('../controllers/chatflows', () => standIn('chatflows'))
jest.mock('../controllers/flow-drafts', () => standIn('drafts'))
jest.mock('../controllers/flow-versions', () => standIn('versions'))
jest.mock('../controllers/flow-promote', () => standIn('promote'))
jest.mock('../controllers/mcp-server', () => standIn('mcp'))
jest.mock('../controllers/flow-configs', () => standIn('config'))
jest.mock('../identity/production', () => ({ applicationSql: () => ({}) }))

type Key = { id: string; workspaceId: string; harnesses: string[] | null }
type Flow = { id: string; name: string; type: string; workspaceId: string; flowData: string; apikeyid: string | null }
const keys = new Map<string, Key>()
const flows = new Map<string, Flow>()

jest.mock('../DataSource', () => ({
    getDataSource: () => ({
        getRepository: (entity: { name?: string }) => ({
            findOneBy: async ({ id }: { id: string }) => (entity?.name === 'ApiKey' ? keys.get(id) ?? null : null),
            findOne: async ({ where }: { where: { id: string; workspaceId: string } }) => {
                const row = entity?.name === 'ChatFlow' ? flows.get(where.id) : undefined
                return row && row.workspaceId === where.workspaceId ? row : null
            }
        })
    })
}))

import chatflowsRouter from './chatflows'
import flowDraftsRouter from './flow-drafts'
import flowVersionsRouter from './flow-versions'
import mcpServerRouter from './mcp-server'
import flowConfigRouter from './flow-config'

const ALL = [
    'chatflows:view',
    'chatflows:create',
    'chatflows:update',
    'chatflows:delete',
    'agentflows:view',
    'agentflows:create',
    'agentflows:update',
    'agentflows:delete',
    'chatflows:config',
    'agentflows:config'
]
const TOKENS: Record<string, { id: string; workspaceId: string; permissions: string[] }> = {
    'bakery-key': { id: 'key-bakery', workspaceId: 'team-a', permissions: ALL },
    'bare-key': { id: 'key-bare', workspaceId: 'team-a', permissions: [] }
}
const person = {
    id: 'user-1',
    activeOrganizationId: 'org-1',
    activeWorkspaceId: 'team-a',
    isOrganizationAdmin: true,
    permissions: ALL
}

function app() {
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
            whitelistURLs: WHITELIST_URLS,
            apiKeyBlacklistURLs: API_KEY_BLACKLIST_URLS,
            licenseRequired: () => false,
            dataSource,
            validateAPIKey: async (req) => {
                const key = TOKENS[String(req.headers.authorization || '').replace(/^Bearer /, '')]
                return key ? { isValid: true, apiKey: key } : { isValid: false }
            },
            attachIdentitySession: async (req) => (req.headers.cookie === 'session=ok' ? { ...person } : null)
        })
    )
    server.use('/api/v1/chatflows', chatflowsRouter)
    server.use('/api/v1/flow-drafts', flowDraftsRouter)
    server.use('/api/v1/flow-versions', flowVersionsRouter)
    server.use('/api/v1/mcp-server', mcpServerRouter)
    server.use('/api/v1/flow-config', flowConfigRouter)
    return request(server)
}

const KEY = { Authorization: 'Bearer bakery-key' }
const SESSION = { Cookie: 'session=ok', 'x-request-from': 'internal' }

const PAYROLL = '11111111-1111-4111-8111-111111111111'
const BAKERY = '22222222-2222-4222-8222-222222222222'
const KEYED_CHAT = '33333333-3333-4333-8333-333333333333'
const PLAIN_CHAT = '44444444-4444-4444-8444-444444444444'
const KEYLESS_PAYROLL = '55555555-5555-4555-8555-555555555555'
const OWN_BAKERY = '66666666-6666-4666-8666-666666666666'
const OWN_PAYROLL = '77777777-7777-4777-8777-777777777777'
const SHA = 'abcdef1'

const harnessCard = (name: string) => JSON.stringify({ nodes: [{ data: { name: 'harness', inputs: { harnessName: name } } }], edges: [] })
const agentTool = (name: string) =>
    JSON.stringify({
        nodes: [
            {
                data: {
                    name: 'agentAgentflow',
                    inputs: { agentTools: [{ agentSelectedTool: 'harness', agentSelectedToolConfig: { harnessName: name } }] }
                }
            }
        ],
        edges: []
    })

beforeAll(() => setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: null }) }))
afterAll(() => setTeamPermissionLookup(null))

beforeEach(() => {
    handled.length = 0
    keys.clear()
    flows.clear()
    keys.set('key-bakery', { id: 'key-bakery', workspaceId: 'team-a', harnesses: ['bakery'] })
    const base = { workspaceId: 'team-a', apikeyid: null }
    flows.set(PAYROLL, { ...base, id: PAYROLL, name: 'payroll', type: 'HARNESS', flowData: '{"nodes":[],"edges":[]}' })
    flows.set(BAKERY, { ...base, id: BAKERY, name: 'bakery', type: 'HARNESS', flowData: '{"nodes":[],"edges":[]}' })
    flows.set(KEYED_CHAT, {
        ...base,
        id: KEYED_CHAT,
        name: 'Support',
        type: 'CHATFLOW',
        flowData: harnessCard('payroll'),
        apikeyid: 'key-x'
    })
    flows.set(PLAIN_CHAT, { ...base, id: PLAIN_CHAT, name: 'Plain', type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}' })
    flows.set(KEYLESS_PAYROLL, { ...base, id: KEYLESS_PAYROLL, name: 'Open', type: 'CHATFLOW', flowData: harnessCard('payroll') })
    flows.set(OWN_BAKERY, {
        ...base,
        id: OWN_BAKERY,
        name: 'Mine',
        type: 'AGENTFLOW',
        flowData: agentTool('bakery'),
        apikeyid: 'key-bakery'
    })
    flows.set(OWN_PAYROLL, {
        ...base,
        id: OWN_PAYROLL,
        name: 'Mine 2',
        type: 'CHATFLOW',
        flowData: harnessCard('payroll'),
        apikeyid: 'key-bakery'
    })
})

/** The path as sent, with each word of each fixed segment after /api/v1/ capitalised, and in mixed case. */
function spellings(path: string): string[] {
    const recase = (fn: (word: string) => string) =>
        path.replace(
            /^\/api\/v1\/(.*)$/,
            (_all, rest: string) =>
                '/api/v1/' +
                rest
                    .split('/')
                    .map((segment) => (/^[a-z-]+$/.test(segment) ? segment.split('-').map(fn).join('-') : segment))
                    .join('/')
        )
    const capitalised = recase((word) => word.charAt(0).toUpperCase() + word.slice(1))
    const mixed = recase((word) =>
        word
            .split('')
            .map((ch, i) => (i % 2 ? ch.toUpperCase() : ch))
            .join('')
    )
    return [capitalised, mixed]
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

/** Sends the request as written, capitalised, and in mixed case, and expects each one refused before a handler. */
async function refusedInEveryCase(method: Method, path: string, headers: Record<string, string>, body?: object, status = 403) {
    for (const spelled of [path, ...spellings(path)]) {
        const sent = app()[method](spelled).set(headers)
        const res = body === undefined ? await sent : await sent.send(body)
        expect({ method, spelled, status: res.status }).toEqual({ method, spelled, status })
    }
    expect(handled).toEqual([])
}

describe('M1: a HARNESS canvas on /chatflows needs its name on the key list', () => {
    it('create: refuses a HARNESS canvas named off the list and saves one on it', async () => {
        const refused = await app().post('/api/v1/chatflows').set(KEY).send({ name: 'payroll', type: 'HARNESS', flowData: '{}' })
        expect(refused.status).toBe(403)
        expect(refused.body).toEqual({ message: 'This API key may not use harness "payroll".' })
        const saved = await app().post('/api/v1/chatflows').set(KEY).send({ name: 'bakery', type: 'HARNESS', flowData: '{}' })
        expect(saved.status).toBe(200)
        expect(handled).toEqual(['chatflows.saveChatflow'])
    })

    it('update: refuses a stored HARNESS canvas off the list, and a rename onto a name off the list', async () => {
        expect((await app().put(`/api/v1/chatflows/${PAYROLL}`).set(KEY).send({ category: 'x' })).status).toBe(403)
        expect((await app().put(`/api/v1/chatflows/${BAKERY}`).set(KEY).send({ name: 'payroll' })).status).toBe(403)
        expect((await app().put(`/api/v1/chatflows/${PLAIN_CHAT}`).set(KEY).send({ type: 'HARNESS', name: 'payroll' })).status).toBe(403)
        expect((await app().put(`/api/v1/chatflows/${BAKERY}`).set(KEY).send({ category: 'x' })).status).toBe(200)
        expect(handled).toEqual(['chatflows.updateChatflow'])
    })

    it('delete and read: refuse a HARNESS canvas off the list', async () => {
        expect((await app().delete(`/api/v1/chatflows/${PAYROLL}`).set(KEY)).status).toBe(403)
        expect((await app().get(`/api/v1/chatflows/${PAYROLL}`).set(KEY)).status).toBe(403)
        expect((await app().delete(`/api/v1/chatflows/${BAKERY}`).set(KEY)).status).toBe(200)
        expect(handled).toEqual(['chatflows.deleteChatflow'])
    })

    it('list: hands the key list to the query, so HARNESS rows off it are left out; a person gets every row', async () => {
        const viaKey = await app().get('/api/v1/chatflows').set(KEY)
        expect(viaKey.status).toBe(200)
        expect(viaKey.body.scope).toEqual(['bakery'])
        keys.set('key-bakery', { id: 'key-bakery', workspaceId: 'team-a', harnesses: null })
        expect((await app().get('/api/v1/chatflows?type=HARNESS').set(KEY)).body.scope).toEqual([])
        expect((await app().get('/api/v1/chatflows').set(SESSION)).body.scope).toBeNull()
    })

    it('a signed-in person is checked by role only', async () => {
        expect((await app().put(`/api/v1/chatflows/${PAYROLL}`).set(SESSION).send({ category: 'x' })).status).toBe(200)
        expect((await app().delete(`/api/v1/chatflows/${PAYROLL}`).set(SESSION)).status).toBe(200)
    })
})

describe('M1: draft save, Publish, Roll back, and Restore on a HARNESS canvas', () => {
    it('refuses each one for a canvas off the key list and lets the listed canvas through', async () => {
        const off = [
            app().put(`/api/v1/flow-drafts/${PAYROLL}`).set(KEY).send({ flowData: '{"nodes":[],"edges":[]}' }),
            app().post(`/api/v1/flow-drafts/${PAYROLL}/publish`).set(KEY).send({}),
            app().post(`/api/v1/flow-drafts/${PAYROLL}/rollback`).set(KEY).send({ sha: SHA }),
            app().post(`/api/v1/flow-versions/${PAYROLL}/${SHA}/restore`).set(KEY).send({})
        ]
        for (const res of await Promise.all(off)) expect(res.status).toBe(403)
        expect(handled).toEqual([])
        await app().put(`/api/v1/flow-drafts/${BAKERY}`).set(KEY).send({ flowData: '{"nodes":[],"edges":[]}' })
        await app().post(`/api/v1/flow-drafts/${BAKERY}/publish`).set(KEY).send({})
        await app().post(`/api/v1/flow-drafts/${BAKERY}/rollback`).set(KEY).send({ sha: SHA })
        await app().post(`/api/v1/flow-versions/${BAKERY}/${SHA}/restore`).set(KEY).send({})
        expect(handled).toEqual(['drafts.saveDraft', 'drafts.publishDraft', 'drafts.rollbackLive', 'versions.restoreVersion'])
    })
})

describe('B1: the publish check on a HARNESS canvas', () => {
    it('refuses starting and reading a check for a harness off the key list', async () => {
        expect((await app().post(`/api/v1/flow-drafts/${PAYROLL}/check`).set(KEY).send({ count: 4 })).status).toBe(403)
        expect((await app().get(`/api/v1/flow-drafts/${PAYROLL}/check/check-1`).set(KEY)).status).toBe(403)
        expect(handled).toEqual([])
        expect((await app().post(`/api/v1/flow-drafts/${BAKERY}/check`).set(KEY).send({ count: 4 })).status).toBe(200)
        expect((await app().get(`/api/v1/flow-drafts/${BAKERY}/check/check-1`).set(KEY)).status).toBe(200)
        expect(handled).toEqual(['drafts.startCheck', 'drafts.getCheck'])
    })
})

describe('B2: a harness named anywhere in a sent canvas', () => {
    it('refuses an Agent harness tool off the key list on a chatflow save and a draft save', async () => {
        const created = await app()
            .post('/api/v1/chatflows')
            .set(KEY)
            .send({ name: 'Agent', type: 'AGENTFLOW', flowData: agentTool('payroll') })
        expect(created.status).toBe(403)
        const draft = await app()
            .put(`/api/v1/flow-drafts/${PLAIN_CHAT}`)
            .set(KEY)
            .send({ flowData: agentTool('payroll') })
        expect(draft.status).toBe(403)
        expect(handled).toEqual([])
        expect(
            (
                await app()
                    .post('/api/v1/chatflows')
                    .set(KEY)
                    .send({ name: 'Agent', flowData: agentTool('bakery') })
            ).status
        ).toBe(200)
    })
})

describe('M2: rebinding or unbinding a flow key', () => {
    it('checks the stored canvas when a key changes apikeyid without sending a canvas', async () => {
        const unbound = await app().put(`/api/v1/chatflows/${KEYED_CHAT}`).set(KEY).send({ apikeyid: null })
        expect(unbound.status).toBe(403)
        const rebound = await app().put(`/api/v1/chatflows/${KEYED_CHAT}`).set(KEY).send({ apikeyid: 'key-bakery' })
        expect(rebound.status).toBe(403)
        expect(handled).toEqual([])
        const same = await app().put(`/api/v1/chatflows/${KEYED_CHAT}`).set(KEY).send({ apikeyid: 'key-x', category: 'x' })
        expect(same.status).toBe(200)
        const sent = await app()
            .put(`/api/v1/chatflows/${KEYED_CHAT}`)
            .set(KEY)
            .send({ apikeyid: null, flowData: harnessCard('bakery') })
        expect(sent.status).toBe(200)
        expect(handled).toEqual(['chatflows.updateChatflow', 'chatflows.updateChatflow'])
    })
})

const MCP_ROUTES: Array<[Method, string, object?]> = [
    ['get', ''],
    ['post', '', {}],
    ['put', '', { enabled: true }],
    ['delete', ''],
    ['post', '/refresh', {}]
]

describe('MCP settings and the MCP token: only on a flow the key could run, with its harnesses on the list', () => {
    it('refuses a flow bound to another key, in every case, on each MCP route', async () => {
        for (const [method, suffix, body] of MCP_ROUTES) {
            await refusedInEveryCase(method, `/api/v1/mcp-server/${KEYED_CHAT}${suffix}`, KEY, body)
        }
    })

    it("refuses a keyless flow or a HARNESS canvas that names a harness off the list, and the key's own flow that does", async () => {
        for (const id of [KEYLESS_PAYROLL, PAYROLL, OWN_PAYROLL]) {
            for (const [method, suffix, body] of MCP_ROUTES) {
                await refusedInEveryCase(method, `/api/v1/mcp-server/${id}${suffix}`, KEY, body)
            }
        }
    })

    it('lets the key manage its own flow and a keyless flow whose harnesses are listed; a person by role', async () => {
        await refusedInEveryCase('post', `/api/v1/mcp-server/${KEYED_CHAT}`, KEY, {})
        expect((await app().post(`/api/v1/mcp-server/${OWN_BAKERY}`).set(KEY).send({})).status).toBe(200)
        expect((await app().get(`/api/v1/mcp-server/${PLAIN_CHAT}`).set(KEY)).status).toBe(200)
        expect((await app().get(`/api/v1/mcp-server/${KEYED_CHAT}`).set(SESSION)).status).toBe(200)
        expect(handled).toEqual(['mcp.createMcpServerConfig', 'mcp.getMcpServerConfig', 'mcp.getMcpServerConfig'])
    })
})

describe('the schedule switch: only on a flow the key could run, with its harnesses on the list', () => {
    it("refuses another key's flow and a flow naming a harness off the list, in every case", async () => {
        for (const id of [KEYED_CHAT, KEYLESS_PAYROLL, OWN_PAYROLL]) {
            await refusedInEveryCase('patch', `/api/v1/chatflows/${id}/schedule/enabled`, KEY, { enabled: true })
        }
        expect((await app().patch(`/api/v1/chatflows/${OWN_BAKERY}/schedule/enabled`).set(KEY).send({ enabled: true })).status).toBe(200)
        expect((await app().patch(`/api/v1/chatflows/${KEYED_CHAT}/schedule/enabled`).set(SESSION).send({ enabled: false })).status).toBe(
            200
        )
        expect(handled).toEqual(['chatflows.toggleScheduleEnabled', 'chatflows.toggleScheduleEnabled'])
    })
})

describe('version history reads on a HARNESS canvas need its name on the key list', () => {
    it('refuses the list, one version, and a diff, in every case', async () => {
        await refusedInEveryCase('get', `/api/v1/flow-versions/${PAYROLL}`, KEY)
        await refusedInEveryCase('get', `/api/v1/flow-versions/${PAYROLL}/${SHA}`, KEY)
        await refusedInEveryCase('get', `/api/v1/flow-versions/${PAYROLL}/${SHA}/diff`, KEY)
        await app().get(`/api/v1/flow-versions/${BAKERY}`).set(KEY)
        await app().get(`/api/v1/flow-versions/${BAKERY}/${SHA}`).set(KEY)
        await app().get(`/api/v1/flow-versions/${BAKERY}/${SHA}/diff`).set(KEY)
        expect(handled).toEqual(['versions.listVersions', 'versions.getVersion', 'versions.diffVersion'])
    })
})

describe('flow config reads use the chatflow read checks', () => {
    it('refuses a key without a view permission and a HARNESS canvas off the list, in every case', async () => {
        await refusedInEveryCase('get', `/api/v1/flow-config/${PLAIN_CHAT}`, { Authorization: 'Bearer bare-key' })
        await refusedInEveryCase('get', `/api/v1/flow-config/${PAYROLL}`, KEY)
        expect((await app().get(`/api/v1/flow-config/${BAKERY}`).set(KEY)).status).toBe(200)
        expect(handled).toEqual(['config.getSingleFlowConfig'])
    })
})
