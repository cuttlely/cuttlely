/** Real routes, flow authorization and quota admission; execution and persistence use local fixtures. */
import express, { Request, Response } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { AppError } from '../errors/appError'
import { parsePolicy } from '../services/accessKeys/policy'
import { clearMinuteBuckets, utcWindows } from '../services/accessKeys/limiter'
import { fixtureAccessData } from '../utils/accessKeyTestFixtures'

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}))
jest.mock('../controllers/predictions', () => ({
    __esModule: true,
    default: { getRateLimiterMiddleware: (_req: Request, _res: Response, next: () => void) => next() }
}))
jest.mock('../controllers/orchestrate', () => ({
    __esModule: true,
    default: {
        createCompletion: jest.fn((req: Request, res: Response) => {
            if (mockExecutionError) throw mockExecutionError
            const body = (req as Request & { orchestrate: { stream?: boolean } }).orchestrate
            if (body.stream) res.type('text/event-stream').send('data: [DONE]\n\n')
            else res.json({ choices: [{ message: { role: 'assistant', content: 'Hello from the garden' } }] })
        })
    }
}))
jest.mock('../services/a2a/executor', () => ({
    emptyA2aLog: () => ({ method: '-', stream: false, ctxSrc: '-', context: '-', rpc: '-' }),
    executeMessage: jest.fn(({ res, rpcId, stream }: { res: Response; rpcId: string; stream: boolean }) => {
        if (mockExecutionError) throw mockExecutionError
        const body = { jsonrpc: '2.0', id: rpcId, result: { kind: 'task', id: 'garden-task', status: { state: 'completed' } } }
        if (stream) res.type('text/event-stream').send(`data: ${JSON.stringify(body)}\n\n`)
        else res.json(body)
    })
}))
jest.mock('../services/apikey', () => ({
    __esModule: true,
    default: {
        getApiKey: async (token: string) => {
            if (mockKeyStoreUnavailable) throw new AppError(503, 'Access key verification is unavailable.')
            return token === TOKEN ? mockKey : undefined
        }
    }
}))
jest.mock('../utils/getRunningExpressApp', () => ({ getRunningExpressApp: () => ({ AppDataSource: mockData }) }))

import orchestrateRouter, { orchestrateContentTypeGuard, orchestrateJsonParser } from './orchestrate'
import a2aRouter, { a2aContentTypeGuard, a2aJsonParser } from './a2a'
import orchestrateController from '../controllers/orchestrate'
import { executeMessage } from '../services/a2a/executor'

const FLOW = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'garden-fixture-access-key'
const mockKey = {
    id: 'garden-key',
    workspaceId: 'garden-workspace',
    permissions: ['chatflows:view'],
    accessPolicy: parsePolicy({ scopes: ['predict', 'stream'], rpm: 10, daily: 10, monthly: 10 })
}
const mockFlows = new Map([
    [
        FLOW,
        {
            id: FLOW,
            name: 'Garden assistant',
            workspaceId: mockKey.workspaceId,
            type: 'CHATFLOW',
            apikeyid: mockKey.id,
            flowData: JSON.stringify({ nodes: [{ data: { name: 'harness' } }], edges: [] })
        }
    ]
])
let mockKeyStoreUnavailable = false
let mockExecutionError: AppError | undefined
const mockUsage = new Map<string, { principalId: string; period: string; operation: string; accepted: number }>()
const usageId = (row: { principalId: string; period: string; operation: string }) => `${row.principalId}:${row.period}:${row.operation}`

// Exercise consume() itself, including each day/month and total/operation increment.
// Only the repository adapter is in memory, matching fixtureAccessData's flow/grant adapter.
const usageRepository = {
    findOneByOrFail: async (where: { principalId: string; period: string; operation: string }) => mockUsage.get(usageId(where)),
    createQueryBuilder: () => {
        let action = ''
        let row: { principalId: string; period: string; operation: string; accepted: number }
        let where: { principalId: string; period: string; operation: string }
        const query = {
            insert: () => ((action = 'insert'), query),
            update: () => ((action = 'update'), query),
            delete: () => ((action = 'delete'), query),
            values: (value: typeof row) => ((row = value), query),
            set: () => query,
            where: (value: typeof where) => ((where = value), query),
            andWhere: () => query,
            orIgnore: () => query,
            execute: async () => {
                if (action === 'insert' && !mockUsage.has(usageId(row))) mockUsage.set(usageId(row), { ...row })
                if (action === 'update') mockUsage.get(usageId(where))!.accepted += 1
                return { affected: 1 }
            }
        }
        return query
    }
}
const flowData = fixtureAccessData(mockFlows)
const mockData = {
    getRepository: (entity: { name: string }) => (entity.name === 'ApiKeyUsage' ? usageRepository : flowData.getRepository(entity)),
    transaction: jest.fn(async (work: (manager: unknown) => Promise<void>): Promise<void> => work(mockData))
}

const server = express()
server.use('/api/v1/orchestrate', orchestrateContentTypeGuard, orchestrateJsonParser, orchestrateRouter)
server.use('/api/v1/a2a', a2aContentTypeGuard, a2aJsonParser, a2aRouter)

const executions = [
    { label: 'Orchestrate non-stream', protocol: 'orchestrate', stream: false },
    { label: 'Orchestrate stream', protocol: 'orchestrate', stream: true },
    { label: 'A2A message/send', protocol: 'a2a', stream: false },
    { label: 'A2A message/stream', protocol: 'a2a', stream: true }
] as const
const sendExecution = (execution: (typeof executions)[number], token = TOKEN, rpcId: string | number = 'garden-request') => {
    const body =
        execution.protocol === 'orchestrate'
            ? { messages: [{ role: 'user', content: 'What grows in the garden?' }], stream: execution.stream }
            : {
                  jsonrpc: '2.0',
                  id: rpcId,
                  method: execution.stream ? 'message/stream' : 'message/send',
                  params: {
                      message: {
                          kind: 'message',
                          messageId: 'garden-message',
                          role: 'user',
                          parts: [{ kind: 'text', text: 'What grows in the garden?' }]
                      }
                  }
              }
    return request(server)
        .post(`/api/v1/${execution.protocol}/${FLOW}`)
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', execution.stream ? 'text/event-stream' : 'application/json')
        .send(body)
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-external-admission-'))
const previousDataDir = process.env.CUTTLELY_DATA_DIR
const previousRollout = process.env.INBOUND_ACCESS_V2
const setRuntime = (state: string) => fs.writeFileSync(path.join(temporary, 'hermes-supervisor.json'), JSON.stringify({ state }))
const usageSnapshot = () => [...mockUsage.values()].map((row) => ({ ...row }))
const expectNoExecution = () => {
    expect(orchestrateController.createCompletion).not.toHaveBeenCalled()
    expect(executeMessage).not.toHaveBeenCalled()
}

beforeEach(() => {
    process.env.CUTTLELY_DATA_DIR = temporary
    process.env.INBOUND_ACCESS_V2 = 'on'
    mockKeyStoreUnavailable = false
    mockExecutionError = undefined
    mockUsage.clear()
    const windows = utcWindows(Date.now())
    for (const period of [windows.day, windows.month]) {
        for (const operation of ['*', 'predict']) {
            const row = { principalId: mockKey.id, period, operation, accepted: 2 }
            mockUsage.set(usageId(row), row)
        }
    }
    clearMinuteBuckets()
    jest.clearAllMocks()
})
afterAll(() => {
    if (previousDataDir === undefined) delete process.env.CUTTLELY_DATA_DIR
    else process.env.CUTTLELY_DATA_DIR = previousDataDir
    if (previousRollout === undefined) delete process.env.INBOUND_ACCESS_V2
    else process.env.INBOUND_ACCESS_V2 = previousRollout
    fs.rmSync(temporary, { recursive: true, force: true })
})

describe.each(executions)('$label runtime admission', (execution) => {
    it.each(['down', 'restarting', 'cooldown', 'exhausted'])('refuses %s before charging or starting a response', async (state) => {
        setRuntime(state)
        const before = usageSnapshot()
        const res = await sendExecution(execution)
        expect(res.status).toBe(503)
        expect(res.headers['retry-after']).toBe('5')
        expect(res.headers['content-type']).toMatch(/^application\/json/)
        const message = 'The agent runtime is unavailable. Try again shortly or contact the instance operator.'
        if (execution.protocol === 'orchestrate') {
            expect(res.body).toEqual({ error: { code: 'RUNTIME_UNAVAILABLE', type: 'server_error', message } })
        } else {
            expect(res.body).toEqual({
                jsonrpc: '2.0',
                id: 'garden-request',
                error: { code: -32603, message, data: { code: 'RUNTIME_UNAVAILABLE' } }
            })
        }
        expect(usageSnapshot()).toEqual(before)
        expect(mockData.transaction).not.toHaveBeenCalled()
        expectNoExecution()
    })

    it('allows an available runtime and charges exactly once', async () => {
        setRuntime('up')
        const res = await sendExecution(execution)
        expect(res.status).toBe(200)
        expect(res.headers['retry-after']).toBeUndefined()
        expect(res.headers['x-ratelimit-remaining']).toBe('9')
        expect(mockData.transaction).toHaveBeenCalledTimes(1)
        expect([...mockUsage.values()].map((row) => row.accepted)).toEqual([3, 3, 3, 3])
        if (execution.protocol === 'orchestrate') expect(orchestrateController.createCompletion).toHaveBeenCalledTimes(1)
        else expect(executeMessage).toHaveBeenCalledTimes(1)
        if (execution.stream) expect(res.headers['content-type']).toMatch(/^text\/event-stream/)
        else if (execution.protocol === 'a2a') expect(res.body.result.status.state).toBe('completed')
        else expect(res.body.choices[0].message.content).toBe('Hello from the garden')
    })

    it('authenticates before revealing runtime availability', async () => {
        setRuntime('down')
        const before = usageSnapshot()
        const res = await sendExecution(execution, 'unknown-fixture-key')
        expect(res.status).toBe(401)
        expect(res.headers['retry-after']).toBeUndefined()
        expect(JSON.stringify(res.body)).not.toContain('RUNTIME_UNAVAILABLE')
        expect(usageSnapshot()).toEqual(before)
        expectNoExecution()
    })

    it('keeps authorization outages distinct from runtime outages', async () => {
        setRuntime('up')
        mockKeyStoreUnavailable = true
        const before = usageSnapshot()
        const res = await sendExecution(execution)
        expect(res.status).toBe(503)
        expect(res.headers['retry-after']).toBeUndefined()
        expect(res.body.error).toMatchObject({ code: 'unavailable', message: 'Authorization is temporarily unavailable.' })
        expect(usageSnapshot()).toEqual(before)
        expectNoExecution()
    })
})

it('serves the authenticated A2A agent card while the runtime is down', async () => {
    setRuntime('down')
    const res = await request(server).get(`/api/v1/a2a/${FLOW}/.well-known/agent-card.json`).set('Authorization', `Bearer ${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ name: 'Garden assistant', protocolVersion: '0.3.0' })
    expect(res.headers['retry-after']).toBeUndefined()
    expectNoExecution()
})

it('keeps A2A task reads available while the runtime is down', async () => {
    setRuntime('down')
    const res = await request(server)
        .post(`/api/v1/a2a/${FLOW}`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ jsonrpc: '2.0', id: 23, method: 'tasks/get', params: { id: 'missing-garden-task' } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ jsonrpc: '2.0', id: 23, error: { code: -32001, message: 'Task not found' } })
    expect(res.headers['retry-after']).toBeUndefined()
    expectNoExecution()
})

it.each([executions[0], executions[2]])('preserves a wrapped runtime error on $label', async (execution) => {
    setRuntime('up')
    mockExecutionError = Object.assign(new AppError(503, 'The agent runtime is recovering. Try again later.'), {
        code: 'RUNTIME_UNAVAILABLE',
        retryAfterSeconds: 17
    })
    const res = await sendExecution(execution, TOKEN, 42)
    expect(res.status).toBe(503)
    expect(res.headers['retry-after']).toBe('17')
    if (execution.protocol === 'orchestrate') {
        expect(res.body.error).toEqual({
            code: 'RUNTIME_UNAVAILABLE',
            type: 'server_error',
            message: mockExecutionError.message
        })
    } else {
        expect(res.body).toEqual({
            jsonrpc: '2.0',
            id: 42,
            error: { code: -32603, message: mockExecutionError.message, data: { code: 'RUNTIME_UNAVAILABLE' } }
        })
    }
})

it('preserves a numeric A2A request id on a runtime admission refusal', async () => {
    setRuntime('down')
    const res = await sendExecution(executions[3], TOKEN, 42)
    expect(res.status).toBe(503)
    expect(res.body.id).toBe(42)
    expect(res.body.error.data.code).toBe('RUNTIME_UNAVAILABLE')
    expectNoExecution()
})
