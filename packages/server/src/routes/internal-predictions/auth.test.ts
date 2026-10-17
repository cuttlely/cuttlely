import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { apiV1Auth } from '../../identity/apiGate'
import { API_KEY_BLACKLIST_URLS, WHITELIST_URLS } from '../../utils/constants'

const handled: string[] = []

jest.mock('../../controllers/internal-predictions', () => ({
    __esModule: true,
    default: {
        createInternalPrediction: (req: Request, res: Response) => {
            handled.push(req.params.id || '')
            res.json({ text: 'draft answer' })
        }
    }
}))

jest.mock('../../utils', () => ({
    getMulterStorage: () => ({ array: () => (_req: Request, _res: Response, next: NextFunction) => next() })
}))

import internalPredictionRouter from './index'

const FLOW_ID = '11111111-1111-4111-8111-111111111111'

const sessionUser = {
    id: 'user-1',
    activeOrganizationId: 'org-1',
    activeWorkspaceId: 'ws-1',
    permissions: ['chatflows:view']
}

function app() {
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
            apiKeyBlacklistURLs: API_KEY_BLACKLIST_URLS,
            licenseRequired: () => false,
            dataSource,
            // A key with no permissions at all, which is the case that ran the draft before.
            validateAPIKey: async (req) =>
                req.headers.authorization === 'Bearer empty-key'
                    ? { isValid: true, apiKey: { id: 'key-1', workspaceId: 'ws-1', permissions: [] } }
                    : { isValid: false },
            attachIdentitySession: async (req) => (req.headers.cookie === 'session=ok' ? { ...sessionUser } : null)
        })
    )
    server.use('/api/v1/internal-prediction', internalPredictionRouter)
    return request(server)
}

describe('POST /api/v1/internal-prediction through the API gate', () => {
    beforeEach(() => {
        handled.length = 0
    })

    it('refuses an API key, so a key cannot run a draft harness or chatflow', async () => {
        const res = await app()
            .post(`/api/v1/internal-prediction/${FLOW_ID}`)
            .set('Authorization', 'Bearer empty-key')
            .send({ question: 'How many loaves?' })
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'Unauthorized Access' })
        const stream = await app()
            .post(`/api/v1/internal-prediction/stream/${FLOW_ID}`)
            .set('Authorization', 'Bearer empty-key')
            .send({ question: 'How many loaves?' })
        expect(stream.status).toBe(401)
        expect(handled).toEqual([])
    })

    it('still serves the signed-in chat', async () => {
        const res = await app()
            .post(`/api/v1/internal-prediction/${FLOW_ID}`)
            .set('Cookie', 'session=ok')
            .set('x-request-from', 'internal')
            .send({ question: 'How many loaves?' })
        expect(res.status).toBe(200)
        expect(handled).toEqual([FLOW_ID])
    })
})
