/**
 * Who a Harness card runs for when a flow is called with no person signed in. MCP counts as internal, but no person is
 * behind it, so the flow's own key and that key's list apply, the same as on the prediction API.
 */
import type { Request } from 'express'
import { readFileSync } from 'fs'
import { join } from 'path'

const jobs: Array<Record<string, unknown>> = []
const getApiKeyById = jest.fn()

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
    open: { id: 'open', type: 'CHATFLOW', workspaceId: 'ws-1', apikeyid: null, flowData: '{"nodes":[],"edges":[]}' }
}

jest.mock('./getRunningExpressApp', () => ({ getRunningExpressApp: () => app }))
jest.mock('./quotaUsage', () => ({
    checkPredictions: async () => undefined,
    updatePredictionsUsage: async () => undefined,
    checkStorage: async () => undefined,
    updateStorageUsage: async () => undefined
}))
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
    })

    it('gives a key that is gone an empty list, so its Harness cards are refused', async () => {
        getApiKeyById.mockResolvedValue(undefined)
        await utilBuildChatflow(mcpRequest('keyed'), true, ChatType.MCP)
        expect(jobs[0].harnessCaller).toEqual({ via: 'api_key', apiKeyId: 'key-1', harnesses: [] })
    })

    it('runs a keyless flow as itself, and only an explicit person as a session', async () => {
        await utilBuildChatflow(mcpRequest('open'), true, ChatType.MCP)
        expect(jobs[0].harnessCaller).toEqual({ via: 'flow' })
        await utilBuildChatflow(mcpRequest('keyed'), true, undefined, { harnessCaller: { via: 'session' } })
        expect(jobs[1].harnessCaller).toEqual({ via: 'session' })
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
