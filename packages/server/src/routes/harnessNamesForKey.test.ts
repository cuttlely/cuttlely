/**
 * Harness names an API key can see outside the harness routes, through the real API gate, the real routers and the
 * real controllers: the Harness card's picker (POST /node-load-method/harness) and GET /chatflows/apikey (key in the Authorization header).
 */
import express from 'express'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { apiV1Auth } from '../identity/apiGate'
import { setTeamPermissionLookup } from '../identity/rbac'
import { API_KEY_BLACKLIST_URLS, WHITELIST_URLS } from '../utils/constants'

const TEAM_HARNESSES = [
    { label: 'bakery', name: 'bakery' },
    { label: 'payroll', name: 'payroll' }
]

jest.mock('../utils', () => ({ databaseEntities: {} }))
jest.mock('../utils/executeCustomNodeFunction', () => ({ executeCustomNodeFunction: jest.fn() }))
jest.mock('../utils/nodePacks', () => ({ loadNodePackIndex: jest.fn() }))
jest.mock('../services/credentials', () => ({ __esModule: true, default: { assertCredentialInWorkspace: jest.fn() } }))
jest.mock('../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        nodesPool: {
            componentNodes: {
                harness: { loadMethods: { listHarnesses: async () => TEAM_HARNESSES.map((row) => ({ ...row })) } }
            }
        }
    })
}))
jest.mock('../identity/production', () => ({ applicationSql: () => ({}) }))

type Key = { id: string; workspaceId: string; harnesses: string[] | null }
const keys = new Map<string, Key>()
jest.mock('../DataSource', () => ({
    getDataSource: () => ({
        getRepository: (entity: { name?: string }) => ({
            findOneBy: async ({ id }: { id: string }) => (entity?.name === 'ApiKey' ? keys.get(id) ?? null : null),
            findOne: async () => null
        })
    })
}))

const boundRows = [
    { id: 'flow-1', name: 'Support', deployed: true, category: null, type: 'CHATFLOW' },
    { id: 'flow-2', name: 'bakery', deployed: true, category: null, type: 'HARNESS' },
    { id: 'flow-3', name: 'payroll', deployed: true, category: null, type: 'HARNESS' }
]
jest.mock('../services/apikey', () => ({
    __esModule: true,
    default: {
        getApiKey: async (supplied: string) =>
            supplied === 'bakery-token-1'
                ? { id: 'key-bakery', workspaceId: 'team-a', harnesses: keys.get('key-bakery')?.harnesses }
                : undefined
    }
}))
jest.mock('../services/chatflows', () => ({
    __esModule: true,
    default: { getChatflowByApiKey: async () => boundRows.map((row) => ({ ...row })) }
}))
jest.mock('../services/schedule', () => ({ __esModule: true, default: {} }))
jest.mock('../schedule/ScheduleBeat', () => ({ ScheduleBeat: { getInstance: jest.fn() } }))

import nodeLoadMethodRouter from './node-load-methods'
import chatflowsRouter from './chatflows'

const PERMISSIONS = ['chatflows:view', 'chatflows:update', 'agentflows:view']
const person = {
    id: 'user-1',
    activeOrganizationId: 'org-1',
    activeWorkspaceId: 'team-a',
    isOrganizationAdmin: true,
    permissions: PERMISSIONS
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
            validateAPIKey: async (req) =>
                req.headers.authorization === 'Bearer bakery-token-1'
                    ? { isValid: true, apiKey: { id: 'key-bakery', workspaceId: 'team-a', permissions: PERMISSIONS } }
                    : { isValid: false },
            attachIdentitySession: async (req) => (req.headers.cookie === 'session=ok' ? { ...person } : null)
        })
    )
    server.use('/api/v1/node-load-method', nodeLoadMethodRouter)
    server.use('/api/v1/chatflows', chatflowsRouter)
    return request(server)
}

/** Each word of each fixed segment after /api/v1/ capitalised, and in mixed case. `keep` names route parameters. */
function spellings(path: string, keep: string[] = []): string[] {
    const recase = (fn: (word: string) => string) =>
        path.replace(
            /^\/api\/v1\/(.*)$/,
            (_all, rest: string) =>
                '/api/v1/' +
                rest
                    .split('/')
                    .map((segment) =>
                        /^[a-z-]+$/.test(segment) && !keep.includes(segment) ? segment.split('-').map(fn).join('-') : segment
                    )
                    .join('/')
        )
    return [
        recase((word) => word.charAt(0).toUpperCase() + word.slice(1)),
        recase((word) =>
            word
                .split('')
                .map((ch, i) => (i % 2 ? ch.toUpperCase() : ch))
                .join('')
        )
    ]
}

beforeAll(() => setTeamPermissionLookup({ accessFor: async () => ({ owner: true, permissions: null }) }))
afterAll(() => setTeamPermissionLookup(null))

beforeEach(() => {
    keys.clear()
    keys.set('key-bakery', { id: 'key-bakery', workspaceId: 'team-a', harnesses: ['bakery'] })
})

describe("the Harness card's picker lists only the key's harnesses", () => {
    it('leaves harnesses off the list out, in every case, and a person sees the whole team', async () => {
        const path = '/api/v1/node-load-method/harness'
        for (const spelled of [path, ...spellings(path, ['harness'])]) {
            const res = await app().post(spelled).set('Authorization', 'Bearer bakery-token-1').send({ loadMethod: 'listHarnesses' })
            expect({ spelled, status: res.status, names: res.body.map?.((row: { name: string }) => row.name) }).toEqual({
                spelled,
                status: 200,
                names: ['bakery']
            })
        }
        keys.set('key-bakery', { id: 'key-bakery', workspaceId: 'team-b', harnesses: ['bakery'] })
        const otherTeam = await app().post(path).set('Authorization', 'Bearer bakery-token-1').send({ loadMethod: 'listHarnesses' })
        expect(otherTeam.body).toEqual([])
        const signedIn = await app()
            .post(path)
            .set({ Cookie: 'session=ok', 'x-request-from': 'internal' })
            .send({ loadMethod: 'listHarnesses' })
        expect(signedIn.body.map((row: { name: string }) => row.name)).toEqual(['bakery', 'payroll'])
    })
})

describe('GET /chatflows/apikey hides HARNESS canvases off the key list', () => {
    it("lists the key's bound flows without a HARNESS canvas it may not run, in every case", async () => {
        const path = '/api/v1/chatflows/apikey'
        const bearer = { Authorization: 'Bearer bakery-token-1' }
        for (const spelled of [path, `${path}/`, ...spellings(path)]) {
            const res = await app().get(spelled).set(bearer)
            expect({ spelled, status: res.status, ids: res.body.map?.((row: { id: string }) => row.id) }).toEqual({
                spelled,
                status: 200,
                ids: ['flow-1', 'flow-2']
            })
        }
        keys.set('key-bakery', { id: 'key-bakery', workspaceId: 'team-a', harnesses: null })
        expect((await app().get(path).set(bearer)).body.map((row: { id: string }) => row.id)).toEqual(['flow-1'])
    })
})
