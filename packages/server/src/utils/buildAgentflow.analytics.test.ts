/**
 * Agentflow v2: drives the real executeAgentFlow call path and spies on
 * AnalyticHandler.getInstance, so a revert of the buildAgentflow.ts analytics call site (the credential leak on main)
 * fails here. A client tracer baseUrl must never reach the handler config. `analytics` is hard-denied, so no allowlist entry,
 * not even one on the Start node, lets it through.
 */
import logger from './logger'
import { executeAgentFlow } from './buildAgentflow'

jest.mock('./logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } }))

const mockGetInstance = jest.fn()
jest.mock('@cuttlely/components', () => {
    const actual = jest.requireActual('@cuttlely/components')
    return {
        ...actual,
        tracingEnvEnabled: () => false,
        AnalyticHandler: {
            getInstance: (...args: unknown[]) => {
                mockGetInstance(...args)
                // Stop tracing here; executeAgentFlow logs the error and carries on.
                throw new Error('analytics handler spy')
            }
        }
    }
})

const TRAP = { langFuse: { status: true, baseUrl: 'http://127.0.0.1:3199', secretKey: 'attacker-secret', publicKey: 'attacker-public' } }
const STORED_ANALYTIC = JSON.stringify({ langFuse: { status: true, credentialId: 'stored-langfuse-credential' } })

const node = (id: string, name: string, label: string, inputs: Record<string, unknown>) => ({
    id,
    type: 'agentFlow',
    position: { x: 0, y: 0 },
    data: { id, name, label, inputs, inputParams: [], inputAnchors: [], outputAnchors: [], outputs: {} }
})

const flowData = JSON.stringify({
    nodes: [
        node('startAgentflow_0', 'startAgentflow', 'Start', { startInputType: 'chatInput' }),
        node('llmAgentflow_0', 'llmAgentflow', 'LLM', { llmModel: 'chatOpenAI' })
    ],
    edges: [
        {
            id: 'e1',
            source: 'startAgentflow_0',
            target: 'llmAgentflow_0',
            sourceHandle: 'startAgentflow_0-output',
            targetHandle: 'llmAgentflow_0'
        }
    ]
})

const allow = (label: string, name: string) => ({ [label]: [{ label: name, name, type: 'json', enabled: true }] })

const repository = {
    find: async () => [],
    findBy: async () => [],
    findOne: async () => null,
    findOneBy: async () => null,
    create: (value: unknown) => value,
    save: async (value: Record<string, unknown>) => ({ id: 'execution-1', ...value }),
    update: async () => ({ affected: 1 })
}

/** Runs executeAgentFlow up to (and past) the analytics block and returns what AnalyticHandler.getInstance received. */
const analyticsSeenByHandler = async (overrideConfig: Record<string, unknown> | undefined) => {
    mockGetInstance.mockClear()
    const chatflow: any = {
        id: '9d1a47db-b84f-40b7-877b-eaeaa38c31a9',
        name: 'api1-agentflow',
        type: 'AGENTFLOW',
        flowData,
        analytic: STORED_ANALYTIC,
        apiConfig: overrideConfig ? JSON.stringify({ overrideConfig }) : undefined,
        workspaceId: 'ws-1'
    }
    try {
        await executeAgentFlow({
            componentNodes: {},
            incomingInput: { question: 'hi', streaming: false, overrideConfig: { analytics: JSON.parse(JSON.stringify(TRAP)) } },
            chatflow,
            chatId: 'chat-1',
            appDataSource: { getRepository: () => repository },
            telemetry: { sendTelemetry: jest.fn() },
            usageCacheManager: {},
            cachePool: {},
            baseURL: 'http://127.0.0.1',
            isInternal: false,
            orgId: 'org-1',
            workspaceId: 'ws-1',
            subscriptionId: 'sub-1',
            productId: 'prod-1'
        } as any)
    } catch (e) {
        // The flow has no runnable nodes here; only the handler config matters.
    }
    expect(mockGetInstance).toHaveBeenCalledTimes(1)
    const [nodeData, options] = mockGetInstance.mock.calls[0]
    return { analytics: nodeData.inputs.analytics, options }
}

describe('Request overrides (agentflow v2, executeAgentFlow): a client tracer baseUrl never reaches AnalyticHandler', () => {
    it('(i) overrides OFF (the case main leaked): the handler gets no override, only the stored analytic config', async () => {
        for (const config of [undefined, { status: false, nodes: allow('Start', 'analytics'), variables: [] }]) {
            const { analytics, options } = await analyticsSeenByHandler(config)
            expect(analytics).toEqual({})
            expect(options.analytic).toBe(STORED_ANALYTIC)
            expect(JSON.stringify(options)).not.toContain('3199')
        }
    })

    it('(ii) overrides ON with an empty allowlist: no override reaches the handler', async () => {
        const { analytics, options } = await analyticsSeenByHandler({ status: true, nodes: {}, variables: [] })
        expect(analytics).toEqual({})
        expect(options.analytic).toBe(STORED_ANALYTIC)
    })

    it('(iii) overrides ON with analytics allowlisted on a non-Start node only: no override reaches the handler', async () => {
        const { analytics, options } = await analyticsSeenByHandler({ status: true, nodes: allow('LLM', 'analytics'), variables: [] })
        expect(analytics).toEqual({})
        expect(options.analytic).toBe(STORED_ANALYTIC)
        expect((logger.warn as jest.Mock).mock.calls.map((c: any[]) => c[0])).toContain(
            '[server]: overrideConfig: 1 ignored (hard-denied, never overridable): analytics'
        )
    })

    it('(iv) hard deny: analytics allowlisted on the Start node (which passed before the hard deny) still never reaches the handler', async () => {
        const nodes = { ...allow('Start', 'analytics'), ...allow('LLM', 'analytics') }
        const { analytics, options } = await analyticsSeenByHandler({ status: true, nodes, variables: [] })
        expect(analytics).toEqual({})
        expect(options.analytic).toBe(STORED_ANALYTIC)
        expect(JSON.stringify(options)).not.toContain('3199')
    })
})
