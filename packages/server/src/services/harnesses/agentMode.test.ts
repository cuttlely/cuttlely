import express from 'express'
import request from 'supertest'
import harnessesService, { setHarnessModuleLoader } from './index'
import harnessesRouter from '../../routes/harnesses'
import { setTeamPermissionLookup } from '../../identity/rbac'

jest.mock('../../utils/runtimeAvailability', () => ({ assertRuntimeAvailable: jest.fn() }))
jest.mock('../../metrics/tracing', () => ({ openHarnessRunTrace: () => ({ event: jest.fn(), finish: jest.fn(), fail: jest.fn() }) }))
jest.mock('../usage', () => ({ recordCompletedRun: jest.fn() }))
jest.mock('../../utils/nestedFlowCall', () => ({ nestedFlowCallerFromHarness: () => undefined }))

const dispatch = jest.fn(async (options: any) => {
    options.onRecorded({ id: 'run-example', mode: options.mode })
    return { text: 'The bakery has twelve loaves.' }
})
const caller = { via: 'session' as const }
const harness = { name: 'bakery', workspaceId: 'team-a', specialists: [] }
const runPermissions = ['chatflows:create']

function app(permissions = runPermissions) {
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => {
        req.user = { id: 'author-example', activeWorkspaceId: 'team-a', activeOrganizationId: 'org-example', permissions } as Express.User
        next()
    })
    server.use('/api/v1/harnesses', harnessesRouter)
    server.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error.statusCode || 500).json({ message: error.message })
    })
    return server
}

beforeEach(() => {
    dispatch.mockClear()
    setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: runPermissions }) })
    setHarnessModuleLoader(async (file) => {
        if (file === 'store.mjs') return { getHarness: () => harness }
        if (file === 'run.mjs') return { runHarness: dispatch }
        throw new Error(`Unexpected harness module: ${file}`)
    })
})

afterEach(() => {
    setHarnessModuleLoader(null)
    setTeamPermissionLookup(null)
})

it.each([undefined, 'router', 'agent'])('passes validated mode %s to the harness execution', async (mode) => {
    const body = { question: 'How many loaves?', ...(mode === undefined ? {} : { mode }) }
    const outcome = await harnessesService.startRun('bakery', body, {
        workspaceId: 'team-a',
        caller,
        runtime: { componentNodes: {}, appDataSource: {} } as any
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
            mode: mode ?? 'router',
            input: body.question,
            flowOptions: expect.objectContaining({ workspaceId: 'team-a' })
        })
    )
    expect(outcome).toMatchObject({
        payload: { text: 'The bakery has twelve loaves.' },
        run: { id: 'run-example', mode: mode ?? 'router' }
    })
})

it.each(['other', '', null, 1, {}, ['agent']])('returns 400 for invalid mode %j before dispatch or recording', async (mode) => {
    const response = await request(app()).post('/api/v1/harnesses/bakery/runs').send({ question: 'How many loaves?', mode })
    expect(response.status).toBe(400)
    expect(response.body.message).toBe('mode must be "router" or "agent".')
    expect(dispatch).not.toHaveBeenCalled()
})

it('refuses an agent caller without run permission before chief dispatch or recording', async () => {
    setTeamPermissionLookup({ accessFor: async () => ({ owner: false, permissions: ['chatflows:view'] }) })
    const response = await request(app(['chatflows:view']))
        .post('/api/v1/harnesses/bakery/runs')
        .send({ question: 'How many loaves?', mode: 'agent' })
    expect(response.status).toBe(403)
    expect(dispatch).not.toHaveBeenCalled()
})

it.each([undefined, 'agent'])('records background mode %s before starting execution', async (mode) => {
    const queued = jest.fn(() => {
        throw new Error('Queued mode captured.')
    })
    setHarnessModuleLoader(async (file) => {
        if (file === 'store.mjs') return { getHarness: () => harness }
        if (file === 'history.mjs') return { queueHarnessRun: queued }
        throw new Error(`Unexpected harness module: ${file}`)
    })
    await expect(
        harnessesService.startBackgroundRun(
            'bakery',
            { question: 'How many loaves?', ...(mode ? { mode } : {}) },
            { workspaceId: 'team-a', caller }
        )
    ).rejects.toThrow('Queued mode captured.')
    expect(queued).toHaveBeenCalledTimes(1)
    expect(queued).toHaveBeenCalledWith(expect.objectContaining({ mode: mode ?? 'router', name: harness.name }))
    expect(dispatch).not.toHaveBeenCalled()
})
