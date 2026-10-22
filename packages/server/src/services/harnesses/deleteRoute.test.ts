import express, { Request } from 'express'
import request from 'supertest'
import { setTeamPermissionLookup } from '../../identity/rbac'
import { builtInPermissionKeys } from '../../identity/builtInRoles'
import { TeamAccess } from '../../identity/sqlStore'

const deleted: string[] = []

jest.mock('.', () => ({
    __esModule: true,
    loadHarness: jest.fn(),
    default: {
        deleteHarness: async (name: string) => {
            deleted.push(name)
            return { name, deleted: true }
        }
    }
}))
jest.mock('../../identity/production', () => ({ applicationSql: () => ({}) }))
jest.mock('../../identity/auditLog', () => ({ safeRecordAudit: async () => undefined }))

import harnessesRouter from '../../routes/harnesses'
import { setHarnessFlowLookup, setHarnessKeyLookup } from './apiAccess'

const access = new Map<string, TeamAccess>()

function app() {
    const server = express()
    server.use((req, _res, next) => {
        ;(req as Request).user = { id: 'user-1', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-1', permissions: [] } as any
        next()
    })
    const api = express.Router()
    api.use('/harnesses', harnessesRouter)
    server.use('/api/v1', api)
    server.use((error: { statusCode?: number; message?: string }, _req: Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error.statusCode || 500).json({ message: error.message })
    })
    return server
}

describe('DELETE /harnesses/:name', () => {
    beforeEach(() => {
        deleted.length = 0
        access.clear()
        setTeamPermissionLookup({ accessFor: async (u, w) => access.get(`${u}|${w}`) || { owner: false, permissions: null } })
        setHarnessFlowLookup(async () => null)
        setHarnessKeyLookup(async () => null)
    })
    afterEach(() => {
        setTeamPermissionLookup(null)
        setHarnessFlowLookup(null)
        setHarnessKeyLookup(null)
    })

    it('lets an owner delete', async () => {
        access.set('user-1|team-a', { owner: true, permissions: null })
        const res = await request(app()).delete('/api/v1/harnesses/navi')
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ name: 'navi', deleted: true })
        expect(deleted).toEqual(['navi'])
    })

    it('lets an editor (builder role) delete', async () => {
        access.set('user-1|team-a', { owner: false, permissions: builtInPermissionKeys('builder') })
        const res = await request(app()).delete('/api/v1/harnesses/NAVI-B')
        expect(res.status).toBe(200)
        expect(deleted).toEqual(['NAVI-B'])
    })

    it('refuses a viewer with 403 and deletes nothing', async () => {
        access.set('user-1|team-a', { owner: false, permissions: builtInPermissionKeys('viewer') })
        const res = await request(app()).delete('/api/v1/harnesses/navi-harness')
        expect(res.status).toBe(403)
        expect(deleted).toEqual([])
    })

    it('refuses someone with no role in the team with 403', async () => {
        const res = await request(app()).delete('/api/v1/harnesses/navi')
        expect(res.status).toBe(403)
        expect(deleted).toEqual([])
    })
})
