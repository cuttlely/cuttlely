const mockNestedFlowNodeOptions = jest.fn((runtime: Record<string, unknown>) => ({
    nestedFlowCaller: runtime.caller,
    nestedFlowDepth: runtime.depth,
    runNestedFlow: jest.fn()
}))
const mockApp = {
    AppDataSource: {
        getRepository: jest.fn(() => ({ findOneBy: async () => ({ id: 'org-1', subscriptionId: 'sub-1' }) }))
    },
    nodesPool: { componentNodes: { chat: {} } },
    cachePool: {},
    telemetry: {},
    usageCacheManager: {},
    sseStreamer: {}
}

jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: () => mockApp }))
jest.mock('../etl', () => ({ orgIdForWorkspace: async () => 'org-1' }))
jest.mock('../../utils/nestedFlowCall', () => ({
    nestedFlowCallerFromHarness: jest.fn(),
    nestedFlowNodeOptions: (runtime: Record<string, unknown>) => mockNestedFlowNodeOptions(runtime)
}))

import { contextFor } from './index'

beforeEach(() => mockNestedFlowNodeOptions.mockClear())

it('builds the specialist nested runner from the serialized parent caller and depth', async () => {
    const context = await contextFor(
        { chatflowId: 'harness-flow', workspaceId: 'workspace' },
        { nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-1' }, nestedFlowDepth: 3 }
    )

    expect(context.flowOptions).toMatchObject({
        chatflowid: 'harness-flow',
        workspaceId: 'workspace',
        orgId: 'org-1',
        nestedFlowCaller: { via: 'api_key', apiKeyId: 'key-1' },
        nestedFlowDepth: 3,
        runNestedFlow: expect.any(Function)
    })
    expect(mockNestedFlowNodeOptions).toHaveBeenCalledWith(
        expect.objectContaining({
            parentFlowId: 'harness-flow',
            parentWorkspaceId: 'workspace',
            caller: { via: 'api_key', apiKeyId: 'key-1' },
            depth: 3,
            subscriptionId: 'sub-1'
        })
    )
})

it('does not create a nested runner when no parent caller is present', async () => {
    const context = await contextFor({ chatflowId: 'harness-flow', workspaceId: 'workspace' })
    expect(context.flowOptions.runNestedFlow).toBeUndefined()
    expect(mockNestedFlowNodeOptions).not.toHaveBeenCalled()
})
