/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import express, { Request, Response } from 'express'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { apiV1Auth, ApiV1AuthDeps } from './apiGate'

const validKey = {
    isValid: true,
    apiKey: { workspaceId: 'ws-1', permissions: ['chatflows:view'] }
}

const sessionUser = { permissions: ['chatflows:view'] }

function dataSource(found: { workspace?: object | null; organization?: object | null } = {}) {
    const workspace = 'workspace' in found ? found.workspace : { id: 'ws-1', name: 'Team', organizationId: 'org-1' }
    const organization = 'organization' in found ? found.organization : { id: 'org-1', subscriptionId: 'sub-1', customerId: 'cus-1' }
    return {
        getRepository(entity: { name?: string }) {
            return {
                findOne: async () => {
                    if (entity?.name === 'Workspace') return workspace
                    if (entity?.name === 'Organization') return organization
                    return null
                }
            }
        }
    } as unknown as DataSource
}

function app(overrides: Partial<ApiV1AuthDeps> = {}) {
    const server = express()
    const deps: ApiV1AuthDeps = {
        whitelistURLs: ['/api/v1/ping'],
        apiKeyBlacklistURLs: ['/api/v1/account/delete'],
        licenseRequired: () => false,
        dataSource: dataSource(),
        validateAPIKey: async () => {
            throw new Error('validateAPIKey should not run')
        },
        attachIdentitySession: async () => null,
        ...overrides
    }
    server.use(apiV1Auth(deps))
    server.use((_req: Request, res: Response) => {
        res.status(200).json({ passed: true })
    })
    return request(server)
}

describe('apiV1Auth', () => {
    it('lets a path outside /api/v1 through', async () => {
        const res = await app().get('/assets/logo.svg')
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ passed: true })
    })

    it('returns 401 for a mixed-case /API/V1/ path', async () => {
        const res = await app().get('/API/V1/nodes')
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'Unauthorized Access' })
    })

    it('lets a whitelisted path through with no credentials', async () => {
        const res = await app().get('/api/v1/ping')
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ passed: true })
    })

    it('returns 401 for a session POST without x-request-from internal, and passes with that header', async () => {
        const attachIdentitySession = async () => sessionUser
        const denied = await app({ attachIdentitySession }).post('/api/v1/chatflows')
        const allowed = await app({ attachIdentitySession }).post('/api/v1/chatflows').set('x-request-from', 'internal')
        expect(denied.status).toBe(401)
        expect(denied.body).toEqual({ message: 'Unauthorized' })
        expect(allowed.status).toBe(200)
        expect(allowed.body).toEqual({ passed: true })
    })

    it('returns 401 for x-request-from internal when there is no session', async () => {
        const res = await app().get('/api/v1/chatflows').set('x-request-from', 'internal')
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'Unauthorized Access' })
    })

    it('returns 401 for an API-key-blacklisted path even with a valid key', async () => {
        const res = await app({ validateAPIKey: async () => validKey })
            .get('/api/v1/account/delete')
            .set('Authorization', 'Bearer good-key')
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'Unauthorized Access' })
    })

    it('returns 401 when a license is required even with a valid key', async () => {
        const res = await app({
            licenseRequired: () => true,
            validateAPIKey: async () => validKey
        })
            .get('/api/v1/chatflows')
            .set('Authorization', 'Bearer good-key')
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'Unauthorized Access' })
    })

    it('returns 401 when a valid key has no workspace or no organization', async () => {
        const validateAPIKey = async () => validKey
        const noWorkspace = await app({ validateAPIKey, dataSource: dataSource({ workspace: null }) })
            .get('/api/v1/chatflows')
            .set('Authorization', 'Bearer good-key')
        const noOrganization = await app({ validateAPIKey, dataSource: dataSource({ organization: null }) })
            .get('/api/v1/chatflows')
            .set('Authorization', 'Bearer good-key')
        expect(noWorkspace.status).toBe(401)
        expect(noWorkspace.body).toEqual({ error: 'Unauthorized Access' })
        expect(noOrganization.status).toBe(401)
        expect(noOrganization.body).toEqual({ error: 'Unauthorized Access' })
    })
})
