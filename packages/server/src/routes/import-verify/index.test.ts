import express, { Request } from 'express'
import request from 'supertest'
import { setTeamPermissionLookup } from '../../identity/rbac'

jest.mock('../../controllers/import-verify', () => ({
    __esModule: true,
    default: new Proxy(
        {},
        {
            get: () => (_req: Request, res: express.Response) => {
                res.status(200).json({ ok: true })
            }
        }
    )
}))

import importVerifyRouter from './index'

const memberships = new Map<string, { owner: boolean; permissions: string[] | null }>()

const call = (user: object, method: 'get' | 'post', path: string) => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
        ;(req as Request).user = user as Express.User
        next()
    })
    app.use(importVerifyRouter)
    return request(app)[method](path)
}

describe('import-verify credential permission', () => {
    beforeEach(() => {
        memberships.clear()
        setTeamPermissionLookup({
            async accessFor(userId, workspaceId) {
                return memberships.get(`${userId}|${workspaceId}`) || { owner: false, permissions: null }
            }
        })
    })

    afterEach(() => {
        setTeamPermissionLookup(null)
    })

    test('an update-only role cannot list or run a check', async () => {
        memberships.set('user-1|team-a', { owner: false, permissions: ['chatflows:update'] })
        const user = { id: 'user-1', activeWorkspaceId: 'team-a', permissions: [], isOrganizationAdmin: false }
        const flowId = '/0b5c3a1e-1111-2222-3333-444455556666'
        expect((await call(user, 'get', flowId)).status).toBe(403)
        expect((await call(user, 'post', flowId)).status).toBe(403)
        memberships.set('user-1|team-a', { owner: false, permissions: ['chatflows:update', 'credentials:view'] })
        expect((await call(user, 'get', flowId)).status).toBe(200)
        expect((await call(user, 'post', flowId)).status).toBe(200)
        memberships.set('user-1|team-a', { owner: false, permissions: ['assistants:update', 'credentials:view'] })
        expect((await call(user, 'post', flowId)).status).toBe(200)
        memberships.set('user-1|team-a', { owner: false, permissions: ['assistants:update'] })
        expect((await call(user, 'post', flowId)).status).toBe(403)
    })
})
