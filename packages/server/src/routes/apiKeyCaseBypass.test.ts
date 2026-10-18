/**
 * Express matches routes without regard to letter case, so the API gate's lists must too. Each case goes through the
 * real gate with the real lists and the real routers. A request that reaches a handler was let through.
 */
import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { apiV1Auth } from '../identity/apiGate'
import { API_KEY_BLACKLIST_URLS, WHITELIST_URLS } from '../utils/constants'

const built: unknown[] = []
const canvasRuns: unknown[] = []

jest.mock('../utils', () => ({
    getMulterStorage: () => ({ array: () => (_req: Request, _res: Response, next: NextFunction) => next() })
}))
jest.mock('../utils/buildChatflow', () => ({
    utilBuildChatflow: async (...args: unknown[]) => {
        built.push(args[3])
        return { text: 'draft answer' }
    }
}))
jest.mock('../services/chatflows', () => ({
    __esModule: true,
    default: {
        getChatflowByIdForWorkspace: async (id: string) =>
            id === HARNESS_ID
                ? { id, name: 'payroll', type: 'HARNESS', flowData: '{"nodes":[],"edges":[]}', workspaceId: 'ws-1' }
                : { id, name: 'Support', type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}', workspaceId: 'ws-1' }
    }
}))
jest.mock('../services/harnesses', () => ({
    __esModule: true,
    default: {
        startCanvasRun: async (_flow: unknown, _body: unknown, opts: unknown) => {
            canvasRuns.push(opts)
            return { chatId: 'c1', run: null, payload: { text: 'team answer' } }
        },
        chatImages: () => []
    }
}))
jest.mock('../utils/sessionOwnership', () => ({ bindRequestSession: jest.fn() }))
jest.mock('../utils/getRunningExpressApp', () => ({ getRunningExpressApp: () => ({}) }))
jest.mock('../DataSource', () => ({
    getDataSource: () => ({ getRepository: () => ({ findOneBy: async () => null, findOne: async () => null }) })
}))

import internalPredictionRouter from './internal-predictions'

const FLOW_ID = '11111111-1111-4111-8111-111111111111'
const HARNESS_ID = '22222222-2222-4222-8222-222222222222'
const KEY = { Authorization: 'Bearer empty-key' }
const SESSION = { Cookie: 'session=ok', 'x-request-from': 'internal' }

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

function app(opts: { blacklist?: string[] } = {}) {
    const dataSource = {
        getRepository: (entity: { name?: string }) => ({
            findOne: async () => (entity?.name === 'Workspace' ? { id: 'ws-1', name: 'Team', organizationId: 'org-1' } : { id: 'org-1' })
        })
    } as unknown as DataSource
    const server = express()
    server.use(express.json())
    server.use(
        apiV1Auth({
            whitelistURLs: WHITELIST_URLS,
            apiKeyBlacklistURLs: opts.blacklist ?? API_KEY_BLACKLIST_URLS,
            licenseRequired: () => false,
            dataSource,
            validateAPIKey: async (req) =>
                req.headers.authorization === 'Bearer empty-key'
                    ? { isValid: true, apiKey: { id: 'key-1', workspaceId: 'ws-1', permissions: [] } }
                    : { isValid: false },
            attachIdentitySession: async (req) =>
                req.headers.cookie === 'session=ok'
                    ? { id: 'user-1', activeOrganizationId: 'org-1', activeWorkspaceId: 'ws-1', permissions: ['chatflows:view'] }
                    : null
        })
    )
    // Mounted as in routes/index.ts, so `/api/v1//internal-prediction` routes as it does on the server.
    const api = express.Router()
    api.use('/internal-prediction', internalPredictionRouter)
    server.use('/api/v1', api)
    // Stands in for every other router: reaching it means the gate let the request through.
    server.use('/api/v1', (req, res) => res.json({ reached: req.path }))
    return request(server)
}

beforeEach(() => {
    built.length = 0
    canvasRuns.length = 0
})

describe('the API gate lists ignore letter case', () => {
    it('refuses an API key on a capitalised or mixed-case in-app prediction path', async () => {
        for (const path of [`/api/v1/internal-prediction/${FLOW_ID}`, `/api/v1/internal-prediction/${HARNESS_ID}`]) {
            for (const spelled of spellings(path)) {
                const res = await app().post(spelled).set(KEY).send({ question: 'How many loaves?' })
                expect({ spelled, status: res.status, body: res.body }).toEqual({
                    spelled,
                    status: 401,
                    body: { error: 'Unauthorized Access' }
                })
            }
        }
        expect(built).toEqual([])
        expect(canvasRuns).toEqual([])
        const [, mixed] = spellings(`/api/v1/internal-prediction/${FLOW_ID}`)
        expect((await app().post(mixed).set(SESSION).send({ question: 'How many loaves?' })).status).toBe(200)
        expect(built).toEqual([{ testDraft: true, harnessCaller: { via: 'session' } }])
    })

    it('refuses an API key on every key-refused prefix, capitalised and in mixed case', async () => {
        // /api/v1/server-setup is on both lists: the public list wins and that route guards itself.
        const refused = API_KEY_BLACKLIST_URLS.filter((prefix) => !WHITELIST_URLS.some((url) => `${prefix}/x`.startsWith(url)))
        expect(refused).toContain('/api/v1/internal-prediction')
        for (const prefix of refused) {
            for (const spelled of spellings(`${prefix}/x`)) {
                const res = await app().get(spelled).set(KEY)
                expect({ spelled, status: res.status }).toEqual({ spelled, status: 401 })
            }
        }
    })

    it('treats a public path in any case as public, as the router does', async () => {
        for (const spelled of spellings('/api/v1/ping')) {
            const res = await app().get(spelled)
            expect({ spelled, status: res.status }).toEqual({ spelled, status: 200 })
        }
    })
})

describe('the API gate collapses repeated slashes, as the router does', () => {
    it('refuses an API key on every key-refused prefix and the in-app prediction path with a doubled slash', async () => {
        const refused = API_KEY_BLACKLIST_URLS.filter((prefix) => !WHITELIST_URLS.some((url) => `${prefix}/x`.startsWith(url)))
        for (const prefix of refused) {
            for (const spelled of [prefix.replace('/api/v1/', '/api/v1//'), prefix.replace('/api/v1/', '/api/v1///')]) {
                const res = await app().get(`${spelled}/x`).set(KEY)
                expect({ spelled, status: res.status }).toEqual({ spelled, status: 401 })
            }
        }
        for (const path of [`/api/v1//internal-prediction/${FLOW_ID}`, `/api/v1//Internal-Prediction/${HARNESS_ID}`]) {
            const res = await app().post(path).set(KEY).send({ question: 'How many loaves?' })
            expect({ path, status: res.status }).toEqual({ path, status: 401 })
        }
        expect(built).toEqual([])
        expect(canvasRuns).toEqual([])
    })
})

describe('the in-app prediction route refuses an API key on its own', () => {
    it('answers 401 to a key that gets past the gate, for a chatflow and a harness canvas, in any case', async () => {
        for (const path of [`/api/v1/internal-prediction/${FLOW_ID}`, `/api/v1/internal-prediction/${HARNESS_ID}`]) {
            for (const spelled of [path, ...spellings(path)]) {
                const res = await app({ blacklist: [] }).post(spelled).set(KEY).send({ question: 'How many loaves?' })
                expect({ spelled, status: res.status }).toEqual({ spelled, status: 401 })
            }
        }
        expect(built).toEqual([])
        expect(canvasRuns).toEqual([])
        const res = await app({ blacklist: [] }).post(`/api/v1/internal-prediction/${HARNESS_ID}`).set(SESSION).send({ question: 'Hi' })
        expect(res.status).toBe(200)
        expect(canvasRuns).toEqual([{ source: 'playground', caller: { via: 'session' } }])
    })
})
