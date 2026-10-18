import express, { Request } from 'express'
import request from 'supertest'
import { setTeamPermissionLookup } from '../../identity/rbac'
import { TeamAccess } from '../../identity/sqlStore'

const saved: Array<{ name: string; body: unknown; ownerId: string }> = []
const statusChanges: string[] = []
const scheduleReads: unknown[] = []

jest.mock('.', () => ({
    __esModule: true,
    loadHarness: jest.fn(),
    default: {
        getHarnessSchedule: async (...args: unknown[]) => {
            scheduleReads.push(args[2])
            return { schedule: null }
        },
        saveHarnessSchedule: async (name: string, body: unknown, opts: { ownerId: string }) => {
            saved.push({ name, body, ownerId: opts.ownerId })
            return { schedule: { harness: name, cron: '0 7 * * 1-5', timezone: 'Europe/Paris', status: 'active' } }
        },
        setHarnessScheduleStatus: async (name: string, status: string, _workspaceId: string, opts?: { ownerId?: string }) => {
            statusChanges.push(`${name} ${status}${opts?.ownerId ? ` ${opts.ownerId}` : ''}`)
            return { schedule: { harness: name, status } }
        },
        deleteHarnessSchedule: async (name: string) => ({ harness: name, deleted: true })
    }
}))

jest.mock('../../identity/production', () => ({ applicationSql: () => ({}) }))
jest.mock('../../identity/auditLog', () => ({ safeRecordAudit: async () => undefined }))

import harnessesRouter from '../../routes/harnesses'
import { setHarnessKeyLookup } from './apiAccess'
import { ownerMayRun } from './schedules'

const access = new Map<string, TeamAccess>()

function app(user: object) {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        ;(req as Request).user = { ...user } as Express.User
        next()
    })
    server.use('/api/v1/harnesses', harnessesRouter)
    server.use((error: { statusCode?: number; message?: string }, _req: Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error.statusCode || 500).json({ message: error.message })
    })
    return server
}

const person = { id: 'user-1', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-1', permissions: [] }
const apiKey = {
    apiKeyId: 'key-1',
    activeWorkspaceId: 'team-a',
    activeOrganizationId: 'org-1',
    permissions: ['chatflows:view', 'chatflows:create']
}
const body = { cron: '0 7 * * 1-5', timezone: 'Europe/Paris', question: "Summarise yesterday's bakery orders." }

describe('harness schedules', () => {
    beforeEach(() => {
        saved.length = 0
        statusChanges.length = 0
        scheduleReads.length = 0
        access.clear()
        setTeamPermissionLookup({
            accessFor: async (userId, workspaceId) => access.get(`${userId}|${workspaceId}`) || { owner: false, permissions: null }
        })
        setHarnessKeyLookup(async () => ({ workspaceId: 'team-a', harnesses: ['bakery'] }))
    })

    afterEach(() => {
        setTeamPermissionLookup(null)
        setHarnessKeyLookup(null)
    })

    it('saves a schedule owned by the person who saved it', async () => {
        access.set('user-1|team-a', { owner: false, permissions: ['chatflows:view', 'chatflows:update'] })
        const res = await request(app(person)).put('/api/v1/harnesses/bakery/schedule').send(body)
        expect(res.status).toBe(200)
        expect(saved).toEqual([{ name: 'bakery', body, ownerId: 'user-1' }])
    })

    it('refuses an API key, even one that may run the harness, because a schedule runs as a person', async () => {
        const res = await request(app(apiKey)).put('/api/v1/harnesses/bakery/schedule').send(body)
        expect(res.status).toBe(403)
        expect(res.body.message).toBe('A schedule runs as a person, so an API key cannot change one. Sign in to set it.')
        expect((await request(app(apiKey)).post('/api/v1/harnesses/bakery/schedule/pause')).status).toBe(403)
        expect(saved).toEqual([])
        expect(statusChanges).toEqual([])
    })

    it('needs a run permission to pause and resume, and resuming makes that person the owner', async () => {
        access.set('user-1|team-a', { owner: false, permissions: ['chatflows:view'] })
        expect((await request(app(person)).post('/api/v1/harnesses/bakery/schedule/pause')).status).toBe(403)
        access.set('user-1|team-a', { owner: false, permissions: ['chatflows:view', 'chatflows:create'] })
        expect((await request(app(person)).post('/api/v1/harnesses/bakery/schedule/pause')).status).toBe(200)
        expect((await request(app(person)).post('/api/v1/harnesses/bakery/schedule/resume')).status).toBe(200)
        expect(statusChanges).toEqual(['bakery paused', 'bakery active user-1'])
    })

    it('lets an API key read the schedule only for a harness on its list', async () => {
        expect((await request(app(apiKey)).get('/api/v1/harnesses/bakery/schedule')).status).toBe(200)
        expect((await request(app(apiKey)).get('/api/v1/harnesses/payroll/schedule')).status).toBe(403)
    })

    it('asks for the API key view of a schedule, without the owner email or id, only for an API key', async () => {
        await request(app(apiKey)).get('/api/v1/harnesses/bakery/schedule')
        access.set('user-1|team-a', { owner: false, permissions: ['chatflows:view'] })
        await request(app(person)).get('/api/v1/harnesses/bakery/schedule')
        expect(scheduleReads).toEqual([{ apiKeyCaller: true }, { apiKeyCaller: false }])
    })

    it('runs a schedule only while its owner can still run harnesses in that team', async () => {
        access.set('owner|team-a', { owner: true, permissions: null })
        access.set('builder|team-a', { owner: false, permissions: ['chatflows:view', 'chatflows:create'] })
        access.set('viewer|team-a', { owner: false, permissions: ['chatflows:view'] })
        expect(await ownerMayRun('owner', 'team-a')).toBe(true)
        expect(await ownerMayRun('builder', 'team-a')).toBe(true)
        expect(await ownerMayRun('viewer', 'team-a')).toBe(false)
        expect(await ownerMayRun('builder', 'team-b')).toBe(false)
        expect(await ownerMayRun('removed', 'team-a')).toBe(false)
        expect(await ownerMayRun('', 'team-a')).toBe(false)
    })
})
