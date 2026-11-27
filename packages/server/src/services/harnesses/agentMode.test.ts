import express from 'express'
import request from 'supertest'
import harnessesService, { setHarnessModuleLoader } from './index'
import harnessesRouter from '../../routes/harnesses'
import { setTeamPermissionLookup } from '../../identity/rbac'

jest.mock('../../utils/runtimeAvailability', () => ({ assertSelectedHarnessAvailable: jest.fn() }))
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

it('rejects agent images through request validation before loading runtime or history', async () => {
    const load = jest.fn(async () => {
        throw new Error('Image refusal must precede runtime or history loading.')
    })
    setHarnessModuleLoader(load)
    await expect(
        harnessesService.assertRunRequest(
            'bakery',
            { question: 'What is in this picture?', mode: 'agent', images: ['https://example.com/fixture.png'] },
            'team-a',
            caller
        )
    ).rejects.toMatchObject({ statusCode: 400, message: 'mode "agent" does not accept images yet; use router mode' })
    expect(load).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
})

it.each(['Default', 'default', 'DEFAULT'])('returns 400 for reserved chief name %s before loading runtime or history', async (name) => {
    const load = jest.fn(async () => {
        throw new Error('Reserved-name refusal must precede runtime or history loading.')
    })
    setHarnessModuleLoader(load)
    for (const [endpoint, streaming] of [
        ['runs', false],
        ['runs', true],
        ['runs/async', false]
    ] as const) {
        const response = await request(app())
            .post(`/api/v1/harnesses/${name}/${endpoint}`)
            .set('Accept', streaming ? 'text/event-stream' : 'application/json')
            .send({ question: 'How many loaves?', mode: 'agent', streaming })
        expect(response.status).toBe(400)
        expect(response.body.message).toBe(
            `Harness "${name}" cannot run in agent mode: the runtime reserves the profile name "default". Rename the harness to use agent mode.`
        )
    }
    expect(load).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
})

it.each(
    [
        ['https://example.com/fixture.png'],
        ['data:image/png;base64,iVBORw0KGgo='],
        [{ url: 'https://example.com/fixture.png' }],
        ['unsupported-image'],
        'https://example.com/fixture.png',
        { url: 'https://example.com/fixture.png' }
    ].map((images) => [images])
)('returns 400 for agent images %j on synchronous, streaming and background runs before dispatch or recording', async (images) => {
    const queued = jest.fn()
    setHarnessModuleLoader(async (file) => {
        if (file === 'store.mjs') return { getHarness: () => harness }
        if (file === 'run.mjs') return { runHarness: dispatch }
        if (file === 'history.mjs') return { queueHarnessRun: queued }
        throw new Error(`Unexpected harness module: ${file}`)
    })
    for (const endpoint of ['runs', 'runs/async']) {
        const response = await request(app())
            .post(`/api/v1/harnesses/bakery/${endpoint}`)
            .send({ question: 'What is in this picture?', mode: 'agent', images })
        expect(response.status).toBe(400)
        expect(response.body.message).toBe('mode "agent" does not accept images yet; use router mode')
    }
    const response = await request(app())
        .post('/api/v1/harnesses/bakery/runs')
        .set('Accept', 'text/event-stream')
        .send({ question: 'What is in this picture?', mode: 'agent', images, streaming: true })
    expect(response.status).toBe(400)
    expect(response.body.message).toBe('mode "agent" does not accept images yet; use router mode')
    expect(dispatch).not.toHaveBeenCalled()
    expect(queued).not.toHaveBeenCalled()
})

it.each(['router', 'agent'])('allows empty images in %s mode', async (mode) => {
    await harnessesService.startRun(
        'bakery',
        { question: 'How many loaves?', mode, images: [] },
        { workspaceId: 'team-a', caller, runtime: { componentNodes: {}, appDataSource: {} } as any }
    )
    expect(dispatch).toHaveBeenCalledTimes(1)
})

it('keeps router image request validation unchanged', async () => {
    await expect(
        harnessesService.assertRunRequest(
            'bakery',
            { question: 'What is in this picture?', images: ['https://example.com/fixture.png'] },
            'team-a',
            caller
        )
    ).resolves.toMatchObject({ mode: 'router' })
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

it('returns only the run id if native canvas delivery loses authorization after the completed row is recorded', async () => {
    const record = { ...harness, chatflowId: 'fixture-canvas' }
    setHarnessModuleLoader(async (file) => {
        if (file === 'store.mjs') return { getHarness: () => record }
        if (file === 'run.mjs')
            return {
                runHarness: async (options: any) => {
                    options.onRecorded({ id: 'run-example', text: 'fixture answer' })
                    return { text: 'fixture answer', trace: { engine: 'native' } }
                }
            }
        if (file === 'canvas-ownership.mjs')
            return {
                publishedCanvasSource: () => {
                    throw Object.assign(new Error('Updated fixture revision.'), { code: 'harness_changed' })
                }
            }
        throw new Error(`Unexpected harness module: ${file}`)
    })
    const failure = await harnessesService
        .startRun(
            'bakery',
            { question: 'Read the guide.' },
            {
                workspaceId: 'team-a',
                caller,
                record,
                runtime: { componentNodes: {}, appDataSource: {} } as any
            }
        )
        .catch((error: unknown) => error)
    expect(failure).toMatchObject({ statusCode: 409 })
    expect(failure).toHaveProperty('harnessRun', { id: 'run-example' })
})
