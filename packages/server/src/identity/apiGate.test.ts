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
import { apiV1Auth, ApiV1AuthDeps, isMcpEndpointPath, normalizeApiPath, withoutDenylisted } from './apiGate'

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

function app(overrides: Partial<ApiV1AuthDeps> = {}, echoUser = false) {
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
    server.use((req: Request, res: Response) => {
        res.status(200).json(echoUser ? { passed: true, user: req.user ?? null } : { passed: true })
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

    it('matches a trailing-slash entry with and without the slash, and only that entry', async () => {
        const gate = (path: string) =>
            app({
                whitelistURLs: ['/api/v1/verify/apikey/', '/api/v1/ping'],
                validateAPIKey: async () => ({ isValid: false })
            }).get(path)
        expect((await gate('/api/v1/verify/apikey')).status).toBe(200)
        expect((await gate('/api/v1/verify/apikey/')).status).toBe(200)
        expect((await gate('/api/v1/verify/apike')).status).toBe(401)
        expect((await gate('/api/v1/pin')).status).toBe(401)
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

    it('returns 401 for an API-key-blacklisted path in another letter case or with repeated slashes', async () => {
        const server = app({ validateAPIKey: async () => validKey, apiKeyBlacklistURLs: ['/api/v1/files'] })
        for (const path of ['/api/v1/Files', '/api/v1//files', '/api/v1//FILES', '/api/v1///files/x']) {
            const res = await server.get(path).set('Authorization', 'Bearer good-key')
            expect({ path, status: res.status }).toEqual({ path, status: 401 })
        }
        expect((await server.get('/api/v1/chatflows').set('Authorization', 'Bearer good-key')).status).toBe(200)
    })

    it('matches a capitalized public entry in any letter case and with repeated slashes', async () => {
        const server = app({ whitelistURLs: ['/api/v1/public-chatbotConfig'], validateAPIKey: async () => ({ isValid: false }) })
        for (const path of [
            '/api/v1/public-chatbotConfig/flow-1',
            '/api/v1/public-chatbotconfig/flow-1',
            '/api/v1//public-chatbotConfig'
        ]) {
            expect({ path, status: (await server.get(path)).status }).toEqual({ path, status: 200 })
        }
        expect((await server.get('/api/v1/public-chatflows')).status).toBe(401)
    })

    it('lowercases ASCII letters only, as Express routing does', () => {
        expect(normalizeApiPath('/API/v1//Public-ChatbotConfig')).toBe('/api/v1/public-chatbotconfig')
        expect(normalizeApiPath('/api/v1/chatflows/api\u212Aey/')).toBe('/api/v1/chatflows/api\u212Aey/')
        expect(normalizeApiPath('/api/v1/\u0130tems')).toBe('/api/v1/\u0130tems')
    })

    it('recognizes remote MCP Streamable HTTP paths and not mcp-server', () => {
        expect(isMcpEndpointPath('/api/v1/mcp')).toBe(true)
        expect(isMcpEndpointPath('/api/v1/mcp/')).toBe(true)
        expect(isMcpEndpointPath('/api/v1/mcp/flow-123')).toBe(true)
        expect(isMcpEndpointPath('/API/v1//MCP/flow-123')).toBe(true)
        expect(isMcpEndpointPath('/api/v1/mcp-server/flow-123')).toBe(false)
        expect(isMcpEndpointPath('/api/v1/prediction/flow-123')).toBe(false)
        expect(isMcpEndpointPath('/chatflows')).toBe(false)
    })

    it('treats an entry in readOnlyWhitelistURLs as public for GET and HEAD only', async () => {
        const server = app({
            whitelistURLs: ['/api/v1/chatflows/apikey/', '/api/v1/ping'],
            readOnlyWhitelistURLs: ['/api/v1/chatflows/apikey/'],
            validateAPIKey: async () => ({ isValid: false })
        })
        expect((await server.get('/api/v1/chatflows/apikey/')).status).toBe(200)
        expect((await server.head('/api/v1/Chatflows/apikey')).status).toBe(200)
        expect((await server.post('/api/v1/chatflows/apikey')).status).toBe(401)
        expect((await server.put('/api/v1/chatflows/apikey/')).status).toBe(401)
        expect((await server.delete('/api/v1//chatflows/apikey')).status).toBe(401)
        expect((await server.post('/api/v1/ping')).status).toBe(200)
    })

    it('drops DENYLIST_URLS entries from the public list in any letter case, slash run or surrounding space', () => {
        const list = ['/api/v1/ping', '/api/v1/public-chatbotConfig', '/api/v1/version']
        expect(withoutDenylisted(list, undefined)).toEqual(list)
        expect(withoutDenylisted(list, '')).toEqual(list)
        expect(withoutDenylisted(list, '/api/v1/public-chatbotconfig, /API/v1//ping')).toEqual(['/api/v1/version'])
        expect(withoutDenylisted(list, '/api/v1/pin')).toEqual(list)
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

    it('attaches each API key id for two keys in one workspace and does not attach the secret', async () => {
        const secret = 'bearer-token-value-not-stored'
        const keys: Record<string, { id: string; workspaceId: string; permissions: string[]; apiKey: string; apiSecret: string }> = {
            'key-a': { id: 'key-a', workspaceId: 'ws-1', permissions: ['chatflows:view'], apiKey: secret, apiSecret: secret },
            'key-b': { id: 'key-b', workspaceId: 'ws-1', permissions: ['chatflows:view'], apiKey: secret, apiSecret: secret }
        }
        const validateAPIKey = async (req: Request) => {
            const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
            const apiKey = keys[token]
            return apiKey ? { isValid: true, apiKey } : { isValid: false }
        }
        const server = app({ validateAPIKey }, true)
        const first = await server.get('/api/v1/flow-drafts/flow-1/check/history').set('Authorization', 'Bearer key-a')
        const second = await server.get('/api/v1/flow-drafts/flow-1/check/history').set('Authorization', 'Bearer key-b')
        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(first.body.user.apiKeyId).toBe('key-a')
        expect(second.body.user.apiKeyId).toBe('key-b')
        expect(first.body.user.activeWorkspaceId).toBe('ws-1')
        expect(second.body.user.activeWorkspaceId).toBe('ws-1')
        expect(first.body.user.apiKey).toBeUndefined()
        expect(first.body.user.apiSecret).toBeUndefined()
        expect(JSON.stringify(first.body)).not.toContain(secret)
        expect(JSON.stringify(second.body)).not.toContain(secret)
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
