/**
 * Who a Harness card runs for when a flow is called with no person signed in. MCP counts as internal, but no person is
 * behind it, so the flow's own key and that key's list apply, the same as on the prediction API.
 */
import type { Request } from 'express'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const jobs: Array<Record<string, unknown>> = []
const getApiKeyById = jest.fn()
// Records each key check and whether it charges (the third argument; omitted means charge).
const validateFlowAPIKey = jest.fn(async (..._args: unknown[]) => true)

const app = {
    AppDataSource: {
        getRepository: (entity: { name?: string }) => ({
            findOneBy: async ({ id }: { id: string }) => {
                if (entity?.name === 'ChatFlow') return flows[id] || null
                if (entity?.name === 'Workspace') return { id, organizationId: 'org-1' }
                return { id: 'org-1', subscriptionId: 'sub-1' }
            }
        })
    },
    queueManager: {
        getQueue: () => ({
            addJob: async (data: Record<string, unknown>) => {
                jobs.push(data)
                return { id: 'job-1', waitUntilFinished: async () => ({ text: 'ok' }) }
            },
            getQueueEvents: () => ({})
        }),
        getPredictionQueueEventsProducer: () => ({ publishEvent: async () => undefined })
    },
    abortControllerPool: { add: () => undefined, remove: () => undefined },
    usageCacheManager: {},
    nodesPool: { componentNodes: {} },
    metricsProvider: undefined,
    sseStreamer: {},
    telemetry: {},
    cachePool: {}
}

const flows: Record<string, Record<string, unknown>> = {
    keyed: { id: 'keyed', type: 'CHATFLOW', workspaceId: 'ws-1', apikeyid: 'key-1', flowData: '{"nodes":[],"edges":[]}' },
    open: { id: 'open', type: 'CHATFLOW', workspaceId: 'ws-1', apikeyid: null, flowData: '{"nodes":[],"edges":[]}' },
    // A keyed flow with a Harness card, so it needs the agent runtime.
    runtimeKeyed: {
        id: 'runtimeKeyed',
        type: 'CHATFLOW',
        workspaceId: 'ws-1',
        apikeyid: 'key-1',
        flowData: JSON.stringify({ nodes: [{ id: 'harness_0', data: { name: 'harness' } }], edges: [] })
    }
}

jest.mock('./getRunningExpressApp', () => ({ getRunningExpressApp: () => app }))
jest.mock('./quotaUsage', () => ({
    checkPredictions: async () => undefined,
    updatePredictionsUsage: async () => undefined,
    checkStorage: async () => undefined,
    updateStorageUsage: async () => undefined
}))
jest.mock('./validateKey', () => ({ validateFlowAPIKey: (...args: unknown[]) => validateFlowAPIKey(...args) }))
jest.mock('./sessionOwnership', () => ({ bindRequestSession: () => ({ chatId: 'chat-1' }) }))
jest.mock('../services/apikey', () => ({
    __esModule: true,
    default: { getApiKeyById: (...args: unknown[]) => getApiKeyById(...args) }
}))
jest.mock('./logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }
}))

import { ChatType } from '../Interface'
import { harnessToolPayloadFor, utilBuildChatflow } from './buildChatflow'

function mcpRequest(id: string): Request {
    return {
        params: { id },
        body: { question: 'How many loaves?' },
        headers: {},
        protocol: 'http',
        files: [],
        get: (name: string) => (name === 'host' ? 'localhost:3000' : undefined)
    } as unknown as Request
}

describe('the harness caller for a flow run with no person signed in', () => {
    const savedMode = process.env.MODE
    beforeAll(() => {
        process.env.MODE = 'queue'
    })
    afterAll(() => {
        if (savedMode === undefined) delete process.env.MODE
        else process.env.MODE = savedMode
    })
    beforeEach(() => {
        jobs.length = 0
        getApiKeyById.mockReset()
    })

    it('runs an MCP call for the flow key and its list, although the call counts as internal', async () => {
        getApiKeyById.mockResolvedValue({ id: 'key-1', workspaceId: 'ws-1', harnesses: ['bakery'] })
        await utilBuildChatflow(mcpRequest('keyed'), true, ChatType.MCP)
        expect(getApiKeyById).toHaveBeenCalledWith('key-1')
        expect(jobs[0].harnessCaller).toEqual({ via: 'api_key', apiKeyId: 'key-1', harnesses: ['bakery'] })
        expect(jobs[0].nestedFlowCaller).toEqual({ via: 'api_key', apiKeyId: 'key-1' })
        expect(jobs[0].nestedFlowDepth).toBe(0)
    })

    it('gives a key that is gone an empty list, so its Harness cards are refused', async () => {
        getApiKeyById.mockResolvedValue(undefined)
        await utilBuildChatflow(mcpRequest('keyed'), true, ChatType.MCP)
        expect(jobs[0].harnessCaller).toEqual({ via: 'api_key', apiKeyId: 'key-1', harnesses: [] })
    })

    it('runs a keyless flow as itself, and only an explicit person as a session', async () => {
        await utilBuildChatflow(mcpRequest('open'), true, ChatType.MCP)
        expect(jobs[0].harnessCaller).toEqual({ via: 'flow' })
        expect(jobs[0].nestedFlowCaller).toEqual({ via: 'flow' })
        await utilBuildChatflow(mcpRequest('keyed'), true, undefined, { harnessCaller: { via: 'session' } })
        expect(jobs[1].harnessCaller).toEqual({ via: 'session' })
        expect(jobs[1].nestedFlowCaller).toEqual({ via: 'session' })
        expect(getApiKeyById).not.toHaveBeenCalled()
    })
})

describe('the harness trace saved with an agent reply when the harness ran as a tool', () => {
    const trace = { harness: 'NAVI-Agentic', tokens: { prompt: 120, completion: 40 }, route: { steps: [{ specialist: 'knowledge' }] } }
    it('keeps the last harness run trace and the reply the chat shows', () => {
        const saved = harnessToolPayloadFor(
            [
                { text: 'first', harness: 'NAVI-Agentic', trace: { tokens: { prompt: 1, completion: 1 } } },
                {
                    text: 'Vault HA uses Raft.',
                    harness: 'NAVI-Agentic',
                    agents: [{ name: 'knowledge' }],
                    report: { tokens: trace.tokens },
                    trace
                }
            ],
            'Here is what the harness found: Vault HA uses Raft.'
        )
        expect(saved).toEqual({
            text: 'Here is what the harness found: Vault HA uses Raft.',
            harness: 'NAVI-Agentic',
            agents: [{ name: 'knowledge' }],
            sources: [],
            artifacts: [],
            report: { tokens: trace.tokens },
            trace,
            viaTool: true
        })
    })
    it('saves nothing when no harness tool ran or it left no trace', () => {
        expect(harnessToolPayloadFor([], 'reply')).toBeUndefined()
        expect(harnessToolPayloadFor(undefined, 'reply')).toBeUndefined()
        expect(harnessToolPayloadFor([{ text: 'no trace' }], 'reply')).toBeUndefined()
    })
})

describe('the multi-agent flow reply', () => {
    it('keeps the harness tool trace, tokens included, like the other flow types', () => {
        const source = readFileSync(join(__dirname, 'buildChatflow.ts'), 'utf8')
        const branch = source.slice(source.indexOf('const { finalResult, finalAction'), source.indexOf('agentflow.followUpPrompts'))
        expect(branch).toContain('harnessToolPayloadFor(harnessToolPayloads, finalResult)')
        expect(branch).toContain('apiMessage.harnessPayload = JSON.stringify(agentflowHarness)')
        const payload = harnessToolPayloadFor([{ trace: { tokens: { total: 42 } } }], 'answer')
        expect(payload?.trace?.tokens?.total ?? 42).toBe(42)
    })
})

// Webhook, Orchestrate and A2A calls reach utilBuildChatflow as external requests. While the agent runtime is down a
// flow that needs it is refused before its key is charged, so a caller retrying on Retry-After is not billed.
describe('an external call to a flow that needs the agent runtime while the runtime is down', () => {
    const savedMode = process.env.MODE
    const savedDataDir = process.env.CUTTLELY_DATA_DIR
    let dataDir = ''
    const setRuntime = (state: string) =>
        writeFileSync(join(dataDir, 'hermes-supervisor.json'), JSON.stringify({ state, restarts: 0, pid: 0 }))

    beforeAll(() => {
        process.env.MODE = 'queue'
    })
    afterAll(() => {
        if (savedMode === undefined) delete process.env.MODE
        else process.env.MODE = savedMode
    })
    beforeEach(() => {
        jobs.length = 0
        validateFlowAPIKey.mockReset()
        validateFlowAPIKey.mockResolvedValue(true)
        getApiKeyById.mockResolvedValue({ id: 'key-1', workspaceId: 'ws-1', harnesses: [] })
        dataDir = mkdtempSync(join(tmpdir(), 'build-chatflow-runtime-'))
        process.env.CUTTLELY_DATA_DIR = dataDir
    })
    afterEach(() => {
        if (savedDataDir === undefined) delete process.env.CUTTLELY_DATA_DIR
        else process.env.CUTTLELY_DATA_DIR = savedDataDir
        rmSync(dataDir, { recursive: true, force: true })
    })

    it('is refused with 503 RUNTIME_UNAVAILABLE and the key is never charged', async () => {
        setRuntime('down')
        await expect(utilBuildChatflow(mcpRequest('runtimeKeyed'), false)).rejects.toMatchObject({
            statusCode: 503,
            code: 'RUNTIME_UNAVAILABLE',
            retryAfterSeconds: 5
        })
        expect(validateFlowAPIKey).toHaveBeenCalled()
        for (const call of validateFlowAPIKey.mock.calls) expect(call[2]).toBe(false)
        expect(jobs).toHaveLength(0)
    })

    it('a wrong key is still 401 while the runtime is down (the key decides first)', async () => {
        setRuntime('down')
        validateFlowAPIKey.mockResolvedValue(false)
        await expect(utilBuildChatflow(mcpRequest('runtimeKeyed'), false)).rejects.toMatchObject({ statusCode: 401 })
    })

    it('with the runtime up the key is charged and the run starts', async () => {
        setRuntime('up')
        await utilBuildChatflow(mcpRequest('runtimeKeyed'), false)
        expect(validateFlowAPIKey.mock.calls.map((call) => call[2])).toEqual([false, undefined])
        expect(jobs).toHaveLength(1)
    })
})
