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

import express, { Request } from 'express'
import request from 'supertest'
import { identityRoleRouter, identityUsersRouter } from './directoryRoutes'
import { setTeamPermissionLookup } from './rbac'

jest.mock('../DataSource', () => ({
    getDataSource: () => ({ options: { type: 'sqlite' } })
}))

function app() {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        req.user = {
            id: 'user-1',
            activeOrganizationId: 'org-1',
            activeWorkspaceId: 'team-1',
            permissions: []
        }
        next()
    })
    server.use('/api/v1/users', identityUsersRouter)
    server.use((error: Error, _req: Request, res: express.Response, _next: express.NextFunction) => {
        if (!res.headersSent) res.status(500).json({ message: error.message })
    })
    return server
}

describe('local user route validation', () => {
    const previous = process.env.CUTTLELY_LOCAL_USERS
    const previousKey = process.env.WORKOS_API_KEY
    const previousClient = process.env.WORKOS_CLIENT_ID

    beforeAll(() => {
        process.env.CUTTLELY_LOCAL_USERS = 'true'
        delete process.env.WORKOS_API_KEY
        delete process.env.WORKOS_CLIENT_ID
        setTeamPermissionLookup({
            accessFor: async () => ({ owner: true, permissions: [] })
        })
    })

    afterAll(() => {
        if (previous === undefined) delete process.env.CUTTLELY_LOCAL_USERS
        else process.env.CUTTLELY_LOCAL_USERS = previous
        if (previousKey === undefined) delete process.env.WORKOS_API_KEY
        else process.env.WORKOS_API_KEY = previousKey
        if (previousClient === undefined) delete process.env.WORKOS_CLIENT_ID
        else process.env.WORKOS_CLIENT_ID = previousClient
        setTeamPermissionLookup(null)
    })

    it('returns 400 for a bad page and a non-boolean disabled flag', async () => {
        const server = app()
        const limit = await request(server).get('/api/v1/users?limit=0')
        expect(limit.status).toBe(400)
        expect(limit.body).toEqual({ message: 'limit must be from 1 to 100' })
        const offset = await request(server).get('/api/v1/users?offset=-1')
        expect(offset.status).toBe(400)
        expect(offset.body).toEqual({ message: 'offset must be 0 or greater' })
        const sessions = await request(server).get('/api/v1/users/user-2/sessions?limit=0')
        expect(sessions.status).toBe(400)
        expect(sessions.body).toEqual({ message: 'limit must be from 1 to 100' })
        const disabled = await request(server).patch('/api/v1/users/user-2').send({ disabled: 'yes' })
        expect(disabled.status).toBe(400)
        expect(disabled.body).toEqual({ message: 'disabled must be true or false' })
    })
})

describe('role list route permission', () => {
    function roleApp() {
        const server = express()
        server.use(express.json())
        server.use((req, _res, next) => {
            req.user = { id: 'user-1', activeOrganizationId: 'org-1', activeWorkspaceId: 'team-1', permissions: [] }
            next()
        })
        server.use('/api/v1/role', identityRoleRouter)
        server.use((error: Error, _req: Request, res: express.Response, _next: express.NextFunction) => {
            if (!res.headersSent) res.status(500).json({ message: error.message })
        })
        return server
    }

    afterEach(() => setTeamPermissionLookup(null))

    it('lets workspace:update read the role list for Change role, and keeps role writes on roles:manage', async () => {
        setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: ['chatflows:view'] }) })
        expect((await request(roleApp()).get('/api/v1/role?organizationId=org-1')).status).toBe(403)
        setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: ['workspace:update'] }) })
        expect((await request(roleApp()).get('/api/v1/role?organizationId=org-1')).status).not.toBe(403)
        expect((await request(roleApp()).post('/api/v1/role').send({ name: 'Lead', permissions: '[]' })).status).toBe(403)
    })
})
