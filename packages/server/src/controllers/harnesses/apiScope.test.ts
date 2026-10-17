import express, { Request } from 'express'
import request from 'supertest'

const calls: Array<{ fn: string; args: unknown[] }> = []

jest.mock('../../services/harnesses', () => ({
    __esModule: true,
    default: {
        listHarnesses: async () => [{ name: 'bakery' }, { name: 'payroll' }],
        listRuns: async (...args: unknown[]) => {
            calls.push({ fn: 'listRuns', args })
            return []
        },
        getRun: async (...args: unknown[]) => {
            calls.push({ fn: 'getRun', args })
            return { id: args[1] }
        },
        getRunResult: async (...args: unknown[]) => {
            calls.push({ fn: 'getRunResult', args })
            return { runId: args[1] }
        },
        startBackgroundRun: async (...args: unknown[]) => {
            calls.push({ fn: 'startBackgroundRun', args })
            return { runId: 'run_00000000-0000-4000-8000-000000000000', harness: 'bakery', chatId: 'api-1', status: 'queued' }
        }
    }
}))

jest.mock('../../services/harnesses/apiAccess', () => {
    const actual = jest.requireActual('../../services/harnesses/apiAccess')
    return { ...actual, noteBackgroundRunStarted: async () => undefined }
})

import controller from './index'
import { setHarnessKeyLookup } from '../../services/harnesses/apiAccess'

function app(user: object) {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        ;(req as Request).user = { ...user } as unknown as Express.User
        next()
    })
    server.get('/harnesses', controller.listHarnesses)
    server.get('/harnesses/:name/runs', controller.listRuns)
    server.get('/harnesses/:name/runs/:runId', controller.getRun)
    server.get('/harnesses/:name/runs/:runId/result', controller.getRunResult)
    server.post('/harnesses/:name/runs/async', controller.startBackgroundRun)
    return server
}

const viaKey = { apiKeyId: 'key-bakery', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-1' }
const person = { id: 'user-1', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-1' }

describe('harness controller scope for an API key', () => {
    beforeAll(() => setHarnessKeyLookup(async () => ({ workspaceId: 'team-a', harnesses: ['bakery'] })))
    afterAll(() => setHarnessKeyLookup(null))
    beforeEach(() => {
        calls.length = 0
    })

    it('lists only the harnesses on the key list, and every harness for a person', async () => {
        expect((await request(app(viaKey)).get('/harnesses')).body).toEqual([{ name: 'bakery' }])
        expect((await request(app(person)).get('/harnesses')).body).toEqual([{ name: 'bakery' }, { name: 'payroll' }])
    })

    it('reads runs scoped to the calling key, and unscoped for a person', async () => {
        const runId = 'run_00000000-0000-4000-8000-000000000000'
        await request(app(viaKey)).get('/harnesses/bakery/runs')
        await request(app(viaKey)).get(`/harnesses/bakery/runs/${runId}`)
        await request(app(viaKey)).get(`/harnesses/bakery/runs/${runId}/result`)
        await request(app(person)).get('/harnesses/bakery/runs')
        expect(calls.map((call) => [call.fn, call.args[call.args.length - 1]])).toEqual([
            ['listRuns', { apiKeyId: 'key-bakery' }],
            ['getRun', { apiKeyId: 'key-bakery' }],
            ['getRunResult', { apiKeyId: 'key-bakery' }],
            ['listRuns', { apiKeyId: null }]
        ])
    })

    it('starts a background run under the key and counts it as in progress', async () => {
        const res = await request(app(viaKey)).post('/harnesses/bakery/runs/async').send({ question: 'How many loaves?' })
        expect(res.status).toBe(202)
        const opts = calls[0].args[2] as { apiKeyId?: string; track?: unknown }
        expect(opts.apiKeyId).toBe('key-bakery')
        expect(typeof opts.track).toBe('function')
    })
})
